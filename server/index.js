import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import {
  analyzeMaterial,
  generateOpenFeedback,
  generateOpenQuestions,
  generateQuiz,
  getAiModelName,
  getAiProviderName,
  hasAiKey,
  isLowCostModelSelected,
} from './deepseek.js'
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

const upload = multer({
  dest: uploadRoot,
  limits: { fileSize: MAX_FILE_SIZE },
})

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: hasAiKey(),
    aiProvider: getAiProviderName(),
    aiModel: getAiModelName(),
    lowCostModelSelected: isLowCostModelSelected(),
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

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!hasAiKey()) {
      throw new Error('还没有配置 DEEPSEEK_API_KEY，暂时无法调用 DeepSeek 进行真实识别。')
    }

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
    const summary = await analyzeMaterial(prepared, fileInfo)
    const sessionId = nanoid()

    sessions.set(sessionId, {
      id: sessionId,
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
    if (!hasAiKey()) {
      throw new Error('还没有配置 DEEPSEEK_API_KEY，暂时无法调用 DeepSeek 生成题目。')
    }

    const settings = normalizeSettings(req.body)
    const session = getSession(settings.sessionId)
    const quiz = await generateQuiz(session, settings)
    session.quiz = quiz
    res.json(quiz)
  } catch (error) {
    res.status(400).json({ error: toUserError(error) })
  }
})

app.post('/api/open/generate', async (req, res) => {
  try {
    if (!hasAiKey()) {
      throw new Error('还没有配置 DEEPSEEK_API_KEY，暂时无法调用 DeepSeek 生成开放式问题。')
    }

    const settings = normalizeOpenQuestionSettings(req.body)
    const session = getSession(settings.sessionId)
    validateSelectedSections(session, settings.selectedSectionIndexes)

    const openQuestionSet = await generateOpenQuestions(session, settings)
    const feedbackContext = buildFeedbackContext(session, settings)
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
    if (!hasAiKey()) {
      throw new Error('还没有配置 DEEPSEEK_API_KEY，暂时无法调用 DeepSeek 生成开放式反馈。')
    }

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

    const feedback = await generateOpenFeedback(session || fallback, {
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
    questionCount,
    writingGoal,
    selectedSectionIndexes,
  }
}

function normalizeOpenFeedbackSettings(body) {
  const sessionId = String(body.sessionId || '')
  const answers = body.answers && typeof body.answers === 'object'
    ? Object.fromEntries(
        Object.entries(body.answers).map(([key, value]) => [String(key), String(value || '').trim()]),
      )
    : {}
  const feedbackContext = normalizeFeedbackContext(body.feedbackContext)

  if (!sessionId) throw new Error('缺少材料会话。')
  return { sessionId, answers, feedbackContext }
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

function buildFeedbackContext(session, settings) {
  return {
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
