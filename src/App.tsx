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
} from 'lucide-react'
import './App.css'

type Importance = 'high' | 'medium' | 'low'
type Difficulty = '简单' | '中等' | '困难'
type QuestionType = 'single' | 'multiple'
type OptionId = 'A' | 'B' | 'C' | 'D'
type Step = 'upload' | 'summary' | 'quiz' | 'result'
type AssessmentMode = 'knowledge' | 'open'

type Health = {
  aiConfigured: boolean
  aiProvider: string
  aiModel: string
  lowCostModelSelected: boolean
  limits: {
    allowedExtensions: string[]
    maxFileSizeMB: number
    maxPdfPages: number
    maxPptxSlides: number
    questionCounts: number[]
    openQuestionMin: number
    openQuestionMax: number
    difficulties: Difficulty[]
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

const apiBase = import.meta.env.VITE_API_BASE || ''
const fallbackQuestionCounts = [5, 10, 15, 20, 30]
const fallbackOpenQuestionMin = 1
const fallbackOpenQuestionMax = 10
const fallbackDifficulties: Difficulty[] = ['简单', '中等', '困难']
const importanceLabels: Record<Importance, string> = {
  high: '重点',
  medium: '常规',
  low: '补充',
}

function App() {
  const [health, setHealth] = useState<Health | null>(null)
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
  const [error, setError] = useState('')
  const [missingIds, setMissingIds] = useState<string[]>([])

  useEffect(() => {
    fetchJson<Health>('/api/health')
      .then((data) => {
        setHealth(data)
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
      const response = await fetch(`${apiBase}/api/upload`, {
        method: 'POST',
        body: formData,
      })
      const data = await parseApiResponse<UploadResponse>(response)
      setUploadResult(data)
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
    if (!writingGoal.trim()) {
      setError('请先填写写作目标。')
      return
    }
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
          questionCount: openQuestionCount,
          writingGoal,
          selectedSectionIndexes,
        }),
      })
      setOpenQuestionSet(data)
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
          answers: openAnswers,
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

  function resetAll() {
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
    setWritingGoal('')
    setError('')
    setMissingIds([])
  }

  return (
    <main className="app-shell">
      <TopBar currentStep={step} />

      {step === 'upload' && (
        <UploadView
          health={health}
          isUploading={isUploading}
          error={error}
          onUpload={handleUpload}
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
          onSubmit={handleSubmitOpenAnswers}
          onBack={() => setStep('summary')}
        />
      )}

      {step === 'result' && assessmentMode === 'knowledge' && quiz && (
        <ResultView
          items={resultItems}
          wrongItems={wrongItems}
          onRestart={resetAll}
        />
      )}

      {step === 'result' && assessmentMode === 'open' && openQuestionSet && openFeedback && (
        <OpenResultView
          questionSet={openQuestionSet}
          answers={openAnswers}
          feedback={openFeedback}
          onRevise={() => setStep('quiz')}
          onRestart={resetAll}
        />
      )}
    </main>
  )
}

function TopBar({ currentStep }: { currentStep: Step }) {
  const items = [
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
      <nav className="stepper" aria-label="流程">
        {items.map(([id, label], index) => (
          <div className={`step-item ${currentStep === id ? 'active' : ''}`} key={id}>
            <span>{index + 1}</span>
            {label}
          </div>
        ))}
      </nav>
    </header>
  )
}

function UploadView({
  health,
  isUploading,
  error,
  onUpload,
}: {
  health: Health | null
  isUploading: boolean
  error: string
  onUpload: (file: File | null) => void
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
        <p>
          使用 DeepSeek API 分析本地提取的材料文字，生成知识检测或批判性开放式追问。
        </p>
      </div>

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
            ? '正在提取材料文字并调用 DeepSeek 分析，请稍等。'
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

      <StatusStrip health={health} />
      {error && <ErrorNotice message={error} />}
    </section>
  )
}

function StatusStrip({ health }: { health: Health | null }) {
  const configured = Boolean(health?.aiConfigured && health?.lowCostModelSelected)
  const message = !health?.aiConfigured
    ? '尚未检测到 DEEPSEEK_API_KEY。配置后即可调用 DeepSeek API。'
    : !health.lowCostModelSelected
      ? `当前模型 ${health.aiModel} 不在低成本保护列表中，请改为 deepseek-v4-flash。`
      : `${health.aiProvider || 'DeepSeek'} API Key 已配置，当前低成本模型：${health.aiModel || 'deepseek-v4-flash'}。`
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
  onGenerate: (event: FormEvent) => void
  onGenerateOpen: (event: FormEvent) => void
  onBack: () => void
}) {
  const { summary, fileInfo, processingNotes } = uploadResult
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
                <span>写作目标</span>
                <textarea
                  value={writingGoal}
                  onChange={(event) => setWritingGoal(event.target.value)}
                  placeholder="例如：说服投资人相信这个方案的市场可行性"
                  required
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
          {error && <ErrorNotice message={error} />}
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

      <section className="notes-line">
        {processingNotes.map((note) => (
          <span key={note}>{note}</span>
        ))}
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
        {error && <ErrorNotice message={error} />}
      </section>
    </section>
  )
}

function ResultView({
  items,
  wrongItems,
  onRestart,
}: {
  items: Array<{ question: Question; index: number; userAnswer: OptionId[]; correct: boolean }>
  wrongItems: Array<{ question: Question; index: number; userAnswer: OptionId[]; correct: boolean }>
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
        <button className="primary-button" onClick={onRestart}>
          <RefreshCcw size={17} />
          重新上传
        </button>
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
              <strong>{item.correct ? '回答正确' : '回答错误'}</strong>
            </div>
            <h2>{item.question.stem}</h2>
            <div className="answer-lines">
              <p>你的答案：{formatAnswer(item.userAnswer)}</p>
              <p>正确答案：{formatAnswer(item.question.answer)}</p>
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
  onRestart,
}: {
  questionSet: OpenQuestionSet
  answers: OpenAnswers
  feedback: OpenFeedbackResponse
  onRevise: () => void
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

function SourceReference({ sourceRef }: { sourceRef: SourceRef }) {
  return (
    <div className="source-ref">
      <strong>{sourceRef.location || '原文片段附近'}</strong>
      <p>{sourceRef.excerpt || 'AI 未返回原文摘录。'}</p>
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

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="error-notice">
      <XCircle size={18} />
      <span>{message}</span>
    </div>
  )
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${url}`, options)
  return parseApiResponse<T>(response)
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error || '请求失败。')
  }
  return data as T
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : '处理失败，请稍后重试。'
}

function sameAnswerSet(left: OptionId[], right: OptionId[]) {
  const a = [...left].sort().join(',')
  const b = [...right].sort().join(',')
  return a === b
}

function formatAnswer(answer: OptionId[]) {
  return answer.length ? [...answer].sort().join('、') : '未作答'
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(size / 1024))}KB`
}

export default App
