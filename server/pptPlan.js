export const PPT_MODES = ['风格复用', '版式套用', '原稿改写']
export const PPT_TYPES = ['课程汇报', '论文答辩', '商业方案', '读书报告', '课堂展示', '培训课件']
export const PPT_MIN_SLIDES = 1
export const PPT_MAX_SLIDES = 30

export function buildPptPlanPrompt(context) {
  return `请根据用户内容和模板参考，生成中文 PPT 页面计划，并只返回 JSON。

生成目标：
- PPT 类型：${context.pptType}
- 生成模式：${context.mode}
- 页数：${context.slideCount}
- 主模板：${context.mainTemplateName}
- 辅助模板：${context.auxiliaryTemplateNames.join('、') || '无'}

生成模式说明：
- 风格复用：学习模板的色系、气质和图文比例，内容结构由你重新组织。
- 版式套用：尽量为每页选择类似模板的页面结构，例如封面、目录、分栏、结论页。
- 原稿改写：更像把用户内容改写成一套表达更顺的 PPT，模板只提供视觉秩序。

用户输入的 PPT 内容：
${context.contentText || '用户未提供明确内容，请根据 PPT 类型和制作需求生成一套合理内容。'}

用户上传内容文件提取文本：
${context.contentFileText || '无'}

用户 PPT 制作需求：
${context.requirements || '用户未填写，请你自行选择清晰、克制、适合中文展示的表达方式。'}

模板可提取信息：
${JSON.stringify(context.templates, null, 2)}

输出要求：
1. 统一使用中文。
2. 必须刚好生成 ${context.slideCount} 页。
3. 不要要求生成新图片，不要写“插入图片占位符”这类无法落地的内容。
4. 每页 bullets 建议 2-5 条，每条尽量短，适合放在 PPT 上。
5. speakerNotes 可写给演讲者看的补充说明，不要太长。
6. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
7. emphasis 只能从 calm、sharp、warm、formal 中选择。
8. 如果内容不足，请用合理结构补全，但不要假装来自用户材料。

JSON 格式：
{
  "title": "整套 PPT 标题",
  "subtitle": "副标题或一句话说明",
  "theme": {
    "tone": "整体语气",
    "primaryColor": "6 位十六进制色值，不带 #",
    "accentColor": "6 位十六进制色值，不带 #",
    "backgroundColor": "6 位十六进制色值，不带 #"
  },
  "slides": [
    {
      "title": "页面标题",
      "subtitle": "可选副标题",
      "layout": "cover",
      "emphasis": "warm",
      "bullets": ["要点 1", "要点 2"],
      "footer": "可选页脚",
      "speakerNotes": "可选演讲备注"
    }
  ]
}`
}

export function buildPptRevisionPrompt(context) {
  return `请根据用户逐页修改意见，重新生成中文 PPT 页面计划，并只返回 JSON。

必须保持页数不变：${context.slideCount} 页。
生成模式：${context.mode}
PPT 类型：${context.pptType}
主模板：${context.mainTemplateName}

原页面计划：
${JSON.stringify(context.currentPlan, null, 2)}

用户逐页修改意见：
${JSON.stringify(context.slideComments, null, 2)}

原始内容文本：
${context.contentText || '无'}

制作需求：
${context.requirements || '无'}

要求：
1. 对有修改意见的页面优先修改，没意见的页面可以保持原结构。
2. 必须刚好返回 ${context.slideCount} 页。
3. 不生成新图片。
4. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
5. emphasis 只能从 calm、sharp、warm、formal 中选择。
6. 只返回 JSON，格式与原页面计划一致。`
}

export function normalizePptPlan(value, expectedCount, fallbackTitle = 'Moonwalk PPT') {
  const slides = Array.isArray(value?.slides) ? value.slides : []
  const normalizedSlides = slides.slice(0, expectedCount).map((slide, index) => normalizeSlide(slide, index))
  while (normalizedSlides.length < expectedCount) {
    normalizedSlides.push(normalizeSlide({ title: `第 ${normalizedSlides.length + 1} 页`, layout: 'content' }, normalizedSlides.length))
  }

  const theme = value?.theme && typeof value.theme === 'object' ? value.theme : {}
  return {
    title: String(value?.title || fallbackTitle),
    subtitle: String(value?.subtitle || ''),
    theme: {
      tone: String(theme.tone || '清晰、克制、适合中文展示'),
      primaryColor: normalizeHex(theme.primaryColor, 'B86232'),
      accentColor: normalizeHex(theme.accentColor, 'C77D4D'),
      backgroundColor: normalizeHex(theme.backgroundColor, 'FFF7EE'),
    },
    slides: normalizedSlides,
  }
}

function normalizeSlide(slide, index) {
  const layout = ['cover', 'agenda', 'section', 'content', 'two_column', 'comparison', 'timeline', 'quote', 'summary']
    .includes(slide?.layout)
    ? slide.layout
    : index === 0
      ? 'cover'
      : 'content'
  const emphasis = ['calm', 'sharp', 'warm', 'formal'].includes(slide?.emphasis)
    ? slide.emphasis
    : 'warm'
  return {
    title: String(slide?.title || `第 ${index + 1} 页`),
    subtitle: String(slide?.subtitle || ''),
    layout,
    emphasis,
    bullets: normalizeStringList(slide?.bullets).slice(0, 6),
    footer: String(slide?.footer || ''),
    speakerNotes: String(slide?.speakerNotes || ''),
  }
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function normalizeHex(value, fallback) {
  const cleaned = String(value || '').replace('#', '').trim().toUpperCase()
  return /^[0-9A-F]{6}$/.test(cleaned) ? cleaned : fallback
}
