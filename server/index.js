import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  adaptTemplateFillPlanToCapacity,
  analyzeTemplateFillLibrary,
  applyTemplateFillPlan,
  buildStructuredSourceDeck,
  buildTemplatePageProfiles,
  checkTemplateFillPlan,
  embedGeneratedImagesInPptx,
  normalizePptxForRendering,
  pruneSlideLibraryForAi,
  summarizeTemplateFillCheck,
  templateFillPlanToPptPlan,
  writeTemplateFillPlan,
} from './pptTemplateFill.js'
import { createStructuredFallbackRolePptx } from './structuredFallbackPptx.js'
import {
  analyzeMasterFile,
  analyzeStructuredMasterFiles,
  analyzeTemplateFiles,
  buildMasterContext,
  buildStructuredMasterContext,
  buildTemplateContext,
  configurePptTemplateCache,
  extractContentFileText,
  hasStructuredMasters,
  serializeStructuredMasters,
  STRUCTURED_MASTER_ROLES,
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
import {
  buildDocumentVisualContext,
  combineVisualContexts,
  publicVisualContext,
  visualContextFromPreviewPaths,
} from './visualContext.js'

const app = express()
const port = Number(process.env.PORT || 5174)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../dist')
const uploadRoot = await mkdtemp(path.join(os.tmpdir(), 'material-quiz-uploads-'))
const pptCacheRoot = process.env.PPT_CACHE_DIR || path.join(os.tmpdir(), 'moonwalk-ppt-cache')
const sessions = new Map()
const pptSessions = new Map()
const pptJobs = new Map()
const pptTemplateFillLibraryCache = new Map()
const maxPptTemplateFillLibraryCacheEntries = 20
const maxPptTemplateFillLibraryDiskEntries = 80
const pptCacheTtlMs = Number(process.env.PPT_CACHE_TTL_MS || 6 * 60 * 60 * 1000)
const configuredGeneratedPptImageLimit = Number(process.env.PPT_MAX_GENERATED_IMAGES || 5)
const maxGeneratedPptImages = Number.isFinite(configuredGeneratedPptImageLimit)
  ? Math.max(0, Math.min(5, configuredGeneratedPptImageLimit))
  : 5
const accessPassword = String(process.env.ACCESS_PASSWORD || '').trim()
const accessAuthEnabled = Boolean(accessPassword)
const accessCookieName = 'moonwalk_access'

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: MAX_FILE_SIZE },
})

let pptRenderingStatusCache = null

await configurePptTemplateCache(pptCacheRoot)
await mkdir(getPptTemplateFillLibraryDiskRoot(), { recursive: true })
await cleanupPptTemplateFillLibraryDiskCache().catch((error) => {
  console.warn(`PPT 填充版式库临时缓存清理失败：${error.message}`)
})

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
    const allowSparseText = aiProvider.id === 'openai'
    const prepared = await prepareDocumentForAi(file.path, originalName, extension, { allowSparseText })
    if (aiProvider.id === 'openai') {
      const visualContext = await buildDocumentVisualContext({
        inputPath: file.path,
        extension,
        outputDir: path.join(uploadRoot, `material-visual-${nanoid(8)}`),
        label: originalName,
        kind: 'material',
        maxPages: 4,
      })
      prepared.visualContext = visualContext
      prepared.processingNotes.push(...visualContext.notes)
    }
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
  { name: 'masterCover', maxCount: 1 },
  { name: 'masterAgenda', maxCount: 1 },
  { name: 'masterSection', maxCount: 1 },
  { name: 'masterContent', maxCount: 1 },
  { name: 'masterEnding', maxCount: 1 },
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
    runPptJob(job, async ({ update, assertNotCancelled }) => {
      try {
        return await analyzePptUploadSession({
          aiProvider,
          files,
          body: req.body,
          sessionId,
          sessionDir,
          update,
          assertNotCancelled,
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
    runPptJob(job, async ({ update, assertNotCancelled }) => {
      update('正在整理内容、需求和模板规则。')
      await generatePptSessionOutput(session, aiProvider, update, assertNotCancelled)
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

app.post('/api/ppt/jobs/:jobId/cancel', (req, res) => {
  try {
    const job = getPptJob(req.params.jobId)
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      res.json(serializePptJob(job))
      return
    }
    updatePptJob(job, {
      status: 'cancelled',
      cancelled: true,
      message: '任务已取消。',
      error: '任务已取消。',
    })
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
    runPptJob(job, async ({ update, assertNotCancelled }) => {
      update('正在读取每页修改意见。')
      const plan = await revisePptSessionPlan(session, aiProvider, settings.slideComments, update, assertNotCancelled)
      update('局部修改已合并，正在重新渲染 PPT。')
      await renderRevisedPptSessionOutput(session, aiProvider, plan, settings.slideComments, update, assertNotCancelled)
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

async function analyzePptUploadSession({ aiProvider, files, body, sessionId, sessionDir, update, assertNotCancelled = () => {} }) {
  const templateFiles = Array.isArray(files.templates) ? files.templates : []
  const contentFile = Array.isArray(files.contentFile) ? files.contentFile[0] : null
  const masterFile = Array.isArray(files.master) ? files.master[0] : null

  assertNotCancelled()
  update('正在分析模板文件并生成预览。')
  const templates = await analyzeTemplateFiles(templateFiles, sessionDir)
  const cachedTemplateCount = templates.filter((template) => template.cacheHit).length

  assertNotCancelled()
  update(contentFile ? '正在读取 PPT 内容文件。' : '正在整理 PPT 文本内容。')
  const contentFileResult = await extractContentFileText(contentFile, {
    allowSparseText: aiProvider.id === 'openai',
  })

  assertNotCancelled()
  const structuredMasterFiles = STRUCTURED_MASTER_ROLES.filter((role) => Array.isArray(files?.[role.field]) && files[role.field][0])
  update(structuredMasterFiles.length
    ? `正在识别 ${structuredMasterFiles.length} 个角色母版。`
    : masterFile
      ? '正在识别幻灯片母版结构。'
      : '正在整理模板生成设置。')
  const structuredMasters = await analyzeStructuredMasterFiles(files, sessionDir)
  const usesStructuredMasters = hasStructuredMasters(structuredMasters)
  const master = usesStructuredMasters ? null : await analyzeMasterFile(masterFile, sessionDir)
  const contentVisualContext = aiProvider.id === 'openai' && contentFile && contentFileResult.fileInfo
    ? await buildDocumentVisualContext({
        inputPath: contentFile.path,
        extension: contentFileResult.fileInfo.extension,
        outputDir: path.join(sessionDir, 'content-visual'),
        label: contentFileResult.fileInfo.originalName,
        kind: 'ppt-content',
        maxPages: 4,
      })
    : null

  assertNotCancelled()
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
    structuredMasters,
    masterDescription: normalizeLongText(body?.masterDescription, 12000),
    mode: null,
    pptType: null,
    slideCount: null,
    contentSlideCount: null,
    structuredPagePlan: null,
    structuredTemplateFillSource: null,
    structuredFallbackRoleSources: null,
    structuredRoleSources: null,
    mainTemplateId: templates[0]?.id || null,
    plan: null,
    narrativePlan: null,
    templateFillPlan: null,
    templateDiagnostics: null,
    output: null,
    qualityCheck: null,
    revisionSummary: null,
    contentVisualContext,
    cacheSummary: {
      templateHits: cachedTemplateCount,
      templateTotal: templates.length,
      contentHit: Boolean(contentFileResult.cacheHit),
      masterHit: Boolean(master?.cacheHit || Object.values(structuredMasters).some((item) => item?.cacheHit)),
      structuredMasterHits: Object.values(structuredMasters).filter((item) => item?.cacheHit).length,
      structuredMasterTotal: Object.keys(structuredMasters).length,
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
    cancelled: false,
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
      assertPptJobNotCancelled(job)
      updatePptJob(job, { status: 'running', message: getPptJobMessage(job.type, 'running') })
      const update = (message) => {
        assertPptJobNotCancelled(job)
        updatePptJob(job, { status: 'running', message })
      }
      const result = await handler({ update, isCancelled: () => job.cancelled, assertNotCancelled: () => assertPptJobNotCancelled(job) })
      assertPptJobNotCancelled(job)
      updatePptJob(job, {
        status: 'completed',
        message: getPptJobMessage(job.type, 'completed'),
        result,
      })
    } catch (error) {
      if (isPptJobCancelledError(error) || job.cancelled) {
        updatePptJob(job, {
          status: 'cancelled',
          cancelled: true,
          message: '任务已取消。',
          error: '任务已取消。',
        })
        return
      }
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
    cancelled: {
      queued: '任务已取消。',
      running: '任务已取消。',
      completed: '任务已取消。',
      failed: '任务已取消。',
    },
  }
  return messages[type]?.[status] || '任务正在处理。'
}

function updatePptJob(job, patch) {
  if (job.status === 'cancelled' && patch.status !== 'cancelled') return
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function assertPptJobNotCancelled(job) {
  if (job.cancelled || job.status === 'cancelled') {
    throw new PptJobCancelledError()
  }
}

function isPptJobCancelledError(error) {
  return error instanceof PptJobCancelledError || error?.name === 'PptJobCancelledError'
}

class PptJobCancelledError extends Error {
  constructor() {
    super('任务已取消。')
    this.name = 'PptJobCancelledError'
  }
}

function serializePptJob(job) {
  return {
    jobId: job.id,
    sessionId: job.sessionId,
    type: job.type,
    status: job.status,
    cancelled: Boolean(job.cancelled),
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
    throw new Error(`PPT 内容页数必须在 ${PPT_MIN_SLIDES} 到 ${PPT_MAX_SLIDES} 页之间。`)
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
  session.contentSlideCount = settings.slideCount
  session.structuredPagePlan = buildStructuredPagePlan(settings.slideCount)
  session.slideCount = session.structuredPagePlan?.totalSlides || settings.slideCount
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
  const visualContext = session.aiProviderId === 'openai' ? buildPptSessionVisualContext(session) : null
  return {
    fallbackTitle: mainTemplate?.originalName || 'Moonwalk PPT',
    pptType: session.pptType,
    mode: session.mode,
    slideCount: session.slideCount,
    contentSlideCount: session.contentSlideCount || session.slideCount,
    mainTemplateName: mainTemplate?.originalName || '未命名模板',
    auxiliaryTemplateNames: auxiliaryTemplates.map((template) => template.originalName),
    contentText: session.contentText,
    contentFileText: session.contentFileText,
    requirements: session.requirements,
    master: buildMasterContext(session.master, session.masterDescription),
    structuredMasters: buildStructuredMasterContext(session.structuredMasters, session.masterDescription, {
      force: Boolean(session.structuredPagePlan),
      roleSources: session.structuredRoleSources,
    }),
    structuredPagePlan: session.structuredPagePlan || null,
    templates: buildTemplateContext(session.templates),
    visualContext,
    imageGenerationEnabled: session.aiProviderId === 'openai',
    maxGeneratedImages: maxGeneratedPptImages,
  }
}

async function generatePptSessionOutput(session, aiProvider, update = () => {}, assertNotCancelled = () => {}) {
  assertNotCancelled()
  const mainTemplate = session.templates.find((template) => template.id === session.mainTemplateId) || session.templates[0]
  const templateFillSource = await getTemplateFillSource(session, mainTemplate, update)
  session.narrativePlan = null
  session.templateDiagnostics = null
  if (templateFillSource && typeof aiProvider.module.generatePptTemplateFillPlan === 'function') {
    try {
      assertNotCancelled()
      update(templateFillSource.role === 'master'
        ? '正在直接编辑母版 PPTX 中的原始文本框。'
        : templateFillSource.role === 'structured-master'
          ? '正在按五类母版固定页型直接编辑 PPTX。'
          : '正在尝试使用模板填充引擎复用原 PPT 结构。')
      await renderTemplateFillSessionOutput(session, aiProvider, templateFillSource.template, update, {
        sourceRole: templateFillSource.role,
        structured: Boolean(templateFillSource.structured),
      }, assertNotCancelled)
      assertNotCancelled()
      await runPptQualityCheck(session, aiProvider, update, assertNotCancelled)
      return
    } catch (error) {
      if (isPptJobCancelledError(error)) throw error
      if (templateFillSource.role === 'master') {
        throw new Error(`母版直接编辑失败：${toUserError(error)}。请确认母版 PPTX 中包含可编辑文本框，而不是整页截图。`)
      }
      if (templateFillSource.role === 'structured-master' && hasUploadedStructuredMasters(session)) {
        throw new Error(`五类母版直接编辑失败：${toUserError(error)}。请确认上传的母版是可编辑单页 PPTX，而不是整页截图。`)
      }
      console.warn(`PPT Master template-fill 失败，回退到原生成器：${toUserError(error)}`)
      session.templateFillFallbackReason = toUserError(error)
      update('模板填充不够稳定，正在切换到普通生成引擎。')
    }
  }

  assertNotCancelled()
  if (typeof aiProvider.module.generatePptNarrativePlan === 'function' && !session.narrativePlan) {
    update('正在先理解内容，生成 PPT 叙事大纲和页面策略。')
    session.narrativePlan = await aiProvider.module.generatePptNarrativePlan(buildPptAiContext(session))
    assertNotCancelled()
  }
  update('正在让 AI 规划每页标题、层级和内容结构。')
  const plan = await aiProvider.module.generatePptPlan({
    ...buildPptAiContext(session),
    narrativePlan: session.narrativePlan,
  })
  assertNotCancelled()
  update('AI 已返回页面方案，正在生成 PPTX。')
  await renderPptSessionOutput(session, plan, { engine: 'fallback', update, assertNotCancelled })
  assertNotCancelled()
  await runPptQualityCheck(session, aiProvider, update, assertNotCancelled)
}

async function revisePptSessionPlan(session, aiProvider, slideComments, update = () => {}, assertNotCancelled = () => {}) {
  const context = {
    ...buildPptAiContext(session),
    currentPlan: session.plan,
    slideComments,
    targetSlides: slideComments.map((item) => ({
      slideNumber: item.slideNumber,
      comment: item.comment,
      currentSlide: session.plan?.slides?.[item.slideNumber - 1] || null,
    })),
  }
  if (typeof aiProvider.module.revisePptPlanPartial === 'function') {
    assertNotCancelled()
    update(`正在局部修改 ${slideComments.length} 页，其余页面保持不变。`)
    const plan = await aiProvider.module.revisePptPlanPartial(context)
    assertNotCancelled()
    session.revisionSummary = {
      mode: 'partial',
      revisedSlides: slideComments.map((item) => item.slideNumber),
      commentCount: slideComments.length,
      updatedAt: new Date().toISOString(),
    }
    return plan
  }

  assertNotCancelled()
  update('当前模型暂不支持局部修改，正在使用整套修改方案。')
  const plan = await aiProvider.module.revisePptPlan(context)
  assertNotCancelled()
  session.revisionSummary = {
    mode: 'full',
    revisedSlides: slideComments.map((item) => item.slideNumber),
    commentCount: slideComments.length,
    updatedAt: new Date().toISOString(),
  }
  return plan
}

async function renderRevisedPptSessionOutput(session, aiProvider, plan, slideComments, update = () => {}, assertNotCancelled = () => {}) {
  const mainTemplate = session.templates.find((template) => template.id === session.mainTemplateId) || session.templates[0]
  const templateFillSource = await getTemplateFillSource(session, mainTemplate, update)
  const canUseTemplateFillRevision = session.output?.engine === 'template-fill'
    && session.templateFillPlan
    && templateFillSource
    && typeof aiProvider.module.generatePptTemplateFillPlan === 'function'

  if (canUseTemplateFillRevision) {
    try {
      assertNotCancelled()
      update(templateFillSource.role === 'master'
        ? '正在沿用母版直接编辑，只更新有修改意见的页面。'
        : templateFillSource.role === 'structured-master'
          ? '正在沿用五类母版直接编辑，只更新有修改意见的页面。'
          : '正在沿用模板填充引擎，只更新有修改意见的页面。')
      await renderTemplateFillSessionOutput(session, aiProvider, templateFillSource.template, update, {
        baseFillPlan: session.templateFillPlan,
        targetSlideNumbers: slideComments.map((item) => item.slideNumber),
        planOverride: plan,
        sourceRole: templateFillSource.role,
        structured: Boolean(templateFillSource.structured),
      }, assertNotCancelled)
      assertNotCancelled()
      await runPptQualityCheck(session, aiProvider, update, assertNotCancelled)
      return
    } catch (error) {
      if (isPptJobCancelledError(error)) throw error
      if (templateFillSource.role === 'master') {
        throw new Error(`母版直接修改失败：${toUserError(error)}。请确认母版 PPTX 中包含可编辑文本框。`)
      }
      if (templateFillSource.role === 'structured-master' && hasUploadedStructuredMasters(session)) {
        throw new Error(`五类母版直接修改失败：${toUserError(error)}。请确认上传的角色母版是可编辑单页 PPTX。`)
      }
      console.warn(`PPT 局部模板填充修改失败，回退到普通渲染：${toUserError(error)}`)
      update('模板填充局部修改不够稳定，正在回退到普通渲染。')
    }
  }

  await renderPptSessionOutput(session, plan, { engine: 'fallback', update, assertNotCancelled })
  assertNotCancelled()
  await runPptQualityCheck(session, aiProvider, update, assertNotCancelled)
}

async function renderTemplateFillSessionOutput(session, aiProvider, mainTemplate, update = () => {}, options = {}, assertNotCancelled = () => {}) {
  const versionId = nanoid(8)
  const outputDir = path.join(session.sessionDir, 'outputs', versionId)
  const analysisDir = path.join(outputDir, 'template-fill')
  const previewDir = path.join(outputDir, 'preview')
  await mkdir(analysisDir, { recursive: true })
  const libraryPath = path.join(analysisDir, 'slide_library.json')
  const planPath = path.join(analysisDir, 'fill_plan.json')
  const checkPath = path.join(analysisDir, 'check_report.json')
  const pptxPath = path.join(outputDir, 'moonwalk-template-filled.pptx')

  assertNotCancelled()
  update('正在读取模板中的页面、文本框和版式元素。')
  const { library, cacheHit: templateFillLibraryCacheHit } = await loadTemplateFillLibrary(mainTemplate, libraryPath)
  assertNotCancelled()
  const templateFillLibrary = pruneSlideLibraryForAi(library)
  const templatePageProfiles = buildTemplatePageProfiles(library)
  const aiContext = buildPptAiContext(session)
  const templateFillContext = {
    ...aiContext,
    fallbackTitle: mainTemplate.originalName || aiContext.fallbackTitle,
    templateFillSourceName: mainTemplate.originalName || '',
    templateFillSourceRole: options.sourceRole || 'template',
    structuredPagePlan: options.structured ? session.structuredPagePlan : null,
  }
  let fillPlan = options.baseFillPlan ? clonePlain(options.baseFillPlan) : null
  if (fillPlan && options.planOverride) {
    fillPlan = mergeTemplateFillPlanWithPptPlan(fillPlan, options.planOverride, options.targetSlideNumbers)
  } else {
    if (typeof aiProvider.module.generatePptNarrativePlan === 'function') {
      update('正在先理解内容，生成 PPT 叙事大纲和页面策略。')
      session.narrativePlan = await aiProvider.module.generatePptNarrativePlan({
        ...templateFillContext,
        templatePageProfiles,
      })
      assertNotCancelled()
    } else {
      session.narrativePlan = null
    }

    update('正在根据叙事大纲匹配模板页面并生成填充方案。')
    fillPlan = await aiProvider.module.generatePptTemplateFillPlan({
      ...templateFillContext,
      templateFillLibrary,
      templateFillLibraryRaw: library,
      templatePageProfiles,
      narrativePlan: session.narrativePlan,
    })
  }
  assertNotCancelled()
  if (options.structured) {
    fillPlan = alignStructuredFillPlan(fillPlan, library, session.structuredPagePlan, session.narrativePlan, session.aiProviderId)
  }
  let adapted = adaptTemplateFillPlanToCapacity(fillPlan, library, session.narrativePlan)
  fillPlan = adapted.plan
  session.templateDiagnostics = {
    phase: options.baseFillPlan ? 'revision' : 'initial',
    narrativePlanUsed: Boolean(session.narrativePlan),
    templatePageProfileCount: templatePageProfiles.length,
    capacity: adapted.diagnostics,
  }

  const minimumReplacements = options.structured
    ? Math.max(3, Math.ceil((session.contentSlideCount || session.slideCount) * 1.1))
    : Math.max(3, Math.ceil(session.slideCount * 1.5))
  if (countTemplateFillEdits(fillPlan) < minimumReplacements) {
    throw new Error('模板填充计划有效替换内容太少，已回退到普通生成。')
  }
  await writeTemplateFillPlan(planPath, fillPlan)

  assertNotCancelled()
  update('正在校验填充方案，避免无效占位和明显溢出。')
  let checkReport = await checkTemplateFillPlan(libraryPath, planPath, checkPath)
  let checkSummary = summarizeTemplateFillCheck(checkReport)
  let repairInfo = {
    attempted: false,
    initialCheckSummary: null,
    finalCheckSummary: null,
  }
  const shouldRepair = shouldRepairTemplateFillPlan(checkSummary, session)
  const canRepair = shouldRepair
    && !options.baseFillPlan
    && !options.planOverride
    && typeof aiProvider.module.generatePptTemplateFillPlan === 'function'
  if (canRepair) {
    repairInfo = {
      attempted: true,
      initialCheckSummary: checkSummary,
      finalCheckSummary: null,
    }
    assertNotCancelled()
    update('填充方案检查发现问题，正在自动修正一次。')
    fillPlan = await aiProvider.module.generatePptTemplateFillPlan({
      ...templateFillContext,
      templateFillLibrary,
      templateFillLibraryRaw: library,
      templatePageProfiles,
      narrativePlan: session.narrativePlan,
      repairMode: true,
      previousFillPlan: fillPlan,
      templateFillCheckSummary: checkSummary,
    })
    assertNotCancelled()
    if (options.structured) {
      fillPlan = alignStructuredFillPlan(fillPlan, library, session.structuredPagePlan, session.narrativePlan, session.aiProviderId)
    }
    adapted = adaptTemplateFillPlanToCapacity(fillPlan, library, session.narrativePlan)
    fillPlan = adapted.plan
    session.templateDiagnostics = {
      ...(session.templateDiagnostics || {}),
      repair: repairInfo,
      capacity: adapted.diagnostics,
    }
    if (countTemplateFillEdits(fillPlan) < minimumReplacements) {
      throw new Error('自动修正后的模板填充计划有效替换内容太少，已回退到普通生成。')
    }
    await writeTemplateFillPlan(planPath, fillPlan)
    assertNotCancelled()
    update('正在复核修正后的填充方案。')
    checkReport = await checkTemplateFillPlan(libraryPath, planPath, checkPath)
    checkSummary = summarizeTemplateFillCheck(checkReport)
    repairInfo = {
      ...repairInfo,
      finalCheckSummary: checkSummary,
    }
  }
  session.templateDiagnostics = {
    ...(session.templateDiagnostics || {}),
    repair: repairInfo,
    checkSummary,
  }
  if (checkSummary.error > 0) {
    throw new Error(`模板填充计划存在 ${checkSummary.error} 个错误，无法应用。`)
  }
  if (checkSummary.warn > Math.max(10, session.slideCount * 4)) {
    throw new Error(`模板填充计划有 ${checkSummary.warn} 个容量警告，已回退到普通生成。`)
  }

  assertNotCancelled()
  update('正在应用填充方案生成 PPTX。')
  const rawGeneratedPptxPath = await applyTemplateFillPlan(mainTemplate.path, planPath, pptxPath)
  const imageEnhancement = await maybeGeneratePptImages({
    session,
    aiProvider,
    fillPlan,
    pptxPath: rawGeneratedPptxPath,
    outputDir,
    update,
    assertNotCancelled,
  })
  const generatedPptxPath = await normalizePptxForRendering(imageEnhancement.pptxPath || rawGeneratedPptxPath)
  assertNotCancelled()
  session.templateDiagnostics = {
    ...(session.templateDiagnostics || {}),
    images: imageEnhancement.summary,
  }
  const plan = templateFillPlanToPptPlan(fillPlan, mainTemplate.originalName || 'Moonwalk PPT')
  let pdfPath = null
  let previewPaths = []
  let previewSource = 'template-fill'
  let previewFallbackReason = ''
  try {
    update('正在把 PPTX 转换为预览图和 PDF。')
    const rendered = await renderDocumentToPreviews(generatedPptxPath, previewDir, { prefix: 'slide', dpi: 128 })
    assertNotCancelled()
    pdfPath = rendered.pdfPath
    previewPaths = rendered.previewPaths
  } catch (error) {
    if (isPptJobCancelledError(error)) throw error
    previewSource = 'fallback'
    previewFallbackReason = toUserError(error)
    console.warn(`PPT Master template-fill PPTX 预览转换失败，改用普通生成器生成预览：${previewFallbackReason}`)
    update('PPTX 已生成，预览转换失败，正在生成兜底预览。')
    const fallbackPreview = await renderFallbackPreviewForTemplateFill(session, plan, outputDir, mainTemplate)
    assertNotCancelled()
    previewPaths = fallbackPreview.previewPaths
  }

  assertNotCancelled()
  session.plan = plan
  session.templateFillPlan = fillPlan
  session.cacheSummary = {
    ...(session.cacheSummary || {}),
    templateFillLibraryHit: templateFillLibraryCacheHit,
  }
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
      images: imageEnhancement.summary,
    },
  }
}

async function maybeGeneratePptImages({
  session,
  aiProvider,
  fillPlan,
  pptxPath,
  outputDir,
  update = () => {},
  assertNotCancelled = () => {},
}) {
  const summary = {
    enabled: false,
    provider: aiProvider?.id || session.aiProviderId || '',
    limit: maxGeneratedPptImages,
    requested: 0,
    attempted: 0,
    generated: 0,
    embedded: 0,
    failed: 0,
    status: 'skipped',
    skippedReason: '',
    failures: [],
  }

  if (session.aiProviderId !== 'openai' || aiProvider?.id !== 'openai') {
    summary.skippedReason = 'provider_not_openai'
    return { pptxPath, summary }
  }
  if (maxGeneratedPptImages <= 0) {
    summary.skippedReason = 'limit_zero'
    return { pptxPath, summary }
  }
  if (typeof aiProvider.module.generatePptImage !== 'function') {
    summary.skippedReason = 'provider_missing_image_generation'
    return { pptxPath, summary }
  }

  const requests = collectPptImageGenerationRequests(session, fillPlan, maxGeneratedPptImages)
  summary.requested = requests.length
  if (!requests.length) {
    summary.skippedReason = 'no_image_placeholders'
    return { pptxPath, summary }
  }

  summary.enabled = true
  summary.status = 'running'
  const imageDir = path.join(outputDir, 'generated-images')
  await mkdir(imageDir, { recursive: true })
  const placements = []

  update(`正在生成 PPT 真实配图（最多 ${maxGeneratedPptImages} 张）。`)
  for (const [index, request] of requests.entries()) {
    assertNotCancelled()
    summary.attempted += 1
    const outputPath = path.join(
      imageDir,
      `slide-${String(request.slideNumber).padStart(2, '0')}-image-${String(index + 1).padStart(2, '0')}.png`,
    )
    try {
      update(`正在生成第 ${index + 1}/${requests.length} 张 PPT 配图。`)
      await aiProvider.module.generatePptImage({
        prompt: request.prompt,
        outputPath,
      })
      placements.push({
        slideNumber: request.slideNumber,
        imagePath: outputPath,
        x: request.x,
        y: request.y,
        width: request.width,
        height: request.height,
      })
      summary.generated += 1
    } catch (error) {
      summary.failed += 1
      summary.failures.push({
        slideNumber: request.slideNumber,
        reason: trimInlineText(toUserError(error), 220),
      })
      console.warn(`第 ${request.slideNumber} 页 PPT 配图生成失败：${toUserError(error)}`)
    }
  }

  if (!placements.length) {
    summary.status = 'generation_failed'
    return { pptxPath, summary }
  }

  assertNotCancelled()
  const enhancedPptxPath = path.join(outputDir, 'moonwalk-template-filled-with-images.pptx')
  try {
    update('正在把真实配图嵌入 PPTX。')
    const outputPath = await embedGeneratedImagesInPptx(pptxPath, placements, enhancedPptxPath)
    summary.embedded = placements.length
    summary.status = summary.failed > 0 ? 'partial' : 'ready'
    return { pptxPath: outputPath, summary }
  } catch (error) {
    summary.status = 'embed_failed'
    summary.failures.push({
      slideNumber: null,
      reason: trimInlineText(toUserError(error), 260),
    })
    console.warn(`PPT 真实配图嵌入失败，继续使用未嵌图版本：${toUserError(error)}`)
    return { pptxPath, summary }
  }
}

function collectPptImageGenerationRequests(session, fillPlan, limit) {
  const requests = []
  const slides = Array.isArray(fillPlan?.slides) ? fillPlan.slides : []
  for (const [slideIndex, slide] of slides.entries()) {
    if (requests.length >= limit) break
    const extraShapes = Array.isArray(slide?.extra_shapes) ? slide.extra_shapes : []
    for (const [shapeIndex, shape] of extraShapes.entries()) {
      if (requests.length >= limit) break
      if (String(shape?.kind || '') !== 'image_placeholder') continue
      const imagePrompt = normalizePptImagePromptSeed(shape)
      if (!imagePrompt) continue
      requests.push({
        slideNumber: slideIndex + 1,
        shapeIndex,
        x: clampUnit(shape.x, 0.08),
        y: clampUnit(shape.y, 0.18),
        width: Math.max(0.02, clampUnit(shape.width, 0.32)),
        height: Math.max(0.02, clampUnit(shape.height, 0.16)),
        prompt: buildPptImageGenerationPrompt({
          session,
          slide,
          shape,
          slideNumber: slideIndex + 1,
          imagePrompt,
        }),
      })
    }
  }
  return requests
}

function normalizePptImagePromptSeed(shape) {
  const text = String(shape?.image_prompt || shape?.prompt || shape?.text || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (/^(图片占位|图片建议|image placeholder|image suggestion)$/i.test(text)) return ''
  return trimInlineText(text, 360)
}

function buildPptImageGenerationPrompt({ session, slide, shape, slideNumber, imagePrompt }) {
  const replacementTexts = Array.isArray(slide?.replacements)
    ? slide.replacements.map((replacement) => replacement?.text).filter(Boolean)
    : []
  return [
    `整套 PPT 标题：${trimInlineText(session.narrativePlan?.title || session.plan?.title || session.pptType || '中文演示文稿', 80)}`,
    `页面位置：第 ${slideNumber} 页，页面用途 ${slide?.purpose || slide?.layout || 'content'}。`,
    `页面已有文字：${trimInlineText(replacementTexts.join('；') || slide?.notes || '无', 320)}`,
    `用户制作需求：${trimInlineText(session.requirements || '保持模板风格，清晰、克制、适合中文演示。', 260)}`,
    `图片具体需求：${imagePrompt}`,
    `占位区域比例：x=${shape.x}，y=${shape.y}，width=${shape.width}，height=${shape.height}。`,
    '生成一张视觉辅助图片，风格要贴合模板和页面语气；不要包含可读文字、汉字、logo、水印、边框、截图界面或复杂表格。',
  ].join('\n')
}

function clampUnit(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(1, number))
}

async function getTemplateFillSource(session, mainTemplate, update = () => {}) {
  if (session.structuredPagePlan) {
    const template = await ensureStructuredTemplateFillSource(session, mainTemplate, update)
    return { template, role: 'structured-master', structured: true }
  }
  if (session.master?.extension === '.pptx') {
    return { template: session.master, role: 'master' }
  }
  if (mainTemplate?.extension === '.pptx') {
    return { template: mainTemplate, role: 'template' }
  }
  return null
}

async function ensureStructuredTemplateFillSource(session, mainTemplate, update = () => {}) {
  const cacheKey = buildStructuredSourceCacheKey(session, mainTemplate)
  if (session.structuredTemplateFillSource?.cacheKey === cacheKey && existsSync(session.structuredTemplateFillSource.path)) {
    return session.structuredTemplateFillSource
  }

  update('正在把已上传母版和缺失页型的可编辑页面合成为源 PPTX。')
  const outputDir = path.join(session.sessionDir, 'structured-source')
  const outputPath = path.join(outputDir, 'moonwalk-structured-source.pptx')
  const roleSources = {}
  for (const role of STRUCTURED_MASTER_ROLES) {
    const master = session.structuredMasters?.[role.key]
    if (master) {
      roleSources[role.key] = {
        source: 'uploaded-master',
        label: role.label,
        originalName: master.originalName,
        path: master.path,
        slide: 1,
      }
      continue
    }

    const templateSource = selectTemplateRoleSource(session, role)
    if (templateSource) {
      roleSources[role.key] = templateSource
      continue
    }

    const generated = await ensureStructuredFallbackRoleSource(session, role)
    roleSources[role.key] = {
      source: 'generated-fallback',
      label: role.label,
      originalName: generated.label,
      path: generated.path,
      slide: 1,
    }
  }
  const manifest = {
    sources: STRUCTURED_MASTER_ROLES.map((role) => {
      const source = roleSources[role.key]
      return {
        id: role.key,
        role: role.key,
        label: role.label,
        source: source.source,
        pptx: source.path,
        slide: source.slide,
      }
    }),
  }
  await buildStructuredSourceDeck(manifest, outputPath)
  session.structuredRoleSources = Object.fromEntries(
    Object.entries(roleSources).map(([roleKey, source]) => [roleKey, {
      source: source.source,
      label: source.label,
      originalName: source.originalName || '',
      templateName: source.templateName || '',
      slide: source.slide,
    }]),
  )

  const roleNames = STRUCTURED_MASTER_ROLES
    .filter((role) => roleSources[role.key]?.source === 'uploaded-master')
    .map((role) => role.label)
  const templateRoleNames = STRUCTURED_MASTER_ROLES
    .filter((role) => roleSources[role.key]?.source === 'template-fallback')
    .map((role) => role.label)
  const generatedRoleNames = STRUCTURED_MASTER_ROLES
    .filter((role) => roleSources[role.key]?.source === 'generated-fallback')
    .map((role) => role.label)
  session.structuredTemplateFillSource = {
    id: 'structured_masters',
    originalName: roleNames.length
      ? `五类母版组合源（上传：${roleNames.join('、')}；模板：${templateRoleNames.join('、') || '无'}；生成：${generatedRoleNames.join('、') || '无'}）`
      : `五类母版组合源（模板：${templateRoleNames.join('、') || '无'}；生成：${generatedRoleNames.join('、') || '无'}）`,
    extension: '.pptx',
    size: 0,
    path: outputPath,
    pageCount: null,
    slideCount: STRUCTURED_MASTER_ROLES.length,
    role: 'structured-master',
    textSample: '',
    detectedColors: mergeStructuredMasterColors(session.structuredMasters, mainTemplate),
    previewPaths: [],
    assets: [],
    slideTexts: [],
    cacheKey,
    cacheHit: false,
    generatedFallbackRoles: generatedRoleNames,
  }
  return session.structuredTemplateFillSource
}

async function ensureStructuredFallbackRoleSource(session, role) {
  const cacheKey = buildStructuredFallbackRoleCacheKey(session, role)
  const cached = session.structuredFallbackRoleSources?.[role.key]
  if (cached?.cacheKey === cacheKey && existsSync(cached.path)) return cached

  const outputDir = path.join(session.sessionDir, 'structured-source', 'fallback-roles')
  const outputPath = path.join(outputDir, `${role.key}.pptx`)
  await createStructuredFallbackRolePptx({
    roleKey: role.key,
    outputPath,
    templates: session.templates,
  })
  session.structuredFallbackRoleSources = {
    ...(session.structuredFallbackRoleSources || {}),
    [role.key]: {
      role: role.key,
      label: role.label,
      path: outputPath,
      cacheKey,
    },
  }
  return session.structuredFallbackRoleSources[role.key]
}

async function loadTemplateFillLibrary(template, libraryPath) {
  const cacheKey = template?.cacheKey || `${template?.extension || 'pptx'}:${template?.size || 0}:${template?.originalName || ''}`
  const cached = pptTemplateFillLibraryCache.get(cacheKey)
  if (cached) {
    const library = withTemplateFillLibrarySource(cached, template.path)
    await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
    return { library: clonePlain(library), cacheHit: true }
  }

  const diskCached = await readPptTemplateFillLibraryDiskCache(cacheKey)
  if (diskCached) {
    rememberPptTemplateFillLibrary(cacheKey, diskCached)
    const library = withTemplateFillLibrarySource(diskCached, template.path)
    await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
    return { library: clonePlain(library), cacheHit: true }
  }

  const rawLibrary = await analyzeTemplateFillLibrary(template.path, libraryPath)
  const cachedLibrary = normalizeTemplateFillLibraryForCache(rawLibrary)
  rememberPptTemplateFillLibrary(cacheKey, cachedLibrary)
  await writePptTemplateFillLibraryDiskCache(cacheKey, cachedLibrary).catch((error) => {
    console.warn(`PPT 填充版式库临时缓存写入失败：${error.message}`)
  })
  return { library: rawLibrary, cacheHit: false }
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

function normalizeTemplateFillLibraryForCache(library) {
  return {
    ...clonePlain(library),
    source_pptx: '',
  }
}

function withTemplateFillLibrarySource(library, sourcePath) {
  return {
    ...clonePlain(library),
    source_pptx: sourcePath || '',
  }
}

async function readPptTemplateFillLibraryDiskCache(cacheKey) {
  if (!cacheKey) return null
  const filePath = getPptTemplateFillLibraryDiskPath(cacheKey)
  try {
    const cached = JSON.parse(await readFile(filePath, 'utf8'))
    if (Date.now() - Number(cached.cachedAt || 0) > pptCacheTtlMs) {
      await rm(filePath, { force: true }).catch(() => {})
      return null
    }
    return cached.library || null
  } catch {
    return null
  }
}

async function writePptTemplateFillLibraryDiskCache(cacheKey, library) {
  if (!cacheKey || !library) return
  await mkdir(getPptTemplateFillLibraryDiskRoot(), { recursive: true })
  await writeFile(
    getPptTemplateFillLibraryDiskPath(cacheKey),
    `${JSON.stringify({ cachedAt: Date.now(), library: clonePlain(library) }, null, 2)}\n`,
    'utf8',
  )
}

function getPptTemplateFillLibraryDiskRoot() {
  return path.join(pptCacheRoot, 'template-fill-library')
}

function getPptTemplateFillLibraryDiskPath(cacheKey) {
  return path.join(getPptTemplateFillLibraryDiskRoot(), `${hashPptCacheKey(cacheKey)}.json`)
}

function hashPptCacheKey(cacheKey) {
  return createHmac('sha256', 'moonwalk-ppt-cache-v1').update(String(cacheKey || '')).digest('hex')
}

async function cleanupPptTemplateFillLibraryDiskCache() {
  const root = getPptTemplateFillLibraryDiskRoot()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = path.join(root, entry.name)
    const info = await stat(fullPath).catch(() => null)
    if (info) files.push({ path: fullPath, mtimeMs: info.mtimeMs })
  }

  const now = Date.now()
  await Promise.all(
    files
      .filter((item) => now - item.mtimeMs > pptCacheTtlMs)
      .map((item) => rm(item.path, { force: true }).catch(() => {})),
  )

  const fresh = files
    .filter((item) => now - item.mtimeMs <= pptCacheTtlMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  await Promise.all(
    fresh
      .slice(maxPptTemplateFillLibraryDiskEntries)
      .map((item) => rm(item.path, { force: true }).catch(() => {})),
  )
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

  options.assertNotCancelled?.()
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
  options.assertNotCancelled?.()

  let pdfPath = null
  let previewPaths = []
  try {
    options.update?.('正在把 PPTX 转换为预览图和 PDF。')
    const rendered = await renderDocumentToPreviews(pptxPath, previewDir, { prefix: 'slide', dpi: 128 })
    options.assertNotCancelled?.()
    pdfPath = rendered.pdfPath
    previewPaths = rendered.previewPaths
  } catch (error) {
    if (isPptJobCancelledError(error)) throw error
    throw new Error(`PPTX 已生成，但预览转换失败：${toUserError(error)}`)
  }

  options.assertNotCancelled?.()
  session.plan = plan
  session.templateFillPlan = null
  session.templateDiagnostics = null
  session.output = {
    versionId,
    engine: options.engine || 'fallback',
    pptxPath,
    pdfPath,
    previewPaths,
    generatedAt: new Date().toISOString(),
  }
}

async function runPptQualityCheck(session, aiProvider, update = () => {}, assertNotCancelled = () => {}) {
  if (typeof aiProvider.module.checkPptQuality !== 'function' || !session.plan) {
    session.qualityCheck = null
    return
  }
  assertNotCancelled()
  update('正在进行生成质量自检。')
  try {
    session.qualityCheck = await aiProvider.module.checkPptQuality({
      ...buildPptAiContext(session),
      plan: session.plan,
      renderInfo: {
        engine: session.output?.engine || 'fallback',
        previewSource: session.output?.previewSource || session.output?.engine || 'fallback',
        previewFallbackReason: session.output?.previewFallbackReason || '',
        previewCount: session.output?.previewPaths?.length || 0,
        templateFillCheck: session.output?.templateFill?.checkSummary || null,
      },
      narrativePlan: session.narrativePlan,
      templateDiagnostics: session.templateDiagnostics,
    })
    assertNotCancelled()
  } catch (error) {
    if (isPptJobCancelledError(error)) throw error
    console.warn(`PPT 质量自检失败：${toUserError(error)}`)
    session.qualityCheck = {
      score: 0,
      summary: `质量自检暂时失败：${toUserError(error)}`,
      passed: false,
      issues: [],
      checks: [],
      generatedAt: new Date().toISOString(),
    }
  }
}

function countTemplateFillEdits(fillPlan) {
  return (fillPlan?.slides || []).reduce((total, slide) => {
    const replacementCount = Array.isArray(slide?.replacements) ? slide.replacements.length : 0
    const tableCellCount = (slide?.table_edits || []).reduce(
      (sum, edit) => sum + (Array.isArray(edit?.cells) ? edit.cells.length : 0),
      0,
    )
    const chartEditCount = Array.isArray(slide?.chart_edits) ? slide.chart_edits.length : 0
    const extraShapeCount = Array.isArray(slide?.extra_shapes) ? slide.extra_shapes.length : 0
    return total + replacementCount + tableCellCount + chartEditCount + extraShapeCount
  }, 0)
}

function shouldRepairTemplateFillPlan(checkSummary, session) {
  const warningLimit = Math.max(10, (Number(session?.slideCount) || 0) * 4)
  return Number(checkSummary?.error || 0) > 0 || Number(checkSummary?.warn || 0) > warningLimit
}

function mergeTemplateFillPlanWithPptPlan(fillPlan, plan, targetSlideNumbers = []) {
  const targetSet = new Set(targetSlideNumbers.map(Number).filter(Boolean))
  return {
    ...fillPlan,
    title: plan.title || fillPlan.title,
    subtitle: plan.subtitle || fillPlan.subtitle,
    slides: fillPlan.slides.map((slide, index) => {
      const slideNumber = index + 1
      if (!targetSet.has(slideNumber)) return slide
      const planSlide = plan.slides[index]
      if (!planSlide) return slide
      const replacementTexts = [
        planSlide.title,
        planSlide.subtitle,
        ...(planSlide.bullets || []),
        planSlide.footer,
      ].map((text) => String(text || '').trim()).filter(Boolean)
      return {
        ...slide,
        purpose: planSlide.layout || slide.purpose,
        layout: planSlide.layout || slide.layout,
        notes: planSlide.speakerNotes || slide.notes,
        replacements: slide.replacements.map((replacement, replacementIndex) => ({
          ...replacement,
          text: replacementTexts[replacementIndex] || replacement.text,
        })),
      }
    }),
  }
}

function buildStructuredPagePlan(contentSlideCount) {
  const contentCount = Math.max(PPT_MIN_SLIDES, Math.min(PPT_MAX_SLIDES, Number(contentSlideCount) || 10))
  const chapterCount = Math.max(1, Math.min(contentCount, 6, Math.ceil(contentCount / 4)))
  const baseSize = Math.floor(contentCount / chapterCount)
  const extraCount = contentCount % chapterCount
  const chapterSizes = Array.from({ length: chapterCount }, (_, index) => baseSize + (index < extraCount ? 1 : 0))
  const slides = []
  const chapters = []

  slides.push(buildStructuredSlidePlanItem({
    role: 'cover',
    slideNumber: slides.length + 1,
  }))
  slides.push(buildStructuredSlidePlanItem({
    role: 'agenda',
    slideNumber: slides.length + 1,
  }))

  let contentIndex = 0
  chapterSizes.forEach((size, chapterOffset) => {
    const chapterIndex = chapterOffset + 1
    const chapter = {
      chapterIndex,
      title: `第 ${chapterIndex} 部分`,
      sectionSlideNumber: slides.length + 1,
      contentStart: contentIndex + 1,
      contentEnd: contentIndex + size,
      contentSlideNumbers: [],
    }
    slides.push(buildStructuredSlidePlanItem({
      role: 'section',
      slideNumber: slides.length + 1,
      chapterIndex,
    }))
    for (let offset = 0; offset < size; offset += 1) {
      contentIndex += 1
      const slideNumber = slides.length + 1
      chapter.contentSlideNumbers.push(slideNumber)
      slides.push(buildStructuredSlidePlanItem({
        role: 'content',
        slideNumber,
        chapterIndex,
        contentIndex,
      }))
    }
    chapters.push(chapter)
  })

  slides.push(buildStructuredSlidePlanItem({
    role: 'ending',
    slideNumber: slides.length + 1,
  }))

  return {
    contentSlideCount: contentCount,
    chapterCount,
    totalSlides: slides.length,
    roleSourceSlides: Object.fromEntries(STRUCTURED_MASTER_ROLES.map((role) => [role.key, role.sourceSlide])),
    chapters,
    slides,
  }
}

function buildStructuredSlidePlanItem({ role, slideNumber, chapterIndex = null, contentIndex = null }) {
  const meta = STRUCTURED_MASTER_ROLES.find((item) => item.key === role) || STRUCTURED_MASTER_ROLES[3]
  return {
    slideNumber,
    role,
    layout: meta.layout,
    sourceSlide: meta.sourceSlide,
    suggestedTemplateRole: meta.suggestedTemplateRole,
    chapterIndex,
    contentIndex,
  }
}

function alignStructuredFillPlan(fillPlan, library, structuredPagePlan, narrativePlan, aiProviderId = '') {
  const plannedSlides = Array.isArray(structuredPagePlan?.slides) ? structuredPagePlan.slides : []
  if (!plannedSlides.length) return fillPlan
  const slideLookup = new Map((library?.slides || []).map((slide) => [Number(slide.slide_index), slide]))
  const originalSlides = Array.isArray(fillPlan?.slides) ? fillPlan.slides : []
  const alignedSlides = plannedSlides.map((plannedSlide, index) => {
    const originalSlide = originalSlides[index] || {}
    const sourceSlide = Number(plannedSlide.sourceSlide) || 4
    const librarySlide = slideLookup.get(sourceSlide) || { slots: [] }
    const validSlotIds = new Set((librarySlide.slots || []).map((slot) => String(slot.slot_id)).filter(Boolean))
    const existingBySlot = new Map(
      (Array.isArray(originalSlide.replacements) ? originalSlide.replacements : [])
        .map((replacement) => ({
          slotId: String(replacement?.slot_id || '').trim(),
          text: String(replacement?.text || '').trim(),
        }))
        .filter((replacement) => replacement.slotId && replacement.text && validSlotIds.has(replacement.slotId))
        .map((replacement) => [replacement.slotId, replacement.text]),
    )
    const existingTexts = (Array.isArray(originalSlide.replacements) ? originalSlide.replacements : [])
      .map((replacement) => String(replacement?.text || '').trim())
      .filter(Boolean)
    const fallbackTexts = buildStructuredReplacementTexts({
      plannedSlide,
      index,
      fillPlan,
      structuredPagePlan,
      narrativePlan,
    })
    const candidateTexts = uniqueStrings([...existingTexts, ...fallbackTexts])
    const replaceableSlots = selectStructuredReplacementSlots(librarySlide, plannedSlide.role)
    const replacements = []

    replaceableSlots.forEach((slot, slotIndex) => {
      const slotId = String(slot.slot_id || '').trim()
      if (!slotId) return
      const text = existingBySlot.get(slotId) || candidateTexts[slotIndex] || candidateTexts.at(-1) || ''
      if (!text) return
      replacements.push({ slot_id: slotId, text })
    })

    const extraShapes = normalizeStructuredExtraShapes(originalSlide.extra_shapes, plannedSlide.role, aiProviderId)
    if (plannedSlide.role === 'content' && replacements.length < 2 && candidateTexts.length >= 2) {
      extraShapes.push(buildStructuredFallbackTextShape(candidateTexts.slice(replacements.length, replacements.length + 3)))
    }

    return {
      ...originalSlide,
      source_slide: sourceSlide,
      purpose: plannedSlide.role,
      layout: plannedSlide.layout,
      notes: String(originalSlide.notes || fallbackTexts.slice(0, 3).join('。')),
      transition: originalSlide.transition || 'keep',
      replacements,
      table_edits: Array.isArray(originalSlide.table_edits) ? originalSlide.table_edits : [],
      chart_edits: Array.isArray(originalSlide.chart_edits) ? originalSlide.chart_edits : [],
      extra_shapes: extraShapes,
    }
  })

  return {
    schema: 'template_fill_pptx_plan.v1',
    title: String(fillPlan?.title || narrativePlan?.title || 'Moonwalk PPT'),
    subtitle: String(fillPlan?.subtitle || narrativePlan?.subtitle || ''),
    slides: alignedSlides,
  }
}

function buildStructuredReplacementTexts({ plannedSlide, index, fillPlan, structuredPagePlan, narrativePlan }) {
  const narrativeSlide = narrativePlan?.slides?.[index] || null
  const chapter = plannedSlide.chapterIndex
    ? structuredPagePlan.chapters?.find((item) => item.chapterIndex === plannedSlide.chapterIndex)
    : null
  const chapterTitle = chapter ? inferStructuredChapterTitle(chapter, narrativePlan) : ''
  const deckTitle = String(fillPlan?.title || narrativePlan?.title || 'Moonwalk PPT')
  const deckSubtitle = String(fillPlan?.subtitle || narrativePlan?.subtitle || narrativePlan?.coreMessage || '')
  const keyMessage = String(narrativeSlide?.keyMessage || '')
  const mustSay = normalizeTextList(narrativeSlide?.mustSay)
  const supportingPoints = normalizeTextList(narrativeSlide?.supportingPoints)

  if (plannedSlide.role === 'cover') {
    return uniqueStrings([deckTitle, deckSubtitle, keyMessage, narrativePlan?.coreMessage])
  }
  if (plannedSlide.role === 'agenda') {
    const chapterTitles = (structuredPagePlan.chapters || []).map((item) => inferStructuredChapterTitle(item, narrativePlan))
    return uniqueStrings(['目录', ...chapterTitles, narrativePlan?.coreMessage])
  }
  if (plannedSlide.role === 'section') {
    return uniqueStrings([chapterTitle, keyMessage, ...mustSay, ...supportingPoints])
  }
  if (plannedSlide.role === 'ending') {
    return uniqueStrings(['总结与下一步', narrativePlan?.coreMessage, keyMessage, ...mustSay, ...supportingPoints, '谢谢观看'])
  }
  return uniqueStrings([keyMessage || chapterTitle || `内容页 ${plannedSlide.contentIndex || ''}`, ...mustSay, ...supportingPoints])
}

function inferStructuredChapterTitle(chapter, narrativePlan) {
  const sectionSlide = narrativePlan?.slides?.[(chapter.sectionSlideNumber || 1) - 1]
  if (sectionSlide?.keyMessage) return trimInlineText(sectionSlide.keyMessage, 18)
  const firstContent = narrativePlan?.slides?.[(chapter.contentSlideNumbers?.[0] || chapter.contentStart || 1) - 1]
  if (firstContent?.keyMessage) return trimInlineText(firstContent.keyMessage, 18)
  return chapter.title || `第 ${chapter.chapterIndex} 部分`
}

function selectStructuredReplacementSlots(librarySlide, role) {
  const slots = Array.isArray(librarySlide?.slots) ? librarySlide.slots : []
  const replaceable = slots.filter((slot) => isStructuredReplaceableSlot(slot, role))
  const selected = replaceable.length ? replaceable : slots.filter((slot) => isStructuredFallbackSlot(slot, role))
  return selected
    .sort((left, right) => compareSlotPosition(left, right))
    .slice(0, role === 'content' ? 8 : 6)
}

function isStructuredReplaceableSlot(slot, role) {
  const text = String(slot?.text || '').trim()
  const slotRole = String(slot?.role || '')
  if (isFixedStructuredSlotText(text)) return false
  if (isStructuredPlaceholderText(text)) return true
  if (!text && role === 'content' && slotRole.includes('body')) return true
  if (role === 'agenda' && slotRole.includes('body')) return true
  if ((role === 'cover' || role === 'section' || role === 'ending') && slotRole.includes('title')) return true
  return role === 'content' && (slotRole.includes('title') || slotRole.includes('body'))
}

function isStructuredFallbackSlot(slot, role) {
  const text = String(slot?.text || '').trim()
  const slotRole = String(slot?.role || '')
  if (isFixedStructuredSlotText(text)) return false
  if (!text) return role === 'content' && slotRole.includes('body')
  return slotRole.includes('title') || slotRole.includes('body')
}

function isStructuredPlaceholderText(text) {
  return /x{2,}|\.{3,}|…{2,}|标题|正文|请输入|占位|单击此处|click\s+to\s+add|lorem/i.test(text)
}

function isFixedStructuredSlotText(text) {
  if (!text) return false
  const compact = text.replace(/\s+/g, '')
  if (/^(logo|页码|page|date|日期|copyright|©|品牌标语|slogan)$/i.test(compact)) return true
  if (/(www\.|https?:\/\/|@)/i.test(text)) return true
  if (/^\d{4}[./年-]\d{1,2}/.test(compact)) return true
  if (/^\d{1,2}\s*\/\s*\d{1,2}$/.test(compact)) return true
  if (/^[0-9０-９ivxIVX一二三四五六七八九十./\-]+$/.test(compact) && compact.length <= 5) return true
  return false
}

function compareSlotPosition(left, right) {
  const leftGeometry = left?.geometry || {}
  const rightGeometry = right?.geometry || {}
  const leftY = Number(leftGeometry.y ?? 9999)
  const rightY = Number(rightGeometry.y ?? 9999)
  if (leftY !== rightY) return leftY - rightY
  return Number(leftGeometry.x ?? 9999) - Number(rightGeometry.x ?? 9999)
}

function normalizeStructuredExtraShapes(value, role, aiProviderId) {
  if (role !== 'content' || !Array.isArray(value)) return []
  return value
    .filter((shape) => {
      const kind = String(shape?.kind || '')
      if (kind === 'image_placeholder') return aiProviderId === 'openai'
      return kind === 'text' || kind === 'rect'
    })
    .slice(0, 3)
}

function buildStructuredFallbackTextShape(texts) {
  return {
    kind: 'text',
    x: 0.08,
    y: 0.22,
    width: 0.38,
    height: 0.22,
    text: texts.filter(Boolean).join('\n'),
    fill_color: 'FFF7EE',
    line_color: 'DCAE80',
    font_color: '71472A',
    font_size: 13,
    fill_transparency: 100,
    line_transparency: 100,
  }
}

function buildStructuredSourceCacheKey(session, mainTemplate) {
  const roleKeys = STRUCTURED_MASTER_ROLES.map((role) => {
    const master = session.structuredMasters?.[role.key]
    if (master) return `${role.key}:master:${master.cacheKey || master.size || master.originalName}`
    return buildStructuredFallbackRoleCacheKey(session, role)
  })
  return ['structured-source-v5', session.masterDescription || '', mainTemplate?.id || 'no-main', ...roleKeys].join('|')
}

function buildStructuredFallbackRoleCacheKey(session, role) {
  const templateKeys = (session.templates || []).map((template) => [
    template.id,
    template.cacheKey || template.size || template.originalName || '',
    ...(template.detectedColors || []).slice(0, 5),
  ].join(':'))
  return `${role.key}:generated-fallback:${templateKeys.join(',') || 'no-template'}`
}

function selectTemplateRoleSource(session, role) {
  const candidates = []
  const templates = [...(session.templates || [])]
    .filter((template) => template?.extension === '.pptx' && existsSync(template.path))
    .sort((left, right) => {
      if (left.id === session.mainTemplateId) return -1
      if (right.id === session.mainTemplateId) return 1
      return 0
    })

  templates.forEach((template, templateIndex) => {
    const slideTexts = Array.isArray(template.slideTexts) ? template.slideTexts : []
    const slideCount = Number(template.slideCount) || slideTexts.length || 1
    for (let index = 1; index <= slideCount; index += 1) {
      const slideText = slideTexts.find((item) => Number(item.slideNumber) === index)?.text || ''
      const score = scoreTemplateSlideForRole(role.key, slideText, index, slideCount, templateIndex)
      if (score <= 0) continue
      candidates.push({
        score,
        source: 'template-fallback',
        label: role.label,
        originalName: `${template.originalName} 第 ${index} 页`,
        templateName: template.originalName,
        path: template.path,
        slide: index,
      })
    }
  })

  return candidates.sort((left, right) => right.score - left.score)[0] || null
}

function scoreTemplateSlideForRole(roleKey, text, slideNumber, slideCount, templateIndex) {
  const normalized = String(text || '').toLowerCase()
  const positionBonus = Math.max(0, 8 - templateIndex)
  const isFirst = slideNumber === 1
  const isLast = slideNumber === slideCount
  const isSparse = normalized.replace(/\s+/g, '').length <= 90
  const hasAgenda = /目录|议程|大纲|agenda|contents?|outline/i.test(normalized)
  const hasSection = /章节|第[一二三四五六七八九十\d]+[章节部分]|chapter|section|part/i.test(normalized)
  const hasEnding = /谢谢|感谢|致谢|总结|结论|答疑|联系方式|thanks?|q&a|contact/i.test(normalized)

  if (roleKey === 'cover') return (isFirst ? 120 : 0) + (isSparse ? 18 : 0) + positionBonus
  if (roleKey === 'agenda') return (hasAgenda ? 130 : slideNumber === 2 ? 42 : 0) + positionBonus
  if (roleKey === 'section') return (hasSection ? 130 : isSparse && !isFirst && !isLast && !hasAgenda ? 55 : 0) + positionBonus
  if (roleKey === 'ending') return (hasEnding ? 130 : isLast ? 62 : 0) + positionBonus
  if (roleKey === 'content') {
    if (isFirst || isLast || hasAgenda || hasSection || hasEnding) return 0
    return 85 + (isSparse ? 0 : 18) + positionBonus
  }
  return 0
}

function hasUploadedStructuredMasters(session) {
  return STRUCTURED_MASTER_ROLES.some((role) => Boolean(session.structuredMasters?.[role.key]))
}

function mergeStructuredMasterColors(structuredMasters, mainTemplate) {
  const colors = []
  for (const role of STRUCTURED_MASTER_ROLES) {
    colors.push(...(structuredMasters?.[role.key]?.detectedColors || []))
  }
  colors.push(...(mainTemplate?.detectedColors || []))
  return uniqueStrings(colors).slice(0, 8)
}

function buildPptSessionVisualContext(session) {
  if (session.aiProviderId !== 'openai') return null
  const mainTemplate = session.templates.find((template) => template.id === session.mainTemplateId) || session.templates[0]
  const auxiliaryTemplates = session.templates.filter((template) => template.id !== mainTemplate?.id)
  const contexts = []

  contexts.push(sliceVisualContext(session.contentVisualContext, 3))

  for (const role of STRUCTURED_MASTER_ROLES) {
    const master = session.structuredMasters?.[role.key]
    if (!master) continue
    contexts.push(visualContextFromPreviewPaths({
      paths: master.previewPaths,
      label: `${role.label}：${master.originalName}`,
      kind: `ppt-master-${role.key}`,
      maxPages: 1,
    }))
  }

  if (session.master) {
    contexts.push(visualContextFromPreviewPaths({
      paths: session.master.previewPaths,
      label: `幻灯片母版：${session.master.originalName}`,
      kind: 'ppt-master',
      maxPages: 3,
    }))
  }

  if (mainTemplate) {
    contexts.push(visualContextFromPreviewPaths({
      paths: mainTemplate.previewPaths,
      label: `主模板：${mainTemplate.originalName}`,
      kind: 'ppt-main-template',
      maxPages: 3,
    }))
  }

  auxiliaryTemplates.slice(0, 2).forEach((template) => {
    contexts.push(visualContextFromPreviewPaths({
      paths: template.previewPaths,
      label: `辅助模板：${template.originalName}`,
      kind: 'ppt-aux-template',
      maxPages: 1,
    }))
  })

  const visualContext = combineVisualContexts(...contexts)
  if (!visualContext.pages.length && !visualContext.notes.length) return null
  return {
    ...visualContext,
    notes: [
      'GPT 模式已启用 PPT 视觉参考：请结合模板/母版预览理解版式、配色、图表、图片和页面层级。',
      ...visualContext.notes,
    ],
  }
}

function sliceVisualContext(context, maxPages) {
  if (!context) return null
  return {
    pages: Array.isArray(context.pages) ? context.pages.slice(0, maxPages) : [],
    notes: Array.isArray(context.notes) ? context.notes : [],
  }
}

function normalizeTextList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
}

function uniqueStrings(values) {
  const seen = new Set()
  const output = []
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    output.push(text)
  }
  return output
}

function trimInlineText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function serializePptSession(session) {
  return {
    sessionId: session.id,
    aiProvider: session.aiProviderId,
    selectedMainTemplateId: session.mainTemplateId,
    mode: session.mode,
    pptType: session.pptType,
    slideCount: session.slideCount,
    contentSlideCount: session.contentSlideCount,
    structuredPagePlan: session.structuredPagePlan || null,
    contentFileInfo: session.contentFileInfo,
    masterDescription: session.masterDescription,
    cacheSummary: session.cacheSummary || null,
    qualityCheck: session.qualityCheck || null,
    revisionSummary: session.revisionSummary || null,
    narrativePlan: session.narrativePlan || null,
    templateDiagnostics: session.templateDiagnostics || null,
    visualContext: session.aiProviderId === 'openai'
      ? publicVisualContext(buildPptSessionVisualContext(session))
      : null,
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
    structuredMasters: hasStructuredMasters(session.structuredMasters)
      ? serializeStructuredMasters(session.structuredMasters, toUploadFileUrl)
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
    prepared: publicPreparedContext(session.prepared),
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

function publicPreparedContext(prepared) {
  return {
    textContext: String(prepared?.textContext || ''),
    processingNotes: Array.isArray(prepared?.processingNotes)
      ? prepared.processingNotes.map(String)
      : [],
  }
}
