import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import {
  DEFAULT_AI_PROVIDER,
  assertAiProviderReady,
  getAiProvider,
  getDefaultAiProviderInfo,
  listAiProviders,
  normalizeAiProviderId,
} from './aiProviders.js'
import {
  getExtension,
  inspectDocument,
  normalizeUploadFilename,
  prepareDocumentForAi,
  validateFileBasics,
} from './documentProcessor.js'
import { createPptxFromPlan } from './pptDeckBuilder.js'
import {
  PPT_MAX_SLIDES,
  PPT_MIN_SLIDES,
  PPT_MODES,
  PPT_TYPES,
} from './pptPlan.js'
import { getCommandVersion, renderDocumentToPreviews } from './pptRenderer.js'
import {
  analyzeTemplateFillLibrary,
  applyTemplateFillPlan,
  checkTemplateFillPlan,
  normalizePptxForRendering,
  pruneSlideLibraryForAi,
  summarizeTemplateFillCheck,
  templateFillPlanToPptPlan,
  writeTemplateFillPlan,
} from './pptTemplateFill.js'
import {
  analyzeMasterFile,
  analyzeTemplateFiles,
  buildMasterContext,
  buildTemplateContext,
  extractContentFileText,
} from './pptTemplateProcessor.js'
import {
  ALLOWED_EXTENSIONS,
  DIFFICULTIES,
  MAX_FILE_SIZE,
  MAX_PDF_PAGES,
  MAX_PPTX_SLIDES,
  OPEN_QUESTION_MAX,
  OPEN_QUESTION_MIN,
  QUESTION_COUNTS,
} from './types.js'

const app = express()
const port = Number(process.env.PORT || 5174)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')
const uploadRoot = await mkdtemp(path.join(os.tmpdir(), 'material-quiz-uploads-'))
const sessions = new Map()
const pptSessions = new Map()
const pptJobs = new Map()
const pptTemplateFillLibraryCache = new Map()
const maxPptTemplateFillLibraryCacheEntries = 20
const accessPassword = String(process.env.ACCESS_PASSWORD || '').trim()
const accessAuthEnabled = Boolean(accessPassword)
const accessCookieName = 'moonwalk_access'

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: MAX_FILE_SIZE },
})

let pptRenderingStatusCache = null

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', async (_req, res) => {
  const defaultProvider = getDefaultAiProviderInfo()
  const pptRendering = await getPptRenderingStatus()
  res.json({
    ok: true,
    aiConfigured: defaultProvider.configured,
    aiProvider: defaultProvider.label,
    aiProviderId: defaultProvider.id,
    aiModel: defaultProvider.model,
    lowCostModelSelected: defaultProvider.lowCostModelSelected,
    accessAuthRequired: accessAuthEnabled,
    defaultAiProvider: DEFAULT_AI_PROVIDER,
    aiProviders: listAiProviders(),
    pptRenderingAvailable: pptRendering.available,
    pptRendering,
    limits: {
      allowedExtensions: ALLOWED_EXTENSIONS,
      maxFileSizeMB: Math.round(MAX_FILE_SIZE / 1024 / 1024),
      maxPdfPages: MAX_PDF_PAGES,
      maxPptxSlides: MAX_PPTX_SLIDES,
      questionCounts: QUESTION_COUNTS,
      openQuestionMin: OPEN_QUESTION_MIN,
      openQuestionMax: OPEN_QUESTION_MAX,
      difficulties: DIFFICULTIES,
      pptModes: PPT_MODES,
      pptTypes: PPT_TYPES,
      pptMinSlides: PPT_MIN_SLIDES,
      pptMaxSlides: PPT_MAX_SLIDES,
    },
  })
})

app.get('/api/auth/status', (req, res) => {
  res.json({
    required: accessAuthEnabled,
    authenticated: !accessAuthEnabled || hasValidAccessCookie(req),
  })
})

app.post('/api/auth/login', (req, res) => {
  if (!accessAuthEnabled) {
    res.json({ required: false, authenticated: true })
    return
  }

  const password = String(req.body?.password || '')
  if (!safeEqual(password, accessPassword)) {
    res.status(401).json({ error: '访问密码不正确，请重新输入。' })
    return
  }

  res.cookie(accessCookieName, buildAccessToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
  res.json({ required: true, authenticated: true })
})

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(accessCookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })
  res.json({ authenticated: false })
})

app.use('/api', requireAccess)
app.use('/api/ppt-files', express.static(uploadRoot))

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const aiProvider = getAiProvider(req.body?.aiProvider)
    assertAiProviderReady(aiProvider)

    const file = req.file
    const originalName = normalizeUploadFilename(file?.originalname)
    const extension = getExtension(originalName)
    await validateFileBasics(file, extension)
    const inspection = await inspectDocument(file.path, extension)
    const prepared = await prepareDocumentForAi(file.path, originalName, extension)
    const fileInfo = {
      originalName,
      extension,
      size: file.size,
      pageCount: inspection.pageCount,
      slideCount: inspection.slideCount,
    }
    const summary = await aiProvider.module.analyzeMaterial(prepared, fileInfo)
    const sessionId = nanoid()

    sessions.set(sessionId, {
      id: sessionId,
      aiProviderId: aiProvider.id,
      filePath: file.path,
      fileInfo,
      prepared,
      summary,
      quiz: null,
      openQuestionSet: null,
      openFeedback: null,
      createdAt: Date.now(),
    })

    res.json({
      sessionId,
      aiProvider: aiProvider.id,
      fileInfo,
      processingNotes: prepared.processingNotes,
      summary,
    })
  } catch (error) {
    if (req.file?.path) {
      await rm(req.file.path, { force: true }).catch(() => {})
    }
    res.status(400).json({ error: toUserError(error) })
  }
})

app.post('/api/ppt/analyze', upload.fields([
  { name: 'templates', maxCount: 10 },
  { name: 'contentFile', maxCount: 1 },
  { name: 'master', maxCount: 1 },
]), async (req, res) => {
  try {
    await assertPptRendererReady()
    const aiProvider = getAiProvider(req.body?.aiProvider)
    assertAiProviderReady(aiProvider)
    const files = req.files || {}
    const templateFiles = Array.isArray(files.templates) ? files.templates : []
    if (!templateFiles.length) throw new Error('请至少上传 1 个模板文件。')
    if (templateFiles.length > 10) throw new Error('模板文件最多上传 10 个。')

    const sessionId = nanoid()
    const sessionDir = path.join(uploadRoot, `ppt-${sessionId}`)
    await mkdir(sessionDir, { recursive: true })

    const job = createPptJob(sessionId, 'analyze')
    runPptJob(job, async ({ update }) => {
      try {
        return await analyzePptUploadSession({
          aiProvider,
          files,
          body: req.body,
          sessionId,
          sessionDir,
          update,
        })
      } catch (error) {
        await cleanupUploadedFiles(req.files)
        await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    })
    res.json(serializePptJob(job))
  } catch (error) {
    await cleanupUploadedFiles(req.files)
    res.status(400).json({ error: toUserError(error) })
  }
})

app.post('/api/ppt/generate', async (req, res) => {
  try {
    await assertPptRendererReady()
    const settings = normalizePptGenerationSettings(req.body)
    const session = getPptSession(settings.sessionId)
    const aiProvider = getSessionAiProvider(session, settings.aiProvider)
    assertAiProviderReady(aiProvider)

    applyPptSettings(session, settings)
    const job = createPptJob(session.id, 'generate')
    runPptJob(job, async ({ update }) => {
      update('正在整理内容、需求和模板规则。')
      await generatePptSessionOutput(session, aiProvider, update)
      return serializePptSession(session)
    })
    res.json(serializePptJob(job))
  } catch (error) {
    res.status(400).json({ error: toUserError(error) })
  }
})

app.get('/api/ppt/jobs/:jobId', (req, res) => {
  try {
    const job = getPptJob(req.params.jobId)
    res.json(serializePptJob(job))
  } catch (error) {
    res.status(404).json({ error: toUserError(error) })
  }
})

app.post('/api/ppt/revise', async (req, res) => {
  try {
    await assertPptRendererReady()
    const settings = normalizePptRevisionSettings(req.body)
    const session = getPptSession(settings.sessionId)
    const aiProvider = getSessionAiProvider(session, settings.aiProvider)
    assertAiProviderReady(aiProvider)
    if (!session.plan) {
      throw new Error('还没有生成 PPT 初稿，请先生成预览。')
    }

    const job = createPptJob(session.id, 'revise')
    runPptJob(job, async ({ update }) => {
      update('正在读取每页修改意见。')
      const plan = await aiProvider.module.revisePptPlan({
        ...buildPptAiContext(session),
        currentPlan: session.plan,
        slideComments: settings.slideComments,
      })
      update('AI 已返回修改方案，正在重新渲染 PPT。')
      await renderPptSessionOutput(session, plan, { engine: 'fallback', update })
      return serializePptSession(session)
    })
    res.json(serializePptJob(job))
  } catch (error) {
    res.status(400).json({ error: toUserError(error) })
  }
})

app.get('/api/ppt/:sessionId/download/pptx', (req, res) => {
  try {
    const session = getPptSession(req.params.sessionId)
    if (!session.output?.pptxPath) throw new Error('还没有可下载的 PPTX 终稿。')
    res.download(session.output.pptxPath, `${safeDownloadName(session.plan?.title || 'moonwalk')}.pptx`)
  } catch (error) {
    res.status(404).json({ error: toUserError(error) })
  }
})

app.get('/api/ppt/:sessionId/download/pdf', (req, res) => {
  try {
    const session = getPptSession(req.params.sessionId)
    if (!session.output?.pdfPath) throw new Error('当前环境暂不支持 PDF 导出。')
    res.download(session.output.pdfPath, `${safeDownloadName(session.plan?.title || 'moonwalk')}.pdf`)
  } catch (error) {
    res.status(404).json({ error: toUserError(error) })
  }
})

async function analyzePptUploadSession({ aiProvider, files, body, sessionId, sessionDir, update }) {
  const templateFiles = Array.isArray(files.templates) ? files.templates : []
  const contentFile = Array.isArray(files.contentFile) ? files.contentFile[0] : null
  const masterFile = Array.isArray(files.master) ? files.master[0] : null

  update('正在分析模板文件并生成预览。')
  const templates = await analyzeTemplateFiles(templateFiles, sessionDir)
  const cachedTemplateCount = templates.filter((template) => template.cacheHit).length

  update(contentFile ? '正在读取 PPT 内容文件。' : '正在整理 PPT 文本内容。')
  const contentFileResult = await extractContentFileText(contentFile)

  update(masterFile ? '正在识别幻灯片母版结构。' : '正在整理模板生成设置。')
  const master = await analyzeMasterFile(masterFile, sessionDir)

  const session = {
    id: sessionId,
    aiProviderId: aiProvider.id,
    sessionDir,
    templates,
    contentText: normalizeLongText(body?.contentText, 40000),
    contentFileText: contentFileResult.text,
    contentFileInfo: contentFileResult.fileInfo,
    requirements: normalizeLongText(body?.requirements, 12000),
    master,
    masterDescription: normalizeLongText(body?.masterDescription, 12000),
    mode: null,
    pptType: null,
    slideCount: null,
    mainTemplateId: templates[0]?.id || null,
    plan: null,
    output: null,
    cacheSummary: {
      templateHits: cachedTemplateCount,
      templateTotal: templates.length,
      contentHit: Boolean(contentFileResult.cacheHit),
      masterHit: Boolean(master?.cacheHit),
    },
    createdAt: Date.now(),
  }
  pptSessions.set(sessionId, session)
  update(cachedTemplateCount > 0
    ? `模板分析完成，已复用 ${cachedTemplateCount}/${templates.length} 个缓存结果。`
    : '模板分析完成，已生成可用预览。')
  return serializePptSession(session)
}

app.post('/api/generate', async (req, res) => {
  try {
    const settings = normalizeSettings(req.body)
    const session = getSession(settings.sessionId)
    const aiProvider = getSessionAiProvider(session, settings.aiProvider)
    assertAiProviderReady(aiProvider)
    const quiz = await aiProvider.module.generateQuiz(session, settings)
    session.quiz = quiz
    res.json(quiz)
  } catch (error) {
    res.status(400).json({ error: toUserError(error) })
  }
})

app.post('/api/open/generate', async (req, res) => {
  try {
    const settings = normalizeOpenQuestionSettings(req.body)
    const session = getSession(settings.sessionId)
    const aiProvider = getSessionAiProvider(session, settings.aiProvider)
    assertAiProviderReady(aiProvider)
    validateSelectedSections(session, settings.selectedSectionIndexes)

    const openQuestionSet = await aiProvider.module.generateOpenQuestions(session, settings)
    const feedbackContext = buildFeedbackContext(session, settings, aiProvider.id)
    session.openQuestionSet = {
      ...openQuestionSet,
      writingGoal: settings.writingGoal,
      selectedSectionIndexes: settings.selectedSectionIndexes,
      feedbackContext,
    }
    session.openFeedback = null
    res.json({ ...openQuestionSet, feedbackContext })
  } catch (error) {
    res.status(400).json({ error: toUserError(error) })
  }
})

app.post('/api/open/feedback', async (req, res) => {
  try {
    const settings = normalizeOpenFeedbackSettings(req.body)
    const session = sessions.get(settings.sessionId)
    const fallback = settings.feedbackContext
    if (!session && !fallback) {
      throw new Error('当前材料会话已过期，请回到摘要页重新生成开放式问题。')
    }

    const questionSet = session?.openQuestionSet || fallback?.questionSet
    if (!questionSet?.questions?.length) {
      throw new Error('还没有生成开放式问题，请先回到摘要页生成问题。')
    }

    const aiProvider = session
      ? getSessionAiProvider(session, settings.aiProvider)
      : getAiProvider(fallback.aiProvider || settings.aiProvider)
    assertAiProviderReady(aiProvider)

    const feedback = await aiProvider.module.generateOpenFeedback(session || fallback, {
      writingGoal: questionSet.writingGoal || fallback?.writingGoal,
      questions: questionSet.questions,
      answers: settings.answers,
      fileInfo: fallback?.fileInfo,
      prepared: fallback?.prepared,
      summary: fallback?.summary,
    })
    if (session) session.openFeedback = feedback
    res.json(feedback)
  } catch (error) {
    res.status(400).json({ error: toUserError(error) })
  }
})

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: '文件超过 50MB，请上传更小的材料。' })
    return
  }
  next(error)
})

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在。' })
})

if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`Material quiz API is running at http://localhost:${port}`)
})

process.on('SIGINT', cleanupAndExit)
process.on('SIGTERM', cleanupAndExit)

async function cleanupAndExit() {
  await rm(uploadRoot, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}

async function getPptRenderingStatus() {
  if (pptRenderingStatusCache) return pptRenderingStatusCache
  const [sofficeVersion, pdftoppmVersion] = await Promise.all([
    getCommandVersion('soffice', ['--version']),
    getCommandVersion('pdftoppm', ['-v']),
  ])
  pptRenderingStatusCache = {
    available: Boolean(sofficeVersion && pdftoppmVersion),
    sofficeVersion,
    pdftoppmVersion,
  }
  return pptRenderingStatusCache
}

async function assertPptRendererReady() {
  const status = await getPptRenderingStatus()
  if (!status.available) {
    throw new Error('当前部署环境暂不支持 PPT 预览转换，请使用 Docker 版 Moonwalk 服务。')
  }
}

function getSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error('当前材料会话不存在，请重新上传材料。')
  }
  return session
}

function getPptSession(sessionId) {
  const session = pptSessions.get(sessionId)
  if (!session) {
    throw new Error('当前 PPT 生成会话不存在，请回到首页重新开始。')
  }
  return session
}

function getPptJob(jobId) {
  const job = pptJobs.get(jobId)
  if (!job) {
    throw new Error('当前 PPT 生成任务不存在，请重新生成。')
  }
  return job
}

function createPptJob(sessionId, type) {
  const job = {
    id: nanoid(),
    sessionId,
    type,
    status: 'queued',
    message: getPptJobMessage(type, 'queued'),
    result: null,
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  pptJobs.set(job.id, job)
  return job
}

function runPptJob(job, handler) {
  queueMicrotask(async () => {
    try {
      updatePptJob(job, { status: 'running', message: getPptJobMessage(job.type, 'running') })
      const update = (message) => updatePptJob(job, { status: 'running', message })
      const result = await handler({ update })
      updatePptJob(job, {
        status: 'completed',
        message: getPptJobMessage(job.type, 'completed'),
        result,
      })
    } catch (error) {
      updatePptJob(job, {
        status: 'failed',
        message: getPptJobMessage(job.type, 'failed'),
        error: toUserError(error),
      })
    }
  })
}

function getPptJobMessage(type, status) {
  const messages = {
    analyze: {
      queued: '分析任务已创建，正在排队。',
      running: '正在分析模板、内容和预览，请稍候。',
      completed: '模板分析完成。',
      failed: '模板分析失败。',
    },
    generate: {
      queued: '生成任务已创建，正在排队。',
      running: '正在生成 PPT，请稍候。',
      completed: 'PPT 已生成。',
      failed: 'PPT 生成失败。',
    },
    revise: {
      queued: '修改任务已创建，正在排队。',
      running: '正在根据修改意见重新生成，请稍候。',
      completed: 'PPT 已重新生成。',
      failed: 'PPT 修改失败。',
    },
  }
  return messages[type]?.[status] || '任务正在处理。'
}

function updatePptJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function serializePptJob(job) {
  return {
    jobId: job.id,
    sessionId: job.sessionId,
    type: job.type,
    status: job.status,
    message: job.message,
    error: job.error,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function getSessionAiProvider(session, requestedProviderId) {
  const normalizedRequested = normalizeAiProviderId(requestedProviderId)
  const sessionProviderId = session.aiProviderId || DEFAULT_AI_PROVIDER
  if (requestedProviderId && normalizedRequested !== sessionProviderId) {
    throw new Error('当前材料已经锁定使用另一种 AI 模型，请回到首页重新上传后再切换模型。')
  }
  return getAiProvider(sessionProviderId)
}

function requireAccess(req, res, next) {
  if (!accessAuthEnabled || hasValidAccessCookie(req)) {
    next()
    return
  }
  res.status(401).json({ error: '请先输入访问密码。' })
}

function hasValidAccessCookie(req) {
  const cookies = parseCookies(req.headers.cookie || '')
  return safeEqual(cookies[accessCookieName] || '', buildAccessToken())
}

function buildAccessToken() {
  if (!accessAuthEnabled) return ''
  return createHmac('sha256', accessPassword).update('moonwalk-access-v1').digest('hex')
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        if (index === -1) return [part, '']
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))]
      }),
  )
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function normalizeSettings(body) {
  const sessionId = String(body.sessionId || '')
  const questionCount = Number(body.questionCount)
  const difficulty = String(body.difficulty || '')
  const selectedKeyPointIds = Array.isArray(body.selectedKeyPointIds)
    ? body.selectedKeyPointIds.map(String)
    : []

  if (!sessionId) throw new Error('缺少材料会话。')
  if (!QUESTION_COUNTS.includes(questionCount)) {
    throw new Error('题目数量只能选择 5、10、15、20 或 30。')
  }
  if (!DIFFICULTIES.includes(difficulty)) {
    throw new Error('难度只能选择简单、中等或困难。')
  }
  if (selectedKeyPointIds.length === 0) {
    throw new Error('请至少选择一个知识点。')
  }

  return {
    sessionId,
    aiProvider: normalizeAiProviderId(body.aiProvider),
    questionCount,
    difficulty,
    focusOnly: Boolean(body.focusOnly),
    chapterBased: Boolean(body.chapterBased),
    selectedKeyPointIds,
  }
}

function normalizeOpenQuestionSettings(body) {
  const sessionId = String(body.sessionId || '')
  const questionCount = Number(body.questionCount)
  const writingGoal = String(body.writingGoal || '').trim()
  const selectedSectionIndexes = Array.isArray(body.selectedSectionIndexes)
    ? body.selectedSectionIndexes.map((item) => Number(item)).filter(Number.isInteger)
    : []

  if (!sessionId) throw new Error('缺少材料会话。')
  if (!Number.isInteger(questionCount) || questionCount < OPEN_QUESTION_MIN || questionCount > OPEN_QUESTION_MAX) {
    throw new Error(`开放式问题数量必须在 ${OPEN_QUESTION_MIN} 到 ${OPEN_QUESTION_MAX} 个之间。`)
  }

  return {
    sessionId,
    aiProvider: normalizeAiProviderId(body.aiProvider),
    questionCount,
    writingGoal,
    selectedSectionIndexes,
  }
}

function normalizeOpenFeedbackSettings(body) {
  const sessionId = String(body.sessionId || '')
  const aiProvider = normalizeAiProviderId(body.aiProvider)
  const answers = body.answers && typeof body.answers === 'object'
    ? Object.fromEntries(
        Object.entries(body.answers).map(([key, value]) => [String(key), String(value || '').trim()]),
      )
    : {}
  const feedbackContext = normalizeFeedbackContext(body.feedbackContext)

  if (!sessionId) throw new Error('缺少材料会话。')
  return { sessionId, aiProvider, answers, feedbackContext }
}

function normalizePptGenerationSettings(body) {
  const sessionId = String(body.sessionId || '')
  const aiProvider = normalizeAiProviderId(body.aiProvider)
  const mainTemplateId = String(body.mainTemplateId || '')
  const mode = String(body.mode || '')
  const pptType = String(body.pptType || '')
  const slideCount = Number(body.slideCount)
  const contentText = normalizeLongText(body.contentText, 40000)
  const requirements = normalizeLongText(body.requirements, 12000)
  const masterDescription = normalizeLongText(body.masterDescription, 12000)

  if (!sessionId) throw new Error('缺少 PPT 生成会话。')
  if (!mainTemplateId) throw new Error('请先选择 1 个主模板。')
  if (!PPT_MODES.includes(mode)) throw new Error('PPT 生成模式无效。')
  if (!PPT_TYPES.includes(pptType)) throw new Error('PPT 类型无效。')
  if (!Number.isInteger(slideCount) || slideCount < PPT_MIN_SLIDES || slideCount > PPT_MAX_SLIDES) {
    throw new Error(`PPT 页数必须在 ${PPT_MIN_SLIDES} 到 ${PPT_MAX_SLIDES} 页之间。`)
  }

  return {
    sessionId,
    aiProvider,
    mainTemplateId,
    mode,
    pptType,
    slideCount,
    contentText,
    requirements,
    masterDescription,
  }
}

function normalizePptRevisionSettings(body) {
  const sessionId = String(body.sessionId || '')
  const aiProvider = normalizeAiProviderId(body.aiProvider)
  const slideComments = Array.isArray(body.slideComments)
    ? body.slideComments.map((item, index) => ({
        slideNumber: Number(item?.slideNumber) || index + 1,
        comment: String(item?.comment || '').trim(),
      })).filter((item) => item.comment)
    : []

  if (!sessionId) throw new Error('缺少 PPT 生成会话。')
  if (!slideComments.length) throw new Error('请至少填写 1 条具体修改意见。')
  return { sessionId, aiProvider, slideComments }
}

function applyPptSettings(session, settings) {
  const mainTemplate = session.templates.find((template) => template.id === settings.mainTemplateId)
  if (!mainTemplate) {
    throw new Error('选择的主模板不存在，请重新选择。')
  }
  session.mainTemplateId = settings.mainTemplateId
  session.mode = settings.mode
  session.pptType = settings.pptType
  session.slideCount = settings.slideCount
  session.contentText = settings.contentText
  session.requirements = settings.requirements
  session.masterDescription = settings.masterDescription
  session.templates = session.templates.map((template) => ({
    ...template,
    role: template.id === settings.mainTemplateId ? 'main' : 'auxiliary',
  }))
}

function buildPptAiContext(session) {
  const mainTemplate = session.templates.find((template) => template.id === session.mainTemplateId) || session.templates[0]
  const auxiliaryTemplates = session.templates.filter((template) => template.id !== mainTemplate?.id)
  return {
    fallbackTitle: mainTemplate?.originalName || 'Moonwalk PPT',
    pptType: session.pptType,
    mode: session.mode,
    slideCount: session.slideCount,
    mainTemplateName: mainTemplate?.originalName || '未命名模板',
    auxiliaryTemplateNames: auxiliaryTemplates.map((template) => template.originalName),
    contentText: session.contentText,
    contentFileText: session.contentFileText,
    requirements: session.requirements,
    master: buildMasterContext(session.master, session.masterDescription),
    templates: buildTemplateContext(session.templates),
  }
}

async function generatePptSessionOutput(session, aiProvider, update = () => {}) {
  const mainTemplate = session.templates.find((template) => template.id === session.mainTemplateId) || session.templates[0]
  const canUseTemplateFill = mainTemplate?.extension === '.pptx' && !session.master
  if (canUseTemplateFill && typeof aiProvider.module.generatePptTemplateFillPlan === 'function') {
    try {
      update('正在尝试使用模板填充引擎复用原 PPT 结构。')
      await renderTemplateFillSessionOutput(session, aiProvider, mainTemplate, update)
      return
    } catch (error) {
      console.warn(`PPT Master template-fill 失败，回退到原生成器：${toUserError(error)}`)
      session.templateFillFallbackReason = toUserError(error)
      update('模板填充不够稳定，正在切换到普通生成引擎。')
    }
  }

  update('正在让 AI 规划每页标题、层级和内容结构。')
  const plan = await aiProvider.module.generatePptPlan(buildPptAiContext(session))
  update('AI 已返回页面方案，正在生成 PPTX。')
  await renderPptSessionOutput(session, plan, { engine: 'fallback', update })
}

async function renderTemplateFillSessionOutput(session, aiProvider, mainTemplate, update = () => {}) {
  const versionId = nanoid(8)
  const outputDir = path.join(session.sessionDir, 'outputs', versionId)
  const analysisDir = path.join(outputDir, 'template-fill')
  const previewDir = path.join(outputDir, 'preview')
  await mkdir(analysisDir, { recursive: true })
  const libraryPath = path.join(analysisDir, 'slide_library.json')
  const planPath = path.join(analysisDir, 'fill_plan.json')
  const checkPath = path.join(analysisDir, 'check_report.json')
  const pptxPath = path.join(outputDir, 'moonwalk-template-filled.pptx')

  update('正在读取模板中的页面、文本框和版式元素。')
  const library = await loadTemplateFillLibrary(mainTemplate, libraryPath)
  const templateFillLibrary = pruneSlideLibraryForAi(library)
  update('正在让 AI 生成逐页模板填充方案。')
  const fillPlan = await aiProvider.module.generatePptTemplateFillPlan({
    ...buildPptAiContext(session),
    templateFillLibrary,
    templateFillLibraryRaw: library,
  })
  const replacementCount = fillPlan.slides.reduce((total, slide) => total + slide.replacements.length, 0)
  if (replacementCount < Math.max(3, Math.ceil(session.slideCount * 1.5))) {
    throw new Error('模板填充计划有效替换内容太少，已回退到普通生成。')
  }
  await writeTemplateFillPlan(planPath, fillPlan)

  update('正在校验填充方案，避免无效占位和明显溢出。')
  const checkReport = await checkTemplateFillPlan(libraryPath, planPath, checkPath)
  const checkSummary = summarizeTemplateFillCheck(checkReport)
  if (checkSummary.error > 0) {
    throw new Error(`模板填充计划存在 ${checkSummary.error} 个错误，无法应用。`)
  }
  if (checkSummary.warn > Math.max(10, session.slideCount * 4)) {
    throw new Error(`模板填充计划有 ${checkSummary.warn} 个容量警告，已回退到普通生成。`)
  }

  update('正在应用填充方案生成 PPTX。')
  const rawGeneratedPptxPath = await applyTemplateFillPlan(mainTemplate.path, planPath, pptxPath)
  const generatedPptxPath = await normalizePptxForRendering(rawGeneratedPptxPath)
  const plan = templateFillPlanToPptPlan(fillPlan, mainTemplate.originalName || 'Moonwalk PPT')
  let pdfPath = null
  let previewPaths = []
  let previewSource = 'template-fill'
  let previewFallbackReason = ''
  try {
    update('正在把 PPTX 转换为预览图和 PDF。')
    const rendered = await renderDocumentToPreviews(generatedPptxPath, previewDir, { prefix: 'slide', dpi: 128 })
    pdfPath = rendered.pdfPath
    previewPaths = rendered.previewPaths
  } catch (error) {
    previewSource = 'fallback'
    previewFallbackReason = toUserError(error)
    console.warn(`PPT Master template-fill PPTX 预览转换失败，改用普通生成器生成预览：${previewFallbackReason}`)
    update('PPTX 已生成，预览转换失败，正在生成兜底预览。')
    const fallbackPreview = await renderFallbackPreviewForTemplateFill(session, plan, outputDir, mainTemplate)
    previewPaths = fallbackPreview.previewPaths
  }

  session.plan = plan
  session.output = {
    versionId,
    engine: 'template-fill',
    pptxPath: generatedPptxPath,
    pdfPath,
    previewPaths,
    previewSource,
    previewFallbackReason,
    generatedAt: new Date().toISOString(),
    templateFill: {
      checkSummary,
      libraryPath,
      planPath,
      checkPath,
    },
  }
}

async function loadTemplateFillLibrary(template, libraryPath) {
  const cacheKey = template?.cacheKey || `${template?.extension || 'pptx'}:${template?.size || 0}:${template?.originalName || ''}`
  const cached = pptTemplateFillLibraryCache.get(cacheKey)
  if (cached) {
    await writeFile(libraryPath, `${JSON.stringify(cached, null, 2)}\n`, 'utf8')
    return clonePlain(cached)
  }

  const library = await analyzeTemplateFillLibrary(template.path, libraryPath)
  rememberPptTemplateFillLibrary(cacheKey, library)
  return library
}

function rememberPptTemplateFillLibrary(key, library) {
  if (!key) return
  if (pptTemplateFillLibraryCache.has(key)) pptTemplateFillLibraryCache.delete(key)
  pptTemplateFillLibraryCache.set(key, clonePlain(library))
  while (pptTemplateFillLibraryCache.size > maxPptTemplateFillLibraryCacheEntries) {
    const oldestKey = pptTemplateFillLibraryCache.keys().next().value
    pptTemplateFillLibraryCache.delete(oldestKey)
  }
}

async function renderFallbackPreviewForTemplateFill(session, plan, outputDir, mainTemplate) {
  const fallbackDir = path.join(outputDir, 'preview-fallback')
  await mkdir(fallbackDir, { recursive: true })
  const fallbackPptxPath = path.join(fallbackDir, 'moonwalk-preview-fallback.pptx')
  await createPptxFromPlan({
    plan,
    outputPath: fallbackPptxPath,
    templateAssets: mainTemplate?.extension === '.pptx' ? mainTemplate.assets : [],
    settings: {
      mode: session.mode,
      pptType: session.pptType,
      master: null,
    },
  })
  const rendered = await renderDocumentToPreviews(fallbackPptxPath, fallbackDir, { prefix: 'slide', dpi: 128 })
  return {
    pdfPath: rendered.pdfPath,
    previewPaths: rendered.previewPaths,
  }
}

async function renderPptSessionOutput(session, plan, options = {}) {
  const versionId = nanoid(8)
  const outputDir = path.join(session.sessionDir, 'outputs', versionId)
  await mkdir(outputDir, { recursive: true })
  const pptxPath = path.join(outputDir, 'moonwalk-generated.pptx')
  const previewDir = path.join(outputDir, 'preview')
  const mainTemplate = session.templates.find((template) => template.id === session.mainTemplateId) || session.templates[0]
  const templateAssets = mainTemplate?.extension === '.pptx' ? mainTemplate.assets : []

  options.update?.('正在写入 PPTX 文件。')
  await createPptxFromPlan({
    plan,
    outputPath: pptxPath,
    templateAssets,
    settings: {
      mode: session.mode,
      pptType: session.pptType,
      master: session.master
        ? {
            previewPaths: session.master.previewPaths,
            slideRoles: session.master.slideRoles,
          }
        : null,
    },
  })

  let pdfPath = null
  let previewPaths = []
  try {
    options.update?.('正在把 PPTX 转换为预览图和 PDF。')
    const rendered = await renderDocumentToPreviews(pptxPath, previewDir, { prefix: 'slide', dpi: 128 })
    pdfPath = rendered.pdfPath
    previewPaths = rendered.previewPaths
  } catch (error) {
    throw new Error(`PPTX 已生成，但预览转换失败：${toUserError(error)}`)
  }

  session.plan = plan
  session.output = {
    versionId,
    engine: options.engine || 'fallback',
    pptxPath,
    pdfPath,
    previewPaths,
    generatedAt: new Date().toISOString(),
  }
}

function serializePptSession(session) {
  return {
    sessionId: session.id,
    aiProvider: session.aiProviderId,
    selectedMainTemplateId: session.mainTemplateId,
    mode: session.mode,
    pptType: session.pptType,
    slideCount: session.slideCount,
    contentFileInfo: session.contentFileInfo,
    masterDescription: session.masterDescription,
    cacheSummary: session.cacheSummary || null,
    master: session.master
      ? {
          originalName: session.master.originalName,
          extension: session.master.extension,
          size: session.master.size,
          slideCount: session.master.slideCount,
          detectedColors: session.master.detectedColors,
          imageCount: session.master.assets.length,
          slideRoles: session.master.slideRoles,
          previewUrls: session.master.previewPaths.map((filePath) => toUploadFileUrl(filePath)),
        }
      : null,
    templates: session.templates.map((template) => ({
      id: template.id,
      originalName: template.originalName,
      extension: template.extension,
      size: template.size,
      pageCount: template.pageCount,
      slideCount: template.slideCount,
      role: template.role,
      textSample: template.textSample,
      detectedColors: template.detectedColors,
      imageCount: template.assets.length,
      previewUrls: template.previewPaths.map((filePath) => toUploadFileUrl(filePath)),
    })),
    plan: session.plan,
    output: session.output
      ? {
          generatedAt: session.output.generatedAt,
          engine: session.output.engine || 'fallback',
          previewSource: session.output.previewSource || session.output.engine || 'fallback',
          previewFallbackReason: session.output.previewFallbackReason || '',
          previewUrls: session.output.previewPaths.map((filePath) => toUploadFileUrl(filePath)),
          pptxDownloadUrl: `/api/ppt/${session.id}/download/pptx`,
          pdfDownloadUrl: session.output.pdfPath ? `/api/ppt/${session.id}/download/pdf` : null,
          templateFill: session.output.templateFill
            ? {
                checkSummary: session.output.templateFill.checkSummary,
              }
            : null,
        }
      : null,
  }
}

function toUploadFileUrl(filePath) {
  const relative = path.relative(uploadRoot, filePath)
  const segments = relative.split(path.sep).map((segment) => encodeURIComponent(segment))
  return `/api/ppt-files/${segments.join('/')}`
}

async function cleanupUploadedFiles(files) {
  const allFiles = Object.values(files || {}).flat().filter(Boolean)
  await Promise.all(allFiles.map((file) => rm(file.path, { force: true }).catch(() => {})))
}

function normalizeLongText(value, maxLength) {
  const text = String(value || '').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（内容已截断）` : text
}

function safeDownloadName(value) {
  return String(value || 'moonwalk')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80)
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value))
}

function validateSelectedSections(session, selectedSectionIndexes) {
  const sectionCount = session.summary.sections.length
  if (sectionCount === 0) return
  if (selectedSectionIndexes.length === 0) {
    throw new Error('请至少选择一个追问范围。')
  }
  const invalid = selectedSectionIndexes.some((index) => index < 0 || index >= sectionCount)
  if (invalid) {
    throw new Error('追问范围无效，请重新选择。')
  }
}

function buildFeedbackContext(session, settings, aiProvider) {
  return {
    aiProvider,
    fileInfo: session.fileInfo,
    prepared: session.prepared,
    summary: session.summary,
    writingGoal: settings.writingGoal,
    questionSet: null,
  }
}

function normalizeFeedbackContext(value) {
  if (!value || typeof value !== 'object') return null
  const questionSet = value.questionSet && typeof value.questionSet === 'object' ? value.questionSet : null
  const questions = Array.isArray(questionSet?.questions) ? questionSet.questions : []
  const prepared = value.prepared && typeof value.prepared === 'object' ? value.prepared : null
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : null
  const fileInfo = value.fileInfo && typeof value.fileInfo === 'object' ? value.fileInfo : null
  if (!questions.length || !prepared?.textContext || !summary || !fileInfo) return null

  return {
    fileInfo: {
      originalName: String(fileInfo.originalName || '未命名材料'),
      extension: String(fileInfo.extension || ''),
      size: Number(fileInfo.size) || 0,
      pageCount: fileInfo.pageCount === null ? null : Number(fileInfo.pageCount) || null,
      slideCount: fileInfo.slideCount === null ? null : Number(fileInfo.slideCount) || null,
    },
    aiProvider: normalizeAiProviderId(value.aiProvider),
    prepared: {
      textContext: String(prepared.textContext || ''),
      processingNotes: Array.isArray(prepared.processingNotes)
        ? prepared.processingNotes.map(String)
        : [],
    },
    summary,
    writingGoal: String(value.writingGoal || ''),
    questionSet: {
      materialType: String(questionSet.materialType || '未识别材料类型'),
      writingGoal: String(questionSet.writingGoal || value.writingGoal || ''),
      questions,
    },
  }
}

function toUserError(error) {
  if (error instanceof Error) return error.message
  return '处理失败，请稍后重试。'
}
