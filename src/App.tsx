import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCcw,
  Sparkles,
  UploadCloud,
  XCircle,
  X,
} from 'lucide-react'
import './App.css'

type Importance = 'high' | 'medium' | 'low'
type Difficulty = '简单' | '中等' | '困难'
type QuestionType = 'single' | 'multiple'
type OptionId = 'A' | 'B' | 'C' | 'D'
type Step = 'upload' | 'summary' | 'quiz' | 'result' | 'pptSetup' | 'pptPreview' | 'pptFinal'
type AssessmentMode = 'knowledge' | 'open'
type AiProviderId = 'deepseek' | 'openai'
type PptMode = '风格复用' | '版式套用' | '原稿改写'
type PptType = '课程汇报' | '论文答辩' | '商业方案' | '读书报告' | '课堂展示' | '培训课件'
type PptMasterRole = 'cover' | 'agenda' | 'section' | 'content' | 'ending'

type AuthStatus = {
  required: boolean
  authenticated: boolean
}

type AiProviderStatus = {
  id: AiProviderId
  label: string
  configured: boolean
  model: string
  lowCostModelSelected: boolean
}

type Health = {
  aiConfigured: boolean
  aiProvider: string
  aiProviderId?: AiProviderId
  aiModel: string
  lowCostModelSelected: boolean
  defaultAiProvider?: AiProviderId
  aiProviders?: AiProviderStatus[]
  pptRenderingAvailable?: boolean
  pptRendering?: {
    available: boolean
    sofficeVersion: string | null
    pdftoppmVersion: string | null
  }
  limits: {
    allowedExtensions: string[]
    maxFileSizeMB: number
    maxPdfPages: number
    maxPptxSlides: number
    questionCounts: number[]
    openQuestionMin: number
    openQuestionMax: number
    difficulties: Difficulty[]
    pptModes?: PptMode[]
    pptTypes?: PptType[]
    pptMinSlides?: number
    pptMaxSlides?: number
  }
}

type KeyPoint = {
  id: string
  title: string
  description: string
  importance: Importance
}

type Section = {
  title: string
  summary: string
  keyPointIds: string[]
}

type MaterialSummary = {
  title: string
  overview: string
  audience: string
  keyPoints: KeyPoint[]
  sections: Section[]
  importantTerms: string[]
}

type FileInfo = {
  originalName: string
  extension: string
  size: number
  pageCount: number | null
  slideCount: number | null
}

type UploadResponse = {
  sessionId: string
  aiProvider?: AiProviderId
  fileInfo: FileInfo
  processingNotes: string[]
  summary: MaterialSummary
}

type Question = {
  id: string
  type: QuestionType
  stem: string
  options: Array<{ id: OptionId; text: string }>
  answer: OptionId[]
  explanation: string
  sourceHint?: string
}

type QuizResponse = {
  questions: Question[]
}

type SourceRef = {
  location: string
  excerpt: string
}

type OpenQuestion = {
  id: string
  prompt: string
  target: string
  sourceRef: SourceRef
}

type OpenQuestionSet = {
  materialType: string
  questions: OpenQuestion[]
  feedbackContext?: FeedbackContext
}

type FeedbackContext = {
  aiProvider?: AiProviderId
  fileInfo: FileInfo
  prepared: {
    textContext: string
    processingNotes: string[]
  }
  summary: MaterialSummary
  writingGoal: string
  questionSet: {
    materialType: string
    writingGoal: string
    questions: OpenQuestion[]
  } | null
}

type OpenFeedback = {
  questionId: string
  answered: boolean
  evaluation: string
  suggestion: string
  sourceRef: SourceRef
}

type OpenFeedbackResponse = {
  overallDiagnosis: {
    summary: string
    mainIssues: string[]
    nextActions: string[]
  }
  feedback: OpenFeedback[]
}

type Answers = Record<string, OptionId[]>
type OpenAnswers = Record<string, string>
type PptTemplate = {
  id: string
  originalName: string
  extension: string
  size: number
  pageCount: number | null
  slideCount: number | null
  role: 'main' | 'auxiliary'
  textSample: string
  detectedColors: string[]
  imageCount: number
  previewUrls: string[]
}

type PptStructuredMaster = {
  role: PptMasterRole
  label: string
  originalName: string
  extension: string
  size: number
  slideCount: number | null
  detectedColors: string[]
  imageCount: number
  previewUrls: string[]
}

type PptSlidePlan = {
  title: string
  subtitle: string
  layout: string
  emphasis: string
  bullets: string[]
  footer: string
  speakerNotes: string
}

type PptPlan = {
  title: string
  subtitle: string
  theme: {
    tone: string
    primaryColor: string
    accentColor: string
    backgroundColor: string
  }
  slides: PptSlidePlan[]
}

type PptNarrativePlan = {
  title: string
  subtitle: string
  audience: string
  coreMessage: string
  storyline: string[]
  assumptions: string[]
  slides: Array<{
    slideNumber: number
    role: string
    layoutIntent: string
    keyMessage: string
    contentPriority: 'high' | 'medium' | 'low'
    suggestedTemplateRole: string
    visualDirection: string
    mustSay: string[]
    supportingPoints: string[]
    avoid: string[]
  }>
}

type PptTemplateDiagnostics = {
  phase?: 'initial' | 'revision' | string
  narrativePlanUsed?: boolean
  templatePageProfileCount?: number
  capacity?: {
    totalReplacements: number
    trimmedReplacements: number
    removedEmptyReplacements: number
    slideDiagnostics?: Array<{
      slideNumber: number
      sourceSlide: number
      layout: string
      narrativeKeyMessage: string
      replacementCountBefore: number
      replacementCountAfter: number
      trimmed: Array<{
        slot_id: string
        beforeLength: number
        afterLength: number
        limit: number
      }>
      removed: string[]
      density: string
      capacityLevel: string
    }>
  }
  checkSummary?: {
    ok: number
    warn: number
    error: number
  }
}

type PptSessionResponse = {
  sessionId: string
  aiProvider: AiProviderId
  selectedMainTemplateId: string
  mode: PptMode | null
  pptType: PptType | null
  slideCount: number | null
  contentSlideCount: number | null
  structuredPagePlan?: {
    contentSlideCount: number
    chapterCount: number
    totalSlides: number
  } | null
  masterDescription: string
  cacheSummary?: {
    templateHits: number
    templateTotal: number
    contentHit: boolean
    masterHit: boolean
    structuredMasterHits?: number
    structuredMasterTotal?: number
    templateFillLibraryHit?: boolean
  } | null
  qualityCheck?: {
    score: number
    summary: string
    passed: boolean
    issues: Array<{
      severity: 'high' | 'medium' | 'low'
      slideNumber: number | null
      title: string
      detail: string
      suggestion: string
    }>
    checks: Array<{
      label: string
      status: 'pass' | 'warn' | 'fail'
      detail: string
    }>
    generatedAt: string
  } | null
  revisionSummary?: {
    mode: 'partial' | 'full'
    revisedSlides: number[]
    commentCount: number
    updatedAt: string
  } | null
  narrativePlan?: PptNarrativePlan | null
  templateDiagnostics?: PptTemplateDiagnostics | null
  master: {
    originalName: string
    extension: string
    size: number
    slideCount: number | null
    detectedColors: string[]
    imageCount: number
    slideRoles: Array<{ slideNumber: number; role: string; text: string }>
    previewUrls: string[]
  } | null
  structuredMasters: Record<PptMasterRole, PptStructuredMaster | null> | null
  contentFileInfo: {
    originalName: string
    extension: string
    size: number
  } | null
  templates: PptTemplate[]
  plan: PptPlan | null
  output: {
    generatedAt: string
    engine?: 'template-fill' | 'fallback'
    previewSource?: 'template-fill' | 'fallback'
    previewFallbackReason?: string
    previewUrls: string[]
    pptxDownloadUrl: string
    pdfDownloadUrl: string | null
    templateFill?: {
      checkSummary: {
        ok: number
        warn: number
        error: number
      }
    } | null
  } | null
}

type PptJobResponse = {
  jobId: string
  sessionId: string
  type: 'analyze' | 'generate' | 'revise'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  cancelled?: boolean
  message: string
  error: string
  result: PptSessionResponse | null
}

type PptSlideComments = Record<number, string>
type PptProgress = {
  label: string
  detail: string
} | null

const apiBase = import.meta.env.VITE_API_BASE || ''
const fallbackQuestionCounts = [5, 10, 15, 20, 30]
const fallbackOpenQuestionMin = 1
const fallbackOpenQuestionMax = 10
const fallbackDifficulties: Difficulty[] = ['简单', '中等', '困难']
const fallbackPptModes: PptMode[] = ['风格复用', '版式套用', '原稿改写']
const fallbackPptTypes: PptType[] = ['课程汇报', '论文答辩', '商业方案', '读书报告', '课堂展示', '培训课件']
const defaultAiProvider: AiProviderId = 'deepseek'
const fallbackAiProviders: AiProviderStatus[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    configured: false,
    model: 'deepseek-v4-flash',
    lowCostModelSelected: true,
  },
  {
    id: 'openai',
    label: 'GPT-5.5',
    configured: false,
    model: 'gpt-5.5',
    lowCostModelSelected: true,
  },
]
const pptMasterRoles: Array<{
  key: PptMasterRole
  field: string
  label: string
  hint: string
}> = [
  { key: 'cover', field: 'masterCover', label: '封面母版', hint: '用于整套 PPT 封面' },
  { key: 'agenda', field: 'masterAgenda', label: '目录母版', hint: '用于目录页，可复制或增删目录项' },
  { key: 'section', field: 'masterSection', label: '标题页母版', hint: '用于每个章节前的标题页' },
  { key: 'content', field: 'masterContent', label: '内容页母版', hint: '用于正文内容页，可追加可编辑元素' },
  { key: 'ending', field: 'masterEnding', label: '结尾页母版', hint: '用于总结、致谢或结束页' },
]
const importanceLabels: Record<Importance, string> = {
  high: '重点',
  medium: '常规',
  low: '补充',
}

function createEmptyPptMasterFiles(): Record<PptMasterRole, File | null> {
  return {
    cover: null,
    agenda: null,
    section: null,
    content: null,
    ending: null,
  }
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [authError, setAuthError] = useState('')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [health, setHealth] = useState<Health | null>(null)
  const [selectedAiProvider, setSelectedAiProvider] = useState<AiProviderId>(defaultAiProvider)
  const [lockedAiProvider, setLockedAiProvider] = useState<AiProviderId>(defaultAiProvider)
  const [step, setStep] = useState<Step>('upload')
  const [assessmentMode, setAssessmentMode] = useState<AssessmentMode>('knowledge')
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null)
  const [quiz, setQuiz] = useState<QuizResponse | null>(null)
  const [openQuestionSet, setOpenQuestionSet] = useState<OpenQuestionSet | null>(null)
  const [openFeedback, setOpenFeedback] = useState<OpenFeedbackResponse | null>(null)
  const [selectedKeyPointIds, setSelectedKeyPointIds] = useState<string[]>([])
  const [selectedSectionIndexes, setSelectedSectionIndexes] = useState<number[]>([])
  const [questionCount, setQuestionCount] = useState(10)
  const [openQuestionCount, setOpenQuestionCount] = useState(5)
  const [writingGoal, setWritingGoal] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>('中等')
  const [focusOnly, setFocusOnly] = useState(true)
  const [chapterBased, setChapterBased] = useState(true)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<Answers>({})
  const [openAnswers, setOpenAnswers] = useState<OpenAnswers>({})
  const [isUploading, setIsUploading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isReviewingOpen, setIsReviewingOpen] = useState(false)
  const [pptSession, setPptSession] = useState<PptSessionResponse | null>(null)
  const [pptTemplates, setPptTemplates] = useState<File[]>([])
  const [pptMasterFiles, setPptMasterFiles] = useState<Record<PptMasterRole, File | null>>(() => createEmptyPptMasterFiles())
  const [pptMasterDescription, setPptMasterDescription] = useState('')
  const [pptContentFile, setPptContentFile] = useState<File | null>(null)
  const [pptContentText, setPptContentText] = useState('')
  const [pptRequirements, setPptRequirements] = useState('')
  const [pptMode, setPptMode] = useState<PptMode>('风格复用')
  const [pptType, setPptType] = useState<PptType>('课程汇报')
  const [pptSlideCount, setPptSlideCount] = useState(10)
  const [pptMainTemplateId, setPptMainTemplateId] = useState('')
  const [pptSlideComments, setPptSlideComments] = useState<PptSlideComments>({})
  const [isAnalyzingPpt, setIsAnalyzingPpt] = useState(false)
  const [isGeneratingPpt, setIsGeneratingPpt] = useState(false)
  const [isRevisingPpt, setIsRevisingPpt] = useState(false)
  const [pptProgress, setPptProgress] = useState<PptProgress>(null)
  const [activePptJobId, setActivePptJobId] = useState('')
  const activePptJobIdRef = useRef('')
  const [error, setError] = useState('')
  const [missingIds, setMissingIds] = useState<string[]>([])

  useEffect(() => {
    fetchJson<AuthStatus>('/api/auth/status')
      .then((data) => {
        setAuthStatus(data)
      })
      .catch(() => {
        setAuthStatus({ required: false, authenticated: true })
      })

    fetchJson<Health>('/api/health')
      .then((data) => {
        setHealth(data)
        setSelectedAiProvider(data.defaultAiProvider || data.aiProviderId || defaultAiProvider)
        setLockedAiProvider(data.defaultAiProvider || data.aiProviderId || defaultAiProvider)
        if (data.limits.questionCounts?.length) {
          setQuestionCount(data.limits.questionCounts.includes(10) ? 10 : data.limits.questionCounts[0])
        }
      })
      .catch(() => {
        setHealth(null)
      })
  }, [])

  const resultItems = useMemo(() => {
    if (!quiz) return []
    return quiz.questions.map((question, index) => {
      const userAnswer = answers[question.id] || []
      const correct = sameAnswerSet(userAnswer, question.answer)
      return { question, index, userAnswer, correct }
    })
  }, [answers, quiz])

  const wrongItems = resultItems.filter((item) => !item.correct)

  async function handleUpload(file: File | null) {
    setError('')
    if (!file) return
    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('aiProvider', selectedAiProvider)
      const response = await fetch(`${apiBase}/api/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      const data = await parseApiResponse<UploadResponse>(response)
      setUploadResult(data)
      setLockedAiProvider(data.aiProvider || selectedAiProvider)
      setSelectedKeyPointIds(data.summary.keyPoints.map((point) => point.id))
      setSelectedSectionIndexes(data.summary.sections.map((_, index) => index))
      setAssessmentMode('knowledge')
      setQuiz(null)
      setOpenQuestionSet(null)
      setOpenFeedback(null)
      setAnswers({})
      setOpenAnswers({})
      setCurrentIndex(0)
      setStep('summary')
    } catch (uploadError) {
      setError(getErrorText(uploadError))
    } finally {
      setIsUploading(false)
    }
  }

  async function handleGenerate(event: FormEvent) {
    event.preventDefault()
    if (!uploadResult) return
    if (selectedKeyPointIds.length === 0) {
      setError('请至少选择一个知识点。')
      return
    }

    setError('')
    setIsGenerating(true)
    try {
      const data = await fetchJson<QuizResponse>('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: uploadResult.sessionId,
          aiProvider: lockedAiProvider,
          questionCount,
          difficulty,
          focusOnly,
          chapterBased,
          selectedKeyPointIds,
        }),
      })
      setQuiz(data)
      setAnswers({})
      setCurrentIndex(0)
      setMissingIds([])
      setStep('quiz')
    } catch (generateError) {
      setError(getErrorText(generateError))
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleGenerateOpen(event: FormEvent) {
    event.preventDefault()
    if (!uploadResult) return
    if (uploadResult.summary.sections.length > 0 && selectedSectionIndexes.length === 0) {
      setError('请至少选择一个追问范围。')
      return
    }

    setError('')
    setIsGenerating(true)
    try {
      const data = await fetchJson<OpenQuestionSet>('/api/open/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: uploadResult.sessionId,
          aiProvider: lockedAiProvider,
          questionCount: openQuestionCount,
          writingGoal,
          selectedSectionIndexes,
        }),
      })
      setOpenQuestionSet(withFeedbackQuestionSet(data, writingGoal))
      setOpenFeedback(null)
      setOpenAnswers({})
      setCurrentIndex(0)
      setStep('quiz')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (generateError) {
      setError(getErrorText(generateError))
    } finally {
      setIsGenerating(false)
    }
  }

  function handleSubmitQuiz() {
    if (!quiz) return
    const missing = quiz.questions
      .filter((question) => !answers[question.id]?.length)
      .map((question) => question.id)
    setMissingIds(missing)
    if (missing.length > 0) return
    setStep('result')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleSubmitOpenAnswers() {
    if (!uploadResult || !openQuestionSet) return
    setError('')
    setIsReviewingOpen(true)
    try {
      const data = await fetchJson<OpenFeedbackResponse>('/api/open/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: uploadResult.sessionId,
          aiProvider: lockedAiProvider,
          answers: openAnswers,
          feedbackContext: withFeedbackQuestionSet(openQuestionSet, writingGoal).feedbackContext,
        }),
      })
      setOpenFeedback(data)
      setStep('result')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (feedbackError) {
      setError(getErrorText(feedbackError))
    } finally {
      setIsReviewingOpen(false)
    }
  }

  function resetFlow(nextAiProvider: AiProviderId) {
    setStep('upload')
    setUploadResult(null)
    setQuiz(null)
    setOpenQuestionSet(null)
    setOpenFeedback(null)
    setSelectedKeyPointIds([])
    setSelectedSectionIndexes([])
    setAnswers({})
    setOpenAnswers({})
    setCurrentIndex(0)
    setAssessmentMode('knowledge')
    setLockedAiProvider(nextAiProvider)
    setWritingGoal('')
    clearPptFlow()
    setError('')
    setMissingIds([])
  }

  function resetAll() {
    resetFlow(selectedAiProvider)
  }

  function resetForDeepSeekRetry() {
    setSelectedAiProvider('deepseek')
    resetFlow('deepseek')
  }

  function startPptFlow() {
    setError('')
    setLockedAiProvider(selectedAiProvider)
    setStep('pptSetup')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function switchPptToDeepSeek() {
    setSelectedAiProvider('deepseek')
    setLockedAiProvider('deepseek')
    setPptSession(null)
    setPptMainTemplateId('')
    setPptSlideComments({})
    setError('')
    setStep('pptSetup')
  }

  function clearPptFlow() {
    setPptSession(null)
    setPptTemplates([])
    setPptMasterFiles(createEmptyPptMasterFiles())
    setPptMasterDescription('')
    setPptContentFile(null)
    setPptContentText('')
    setPptRequirements('')
    setPptMode('风格复用')
    setPptType('课程汇报')
    setPptSlideCount(10)
    setPptMainTemplateId('')
    setPptSlideComments({})
    setIsAnalyzingPpt(false)
    setIsGeneratingPpt(false)
    setIsRevisingPpt(false)
    setPptProgress(null)
    setCurrentPptJobId('')
  }

  function backToUploadFromPpt() {
    clearPptFlow()
    setLockedAiProvider(selectedAiProvider)
    setError('')
    setStep('upload')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleAnalyzePptTemplates(event: FormEvent) {
    event.preventDefault()
    if (!pptTemplates.length) {
      setError('请至少上传 1 个模板文件。')
      return
    }
    if (pptTemplates.length > 10) {
      setError('模板文件最多上传 10 个。')
      return
    }

    setError('')
    setIsAnalyzingPpt(true)
    setPptProgress({ label: '模板分析', detail: '正在上传模板文件并创建分析任务。' })
    let jobId = ''
    try {
      const formData = new FormData()
      pptTemplates.forEach((file) => formData.append('templates', file))
      pptMasterRoles.forEach((role) => {
        const file = pptMasterFiles[role.key]
        if (file) formData.append(role.field, file)
      })
      if (pptContentFile) formData.append('contentFile', pptContentFile)
      formData.append('masterDescription', pptMasterDescription)
      formData.append('contentText', pptContentText)
      formData.append('requirements', pptRequirements)
      formData.append('aiProvider', lockedAiProvider)

      const response = await fetch(`${apiBase}/api/ppt/analyze`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      const job = await parseApiResponse<PptJobResponse>(response)
      jobId = job.jobId
      setCurrentPptJobId(job.jobId)
      setPptProgress({ label: '模板分析', detail: job.message })
      const data = await waitForPptJob(job.jobId, {
        fallbackError: '模板分析失败，请重试。',
        timeoutError: '模板分析时间过长，请稍后刷新或重新上传。',
        onProgress: (nextJob) => {
          if (isCurrentPptJob(nextJob.jobId)) setPptProgress({ label: '模板分析', detail: nextJob.message })
        },
      })
      setPptSession(data)
      setPptMainTemplateId(data.selectedMainTemplateId || data.templates[0]?.id || '')
    } catch (pptError) {
      if (isCurrentPptJob(jobId)) setError(getErrorText(pptError))
    } finally {
      if (isCurrentPptJob(jobId)) {
        setIsAnalyzingPpt(false)
        setPptProgress(null)
        setCurrentPptJobId('')
      }
    }
  }

  async function handleGeneratePpt(event?: FormEvent) {
    event?.preventDefault()
    if (!pptSession) {
      setError('请先分析模板文件。')
      return
    }
    if (!pptMainTemplateId) {
      setError('请先选择 1 个主模板。')
      return
    }

    setError('')
    setIsGeneratingPpt(true)
    setPptProgress({ label: '生成初稿', detail: '正在创建 PPT 生成任务。' })
    let jobId = ''
    try {
      const job = await fetchJson<PptJobResponse>('/api/ppt/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: pptSession.sessionId,
          aiProvider: lockedAiProvider,
          mainTemplateId: pptMainTemplateId,
          mode: pptMode,
          pptType,
          slideCount: pptSlideCount,
          masterDescription: pptMasterDescription,
          contentText: pptContentText,
          requirements: pptRequirements,
        }),
      })
      jobId = job.jobId
      setCurrentPptJobId(job.jobId)
      setPptProgress({ label: '生成初稿', detail: job.message })
      const data = await waitForPptJob(job.jobId, {
        fallbackError: 'PPT 生成失败，请重试。',
        timeoutError: 'PPT 生成时间过长，请稍后刷新或重新生成。',
        onProgress: (nextJob) => {
          if (isCurrentPptJob(nextJob.jobId)) setPptProgress({ label: '生成初稿', detail: nextJob.message })
        },
      })
      setPptSession(data)
      setPptSlideComments({})
      setStep('pptPreview')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (pptError) {
      if (isCurrentPptJob(jobId)) setError(getErrorText(pptError))
    } finally {
      if (isCurrentPptJob(jobId)) {
        setIsGeneratingPpt(false)
        setPptProgress(null)
        setCurrentPptJobId('')
      }
    }
  }

  async function handleRevisePpt() {
    if (!pptSession) return
    const slideComments = Object.entries(pptSlideComments)
      .map(([slideNumber, comment]) => ({ slideNumber: Number(slideNumber), comment: comment.trim() }))
      .filter((item) => item.comment)
    if (!slideComments.length) {
      setError('请至少给 1 页填写具体修改意见。')
      return
    }

    setError('')
    setIsRevisingPpt(true)
    setPptProgress({ label: '局部修改', detail: '正在创建修改任务。' })
    let jobId = ''
    try {
      const job = await fetchJson<PptJobResponse>('/api/ppt/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: pptSession.sessionId,
          aiProvider: lockedAiProvider,
          slideComments,
        }),
      })
      jobId = job.jobId
      setCurrentPptJobId(job.jobId)
      setPptProgress({ label: '局部修改', detail: job.message })
      const data = await waitForPptJob(job.jobId, {
        fallbackError: 'PPT 修改失败，请重试。',
        timeoutError: 'PPT 修改时间过长，请稍后刷新或重新生成。',
        onProgress: (nextJob) => {
          if (isCurrentPptJob(nextJob.jobId)) setPptProgress({ label: '局部修改', detail: nextJob.message })
        },
      })
      setPptSession(data)
      setPptSlideComments({})
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (pptError) {
      if (isCurrentPptJob(jobId)) setError(getErrorText(pptError))
    } finally {
      if (isCurrentPptJob(jobId)) {
        setIsRevisingPpt(false)
        setPptProgress(null)
        setCurrentPptJobId('')
      }
    }
  }

  async function handleCancelPptJob() {
    if (!activePptJobId) return
    try {
      await fetchJson<PptJobResponse>(`/api/ppt/jobs/${activePptJobId}/cancel`, { method: 'POST' })
      setError('当前 PPT 任务已取消。')
    } catch (cancelError) {
      setError(getErrorText(cancelError))
    } finally {
      setIsAnalyzingPpt(false)
      setIsGeneratingPpt(false)
      setIsRevisingPpt(false)
      setPptProgress(null)
      setCurrentPptJobId('')
    }
  }

  function setCurrentPptJobId(jobId: string) {
    activePptJobIdRef.current = jobId
    setActivePptJobId(jobId)
  }

  function isCurrentPptJob(jobId: string) {
    return !jobId || activePptJobIdRef.current === jobId
  }

  function backToSummaryFromResult() {
    setError('')
    setMissingIds([])
    setCurrentIndex(0)
    if (assessmentMode === 'knowledge') {
      setQuiz(null)
      setAnswers({})
    } else {
      setOpenQuestionSet(null)
      setOpenFeedback(null)
      setOpenAnswers({})
    }
    setStep('summary')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleAccessLogin(password: string) {
    setAuthError('')
    setIsAuthenticating(true)
    try {
      const data = await fetchJson<AuthStatus>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      setAuthStatus(data)
      resetFlow(selectedAiProvider)
    } catch (loginError) {
      setAuthError(getErrorText(loginError))
    } finally {
      setIsAuthenticating(false)
    }
  }

  async function handleLogout() {
    await fetchJson<{ authenticated: boolean }>('/api/auth/logout', { method: 'POST' }).catch(() => null)
    resetFlow(selectedAiProvider)
    setAuthStatus((current) => ({
      required: current?.required ?? true,
      authenticated: false,
    }))
  }

  if (!authStatus) {
    return <LoadingScreen />
  }

  if (authStatus.required && !authStatus.authenticated) {
    return (
      <AccessGate
        error={authError}
        isAuthenticating={isAuthenticating}
        onSubmit={handleAccessLogin}
      />
    )
  }

  return (
    <main className="app-shell">
      <TopBar currentStep={step} showLogout={authStatus.required} onLogout={handleLogout} />

      {step === 'upload' && (
        <UploadView
          health={health}
          selectedAiProvider={selectedAiProvider}
          setSelectedAiProvider={setSelectedAiProvider}
          isUploading={isUploading}
          error={error}
          onSwitchToDeepSeek={resetForDeepSeekRetry}
          onUpload={handleUpload}
          onStartPpt={startPptFlow}
        />
      )}

      {step === 'pptSetup' && (
        <PptSetupView
          health={health}
          lockedAiProvider={lockedAiProvider}
          templates={pptTemplates}
          setTemplates={(files) => {
            setPptTemplates(files)
            setPptSession(null)
            setPptMainTemplateId('')
            setPptProgress(null)
          }}
          masterFiles={pptMasterFiles}
          setMasterFile={(role, file) => {
            setPptMasterFiles((current) => ({ ...current, [role]: file }))
            setPptSession(null)
            setPptMainTemplateId('')
            setPptProgress(null)
          }}
          masterDescription={pptMasterDescription}
          setMasterDescription={(value) => {
            setPptMasterDescription(value)
            setPptSession(null)
            setPptMainTemplateId('')
            setPptProgress(null)
          }}
          contentFile={pptContentFile}
          setContentFile={(file) => {
            setPptContentFile(file)
            setPptSession(null)
            setPptMainTemplateId('')
            setPptProgress(null)
          }}
          contentText={pptContentText}
          setContentText={setPptContentText}
          requirements={pptRequirements}
          setRequirements={setPptRequirements}
          mode={pptMode}
          setMode={setPptMode}
          pptType={pptType}
          setPptType={setPptType}
          slideCount={pptSlideCount}
          setSlideCount={setPptSlideCount}
          session={pptSession}
          mainTemplateId={pptMainTemplateId}
          setMainTemplateId={setPptMainTemplateId}
          isAnalyzing={isAnalyzingPpt}
          isGenerating={isGeneratingPpt}
          progress={pptProgress}
          activeJobId={activePptJobId}
          error={error}
          onAnalyze={handleAnalyzePptTemplates}
          onGenerate={handleGeneratePpt}
          onCancelJob={handleCancelPptJob}
          onBack={backToUploadFromPpt}
          onSwitchToDeepSeek={switchPptToDeepSeek}
        />
      )}

      {step === 'pptPreview' && pptSession && (
        <PptPreviewView
          session={pptSession}
          slideComments={pptSlideComments}
          setSlideComments={setPptSlideComments}
          isRevising={isRevisingPpt}
          progress={pptProgress}
          activeJobId={activePptJobId}
          error={error}
          lockedAiProvider={lockedAiProvider}
          onRevise={handleRevisePpt}
          onCancelJob={handleCancelPptJob}
          onFinal={() => {
            setError('')
            setStep('pptFinal')
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          onBack={() => setStep('pptSetup')}
          onSwitchToDeepSeek={switchPptToDeepSeek}
        />
      )}

      {step === 'pptFinal' && pptSession && (
        <PptFinalView
          session={pptSession}
          onBack={() => setStep('pptPreview')}
          onRestart={backToUploadFromPpt}
        />
      )}

      {step === 'summary' && uploadResult && (
        <SummaryView
          uploadResult={uploadResult}
          assessmentMode={assessmentMode}
          setAssessmentMode={setAssessmentMode}
          selectedKeyPointIds={selectedKeyPointIds}
          setSelectedKeyPointIds={setSelectedKeyPointIds}
          selectedSectionIndexes={selectedSectionIndexes}
          setSelectedSectionIndexes={setSelectedSectionIndexes}
          questionCount={questionCount}
          setQuestionCount={setQuestionCount}
          openQuestionCount={openQuestionCount}
          setOpenQuestionCount={setOpenQuestionCount}
          writingGoal={writingGoal}
          setWritingGoal={setWritingGoal}
          difficulty={difficulty}
          setDifficulty={setDifficulty}
          focusOnly={focusOnly}
          setFocusOnly={setFocusOnly}
          chapterBased={chapterBased}
          setChapterBased={setChapterBased}
          health={health}
          isGenerating={isGenerating}
          error={error}
          lockedAiProvider={lockedAiProvider}
          onSwitchToDeepSeek={resetForDeepSeekRetry}
          onGenerate={handleGenerate}
          onGenerateOpen={handleGenerateOpen}
          onBack={resetAll}
        />
      )}

      {step === 'quiz' && assessmentMode === 'knowledge' && quiz && (
        <QuizView
          quiz={quiz}
          currentIndex={currentIndex}
          setCurrentIndex={setCurrentIndex}
          answers={answers}
          setAnswers={setAnswers}
          missingIds={missingIds}
          onSubmit={handleSubmitQuiz}
          onBack={() => setStep('summary')}
        />
      )}

      {step === 'quiz' && assessmentMode === 'open' && openQuestionSet && (
        <OpenQuestionView
          questionSet={openQuestionSet}
          currentIndex={currentIndex}
          setCurrentIndex={setCurrentIndex}
          answers={openAnswers}
          setAnswers={setOpenAnswers}
          isReviewing={isReviewingOpen}
          error={error}
          lockedAiProvider={lockedAiProvider}
          onSwitchToDeepSeek={resetForDeepSeekRetry}
          onSubmit={handleSubmitOpenAnswers}
          onBack={() => setStep('summary')}
        />
      )}

      {step === 'result' && assessmentMode === 'knowledge' && quiz && (
        <ResultView
          items={resultItems}
          wrongItems={wrongItems}
          onBackToSummary={backToSummaryFromResult}
          onRestart={resetAll}
        />
      )}

      {step === 'result' && assessmentMode === 'open' && openQuestionSet && openFeedback && (
        <OpenResultView
          questionSet={openQuestionSet}
          answers={openAnswers}
          feedback={openFeedback}
          onRevise={() => setStep('quiz')}
          onBackToSummary={backToSummaryFromResult}
          onRestart={resetAll}
        />
      )}
    </main>
  )
}

function LoadingScreen() {
  return (
    <main className="access-shell">
      <div className="access-card loading-card">
        <span className="brand-mark">
          <Loader2 className="spin" size={18} />
        </span>
        <strong className="brand-title">Moonwalk</strong>
      </div>
    </main>
  )
}

function AccessGate({
  error,
  isAuthenticating,
  onSubmit,
}: {
  error: string
  isAuthenticating: boolean
  onSubmit: (password: string) => void
}) {
  const [password, setPassword] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(password)
  }

  return (
    <main className="access-shell">
      <form className="access-card" onSubmit={submit}>
        <span className="brand-mark">
          <Sparkles size={18} />
        </span>
        <strong className="brand-title">Moonwalk</strong>
        <h1>请输入访问密码</h1>
        <label className="field-block">
          <span>访问密码</span>
          <input
            autoComplete="current-password"
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="primary-button full" disabled={isAuthenticating || !password.trim()}>
          {isAuthenticating ? <Loader2 className="spin" size={18} /> : <ChevronRight size={18} />}
          {isAuthenticating ? '正在验证' : '进入网站'}
        </button>
        {error && <ErrorNotice message={error} />}
      </form>
    </main>
  )
}

function TopBar({
  currentStep,
  showLogout,
  onLogout,
}: {
  currentStep: Step
  showLogout: boolean
  onLogout: () => void
}) {
  const isPptFlow = currentStep.startsWith('ppt')
  const items = isPptFlow
    ? [
        ['upload', '首页'],
        ['pptSetup', '设置模板'],
        ['pptPreview', '预览修改'],
        ['pptFinal', '导出终稿'],
      ] as Array<[Step, string]>
    : [
        ['upload', '上传材料'],
        ['summary', '确认摘要'],
        ['quiz', '开始答题'],
        ['result', '查看解析'],
      ] as Array<[Step, string]>

  return (
    <header className="top-bar">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={18} />
          </span>
          <div>
            <strong className="brand-title">Moonwalk</strong>
            <span>生成选择测试与开放式追问</span>
          </div>
        </div>
      <div className="top-actions">
        <nav className="stepper" aria-label="流程">
          {items.map(([id, label], index) => (
            <div className={`step-item ${currentStep === id ? 'active' : ''}`} key={id}>
              <span>{index + 1}</span>
              {label}
            </div>
          ))}
        </nav>
        {showLogout && (
          <button className="ghost-button" onClick={onLogout}>
            退出访问
          </button>
        )}
      </div>
    </header>
  )
}

function UploadView({
  health,
  selectedAiProvider,
  setSelectedAiProvider,
  isUploading,
  error,
  onSwitchToDeepSeek,
  onUpload,
  onStartPpt,
}: {
  health: Health | null
  selectedAiProvider: AiProviderId
  setSelectedAiProvider: (provider: AiProviderId) => void
  isUploading: boolean
  error: string
  onSwitchToDeepSeek: () => void
  onUpload: (file: File | null) => void
  onStartPpt: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragActive, setDragActive] = useState(false)

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    onUpload(event.target.files?.[0] || null)
    event.target.value = ''
  }

  return (
    <section className="upload-layout">
      <div className="intro">
        <div className="eyebrow">
          <FileText size={16} />
          PDF / DOCX / PPTX
        </div>
        <h1 className="hero-title">Moonwalk</h1>
      </div>

      <div className="feature-panels">
        <div
          className={`upload-panel ${dragActive ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragActive(false)
            onUpload(event.dataTransfer.files?.[0] || null)
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            onChange={onFileChange}
            hidden
          />
          <div className="upload-icon">
            {isUploading ? <Loader2 className="spin" size={34} /> : <UploadCloud size={36} />}
          </div>
          <h2>{isUploading ? '正在识别材料' : '上传学习材料'}</h2>
          <p>
            {isUploading
              ? `正在提取材料文字并调用 ${getAiProviderLabel(health, selectedAiProvider)} 分析，请稍等。`
              : '拖拽文件到这里，或点击按钮选择文件。'}
          </p>
          <button className="primary-button" disabled={isUploading} onClick={() => inputRef.current?.click()}>
            {isUploading ? '分析中' : '选择文件'}
            {!isUploading && <ChevronRight size={18} />}
          </button>
          <div className="limit-grid">
            <span>单文件不超过 {health?.limits.maxFileSizeMB || 50}MB</span>
            <span>PDF 不超过 {health?.limits.maxPdfPages || 100} 页</span>
            <span>PPTX 不超过 {health?.limits.maxPptxSlides || 100} 页</span>
          </div>
        </div>

        <section className="ppt-entry-panel">
          <div className="upload-icon">
            <FileText size={36} />
          </div>
          <h2>基于模板的 PPT 生成</h2>
          <p>
            {health?.pptRenderingAvailable === false
              ? '当前部署环境暂不支持 PPT 预览转换，请使用 Docker 版 Moonwalk 服务。'
              : '上传 PPTX 或 PDF 模板，再输入内容和制作需求，生成可预览、可修改、可下载的 PPTX。'}
          </p>
          <button
            className="primary-button"
            disabled={isUploading || health?.pptRenderingAvailable === false}
            onClick={onStartPpt}
          >
            进入 PPT 生成
            <ChevronRight size={18} />
          </button>
          <div className="limit-grid">
            <span>最多 10 个模板</span>
            <span>单文件不超过 50MB</span>
            <span>PPT / PDF 不超过 100 页</span>
          </div>
        </section>
      </div>

      <AiProviderSelector
        health={health}
        selectedAiProvider={selectedAiProvider}
        setSelectedAiProvider={setSelectedAiProvider}
        disabled={isUploading}
      />

      <StatusStrip health={health} selectedAiProvider={selectedAiProvider} />
      {error && (
        <ErrorNotice
          message={error}
          actionLabel={selectedAiProvider === 'openai' ? '切换到 DeepSeek 重试' : undefined}
          onAction={selectedAiProvider === 'openai' ? onSwitchToDeepSeek : undefined}
        />
      )}
    </section>
  )
}

function AiProviderSelector({
  health,
  selectedAiProvider,
  setSelectedAiProvider,
  disabled,
}: {
  health: Health | null
  selectedAiProvider: AiProviderId
  setSelectedAiProvider: (provider: AiProviderId) => void
  disabled: boolean
}) {
  const providers = getAiProviders(health)
  return (
    <section className="provider-selector" aria-label="AI 模型选择">
      <div>
        <span className="provider-label">AI 模型</span>
        <p>进入流程后会锁定当前选择，整套识别、出题和反馈都使用同一个模型。</p>
      </div>
      <div className="provider-options">
        {providers.map((provider) => (
          <button
            type="button"
            className={selectedAiProvider === provider.id ? 'active' : ''}
            disabled={disabled}
            key={provider.id}
            onClick={() => setSelectedAiProvider(provider.id)}
          >
            <strong>{provider.label}</strong>
            <span>{provider.model}</span>
            <small>{provider.configured ? '已配置' : '未配置'}</small>
          </button>
        ))}
      </div>
    </section>
  )
}

function StatusStrip({ health, selectedAiProvider }: { health: Health | null; selectedAiProvider: AiProviderId }) {
  const provider = getAiProviderStatus(health, selectedAiProvider)
  const configured = Boolean(provider?.configured && provider?.lowCostModelSelected)
  const message = !health
    ? '正在检查 AI 服务配置。'
    : !provider?.configured
      ? `尚未检测到 ${selectedAiProvider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'}。请配置后再使用 ${provider?.label || getAiProviderLabel(health, selectedAiProvider)}。`
      : !provider.lowCostModelSelected
        ? `当前模型 ${provider.model} 不在保护列表中，请检查环境变量。`
        : `${provider.label} 已配置，当前模型：${provider.model}。`
  return (
    <div className={`status-strip ${configured ? 'ready' : 'warning'}`}>
      {configured ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
      <span>{message}</span>
    </div>
  )
}

function SummaryView({
  uploadResult,
  assessmentMode,
  setAssessmentMode,
  selectedKeyPointIds,
  setSelectedKeyPointIds,
  selectedSectionIndexes,
  setSelectedSectionIndexes,
  questionCount,
  setQuestionCount,
  openQuestionCount,
  setOpenQuestionCount,
  writingGoal,
  setWritingGoal,
  difficulty,
  setDifficulty,
  focusOnly,
  setFocusOnly,
  chapterBased,
  setChapterBased,
  health,
  isGenerating,
  error,
  lockedAiProvider,
  onSwitchToDeepSeek,
  onGenerate,
  onGenerateOpen,
  onBack,
}: {
  uploadResult: UploadResponse
  assessmentMode: AssessmentMode
  setAssessmentMode: (mode: AssessmentMode) => void
  selectedKeyPointIds: string[]
  setSelectedKeyPointIds: (ids: string[]) => void
  selectedSectionIndexes: number[]
  setSelectedSectionIndexes: (indexes: number[]) => void
  questionCount: number
  setQuestionCount: (count: number) => void
  openQuestionCount: number
  setOpenQuestionCount: (count: number) => void
  writingGoal: string
  setWritingGoal: (goal: string) => void
  difficulty: Difficulty
  setDifficulty: (difficulty: Difficulty) => void
  focusOnly: boolean
  setFocusOnly: (value: boolean) => void
  chapterBased: boolean
  setChapterBased: (value: boolean) => void
  health: Health | null
  isGenerating: boolean
  error: string
  lockedAiProvider: AiProviderId
  onSwitchToDeepSeek: () => void
  onGenerate: (event: FormEvent) => void
  onGenerateOpen: (event: FormEvent) => void
  onBack: () => void
}) {
  const { summary, fileInfo } = uploadResult
  const questionCounts = health?.limits.questionCounts || fallbackQuestionCounts
  const difficulties = health?.limits.difficulties || fallbackDifficulties
  const openQuestionMin = health?.limits.openQuestionMin || fallbackOpenQuestionMin
  const openQuestionMax = health?.limits.openQuestionMax || fallbackOpenQuestionMax

  function toggleKeyPoint(id: string) {
    setSelectedKeyPointIds(
      selectedKeyPointIds.includes(id)
        ? selectedKeyPointIds.filter((item) => item !== id)
        : [...selectedKeyPointIds, id],
    )
  }

  function toggleSection(index: number) {
    setSelectedSectionIndexes(
      selectedSectionIndexes.includes(index)
        ? selectedSectionIndexes.filter((item) => item !== index)
        : [...selectedSectionIndexes, index].sort((a, b) => a - b),
    )
  }

  return (
    <section className="summary-layout">
      <div className="page-heading summary-heading">
        <button className="ghost-button" onClick={onBack}>
          <ArrowLeft size={17} />
          重新上传
        </button>
        <div>
          <span className="eyebrow">内容摘要</span>
          <h1>{summary.title}</h1>
          <p>{summary.overview}</p>
        </div>
      </div>

      <div className="summary-grid">
        <section className="panel main-panel">
          <div className="section-title">
            <h2>{assessmentMode === 'knowledge' ? '知识点确认' : '追问范围'}</h2>
            <span>
              {assessmentMode === 'knowledge'
                ? `${selectedKeyPointIds.length} / ${summary.keyPoints.length} 已选择`
                : `${selectedSectionIndexes.length} / ${summary.sections.length} 已选择`}
            </span>
          </div>

          {assessmentMode === 'knowledge' ? (
            <div className="keypoint-list">
              {summary.keyPoints.map((point) => (
                <button
                  className={`keypoint ${selectedKeyPointIds.includes(point.id) ? 'selected' : ''}`}
                  key={point.id}
                  onClick={() => toggleKeyPoint(point.id)}
                >
                  <span className="check-dot">
                    {selectedKeyPointIds.includes(point.id) && <Check size={14} />}
                  </span>
                  <span>
                    <strong>{point.title}</strong>
                    <small>{importanceLabels[point.importance]} · {point.description}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="keypoint-list">
              {summary.sections.length > 0 ? (
                summary.sections.map((section, index) => (
                  <button
                    className={`keypoint ${selectedSectionIndexes.includes(index) ? 'selected' : ''}`}
                    key={`${section.title}-${index}`}
                    onClick={() => toggleSection(index)}
                  >
                    <span className="check-dot">
                      {selectedSectionIndexes.includes(index) && <Check size={14} />}
                    </span>
                    <span>
                      <strong>{section.title}</strong>
                      <small>{section.summary}</small>
                    </span>
                  </button>
                ))
              ) : (
                <p className="empty-state">未识别到明确章节，将按全文生成开放式追问。</p>
              )}
            </div>
          )}
        </section>

        <aside className="panel side-panel">
          <div className="meta-block">
            <h2>材料信息</h2>
            <p>{fileInfo.originalName}</p>
            <div className="meta-row">
              <span>{fileInfo.extension.toUpperCase().replace('.', '')}</span>
              <span>{formatFileSize(fileInfo.size)}</span>
              {fileInfo.pageCount && <span>{fileInfo.pageCount} 页</span>}
              {fileInfo.slideCount && <span>{fileInfo.slideCount} 页幻灯片</span>}
            </div>
          </div>

          <fieldset>
            <legend>生成模式</legend>
            <div className="mode-switch">
              <button
                type="button"
                className={assessmentMode === 'knowledge' ? 'active' : ''}
                onClick={() => setAssessmentMode('knowledge')}
              >
                知识检测
              </button>
              <button
                type="button"
                className={assessmentMode === 'open' ? 'active' : ''}
                onClick={() => setAssessmentMode('open')}
              >
                开放式问题
              </button>
            </div>
          </fieldset>

          {assessmentMode === 'knowledge' ? (
            <form className="settings-form" onSubmit={onGenerate}>
              <fieldset>
                <legend>题目数量</legend>
                <div className="segmented">
                  {questionCounts.map((count) => (
                    <button
                      type="button"
                      className={questionCount === count ? 'active' : ''}
                      key={count}
                      onClick={() => setQuestionCount(count)}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend>难度</legend>
                <div className="segmented">
                  {difficulties.map((item) => (
                    <button
                      type="button"
                      className={difficulty === item ? 'active' : ''}
                      key={item}
                      onClick={() => setDifficulty(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="toggle-row">
                <span>
                  <strong>只考重点内容</strong>
                  <small>优先围绕重点知识点出题</small>
                </span>
                <input
                  type="checkbox"
                  checked={focusOnly}
                  onChange={(event) => setFocusOnly(event.target.checked)}
                />
              </label>

              <label className="toggle-row">
                <span>
                  <strong>按照章节生成</strong>
                  <small>无明确章节时按主题模块分布</small>
                </span>
                <input
                  type="checkbox"
                  checked={chapterBased}
                  onChange={(event) => setChapterBased(event.target.checked)}
                />
              </label>

              <button className="primary-button full" disabled={isGenerating}>
                {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
                {isGenerating ? '正在生成测试' : '生成测试'}
              </button>
            </form>
          ) : (
            <form className="settings-form" onSubmit={onGenerateOpen}>
              <label className="field-block">
                <span>问题方向</span>
                <textarea
                  value={writingGoal}
                  onChange={(event) => setWritingGoal(event.target.value)}
                  placeholder="可选：例如从论证漏洞、人物动机、商业可行性、反方视角等角度追问"
                />
              </label>

              <label className="field-block">
                <span>问题数量</span>
                <input
                  type="number"
                  min={openQuestionMin}
                  max={openQuestionMax}
                  value={openQuestionCount}
                  onChange={(event) => {
                    const next = Number(event.target.value) || openQuestionMin
                    setOpenQuestionCount(Math.min(openQuestionMax, Math.max(openQuestionMin, next)))
                  }}
                />
              </label>

              <button className="primary-button full" disabled={isGenerating}>
                {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
                {isGenerating ? '正在生成问题' : '生成开放式问题'}
              </button>
            </form>
          )}
          {error && (
            <ErrorNotice
              message={error}
              actionLabel={lockedAiProvider === 'openai' ? '切换到 DeepSeek 重试' : undefined}
              onAction={lockedAiProvider === 'openai' ? onSwitchToDeepSeek : undefined}
            />
          )}
        </aside>
      </div>

      <section className="panel">
        <div className="section-title">
          <h2>章节 / 模块</h2>
          <span>{summary.sections.length} 个</span>
        </div>
        <div className="section-list">
          {summary.sections.map((section, index) => (
            <article className="section-item" key={`${section.title}-${index}`}>
              <span>{index + 1}</span>
              <div>
                <strong>{section.title}</strong>
                <p>{section.summary}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

    </section>
  )
}

function QuizView({
  quiz,
  currentIndex,
  setCurrentIndex,
  answers,
  setAnswers,
  missingIds,
  onSubmit,
  onBack,
}: {
  quiz: QuizResponse
  currentIndex: number
  setCurrentIndex: (index: number) => void
  answers: Answers
  setAnswers: (answers: Answers) => void
  missingIds: string[]
  onSubmit: () => void
  onBack: () => void
}) {
  const question = quiz.questions[currentIndex]
  const selected = answers[question.id] || []

  function choose(optionId: OptionId) {
    if (question.type === 'single') {
      setAnswers({ ...answers, [question.id]: [optionId] })
      return
    }
    const next = selected.includes(optionId)
      ? selected.filter((id) => id !== optionId)
      : [...selected, optionId].sort()
    setAnswers({ ...answers, [question.id]: next })
  }

  return (
    <section className="quiz-layout">
      <aside className="question-nav panel">
        <div className="section-title">
          <h2>题目导航</h2>
          <span>{Object.values(answers).filter((item) => item.length).length} / {quiz.questions.length}</span>
        </div>
        <div className="number-grid">
          {quiz.questions.map((item, index) => {
            const answered = Boolean(answers[item.id]?.length)
            const missing = missingIds.includes(item.id)
            return (
              <button
                className={`${index === currentIndex ? 'current' : ''} ${answered ? 'answered' : ''} ${missing ? 'missing' : ''}`}
                key={item.id}
                onClick={() => setCurrentIndex(index)}
              >
                {index + 1}
              </button>
            )
          })}
        </div>
        <div className="legend">
          <span><i className="current-dot" />当前</span>
          <span><i className="answered-dot" />已答</span>
          <span><i className="missing-dot" />未答提示</span>
        </div>
        {missingIds.length > 0 && (
          <p className="missing-text">
            还有第 {missingIds.map((id) => quiz.questions.findIndex((q) => q.id === id) + 1).join('、')} 题未作答。
          </p>
        )}
      </aside>

      <section className="panel question-panel">
        <button className="ghost-button" onClick={onBack}>
          <ArrowLeft size={17} />
          返回设置
        </button>
        <div className="question-meta">
          <span>第 {currentIndex + 1} 题 / 共 {quiz.questions.length} 题</span>
          <strong>{question.type === 'single' ? '单选题' : '多选题'}</strong>
        </div>
        <h1>{question.stem}</h1>
        <div className="option-list">
          {question.options.map((option) => (
            <button
              className={`option ${selected.includes(option.id) ? 'selected' : ''}`}
              key={option.id}
              onClick={() => choose(option.id)}
            >
              <span>{option.id}</span>
              <p>{option.text}</p>
            </button>
          ))}
        </div>
        <div className="quiz-actions">
          <button
            className="secondary-button"
            disabled={currentIndex === 0}
            onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
          >
            <ArrowLeft size={17} />
            上一题
          </button>
          {currentIndex < quiz.questions.length - 1 ? (
            <button
              className="primary-button"
              onClick={() => setCurrentIndex(Math.min(quiz.questions.length - 1, currentIndex + 1))}
            >
              下一题
              <ArrowRight size={17} />
            </button>
          ) : (
            <button className="primary-button" onClick={onSubmit}>
              提交测试
              <CheckCircle2 size={17} />
            </button>
          )}
        </div>
      </section>
    </section>
  )
}

function OpenQuestionView({
  questionSet,
  currentIndex,
  setCurrentIndex,
  answers,
  setAnswers,
  isReviewing,
  error,
  lockedAiProvider,
  onSwitchToDeepSeek,
  onSubmit,
  onBack,
}: {
  questionSet: OpenQuestionSet
  currentIndex: number
  setCurrentIndex: (index: number) => void
  answers: OpenAnswers
  setAnswers: (answers: OpenAnswers) => void
  isReviewing: boolean
  error: string
  lockedAiProvider: AiProviderId
  onSwitchToDeepSeek: () => void
  onSubmit: () => void
  onBack: () => void
}) {
  const question = questionSet.questions[currentIndex]
  const answeredCount = questionSet.questions.filter((item) => answers[item.id]?.trim()).length

  function updateAnswer(value: string) {
    setAnswers({ ...answers, [question.id]: value })
  }

  return (
    <section className="quiz-layout open-quiz-layout">
      <aside className="question-nav panel">
        <div className="section-title">
          <h2>问题索引</h2>
          <span>{answeredCount} / {questionSet.questions.length}</span>
        </div>
        <div className="number-grid">
          {questionSet.questions.map((item, index) => {
            const answered = Boolean(answers[item.id]?.trim())
            return (
              <button
                className={`${index === currentIndex ? 'current' : ''} ${answered ? 'answered' : ''}`}
                key={item.id}
                onClick={() => setCurrentIndex(index)}
              >
                {index + 1}
              </button>
            )
          })}
        </div>
        <div className="legend">
          <span><i className="current-dot" />当前</span>
          <span><i className="answered-dot" />已回答</span>
        </div>
      </aside>

      <section className="panel question-panel open-question-panel">
        <button className="ghost-button" onClick={onBack}>
          <ArrowLeft size={17} />
          返回设置
        </button>
        <div className="question-meta">
          <span>第 {currentIndex + 1} 问 / 共 {questionSet.questions.length} 问</span>
          <strong>{questionSet.materialType}</strong>
        </div>
        <h1>{question.prompt}</h1>
        {question.target && (
          <p className="open-target">
            批判目标：{question.target}
          </p>
        )}
        <SourceReference sourceRef={question.sourceRef} />
        <label className="open-answer">
          <span>你的回答</span>
          <textarea
            value={answers[question.id] || ''}
            onChange={(event) => updateAnswer(event.target.value)}
            placeholder="可以先写粗糙想法，也可以留空提交，让 AI 给出思考方向。"
          />
        </label>
        <div className="quiz-actions">
          <button
            className="secondary-button"
            disabled={currentIndex === 0}
            onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
          >
            <ArrowLeft size={17} />
            上一问
          </button>
          {currentIndex < questionSet.questions.length - 1 ? (
            <button
              className="primary-button"
              onClick={() => setCurrentIndex(Math.min(questionSet.questions.length - 1, currentIndex + 1))}
            >
              下一问
              <ArrowRight size={17} />
            </button>
          ) : (
            <button className="primary-button" disabled={isReviewing} onClick={onSubmit}>
              {isReviewing ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
              {isReviewing ? '正在生成反馈' : '提交回答'}
            </button>
          )}
        </div>
        {error && (
          <ErrorNotice
            message={error}
            actionLabel={lockedAiProvider === 'openai' ? '切换到 DeepSeek 重试' : undefined}
            onAction={lockedAiProvider === 'openai' ? onSwitchToDeepSeek : undefined}
          />
        )}
      </section>
    </section>
  )
}

function ResultView({
  items,
  wrongItems,
  onBackToSummary,
  onRestart,
}: {
  items: Array<{ question: Question; index: number; userAnswer: OptionId[]; correct: boolean }>
  wrongItems: Array<{ question: Question; index: number; userAnswer: OptionId[]; correct: boolean }>
  onBackToSummary: () => void
  onRestart: () => void
}) {
  return (
    <section className="result-layout">
      <div className="page-heading result-heading">
        <div>
          <span className="eyebrow">答案解析</span>
          <h1>{wrongItems.length === 0 ? '全部答对' : `有 ${wrongItems.length} 道题需要回看`}</h1>
          <p>多选题按完全一致判断正确；下面可以查看错题和所有题目的解析。</p>
        </div>
        <div className="result-actions">
          <button className="secondary-button" onClick={onBackToSummary}>
            <ArrowLeft size={17} />
            返回题目生成
          </button>
          <button className="primary-button" onClick={onRestart}>
            <RefreshCcw size={17} />
            重新上传
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="section-title">
          <h2>错题列表</h2>
          <span>{wrongItems.length} 道</span>
        </div>
        {wrongItems.length === 0 ? (
          <p className="empty-state">这次没有错题，可以直接浏览全部解析。</p>
        ) : (
          <div className="wrong-list">
            {wrongItems.map((item) => (
              <a href={`#question-${item.question.id}`} key={item.question.id}>
                <span>第 {item.index + 1} 题</span>
                <strong>{item.question.stem}</strong>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="analysis-list">
        {items.map((item) => (
          <article
            className={`analysis-card ${item.correct ? 'correct' : 'wrong'}`}
            id={`question-${item.question.id}`}
            key={item.question.id}
          >
            <div className="analysis-top">
              <span>第 {item.index + 1} 题 · {item.question.type === 'single' ? '单选' : '多选'}</span>
            </div>
            <div className="analysis-title-row">
              <h2>{item.question.stem}</h2>
              <CorrectnessBadge correct={item.correct} />
            </div>
            <div className="answer-lines">
              <p>你的答案：{formatAnswerWithText(item.userAnswer, item.question.options)}</p>
              <p>正确答案：{formatAnswerWithText(item.question.answer, item.question.options)}</p>
            </div>
            <p className="explanation">{item.question.explanation}</p>
            {item.question.sourceHint && <small>{item.question.sourceHint}</small>}
          </article>
        ))}
      </section>
    </section>
  )
}

function OpenResultView({
  questionSet,
  answers,
  feedback,
  onRevise,
  onBackToSummary,
  onRestart,
}: {
  questionSet: OpenQuestionSet
  answers: OpenAnswers
  feedback: OpenFeedbackResponse
  onRevise: () => void
  onBackToSummary: () => void
  onRestart: () => void
}) {
  const feedbackById = new Map(feedback.feedback.map((item) => [item.questionId, item]))
  const diagnosis = feedback.overallDiagnosis

  return (
    <section className="result-layout">
      <div className="page-heading result-heading">
        <div>
          <span className="eyebrow">开放式反馈</span>
          <h1>总体诊断</h1>
          <p>AI 会直接指出文本和回答中的逻辑缺口；你可以返回修改回答后重新生成反馈。</p>
        </div>
        <div className="result-actions">
          <button className="secondary-button" onClick={onRevise}>
            <ArrowLeft size={17} />
            返回修改
          </button>
          <button className="secondary-button" onClick={onBackToSummary}>
            <ArrowLeft size={17} />
            返回题目生成
          </button>
          <button className="primary-button" onClick={onRestart}>
            <RefreshCcw size={17} />
            重新上传
          </button>
        </div>
      </div>

      <section className="panel diagnosis-panel">
        <p className="diagnosis-summary">{diagnosis.summary}</p>
        <div className="diagnosis-grid">
          <div>
            <h2>关键问题</h2>
            <BulletList items={diagnosis.mainIssues} fallback="AI 没有返回明确的关键问题。" />
          </div>
          <div>
            <h2>下一步修改</h2>
            <BulletList items={diagnosis.nextActions} fallback="AI 没有返回明确的下一步建议。" />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <h2>问题索引</h2>
          <span>{questionSet.questions.length} 个</span>
        </div>
        <div className="wrong-list open-index-list">
          {questionSet.questions.map((question, index) => (
            <a href={`#open-question-${question.id}`} key={question.id}>
              <span>第 {index + 1} 问</span>
              <strong>{question.prompt}</strong>
            </a>
          ))}
        </div>
      </section>

      <section className="analysis-list">
        {questionSet.questions.map((question, index) => {
          const item = feedbackById.get(question.id)
          const userAnswer = answers[question.id]?.trim()
          return (
            <article
              className={`analysis-card open-analysis-card ${item?.answered ? 'answered-open' : 'unanswered-open'}`}
              id={`open-question-${question.id}`}
              key={question.id}
            >
              <div className="analysis-top">
                <span>第 {index + 1} 问 · {item?.answered ? '已回答' : '未回答'}</span>
                <strong>{questionSet.materialType}</strong>
              </div>
              <h2>{question.prompt}</h2>
              {question.target && <p className="open-target">批判目标：{question.target}</p>}
              <SourceReference sourceRef={item?.sourceRef || question.sourceRef} />
              <div className="open-response-block">
                <strong>你的回答</strong>
                <p>{userAnswer || '未作答'}</p>
              </div>
              <div className="open-feedback-grid">
                <div>
                  <strong>AI 评价</strong>
                  <p>{item?.evaluation || 'AI 未返回评价，请重新生成反馈。'}</p>
                </div>
                <div>
                  <strong>改进建议</strong>
                  <p>{item?.suggestion || 'AI 未返回建议，请重新生成反馈。'}</p>
                </div>
              </div>
            </article>
          )
        })}
      </section>
    </section>
  )
}

function PptSetupView({
  health,
  lockedAiProvider,
  templates,
  setTemplates,
  masterFiles,
  setMasterFile,
  masterDescription,
  setMasterDescription,
  contentFile,
  setContentFile,
  contentText,
  setContentText,
  requirements,
  setRequirements,
  mode,
  setMode,
  pptType,
  setPptType,
  slideCount,
  setSlideCount,
  session,
  mainTemplateId,
  setMainTemplateId,
  isAnalyzing,
  isGenerating,
  progress,
  activeJobId,
  error,
  onAnalyze,
  onGenerate,
  onCancelJob,
  onBack,
  onSwitchToDeepSeek,
}: {
  health: Health | null
  lockedAiProvider: AiProviderId
  templates: File[]
  setTemplates: (files: File[]) => void
  masterFiles: Record<PptMasterRole, File | null>
  setMasterFile: (role: PptMasterRole, file: File | null) => void
  masterDescription: string
  setMasterDescription: (value: string) => void
  contentFile: File | null
  setContentFile: (file: File | null) => void
  contentText: string
  setContentText: (text: string) => void
  requirements: string
  setRequirements: (text: string) => void
  mode: PptMode
  setMode: (mode: PptMode) => void
  pptType: PptType
  setPptType: (type: PptType) => void
  slideCount: number
  setSlideCount: (count: number) => void
  session: PptSessionResponse | null
  mainTemplateId: string
  setMainTemplateId: (id: string) => void
  isAnalyzing: boolean
  isGenerating: boolean
  progress: PptProgress
  activeJobId: string
  error: string
  onAnalyze: (event: FormEvent) => void
  onGenerate: (event?: FormEvent) => void
  onCancelJob: () => void
  onBack: () => void
  onSwitchToDeepSeek: () => void
}) {
  const templateInputRef = useRef<HTMLInputElement | null>(null)
  const masterInputRefs = useRef<Record<PptMasterRole, HTMLInputElement | null>>({
    cover: null,
    agenda: null,
    section: null,
    content: null,
    ending: null,
  })
  const contentInputRef = useRef<HTMLInputElement | null>(null)
  const modes = health?.limits.pptModes?.length ? health.limits.pptModes : fallbackPptModes
  const types = health?.limits.pptTypes?.length ? health.limits.pptTypes : fallbackPptTypes
  const minSlides = health?.limits.pptMinSlides || 1
  const maxSlides = health?.limits.pptMaxSlides || 30

  function onTemplateChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []).slice(0, 10)
    setTemplates(files)
    event.target.value = ''
  }

  function onContentFileChange(event: ChangeEvent<HTMLInputElement>) {
    setContentFile(event.target.files?.[0] || null)
    event.target.value = ''
  }

  function onMasterFileChange(role: PptMasterRole, event: ChangeEvent<HTMLInputElement>) {
    setMasterFile(role, event.target.files?.[0] || null)
    event.target.value = ''
  }

  return (
    <section className="summary-layout ppt-setup-layout">
      <div className="page-heading summary-heading">
        <button className="ghost-button" onClick={onBack}>
          <ArrowLeft size={17} />
          返回首页
        </button>
        <div>
          <span className="eyebrow">基于模板的 PPT 生成</span>
          <h1>上传模板，设定内容与生成方向</h1>
          <p>当前流程已锁定使用 {lockedAiProvider === 'openai' ? 'GPT-5.5' : 'DeepSeek'}。先分析模板，再选择主模板生成初稿。</p>
        </div>
      </div>

      <div className="ppt-setup-grid">
        <form className="panel ppt-form-panel" onSubmit={onAnalyze}>
          <div className="section-title">
            <h2>模板上传</h2>
            <span>{templates.length} / 10 个模板</span>
          </div>

          <input
            ref={templateInputRef}
            type="file"
            accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            multiple
            hidden
            onChange={onTemplateChange}
          />
          <input
            ref={contentInputRef}
            type="file"
            accept=".txt,.docx,.pdf,.pptx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            hidden
            onChange={onContentFileChange}
          />
          {pptMasterRoles.map((role) => (
            <input
              key={role.key}
              ref={(element) => {
                masterInputRefs.current[role.key] = element
              }}
              type="file"
              accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              hidden
              onChange={(event) => onMasterFileChange(role.key, event)}
            />
          ))}

          <button type="button" className="file-pick-button" onClick={() => templateInputRef.current?.click()}>
            <UploadCloud size={20} />
            <span>
              <strong>上传模板文件</strong>
              <small>PPTX / PDF，最多 10 个，每个不超过 50MB</small>
            </span>
          </button>
          {templates.length > 0 && (
            <div className="selected-file-list">
              {templates.map((file, index) => (
                <span key={`${file.name}-${index}`}>{file.name}</span>
              ))}
            </div>
          )}

          <section className="field-block master-block">
            <div className="section-title compact-title">
              <h2>五类母版上传</h2>
              <span>可选 · 单页 PPTX</span>
            </div>
            <div className="master-role-grid">
              {pptMasterRoles.map((role) => {
                const file = masterFiles[role.key]
                const analyzed = session?.structuredMasters?.[role.key] || null
                const previewUrl = analyzed?.previewUrls?.[0]
                return (
                  <div className="master-role-card" key={role.key}>
                    <button
                      type="button"
                      className="master-role-upload"
                      onClick={() => masterInputRefs.current[role.key]?.click()}
                    >
                      <span className="master-role-preview">
                        {previewUrl ? (
                          <img src={withApiBase(previewUrl)} alt={role.label} />
                        ) : (
                          <UploadCloud size={20} />
                        )}
                      </span>
                      <span>
                        <strong>{role.label}</strong>
                        <small>{file?.name || analyzed?.originalName || role.hint}</small>
                      </span>
                    </button>
                    {(file || analyzed) && (
                      <button type="button" className="master-role-remove" onClick={() => setMasterFile(role.key, null)}>
                        移除
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <textarea
              value={masterDescription}
              onChange={(event) => setMasterDescription(event.target.value)}
              placeholder="母版补充说明（可选）：例如保留页眉页脚和 logo，但正文页尽量更简洁；如果不上传任何母版，将按模板文件风格生成。"
            />
            {session?.structuredPagePlan && (
              <div className="master-summary">
                <strong>已启用五类母版结构</strong>
                <span>
                  {session.structuredPagePlan.contentSlideCount} 页内容 · {session.structuredPagePlan.chapterCount} 个章节 ·
                  预计生成 {session.structuredPagePlan.totalSlides} 页总稿
                </span>
              </div>
            )}
          </section>

          <label className="field-block">
            <span>PPT 内容</span>
            <button type="button" className="file-pick-button compact" onClick={() => contentInputRef.current?.click()}>
              <FileText size={20} />
              <span>
                <strong>上传内容文件</strong>
                <small>可选，TXT / DOCX / PDF / PPTX，最多 1 个</small>
              </span>
            </button>
            {contentFile && (
              <div className="selected-file-list single">
                <span>{contentFile.name}</span>
                <button type="button" onClick={() => setContentFile(null)}>移除</button>
              </div>
            )}
            <textarea
              value={contentText}
              onChange={(event) => setContentText(event.target.value)}
              placeholder="可以粘贴大纲、正文、演讲稿或要点。若为空，AI 会根据类型和需求自行组织。"
            />
          </label>

          <label className="field-block">
            <span>PPT 制作需求</span>
            <textarea
              value={requirements}
              onChange={(event) => setRequirements(event.target.value)}
              placeholder="可选：例如更像某个模板、偏学术/商业、希望版式简洁、突出对比关系等。"
            />
          </label>

          <button className="secondary-button full" disabled={isAnalyzing || isGenerating || !templates.length}>
            {isAnalyzing ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            {isAnalyzing ? '正在分析模板' : '分析模板'}
          </button>
          {isAnalyzing && progress && <PptProgressNotice progress={progress} canCancel={Boolean(activeJobId)} onCancel={onCancelJob} />}
          {session?.cacheSummary && (
            <div className="ppt-cache-summary">
              <CheckCircle2 size={17} />
              <span>{formatPptCacheSummary(session.cacheSummary)}</span>
            </div>
          )}
        </form>

        <aside className="panel ppt-settings-panel">
          <div className="section-title">
            <h2>生成规则</h2>
            <span>{slideCount} 页内容</span>
          </div>

          <fieldset>
            <legend>生成模式</legend>
            <div className="mode-switch three">
              {modes.map((item) => (
                <button
                  type="button"
                  className={mode === item ? 'active' : ''}
                  key={item}
                  onClick={() => setMode(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>PPT 类型</legend>
            <div className="ppt-type-grid">
              {types.map((item) => (
                <button
                  type="button"
                  className={pptType === item ? 'active' : ''}
                  key={item}
                  onClick={() => setPptType(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field-block">
            <span>PPT 内容页数</span>
            <input
              type="number"
              min={minSlides}
              max={maxSlides}
              value={slideCount}
              onChange={(event) => {
                const next = Number(event.target.value) || minSlides
                setSlideCount(Math.min(maxSlides, Math.max(minSlides, next)))
              }}
            />
          </label>

          <div className="ppt-note">
            内容页数不包含封面、目录、章节标题页和结尾页。上传的母版会在原 PPTX 上直接替换和追加内容；未上传的页型由系统生成可编辑页面并贴合模板风格。
          </div>

          <button
            className="primary-button full"
            disabled={isAnalyzing || isGenerating || !session || !mainTemplateId}
            onClick={() => onGenerate()}
          >
            {isGenerating ? <Loader2 className="spin" size={18} /> : <ChevronRight size={18} />}
            {isGenerating ? '正在生成，可能需要几分钟' : '生成 PPT 初稿'}
          </button>
          {isGenerating && progress && <PptProgressNotice progress={progress} canCancel={Boolean(activeJobId)} onCancel={onCancelJob} />}

          {error && (
            <ErrorNotice
              message={error}
              actionLabel={lockedAiProvider === 'openai' ? '切换到 DeepSeek 重试' : undefined}
              onAction={lockedAiProvider === 'openai' ? onSwitchToDeepSeek : undefined}
            />
          )}
        </aside>
      </div>

      {session && (
        <section className="panel ppt-template-panel">
          <div className="section-title">
            <h2>选择主模板</h2>
            <span>必须选择 1 个</span>
          </div>
          <div className="template-grid">
            {session.templates.map((template) => (
              <button
                type="button"
                className={`template-card ${mainTemplateId === template.id ? 'selected' : ''}`}
                key={template.id}
                onClick={() => setMainTemplateId(template.id)}
              >
                <div className="template-preview">
                  {template.previewUrls[0] ? (
                    <img src={withApiBase(template.previewUrls[0])} alt={template.originalName} />
                  ) : (
                    <FileText size={34} />
                  )}
                </div>
                <div>
                  <strong>{template.originalName}</strong>
                  <small>
                    {template.extension.toUpperCase().replace('.', '')}
                    {template.slideCount ? ` · ${template.slideCount} 页幻灯片` : ''}
                    {template.pageCount ? ` · ${template.pageCount} 页` : ''}
                  </small>
                </div>
                <span>{mainTemplateId === template.id ? '主模板' : '辅助参考'}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  )
}

function PptPreviewView({
  session,
  slideComments,
  setSlideComments,
  isRevising,
  progress,
  activeJobId,
  error,
  lockedAiProvider,
  onRevise,
  onCancelJob,
  onFinal,
  onBack,
  onSwitchToDeepSeek,
}: {
  session: PptSessionResponse
  slideComments: PptSlideComments
  setSlideComments: (comments: PptSlideComments) => void
  isRevising: boolean
  progress: PptProgress
  activeJobId: string
  error: string
  lockedAiProvider: AiProviderId
  onRevise: () => void
  onCancelJob: () => void
  onFinal: () => void
  onBack: () => void
  onSwitchToDeepSeek: () => void
}) {
  const previews = session.output?.previewUrls || []
  return (
    <section className="result-layout ppt-preview-layout">
      <div className="page-heading result-heading">
        <div>
          <span className="eyebrow">PPT 初稿预览</span>
          <h1>{session.plan?.title || '已生成 PPT 初稿'}</h1>
          <p>
            {session.output?.engine === 'template-fill' && session.output?.previewSource === 'fallback'
              ? 'PPTX 已由模板填充引擎生成；当前预览为兜底预览，下载 PPTX 以终稿为准。'
              : '预览由真实 PPTX 转换而来，与下载终稿保持一致。'}
            {session.output?.engine === 'template-fill' ? '本次已使用模板填充引擎。' : '本次使用普通生成引擎。'}
          </p>
        </div>
        <div className="result-actions">
          <button className="secondary-button" onClick={onBack}>
            <ArrowLeft size={17} />
            返回设置
          </button>
          <button className="secondary-button" disabled={isRevising} onClick={onRevise}>
            {isRevising ? <Loader2 className="spin" size={17} /> : <RefreshCcw size={17} />}
            {isRevising ? '正在局部修改，可能需要几分钟' : '局部修改并重新预览'}
          </button>
          <button className="primary-button" onClick={onFinal}>
            生成终稿
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      {error && (
        <ErrorNotice
          message={error}
          actionLabel={lockedAiProvider === 'openai' ? '切换到 DeepSeek 重试' : undefined}
          onAction={lockedAiProvider === 'openai' ? onSwitchToDeepSeek : undefined}
        />
      )}
      {isRevising && progress && <PptProgressNotice progress={progress} canCancel={Boolean(activeJobId)} onCancel={onCancelJob} />}
      <PptQualityPanel session={session} />

      <section className="ppt-slide-list">
        {previews.map((url, index) => (
          <article className="ppt-slide-card" key={url}>
            <div className="ppt-slide-meta">
              <strong>第 {index + 1} 页</strong>
              <span>{session.plan?.slides[index]?.layout || 'content'}</span>
            </div>
            <img src={withApiBase(url)} alt={`第 ${index + 1} 页预览`} />
            <label className="field-block">
              <span>本页修改意见</span>
              <textarea
                value={slideComments[index + 1] || ''}
                onChange={(event) => setSlideComments({ ...slideComments, [index + 1]: event.target.value })}
                placeholder="例如：这一页标题更锋利、删掉第三个要点、把结论提前、改成对比结构。"
              />
            </label>
          </article>
        ))}
      </section>
    </section>
  )
}

function PptFinalView({
  session,
  onBack,
  onRestart,
}: {
  session: PptSessionResponse
  onBack: () => void
  onRestart: () => void
}) {
  const previews = session.output?.previewUrls || []
  return (
    <section className="result-layout ppt-final-layout">
      <div className="page-heading result-heading">
        <div>
          <span className="eyebrow">PPT 终稿</span>
          <h1>{session.plan?.title || 'Moonwalk PPT'}</h1>
          <p>{session.plan?.subtitle || '已生成可下载的 PPTX 文件。'}</p>
        </div>
        <div className="result-actions">
          <button className="secondary-button" onClick={onBack}>
            <ArrowLeft size={17} />
            返回预览
          </button>
          <a className="primary-button" href={withApiBase(session.output?.pptxDownloadUrl || '#')}>
            下载 PPTX
            <ChevronRight size={17} />
          </a>
          {session.output?.pdfDownloadUrl ? (
            <a className="secondary-button" href={withApiBase(session.output.pdfDownloadUrl)}>
              下载 PDF
            </a>
          ) : (
            <button className="secondary-button" disabled>暂不支持 PDF 导出</button>
          )}
          <button className="ghost-button" onClick={onRestart}>返回首页</button>
        </div>
      </div>

      {previews[0] && (
        <section className="panel cover-preview-panel">
          <div className="section-title">
            <h2>封面预览</h2>
            <span>{previews.length} 页</span>
          </div>
          <img src={withApiBase(previews[0])} alt="PPT 封面预览" />
        </section>
      )}

      <PptQualityPanel session={session} compact />

      <section className="ppt-slide-list compact">
        {previews.map((url, index) => (
          <article className="ppt-slide-card" key={url}>
            <div className="ppt-slide-meta">
              <strong>第 {index + 1} 页</strong>
            </div>
            <img src={withApiBase(url)} alt={`第 ${index + 1} 页预览`} />
          </article>
        ))}
      </section>
    </section>
  )
}

function SourceReference({ sourceRef }: { sourceRef: SourceRef }) {
  return (
    <div className="source-ref">
      <strong>{sourceRef.location || '原文片段附近'}</strong>
      <p>{sourceRef.excerpt || 'AI 未返回原文摘录。'}</p>
    </div>
  )
}

function PptQualityPanel({ session, compact = false }: { session: PptSessionResponse; compact?: boolean }) {
  const quality = session.qualityCheck
  if (!quality && !session.narrativePlan && !session.templateDiagnostics) return null
  const issueCount = quality?.issues.length || 0
  const revisedSlides = session.revisionSummary?.revisedSlides || []

  return (
    <section className={`panel ppt-quality-panel ${compact ? 'compact' : ''}`}>
      <PptEnhancementStrip session={session} />

      {quality && (
        <>
          <div className="ppt-quality-head">
            <div>
              <span className="eyebrow">生成质量自检</span>
              <h2>{quality.summary}</h2>
            </div>
            <div className={`quality-score ${quality.passed ? 'passed' : 'warning'}`}>
              <strong>{quality.score}</strong>
              <span>{quality.passed ? '通过' : '需注意'}</span>
            </div>
          </div>

          {revisedSlides.length > 0 && (
            <div className="revision-summary">
              <RefreshCcw size={16} />
              <span>
                本次{session.revisionSummary?.mode === 'partial' ? '局部修改' : '整套修改'}了第 {revisedSlides.join('、')} 页。
              </span>
            </div>
          )}

          {!compact && (
            <div className="quality-check-grid">
              {quality.checks.map((check) => (
                <div className={`quality-check ${check.status}`} key={`${check.label}-${check.detail}`}>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              ))}
            </div>
          )}

          {issueCount > 0 ? (
            <div className="quality-issues">
              {quality.issues.slice(0, compact ? 3 : 10).map((issue, index) => (
                <article className={`quality-issue ${issue.severity}`} key={`${issue.title}-${index}`}>
                  <span>{issue.slideNumber ? `第 ${issue.slideNumber} 页` : '整体'}</span>
                  <strong>{issue.title}</strong>
                  <p>{issue.detail}</p>
                  {issue.suggestion && <small>{issue.suggestion}</small>}
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">自检没有发现明显高风险问题。</p>
          )}
        </>
      )}
    </section>
  )
}

function PptEnhancementStrip({ session }: { session: PptSessionResponse }) {
  const diagnostics = session.templateDiagnostics
  const capacity = diagnostics?.capacity
  const check = diagnostics?.checkSummary || session.output?.templateFill?.checkSummary
  const items = [
    {
      label: '叙事大纲',
      detail: session.narrativePlan ? `${session.narrativePlan.slides.length} 页策略` : '未启用',
      active: Boolean(session.narrativePlan),
    },
    {
      label: '模板画像',
      detail: diagnostics?.templatePageProfileCount ? `${diagnostics.templatePageProfileCount} 页已识别` : '普通生成',
      active: Boolean(diagnostics?.templatePageProfileCount),
    },
    {
      label: '容量压缩',
      detail: capacity
        ? `${capacity.trimmedReplacements} 处收短，${capacity.removedEmptyReplacements} 处清理`
        : '未触发',
      active: Boolean(capacity && (capacity.totalReplacements > 0 || capacity.trimmedReplacements > 0)),
    },
    {
      label: '生成自检',
      detail: check
        ? `${check.warn} 个警告，${check.error} 个错误`
        : session.qualityCheck
          ? '已完成'
          : '未完成',
      active: Boolean(check || session.qualityCheck),
    },
  ]

  if (!items.some((item) => item.active)) return null

  return (
    <div className="ppt-enhancement-strip" aria-label="PPT 第二阶段增强状态">
      <div>
        <span className="eyebrow">第二阶段增强</span>
        <strong>{session.narrativePlan?.coreMessage || '已启用更强模板理解与内容规划'}</strong>
      </div>
      <div className="ppt-enhancement-items">
        {items.map((item) => (
          <span className={item.active ? 'active' : ''} key={item.label}>
            <CheckCircle2 size={15} />
            <b>{item.label}</b>
            {item.detail}
          </span>
        ))}
      </div>
    </div>
  )
}

function BulletList({ items, fallback }: { items: string[]; fallback: string }) {
  if (!items.length) return <p className="empty-state">{fallback}</p>
  return (
    <ul className="diagnosis-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

function CorrectnessBadge({ correct }: { correct: boolean }) {
  return (
    <div className={`correctness-badge ${correct ? 'correct' : 'wrong'}`}>
      <span>是否正确：</span>
      <i aria-label={correct ? '正确' : '错误'}>{correct ? '✓' : '✕'}</i>
    </div>
  )
}

function ErrorNotice({
  message,
  actionLabel,
  onAction,
}: {
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="error-notice">
      <XCircle size={18} className="notice-icon" />
      <span>{message}</span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function PptProgressNotice({
  progress,
  canCancel = false,
  onCancel,
}: {
  progress: PptProgress
  canCancel?: boolean
  onCancel?: () => void
}) {
  if (!progress) return null
  return (
    <div className="ppt-progress-notice">
      <Loader2 className="spin" size={18} />
      <div>
        <strong>{progress.label}</strong>
        <span>{progress.detail}</span>
      </div>
      {canCancel && onCancel && (
        <button type="button" className="cancel-job-button" onClick={onCancel}>
          <X size={15} />
          取消任务
        </button>
      )}
    </div>
  )
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${url}`, {
    ...options,
    credentials: options?.credentials || 'include',
  })
  return parseApiResponse<T>(response)
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error || '请求失败。')
  }
  return data as T
}

async function waitForPptJob(
  jobId: string,
  options: {
    fallbackError?: string
    timeoutError?: string
    onProgress?: (job: PptJobResponse) => void
  } = {},
): Promise<PptSessionResponse> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 20 * 60 * 1000) {
    await delay(2500)
    const job = await fetchJson<PptJobResponse>(`/api/ppt/jobs/${jobId}`)
    options.onProgress?.(job)
    if (job.status === 'completed' && job.result) return job.result
    if (job.status === 'cancelled') {
      throw new Error('任务已取消。')
    }
    if (job.status === 'failed') {
      throw new Error(job.error || options.fallbackError || 'PPT 生成失败，请重试。')
    }
  }
  throw new Error(options.timeoutError || 'PPT 生成时间过长，请稍后刷新或重新生成。')
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : '处理失败，请稍后重试。'
}

function sameAnswerSet(left: OptionId[], right: OptionId[]) {
  const a = [...left].sort().join(',')
  const b = [...right].sort().join(',')
  return a === b
}

function formatAnswerWithText(answer: OptionId[], options: Question['options']) {
  if (!answer.length) return '未作答'
  const optionMap = new Map(options.map((option) => [option.id, option.text]))
  return [...answer]
    .sort()
    .map((id) => `${id}. ${optionMap.get(id) || '未找到对应选项内容'}`)
    .join('；')
}

function formatPptCacheSummary(cacheSummary: NonNullable<PptSessionResponse['cacheSummary']>) {
  const parts = []
  if (cacheSummary.templateHits > 0) {
    parts.push(`已复用 ${cacheSummary.templateHits}/${cacheSummary.templateTotal} 个模板缓存`)
  } else {
    parts.push('模板分析结果已加入缓存')
  }
  if (cacheSummary.contentHit) parts.push('内容文件缓存命中')
  if (cacheSummary.structuredMasterTotal && cacheSummary.structuredMasterTotal > 0) {
    parts.push(`五类母版缓存 ${cacheSummary.structuredMasterHits || 0}/${cacheSummary.structuredMasterTotal}`)
  } else if (cacheSummary.masterHit) {
    parts.push('母版缓存命中')
  }
  if (cacheSummary.templateFillLibraryHit) parts.push('PPT 版式库缓存命中')
  return `${parts.join(' · ')}，下次上传相同文件会更快。`
}

function getAiProviders(health: Health | null) {
  const providers = health?.aiProviders?.length ? health.aiProviders : fallbackAiProviders
  return providers.map((provider) => ({
    ...provider,
    id: provider.id === 'openai' ? 'openai' : 'deepseek',
  })) as AiProviderStatus[]
}

function getAiProviderStatus(health: Health | null, providerId: AiProviderId) {
  return getAiProviders(health).find((provider) => provider.id === providerId)
}

function getAiProviderLabel(health: Health | null, providerId: AiProviderId) {
  return getAiProviderStatus(health, providerId)?.label || (providerId === 'openai' ? 'GPT-5.5' : 'DeepSeek')
}

function withFeedbackQuestionSet(questionSet: OpenQuestionSet, writingGoal: string): OpenQuestionSet {
  if (!questionSet.feedbackContext) return questionSet
  return {
    ...questionSet,
    feedbackContext: {
      ...questionSet.feedbackContext,
      writingGoal,
      questionSet: {
        materialType: questionSet.materialType,
        writingGoal,
        questions: questionSet.questions,
      },
    },
  }
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(size / 1024))}KB`
}

function withApiBase(url: string) {
  if (!url || url.startsWith('http') || url.startsWith('data:')) return url
  return `${apiBase}${url}`
}

export default App
