import { emptyMaterialSummary } from './types.js'

const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions'
const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
const LOW_COST_MODELS = new Set(['deepseek-v4-flash', 'deepseek-chat'])

export function hasAiKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY)
}

export function getAiProviderName() {
  return 'DeepSeek'
}

export function getAiModelName() {
  return modelName
}

export function isLowCostModelSelected() {
  return LOW_COST_MODELS.has(modelName)
}

export async function analyzeMaterial(prepared, fileInfo) {
  const payload = await callDeepSeek({
    temperature: 0.2,
    maxTokens: 4096,
    messages: [
      {
        role: 'system',
        content:
          '你是中文学习材料分析助手。你只能根据用户提供的文本内容分析，不要编造材料之外的信息。必须只输出有效 JSON。',
      },
      {
        role: 'user',
        content: `请分析这份材料，并只返回 JSON。

材料文件：${fileInfo.originalName}
文件类型：${fileInfo.extension}
处理说明：${prepared.processingNotes.join('；')}

材料文本：
${prepared.textContext}

JSON 要求：
{
  "title": "材料主题",
  "overview": "不超过 180 字的摘要",
  "audience": "适合的学习对象",
  "keyPoints": [
    {"id": "kp1", "title": "知识点标题", "description": "知识点说明", "importance": "high|medium|low"}
  ],
  "sections": [
    {"title": "章节或主题模块", "summary": "模块摘要", "keyPointIds": ["kp1"]}
  ],
  "importantTerms": ["术语1"]
}

要求：
1. 统一使用中文。
2. keyPoints 数量控制在 3 到 16 个。
3. sections 如果没有明确章节，请按主题模块组织。
4. importance 只能是 high、medium、low。`,
      },
    ],
  })

  return normalizeSummary(parseJsonResponse(payload))
}

export async function generateQuiz(session, settings) {
  const selectedPoints = session.summary.keyPoints.filter((point) =>
    settings.selectedKeyPointIds.includes(point.id),
  )

  const payload = await callDeepSeek({
    temperature: 0.35,
    maxTokens: Math.max(4096, settings.questionCount * 900),
    messages: [
      {
        role: 'system',
        content:
          '你是中文选择题出题助手。你只能根据用户提供的材料文本和知识点出题。必须只输出有效 JSON。',
      },
      {
        role: 'user',
        content: `请基于这份材料生成中文选择题测试，并只返回 JSON。

材料文件：${session.fileInfo.originalName}
处理说明：${session.prepared.processingNotes.join('；')}

材料文本：
${session.prepared.textContext}

用户确认的材料摘要：
${JSON.stringify(session.summary, null, 2)}

本次选中的知识点：
${JSON.stringify(selectedPoints, null, 2)}

生成规则：
- 题目数量：${settings.questionCount}
- 难度：${settings.difficulty}
- 是否只考重点内容：${settings.focusOnly ? '是' : '否'}
- 是否按照章节/模块分布：${settings.chapterBased ? '是' : '否'}
- 单选和多选由你自动分配，但至少包含 1 道多选题，除非题目数量为 1。
- 每题必须固定 4 个选项：A、B、C、D。
- 单选题 answer 只能包含 1 个选项，多选题 answer 必须包含 2 个或以上选项。
- 多选题必须全部选对才算正确，因此答案要明确。
- 解析只需简单解释为什么选这个答案。
- 不要生成超出材料依据的题目。
- id 使用 q1、q2 这样的稳定编号。
- type 只能是 single 或 multiple。

JSON 格式：
{
  "questions": [
    {
      "id": "q1",
      "type": "single",
      "stem": "题干",
      "options": [
        {"id": "A", "text": "选项 A"},
        {"id": "B", "text": "选项 B"},
        {"id": "C", "text": "选项 C"},
        {"id": "D", "text": "选项 D"}
      ],
      "answer": ["A"],
      "explanation": "简单解析",
      "sourceHint": "来自材料中的相关内容"
    }
  ]
}`,
      },
    ],
  })

  return normalizeQuiz(parseJsonResponse(payload), settings.questionCount)
}

export async function generateOpenQuestions(session, settings) {
  const selectedSections = session.summary.sections.filter((_, index) =>
    settings.selectedSectionIndexes.includes(index),
  )

  const payload = await callDeepSeek({
    temperature: 0.45,
    maxTokens: Math.max(4096, settings.questionCount * 900),
    messages: [
      {
        role: 'system',
        content:
          '你是中文批判性阅读导师。你要直接、批判、具体、不客套，但只能批评文本、论证、结构和证据，不能攻击作者本人。必须只输出有效 JSON。',
      },
      {
        role: 'user',
        content: `请基于这份材料生成开放式追问，并只返回 JSON。

材料文件：${session.fileInfo.originalName}
处理说明：${session.prepared.processingNotes.join('；')}

材料文本：
${session.prepared.textContext}

用户确认的材料摘要：
${JSON.stringify(session.summary, null, 2)}

用户问题方向（可选）：
${settings.writingGoal || '用户未填写，请你自主选择最值得追问的方向与角度。'}

用户选择的追问范围：
${JSON.stringify(selectedSections, null, 2)}

生成规则：
- 自动判断材料类型，例如论文、作文、商业方案、读书报告、剧本、策划案、演讲稿等。
- 生成 ${settings.questionCount} 个开放式问题。
- 每个问题都必须针对材料中的具体论点、叙事选择、证据缺口、逻辑跳跃、概念含混、反方视角或遗漏前提。
- 如果用户填写了问题方向，优先沿这个方向生成问题；如果未填写，由你自主选择最能暴露文本问题的提问角度。
- 问题必须一针见血，不要生成“你怎么看”“请谈谈”这类空泛问题。
- 不要判断对错，不要给选择题选项。
- sourceRef 必须引用原文位置。能识别章节、页码或幻灯片时写清楚；否则写“原文片段附近”并给出短摘录。
- excerpt 必须来自材料原文，不要编造。
- target 是给系统用的内部批判目标，简洁说明这个问题实际刺向哪里。
- id 使用 oq1、oq2 这样的稳定编号。

JSON 格式：
{
  "materialType": "自动判断的材料类型",
  "questions": [
    {
      "id": "oq1",
      "prompt": "开放式问题",
      "target": "该问题针对的逻辑问题或遗漏点",
      "sourceRef": {
        "location": "章节/页码/幻灯片或原文片段附近",
        "excerpt": "原文短摘录"
      }
    }
  ]
}`,
      },
    ],
  })

  return normalizeOpenQuestions(parseJsonResponse(payload), settings.questionCount)
}

export async function generateOpenFeedback(session, settings) {
  const answerItems = settings.questions.map((question) => ({
    questionId: question.id,
    question: question.prompt,
    target: question.target,
    sourceRef: question.sourceRef,
    userAnswer: settings.answers[question.id] || '',
  }))
  const fileInfo = settings.fileInfo || session.fileInfo
  const prepared = settings.prepared || session.prepared
  const summary = settings.summary || session.summary

  const payload = await callDeepSeek({
    temperature: 0.35,
    maxTokens: Math.max(4096, settings.questions.length * 1000),
    messages: [
      {
        role: 'system',
        content:
          '你是中文批判性阅读反馈导师。你的反馈要直接、批判、具体、不客套，只评价文本与回答是否补足论证，不攻击作者本人。必须只输出有效 JSON。',
      },
	      {
	        role: 'user',
	        content: `请基于材料、开放式问题和用户回答生成诊断反馈，并只返回 JSON。

	材料文件：${fileInfo.originalName}
	处理说明：${prepared.processingNotes.join('；')}

	材料文本：
	${prepared.textContext}

	用户确认的材料摘要：
	${JSON.stringify(summary, null, 2)}

	用户问题方向（可选）：
	${settings.writingGoal || '用户未填写，由 AI 自主选择追问方向。'}

开放式问题与用户回答：
${JSON.stringify(answerItems, null, 2)}

反馈规则：
- 顶部 overallDiagnosis 要给出总体诊断，指出材料最关键的逻辑问题、缺口或风险。
- 对已回答的问题：评价用户回答是否真正补足了逻辑、证据或结构，并给出具体改进建议。
- 对未回答的问题：不要判错，直接给出可思考方向和可能的补充路径。
- 反馈必须具体引用原问题的原文位置或摘录，不要泛泛地说“需要加强论证”。
- 不要攻击作者本人，只批评文本和回答。
- 每条 feedback 必须对应一个 questionId。

JSON 格式：
{
  "overallDiagnosis": {
    "summary": "总体诊断",
    "mainIssues": ["关键问题 1", "关键问题 2"],
    "nextActions": ["下一步修改建议 1", "下一步修改建议 2"]
  },
  "feedback": [
    {
      "questionId": "oq1",
      "answered": true,
      "evaluation": "对用户回答是否补足问题的评价",
      "suggestion": "具体改进建议或未回答时的思考路径",
      "sourceRef": {
        "location": "章节/页码/幻灯片或原文片段附近",
        "excerpt": "原文短摘录"
      }
    }
  ]
}`,
      },
    ],
  })

  return normalizeOpenFeedback(parseJsonResponse(payload), answerItems)
}

async function callDeepSeek({ messages, temperature, maxTokens }) {
  if (!hasAiKey()) {
    throw new Error('还没有配置 DEEPSEEK_API_KEY。请在 .env 中填入 DeepSeek API Key。')
  }
  if (!isLowCostModelSelected()) {
    throw new Error(`当前模型 ${modelName} 不在低成本保护列表中。请将 DEEPSEEK_MODEL 设置为 deepseek-v4-flash。`)
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      temperature,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      stream: false,
    }),
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const message = json?.error?.message || json?.message || 'DeepSeek API 调用失败。'
    throw new Error(message)
  }

  const content = json?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('DeepSeek 没有返回内容。')
  }
  return content
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      throw new Error('DeepSeek 返回的内容不是有效 JSON。')
    }
    return JSON.parse(match[0])
  }
}

function normalizeSummary(value) {
  const summary = { ...emptyMaterialSummary, ...value }
  const keyPoints = Array.isArray(summary.keyPoints) ? summary.keyPoints : []
  summary.keyPoints = keyPoints.map((point, index) => ({
    id: String(point.id || `kp${index + 1}`),
    title: String(point.title || `知识点 ${index + 1}`),
    description: String(point.description || ''),
    importance: ['high', 'medium', 'low'].includes(point.importance)
      ? point.importance
      : 'medium',
  }))
  summary.sections = Array.isArray(summary.sections)
    ? summary.sections.map((section, index) => ({
        title: String(section.title || `模块 ${index + 1}`),
        summary: String(section.summary || ''),
        keyPointIds: Array.isArray(section.keyPointIds)
          ? section.keyPointIds.map(String)
          : [],
      }))
    : []
  summary.importantTerms = Array.isArray(summary.importantTerms)
    ? summary.importantTerms.map((term) => String(term))
    : []
  summary.title = String(summary.title || '未命名材料')
  summary.overview = String(summary.overview || '')
  summary.audience = String(summary.audience || '')
  return summary
}

function normalizeQuiz(value, expectedCount) {
  const questions = Array.isArray(value?.questions) ? value.questions : []
  const normalized = questions.slice(0, expectedCount).map((question, index) => {
    const type = question.type === 'multiple' ? 'multiple' : 'single'
    const options = ['A', 'B', 'C', 'D'].map((id) => {
      const existing = Array.isArray(question.options)
        ? question.options.find((option) => option.id === id)
        : null
      return {
        id,
        text: String(existing?.text || `${id} 选项`),
      }
    })
    const rawAnswer = Array.isArray(question.answer) ? question.answer : [question.answer]
    let answer = rawAnswer.filter((id) => ['A', 'B', 'C', 'D'].includes(id))
    if (type === 'single') {
      answer = [answer[0] || 'A']
    } else if (answer.length < 2) {
      answer = ['A', 'B']
    }
    return {
      id: String(question.id || `q${index + 1}`),
      type,
      stem: String(question.stem || `第 ${index + 1} 题`),
      options,
      answer,
      explanation: String(question.explanation || '该答案来自材料中的关键内容。'),
      sourceHint: String(question.sourceHint || ''),
    }
  })

  if (normalized.length !== expectedCount) {
    throw new Error(`DeepSeek 返回了 ${normalized.length} 道题，未达到要求的 ${expectedCount} 道题。请重试。`)
  }

  return { questions: normalized }
}

function normalizeOpenQuestions(value, expectedCount) {
  const questions = Array.isArray(value?.questions) ? value.questions : []
  const normalized = questions.slice(0, expectedCount).map((question, index) => ({
    id: String(question.id || `oq${index + 1}`),
    prompt: String(question.prompt || `第 ${index + 1} 个开放式问题`),
    target: String(question.target || ''),
    sourceRef: normalizeSourceRef(question.sourceRef),
  }))

  if (normalized.length !== expectedCount) {
    throw new Error(`DeepSeek 返回了 ${normalized.length} 个开放式问题，未达到要求的 ${expectedCount} 个。请重试。`)
  }

  return {
    materialType: String(value?.materialType || '未识别材料类型'),
    questions: normalized,
  }
}

function normalizeOpenFeedback(value, answerItems) {
  const diagnosis = value?.overallDiagnosis || {}
  const feedback = Array.isArray(value?.feedback) ? value.feedback : []

  return {
    overallDiagnosis: {
      summary: String(diagnosis.summary || '这份材料还需要进一步压实论证链条。'),
      mainIssues: normalizeStringList(diagnosis.mainIssues),
      nextActions: normalizeStringList(diagnosis.nextActions),
    },
    feedback: answerItems.map((question) => {
      const item = feedback.find((entry) => String(entry.questionId) === question.questionId) || {}
      return {
        questionId: question.questionId,
        answered: Boolean(question.userAnswer),
        evaluation: String(item.evaluation || '这个回答还没有充分回应问题刺向的论证缺口。'),
        suggestion: String(item.suggestion || '回到原文对应位置，补清楚论点、证据和结论之间的关系。'),
        sourceRef: normalizeSourceRef(item.sourceRef || question.sourceRef),
      }
    }),
  }
}

function normalizeSourceRef(value) {
  return {
    location: String(value?.location || '原文片段附近'),
    excerpt: String(value?.excerpt || ''),
  }
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []
}
