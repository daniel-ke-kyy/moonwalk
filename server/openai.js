import {
  normalizeOpenFeedback,
  normalizeOpenQuestions,
  normalizeQuiz,
  normalizeSummary,
  parseJsonResponse,
} from './deepseek.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildPptNarrativePlanPrompt,
  buildPptPartialRevisionPrompt,
  buildPptPlanPrompt,
  buildPptQualityCheckPrompt,
  buildPptRevisionPrompt,
  buildPptTemplateFillPrompt,
  mergePartialPptPlan,
  normalizePptNarrativePlan,
  normalizePptPlan,
  normalizePptQualityCheck,
} from './pptPlan.js'
import { normalizeTemplateFillPlan } from './pptTemplateFill.js'

const OPENAI_API_URL = normalizeOpenAiApiUrl()
const modelName = process.env.OPENAI_MODEL || 'gpt-5.5'
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'low'
const maxVisualPages = Number(process.env.OPENAI_MAX_VISUAL_PAGES || 8)

export function hasAiKey() {
  return Boolean(process.env.OPENAI_API_KEY)
}

export function getAiProviderName() {
  return 'GPT-5.5'
}

export function getAiModelName() {
  return modelName
}

export function isLowCostModelSelected() {
  return true
}

export async function analyzeMaterial(prepared, fileInfo) {
  const payload = await callOpenAi({
    temperature: 0.2,
    maxTokens: 4096,
    instructions:
      '你是中文学习材料分析助手。你要结合用户提供的文本和页面截图理解材料；如果截图可用，需要识别图片里的文字、图示、表格和版式含义。不要编造材料之外的信息。必须只输出有效 JSON。',
    input: `请分析这份材料，并只返回 JSON。

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
4. importance 只能是 high、medium、low。
5. 如果提供了页面截图，请把截图中可见的文字、图示、流程图、表格和图片含义也纳入分析。`,
    visualContext: prepared.visualContext,
  })

  return normalizeSummary(parseJsonResponse(payload, 'GPT-5.5'))
}

export async function generateQuiz(session, settings) {
  const selectedPoints = session.summary.keyPoints.filter((point) =>
    settings.selectedKeyPointIds.includes(point.id),
  )

  const payload = await callOpenAi({
    temperature: 0.35,
    maxTokens: Math.max(4096, settings.questionCount * 900),
    instructions:
      '你是中文选择题出题助手。你只能根据用户提供的材料文本和知识点出题。必须只输出有效 JSON。',
    input: `请基于这份材料生成中文选择题测试，并只返回 JSON。

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
- 如果提供了页面截图，可基于截图中明确可见的文字、图示、流程图、表格和图片含义出题，但不要臆测截图外的信息。

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
    visualContext: session.prepared.visualContext,
  })

  return normalizeQuiz(parseJsonResponse(payload, 'GPT-5.5'), settings.questionCount, 'GPT-5.5')
}

export async function generateOpenQuestions(session, settings) {
  const selectedSections = session.summary.sections.filter((_, index) =>
    settings.selectedSectionIndexes.includes(index),
  )

  const payload = await callOpenAi({
    temperature: 0.45,
    maxTokens: Math.max(4096, settings.questionCount * 900),
    instructions:
      '你是中文批判性阅读导师。你要直接、批判、具体、不客套，但只能批评文本、论证、结构和证据，不能攻击作者本人。必须只输出有效 JSON。',
    input: `请基于这份材料生成开放式追问，并只返回 JSON。

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
- 如果提供了页面截图，可针对截图中的图示、表格、版式暗示和图片含义追问；sourceRef 要标明对应页码/幻灯片。
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
    visualContext: session.prepared.visualContext,
  })

  return normalizeOpenQuestions(parseJsonResponse(payload, 'GPT-5.5'), settings.questionCount, 'GPT-5.5')
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

  const payload = await callOpenAi({
    temperature: 0.35,
    maxTokens: Math.max(4096, settings.questions.length * 1000),
    instructions:
      '你是中文批判性阅读反馈导师。你的反馈要直接、批判、具体、不客套，只评价文本与回答是否补足论证，不攻击作者本人。必须只输出有效 JSON。',
    input: `请基于材料、开放式问题和用户回答生成诊断反馈，并只返回 JSON。

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
- 如果提供了页面截图，可结合截图中的图示、表格和图片含义判断回答是否补足论证。

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
    visualContext: prepared.visualContext,
  })

  return normalizeOpenFeedback(parseJsonResponse(payload, 'GPT-5.5'), answerItems)
}

export async function generatePptPlan(context) {
  const payload = await callOpenAi({
    temperature: 0.38,
    maxTokens: Math.max(4096, context.slideCount * 850),
    instructions:
      '你是中文 PPT 内容策划助手。你只负责生成页面计划 JSON，不生成图片，不输出 Markdown。必须只输出有效 JSON。',
    input: buildPptPlanPrompt(context),
    visualContext: context.visualContext,
  })

  return normalizePptPlan(parseJsonResponse(payload, 'GPT-5.5'), context.slideCount, context.fallbackTitle)
}

export async function generatePptNarrativePlan(context) {
  const payload = await callOpenAi({
    temperature: 0.32,
    maxTokens: Math.max(4096, context.slideCount * 650),
    instructions:
      '你是中文 PPT 内容架构师。你只负责先生成内容叙事大纲和页面策略 JSON，不选择模板页，不输出 Markdown。必须只输出有效 JSON。',
    input: buildPptNarrativePlanPrompt(context),
    visualContext: context.visualContext,
  })

  return normalizePptNarrativePlan(parseJsonResponse(payload, 'GPT-5.5'), context.slideCount, context.fallbackTitle)
}

export async function generatePptTemplateFillPlan(context) {
  const payload = await callOpenAi({
    temperature: 0.28,
    maxTokens: Math.max(4096, context.slideCount * 1200),
    instructions:
      '你是中文 PPT 模板填充策划助手。你只负责根据模板页面库生成 fill_plan JSON，不生成图片，不输出 Markdown。必须只输出有效 JSON。',
    input: buildPptTemplateFillPrompt(context),
    visualContext: context.visualContext,
  })

  return normalizeTemplateFillPlan(parseJsonResponse(payload, 'GPT-5.5'), context.templateFillLibraryRaw, context.slideCount)
}

export async function revisePptPlan(context) {
  const payload = await callOpenAi({
    temperature: 0.34,
    maxTokens: Math.max(4096, context.slideCount * 850),
    instructions:
      '你是中文 PPT 修改助手。你只根据修改意见调整页面计划 JSON，不生成图片，不输出 Markdown。必须只输出有效 JSON。',
    input: buildPptRevisionPrompt(context),
    visualContext: context.visualContext,
  })

  return normalizePptPlan(parseJsonResponse(payload, 'GPT-5.5'), context.slideCount, context.fallbackTitle)
}

export async function revisePptPlanPartial(context) {
  const payload = await callOpenAi({
    temperature: 0.3,
    maxTokens: Math.max(4096, context.slideComments.length * 1200),
    instructions:
      '你是中文 PPT 局部修改助手。你只能返回用户要求修改的页面 JSON，不生成整套 PPT，不输出 Markdown。必须只输出有效 JSON。',
    input: buildPptPartialRevisionPrompt(context),
    visualContext: context.visualContext,
  })

  return mergePartialPptPlan(
    context.currentPlan,
    parseJsonResponse(payload, 'GPT-5.5'),
    context.slideComments,
    context.slideCount,
    context.fallbackTitle,
  )
}

export async function checkPptQuality(context) {
  const payload = await callOpenAi({
    temperature: 0.2,
    maxTokens: 4096,
    instructions:
      '你是中文 PPT 质量审稿人。你要直接、具体、严格，只输出质量自检 JSON，不输出 Markdown。',
    input: buildPptQualityCheckPrompt(context),
    visualContext: context.visualContext,
  })

  return normalizePptQualityCheck(parseJsonResponse(payload, 'GPT-5.5'), context.plan)
}

export async function generatePptImage({ prompt, outputPath }) {
  if (!hasAiKey()) {
    throw new Error('还没有配置 OPENAI_API_KEY。请先配置 OpenAI API Key。')
  }
  const safePrompt = String(prompt || '').trim()
  if (!safePrompt) throw new Error('缺少图片生成提示词。')

  const body = {
    model: modelName,
    input: [
      '请为中文 PPT 生成一张可直接放入幻灯片的图片。',
      '要求：无水印、无边框、不要生成可读文字或复杂中文字，画面干净，适合作为 16:9 演示文稿中的插图。',
      `图片需求：${safePrompt}`,
    ].join('\n'),
    tools: [
      {
        type: 'image_generation',
        size: '1024x1024',
        action: 'generate',
      },
    ],
    tool_choice: { type: 'image_generation' },
  }
  const json = await sendOpenAiRequest(body).catch((error) => {
    if (!isImageGenerationToolOptionsFallbackError(error)) throw error
    return sendOpenAiRequest({
      ...body,
      tools: [{ type: 'image_generation' }],
      tool_choice: undefined,
    })
  })

  const imageData = extractImageGenerationResult(json)
  if (!imageData) {
    throw new Error('GPT-5.5 图片生成没有返回可用图片。')
  }
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeImageResult(outputPath, imageData)
  return {
    outputPath,
    model: modelName,
  }
}

async function callOpenAi({ instructions, input, temperature, maxTokens, visualContext = null, tools = null }) {
  if (!hasAiKey()) {
    throw new Error('还没有配置 OPENAI_API_KEY。请先配置 OpenAI API Key，或切换到 DeepSeek 重试。')
  }

  const visualInput = await buildOpenAiInput(input, visualContext)
  const usedVisualInput = Array.isArray(visualInput)
  const body = {
    model: modelName,
    instructions,
    input: visualInput,
    temperature,
    max_output_tokens: maxTokens,
    reasoning: {
      effort: reasoningEffort,
    },
    text: {
      format: {
        type: 'json_object',
      },
    },
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
  }
  const json = await sendOpenAiRequest(body).catch(async (error) => {
    if (!usedVisualInput || !isVisualInputFallbackError(error)) throw error
    console.warn(`GPT-5.5 视觉输入暂不可用，已自动退回文本理解：${error.message}`)
    return sendOpenAiRequest({
      ...body,
      input: appendVisualFallbackNote(input, visualContext, error.message),
    })
  })

  const content = extractResponseText(json)
  if (!content) {
    throw new Error('GPT-5.5 没有返回内容。你可以切换到 DeepSeek 重试。')
  }
  return content
}

async function sendOpenAiRequest(body) {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const rawMessage = json?.error?.message || json?.message || 'OpenAI API 调用失败。'
    const error = new Error(`GPT-5.5 调用失败：${rawMessage}。你可以切换到 DeepSeek 重试。`)
    error.status = response.status
    error.rawMessage = rawMessage
    throw error
  }
  return json
}

function extractResponseText(json) {
  if (typeof json?.output_text === 'string') return json.output_text

  const output = Array.isArray(json?.output) ? json.output : []
  const chunks = []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const part of content) {
      if (typeof part?.text === 'string') chunks.push(part.text)
      if (typeof part?.content === 'string') chunks.push(part.content)
    }
  }

  return chunks.join('\n').trim()
}

function extractImageGenerationResult(json) {
  const output = Array.isArray(json?.output) ? json.output : []
  for (const item of output) {
    if (item?.type === 'image_generation_call') {
      const result = item.result || item.image || item.data
      if (typeof result === 'string' && result.trim()) return normalizeImageData(result)
    }
    const content = Array.isArray(item?.content) ? item.content : []
    for (const part of content) {
      const result = part?.result || part?.image || part?.data || part?.image_url
      if (typeof result === 'string' && result.trim()) return normalizeImageData(result)
    }
  }
  const direct = json?.result || json?.image || json?.url || json?.data?.[0]?.b64_json || json?.data?.[0]?.url
  return typeof direct === 'string' && direct.trim() ? normalizeImageData(direct) : ''
}

function normalizeImageData(value) {
  const text = String(value || '').trim()
  if (!text.startsWith('data:')) return text
  return text.split(',').at(-1) || ''
}

async function writeImageResult(outputPath, imageData) {
  const data = String(imageData || '').trim()
  if (/^https?:\/\//i.test(data)) {
    const response = await fetch(data)
    if (!response.ok) {
      throw new Error(`图片下载失败：HTTP ${response.status}`)
    }
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
    return
  }
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(data) || data.length < 80) {
    throw new Error('GPT-5.5 图片生成返回了无法识别的图片数据。')
  }
  await writeFile(outputPath, data.replace(/\s+/g, ''), 'base64')
}

async function buildOpenAiInput(text, visualContext) {
  const pages = (visualContext?.pages || []).slice(0, maxVisualPages)
  if (!pages.length) return text

  const content = [
    {
      type: 'input_text',
      text: [
        text,
        '',
        '以下页面截图是同一任务的视觉上下文。请结合截图中可见的文字、图示、流程图、表格、图片含义和版式信息进行理解；如果截图和提取文字冲突，以截图中清晰可见的信息为准。',
        ...(visualContext?.notes || []).map((note) => `- ${note}`),
      ].join('\n'),
    },
  ]

  for (const page of pages) {
    try {
      const imageUrl = await imagePathToDataUrl(page.imagePath, page.mimeType)
      content.push({
        type: 'input_text',
        text: `视觉页：${page.label || `第 ${page.pageNumber || content.length} 页`}`,
      })
      content.push({
        type: 'input_image',
        image_url: imageUrl,
      })
    } catch (error) {
      content.push({
        type: 'input_text',
        text: `视觉页读取失败：${page.label || page.imagePath}（${error.message}）`,
      })
    }
  }

  return [{ role: 'user', content }]
}

async function imagePathToDataUrl(imagePath, mimeType = 'image/png') {
  const data = await readFile(imagePath)
  return `data:${mimeType || 'image/png'};base64,${data.toString('base64')}`
}

function isVisualInputFallbackError(error) {
  const message = String(error?.rawMessage || error?.message || '')
  return Boolean(error?.status === 400 || error?.status === 415 || error?.status === 422 || error?.status === 503)
    || /input_image|image|vision|multimodal|供应商暂时不可用|暂时不可用|unsupported/i.test(message)
}

function isImageGenerationToolOptionsFallbackError(error) {
  const message = String(error?.rawMessage || error?.message || '')
  return Boolean(error?.status === 400 || error?.status === 422)
    && /tool_choice|action|size|unknown parameter|unsupported|invalid/i.test(message)
}

function appendVisualFallbackNote(text, visualContext, reason) {
  const notes = [
    text,
    '',
    '注意：本次 GPT 视觉输入通道暂时不可用，系统已自动退回文本理解。',
    `降级原因：${reason}`,
    ...(visualContext?.notes || []).map((note) => `- ${note}`),
  ]
  return notes.join('\n')
}

function normalizeOpenAiApiUrl() {
  if (process.env.OPENAI_API_URL) return process.env.OPENAI_API_URL
  const baseUrl = process.env.OPENAI_BASE_URL
  if (!baseUrl) return 'https://api.openai.com/v1/responses'
  return `${baseUrl.replace(/\/+$/, '')}/responses`
}
