import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
const accessPassword = String(process.env.ACCESS_PASSWORD || '').trim()
const accessAuthEnabled = Boolean(accessPassword)
const accessCookieName = 'moonwalk_access'

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: MAX_FILE_SIZE },
})

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  const defaultProvider = getDefaultAiProviderInfo()
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
    limits: {
      allowedExtensions: ALLOWED_EXTENSIONS,
      maxFileSizeMB: Math.round(MAX_FILE_SIZE / 1024 / 1024),
      maxPdfPages: MAX_PDF_PAGES,
      maxPptxSlides: MAX_PPTX_SLIDES,
      questionCounts: QUESTION_COUNTS,
      openQuestionMin: OPEN_QUESTION_MIN,
      openQuestionMax: OPEN_QUESTION_MAX,
      difficulties: DIFFICULTIES,
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

function getSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error('当前材料会话不存在，请重新上传材料。')
  }
  return session
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
