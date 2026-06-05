export const PPT_MODES = ['风格复用', '版式套用', '原稿改写']
export const PPT_TYPES = ['课程汇报', '论文答辩', '商业方案', '读书报告', '课堂展示', '培训课件']
export const PPT_MIN_SLIDES = 1
export const PPT_MAX_SLIDES = 30

function buildStructuredModeBlock(context) {
  if (!context.structuredPagePlan) return ''
  return `
五类母版结构（最高优先级，必须遵守）：
- 用户设置的是 PPT 内容页数：${context.contentSlideCount || context.structuredPagePlan.contentSlideCount || context.slideCount}。
- 系统会自动加入封面、目录、每章标题页和结尾页，所以本次实际总页数是：${context.slideCount}。
- 必须包含五个逻辑板块：封面、目录、标题页、内容页、结尾页。
- 每个章节前必须有标题页；内容章节数由系统计划给出。
- structuredPagePlan 已经固定每页 role、layout 和 sourceSlide；不要自行改变页型顺序。
- sourceSlide 固定映射：封面=1，目录=2，标题页=3，内容页=4，结尾=5。
- 如果某一类母版未上传，系统会从主模板中抽取可编辑页面兜底；仍然要按对应页型使用。
- 不要把目录页当内容页，不要把内容页当目录页，不要把标题页当正文页。
- 用户母版补充说明优先于母版本身，母版优先于模板，模板优先于 AI 自行发挥。

structuredPagePlan：
${JSON.stringify(context.structuredPagePlan, null, 2)}

五类母版信息：
${JSON.stringify(context.structuredMasters || null, null, 2)}
`
}

export function buildPptNarrativePlanPrompt(context) {
  return `请先为这份 PPT 生成中文“内容叙事大纲 + 页面策略”，并只返回 JSON。

这个步骤不是选择模板页，也不是填充 PPT。你要先理解用户内容，把它拆成一套有逻辑、有主线、适合做成 PPT 的页面策略。后续系统会根据这个策略去匹配模板页。

生成目标：
- PPT 类型：${context.pptType}
- 生成模式：${context.mode}
- 总页数：${context.slideCount}
- PPT 内容页数：${context.contentSlideCount || context.slideCount}
- 主模板：${context.mainTemplateName}
- 辅助模板：${context.auxiliaryTemplateNames.join('、') || '无'}
${buildStructuredModeBlock(context)}

用户输入的 PPT 内容：
${context.contentText || '用户未提供明确内容。'}

用户上传内容文件提取文本：
${context.contentFileText || '无'}

用户 PPT 制作需求：
${context.requirements || '用户未填写，请你自行组织内容。'}

模板页画像摘要：
${JSON.stringify(context.templatePageProfiles || [], null, 2)}

要求：
1. 必须刚好规划 ${context.slideCount} 页。
2. 先建立叙事主线，不要把原文机械切块。
3. 每一页只承载一个清晰核心信息，避免一页堆多个结论。
4. 根据内容选择 layoutIntent，只能是 cover、agenda、section、content、two_column、comparison、timeline、quote、summary。
5. keyMessage 要锋利具体，不要写“介绍背景”“阐述内容”这类空标题。
6. contentPriority 用 high、medium、low 表示这一页信息密度，便于后续控制字数。
7. suggestedTemplateRole 写该页更适合的模板角色：cover_candidate、toc_candidate、chapter_candidate、content_candidate、ending_candidate。
8. visualDirection 写页面表达方式，例如“左右对比”“三点递进”“结论先行”“时间顺序”“大标题少文字”。
9. 如果用户内容不足，可以合理补全结构，但要在 assumptions 中说明，不要假装来自用户材料。
10. 如果提供了 structuredPagePlan，slides[n] 的 role、layoutIntent、suggestedTemplateRole 必须贴合 structuredPagePlan.slides[n]，不能调整顺序。

JSON 格式：
{
  "title": "整套 PPT 标题",
  "subtitle": "副标题",
  "audience": "目标观众",
  "coreMessage": "整套 PPT 最核心的一句话",
  "storyline": ["叙事节点 1", "叙事节点 2"],
  "assumptions": ["内容不足时的补全假设"],
  "slides": [
    {
      "slideNumber": 1,
      "role": "cover",
      "layoutIntent": "cover",
      "keyMessage": "本页核心信息",
      "contentPriority": "high",
      "suggestedTemplateRole": "cover_candidate",
      "visualDirection": "大标题少文字",
      "mustSay": ["必须出现的信息"],
      "supportingPoints": ["辅助要点 1", "辅助要点 2"],
      "avoid": ["本页不要塞入的信息"]
    }
  ]
}`
}

export function buildPptTemplateFillPrompt(context) {
  return `请根据用户内容和 PPTX 模板页面库，生成中文 PPT 模板填充计划，并只返回 JSON。

这个任务不是从零设计 PPT，而是根据“内容叙事大纲 + 页面策略”选择模板中的源页面，克隆页面，并把新内容写入已有文本槽位。
${context.templateFillSourceRole === 'master'
  ? '\n重要：当前源文件是用户上传的“幻灯片母版 PPTX”。你必须把它当成可编辑母版直接修改，只替换母版页面中原有示例文字，不允许把母版当背景图，也不允许新增白色文本框、色块、遮罩或任何新页面元素。'
  : ''}
${context.templateFillSourceRole === 'structured-master'
  ? '\n重要：当前源文件是五类母版组合成的可编辑 PPTX。第 1 页封面、第 2 页目录、第 3 页标题页、第 4 页内容页、第 5 页结尾页。你必须直接替换这些 PPTX 页里的可编辑文本槽位，不能把母版当背景图，不能新增白色文本框、色块或遮罩。'
  : ''}

生成目标：
- PPT 类型：${context.pptType}
- 生成模式：${context.mode}
- 总页数：${context.slideCount}
- PPT 内容页数：${context.contentSlideCount || context.slideCount}
- 主模板：${context.mainTemplateName}
- 当前直接编辑源：${context.templateFillSourceName || context.mainTemplateName}
${buildStructuredModeBlock(context)}

用户输入的 PPT 内容：
${context.contentText || '用户未提供明确内容。'}

用户上传内容文件提取文本：
${context.contentFileText || '无'}

用户 PPT 制作需求：
${context.requirements || '用户未填写，请你自行组织内容。'}

内容叙事大纲和页面策略（必须优先遵守）：
${JSON.stringify(context.narrativePlan || null, null, 2)}

模板页画像和适配建议：
${JSON.stringify(context.templatePageProfiles || [], null, 2)}

模板页面库：
${JSON.stringify(context.templateFillLibrary, null, 2)}

规则：
1. 必须刚好生成 ${context.slideCount} 页。
2. 只能使用模板页面库里存在的 source_slide 和 slot_id，不要编造槽位。
3. source_slide 必须优先匹配 narrativePlan.slides[n].suggestedTemplateRole 和 layoutIntent，不要机械按模板原顺序替换。
4. 可以重复使用同一个 source_slide，也可以跳过不适合的源页面；输出顺序必须服务内容逻辑。
5. 第 1 页优先使用 cover_candidate；最后 1 页优先使用 ending_candidate 或总结型页面；中间页面选择最适合表达内容的 content_candidate/toc_candidate/chapter_candidate。
6. 每个 replacement 的文字必须适合该 slot 的容量。中文尤其要短，标题控制在 4-16 个汉字，标签控制在 2-12 个汉字，正文槽位也尽量用短句。
7. contentPriority 为 high 的页面也不能堆字，宁可表达更锋利；low 页面必须克制留白。
8. 不要填满所有槽位。只替换真正需要承载内容的槽位；页码、装饰性极短数字、品牌标语如果不确定可以保留原样。
9. notes 写演讲者备注，2-4 句自然中文，不要复制页面文字。
10. 默认不要生成图片，不要要求新增页面元素；只有五类母版模式的内容页可以通过 extra_shapes 添加少量透明可编辑文本框或图片占位建议。
11. 如内容不足，合理补全结构，但不要声称来自用户材料。
12. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
13. 如果源文件是母版 PPTX：保留 logo、页眉页脚、页码、装饰线、背景、数字编号、红色侧栏等固定视觉元素；优先替换 XXXXX、占位标题、占位正文、示例项目名等明显示例文字。
14. 如果源文件是母版 PPTX：不要把“目录”“01”“02”“03”“04”这类结构性文字随意改掉，除非它本身就是该页唯一需要表达的新内容。
15. 如果提供 structuredPagePlan：第 n 页的 source_slide 必须等于 structuredPagePlan.slides[n-1].sourceSlide，layout 必须等于 structuredPagePlan.slides[n-1].layout。
16. 五类母版模式下，封面、目录、标题页、结尾页只替换原有文本槽位；内容页可以使用 extra_shapes 添加少量可编辑元素，但新增文本框必须透明，不得覆盖母版结构。
17. DeepSeek 不生成真实图片；GPT-5.5 当前只允许输出 image_placeholder 作为图片占位/建议，不生成真实图片。

JSON 格式：
{
  "title": "整套 PPT 标题",
  "subtitle": "副标题",
  "slides": [
    {
      "source_slide": 1,
      "purpose": "cover",
      "layout": "cover",
      "notes": "演讲备注",
      "transition": "fade",
      "replacements": [
        {"slot_id": "s01_sh2", "text": "新标题"}
      ],
      "table_edits": [],
      "chart_edits": [],
      "extra_shapes": [
        {
          "kind": "text",
          "x": 0.08,
          "y": 0.22,
          "width": 0.36,
          "height": 0.18,
          "text": "透明可编辑补充文字",
          "fill_transparency": 100,
          "line_transparency": 100
        }
      ]
    }
  ]
}`
}

export function buildPptPlanPrompt(context) {
  return `请根据用户内容和模板参考，生成中文 PPT 页面计划，并只返回 JSON。

生成目标：
- PPT 类型：${context.pptType}
- 生成模式：${context.mode}
- 总页数：${context.slideCount}
- PPT 内容页数：${context.contentSlideCount || context.slideCount}
- 主模板：${context.mainTemplateName}
- 辅助模板：${context.auxiliaryTemplateNames.join('、') || '无'}
- 幻灯片母版：${context.master?.uploaded ? context.master.originalName : context.master?.description ? '仅文字描述' : '未提供'}
${buildStructuredModeBlock(context)}

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

内容叙事大纲和页面策略（如果提供，必须优先遵守）：
${JSON.stringify(context.narrativePlan || null, null, 2)}

幻灯片母版要求（最高优先级）：
${context.structuredMasters ? JSON.stringify(context.structuredMasters, null, 2) : context.master ? JSON.stringify(context.master, null, 2) : '用户未提供母版文件或母版描述，沿用模板参考与现有生成逻辑。'}

模板可提取信息：
${JSON.stringify(context.templates, null, 2)}

优先级规则：
1. 用户对母版的补充说明优先级最高。
2. 如果上传了母版 PPTX，必须优先遵守母版的颜色、字体、页眉页脚、背景、标题位置、内容区位置、形状、装饰线、图片、logo、页码位置。
3. 如果上传母版且用户没有额外说明，页面计划要尽量 1:1 复刻母版的视觉结构；模板文件只作为辅助参考。
4. 如果没有上传母版，但有母版文字描述，则优先遵守文字描述。
5. 如果母版和主模板冲突，母版优先。

输出要求：
1. 统一使用中文。
2. 必须刚好生成 ${context.slideCount} 页。
3. 不要要求生成真实新图片。DeepSeek 不写图片占位，GPT-5.5 可在五类母版内容页使用图片占位/图片建议。
4. 每页 bullets 建议 2-5 条，每条尽量短，适合放在 PPT 上。
5. speakerNotes 可写给演讲者看的补充说明，不要太长。
6. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
7. emphasis 只能从 calm、sharp、warm、formal 中选择。
8. 如果内容不足，请用合理结构补全，但不要假装来自用户材料。
9. 如果上传了母版，layout 要尽量匹配自动识别的母版页类型：封面用 cover，目录用 agenda，章节页用 section，正文页用 content/two_column/comparison/timeline，结尾用 summary。
10. 如果提供了内容叙事大纲，页面标题、核心要点和 layout 必须贴合对应页的 keyMessage、layoutIntent 和 visualDirection。
11. 如果提供 structuredPagePlan，必须按 structuredPagePlan 的页型和顺序生成，不得删除封面、目录、章节标题页或结尾页。

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
幻灯片母版：${context.master?.uploaded ? context.master.originalName : context.master?.description ? '仅文字描述' : '未提供'}
${buildStructuredModeBlock(context)}

原页面计划：
${JSON.stringify(context.currentPlan, null, 2)}

用户逐页修改意见：
${JSON.stringify(context.slideComments, null, 2)}

原始内容文本：
${context.contentText || '无'}

制作需求：
${context.requirements || '无'}

幻灯片母版要求（最高优先级）：
${context.structuredMasters ? JSON.stringify(context.structuredMasters, null, 2) : context.master ? JSON.stringify(context.master, null, 2) : '无'}

要求：
1. 对有修改意见的页面优先修改，没意见的页面可以保持原结构。
2. 必须刚好返回 ${context.slideCount} 页。
3. 不生成新图片。
4. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
5. emphasis 只能从 calm、sharp、warm、formal 中选择。
6. 如果上传了母版，继续优先保留母版视觉结构，只调整用户要求修改的内容。
7. 如果提供 structuredPagePlan，页数、页型顺序和每页 layout 必须保持 structuredPagePlan 不变。
8. 只返回 JSON，格式与原页面计划一致。`
}

export function buildPptPartialRevisionPrompt(context) {
  return `请根据用户逐页修改意见，只修改指定页面，并只返回 JSON。

这是局部修改任务，不是重新生成整套 PPT。你只能返回用户有修改意见的页面。

整套 PPT 页数：${context.slideCount}
生成模式：${context.mode}
PPT 类型：${context.pptType}
主模板：${context.mainTemplateName}
${buildStructuredModeBlock(context)}

整套页面计划：
${JSON.stringify(context.currentPlan, null, 2)}

需要修改的页面：
${JSON.stringify(context.targetSlides, null, 2)}

用户逐页修改意见：
${JSON.stringify(context.slideComments, null, 2)}

原始内容文本：
${context.contentText || '无'}

制作需求：
${context.requirements || '无'}

幻灯片母版要求（最高优先级）：
${context.structuredMasters ? JSON.stringify(context.structuredMasters, null, 2) : context.master ? JSON.stringify(context.master, null, 2) : '无'}

要求：
1. 只返回有修改意见的页面，不要返回未修改页面。
2. slideNumber 必须对应原页码，不能新增、删除或调换页面。
3. 未被用户要求改变的标题、版式、语气、备注和内容尽量保持。
4. 修改必须具体落实用户意见，不要只做同义改写。
5. 不生成新图片，不要求新增无法落地的元素。
6. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
7. emphasis 只能从 calm、sharp、warm、formal 中选择。
8. 如果上传了母版，继续优先保留母版视觉结构，只调整该页文本内容。
9. 如果提供 structuredPagePlan，不能把目录页、标题页、内容页、结尾页互相改换角色。

JSON 格式：
{
  "slides": [
    {
      "slideNumber": 2,
      "title": "修改后的页面标题",
      "subtitle": "修改后的副标题",
      "layout": "content",
      "emphasis": "warm",
      "bullets": ["修改后的要点 1", "修改后的要点 2"],
      "footer": "页脚",
      "speakerNotes": "演讲备注"
    }
  ]
}`
}

export function buildPptQualityCheckPrompt(context) {
  return `请对这份中文 PPT 生成结果做质量自检，并只返回 JSON。

你要像严格的 PPT 审稿人一样检查，不要客套。只评价页面计划和生成约束，不要声称看到了最终图片之外的细节。

生成目标：
- PPT 类型：${context.pptType}
- 生成模式：${context.mode}
- 总页数：${context.slideCount}
- PPT 内容页数：${context.contentSlideCount || context.slideCount}
- 主模板：${context.mainTemplateName}
${buildStructuredModeBlock(context)}

用户输入内容：
${context.contentText || '用户未提供明确内容。'}

用户上传内容文件提取文本：
${context.contentFileText || '无'}

制作需求：
${context.requirements || '无'}

模板/母版约束：
${context.structuredMasters ? JSON.stringify(context.structuredMasters, null, 2) : context.master ? JSON.stringify(context.master, null, 2) : '未提供母版。'}

最终页面计划：
${JSON.stringify(context.plan, null, 2)}

渲染与模板检查信息：
${JSON.stringify(context.renderInfo || {}, null, 2)}

内容叙事大纲和页面策略：
${JSON.stringify(context.narrativePlan || null, null, 2)}

模板页匹配/容量诊断：
${JSON.stringify(context.templateDiagnostics || null, null, 2)}

检查维度：
1. 是否贴合用户内容和制作需求。
2. 是否遵守叙事大纲，是否每页只有一个核心信息。
3. 模板页选择是否匹配页面意图，是否保留模板/母版优先级。
4. 页数、结构、标题层级是否清晰。
5. 单页文字量是否可能过多，是否存在容量压缩痕迹。
6. 是否存在内容空泛、重复、逻辑跳跃或结论不足。
7. 如果有模板填充检查 warning/error，要指出风险。

JSON 格式：
{
  "score": 0-100,
  "summary": "一句话总体评价",
  "passed": true,
  "issues": [
    {
      "severity": "high|medium|low",
      "slideNumber": 2,
      "title": "问题标题",
      "detail": "具体问题",
      "suggestion": "具体修正建议"
    }
  ],
  "checks": [
    {"label": "内容贴合", "status": "pass|warn|fail", "detail": "判断依据"}
  ]
}`
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

export function normalizePptNarrativePlan(value, expectedCount, fallbackTitle = 'Moonwalk PPT') {
  const slides = Array.isArray(value?.slides) ? value.slides : []
  const normalizedSlides = slides.slice(0, expectedCount).map((slide, index) => normalizeNarrativeSlide(slide, index, expectedCount))
  while (normalizedSlides.length < expectedCount) {
    normalizedSlides.push(normalizeNarrativeSlide({}, normalizedSlides.length, expectedCount))
  }

  return {
    title: String(value?.title || fallbackTitle),
    subtitle: String(value?.subtitle || ''),
    audience: String(value?.audience || ''),
    coreMessage: String(value?.coreMessage || value?.summary || ''),
    storyline: normalizeStringList(value?.storyline).slice(0, 8),
    assumptions: normalizeStringList(value?.assumptions).slice(0, 6),
    slides: normalizedSlides,
  }
}

export function mergePartialPptPlan(currentPlan, partialValue, slideComments, expectedCount, fallbackTitle = 'Moonwalk PPT') {
  const basePlan = normalizePptPlan(currentPlan, expectedCount, fallbackTitle)
  const allowedSlideNumbers = new Set(slideComments.map((item) => Number(item.slideNumber)).filter(Boolean))
  const partialSlides = Array.isArray(partialValue?.slides) ? partialValue.slides : []
  const mergedSlides = [...basePlan.slides]

  partialSlides.forEach((slide) => {
    const slideNumber = Number(slide?.slideNumber)
    if (!allowedSlideNumbers.has(slideNumber)) return
    const index = slideNumber - 1
    if (index < 0 || index >= mergedSlides.length) return
    mergedSlides[index] = normalizeSlide({
      ...mergedSlides[index],
      ...slide,
    }, index)
  })

  return {
    ...basePlan,
    title: String(partialValue?.title || basePlan.title || fallbackTitle),
    subtitle: String(partialValue?.subtitle || basePlan.subtitle || ''),
    slides: mergedSlides,
  }
}

export function normalizePptQualityCheck(value, plan) {
  const issues = Array.isArray(value?.issues) ? value.issues : []
  const checks = Array.isArray(value?.checks) ? value.checks : []
  const normalizedIssues = issues.slice(0, 10).map((issue) => ({
    severity: ['high', 'medium', 'low'].includes(issue?.severity) ? issue.severity : 'medium',
    slideNumber: normalizeSlideNumber(issue?.slideNumber, plan?.slides?.length),
    title: String(issue?.title || '需要检查的问题'),
    detail: String(issue?.detail || ''),
    suggestion: String(issue?.suggestion || ''),
  }))
  const normalizedChecks = checks.slice(0, 8).map((check) => ({
    label: String(check?.label || '质量检查'),
    status: ['pass', 'warn', 'fail'].includes(check?.status) ? check.status : 'warn',
    detail: String(check?.detail || ''),
  }))
  const score = Number(value?.score)

  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : inferQualityScore(normalizedIssues),
    summary: String(value?.summary || '已完成质量自检。'),
    passed: typeof value?.passed === 'boolean'
      ? value.passed
      : !normalizedIssues.some((issue) => issue.severity === 'high'),
    issues: normalizedIssues,
    checks: normalizedChecks,
    generatedAt: new Date().toISOString(),
  }
}

function normalizeNarrativeSlide(slide, index, total) {
  const layoutIntent = normalizePptLayout(slide?.layoutIntent || slide?.layout, index)
  return {
    slideNumber: index + 1,
    role: String(slide?.role || inferNarrativeRole(index, total)),
    layoutIntent,
    keyMessage: String(slide?.keyMessage || slide?.title || `第 ${index + 1} 页核心信息`),
    contentPriority: ['high', 'medium', 'low'].includes(slide?.contentPriority) ? slide.contentPriority : 'medium',
    suggestedTemplateRole: normalizeSuggestedTemplateRole(slide?.suggestedTemplateRole, index, total),
    visualDirection: String(slide?.visualDirection || inferVisualDirection(layoutIntent)),
    mustSay: normalizeStringList(slide?.mustSay).slice(0, 4),
    supportingPoints: normalizeStringList(slide?.supportingPoints || slide?.bullets).slice(0, 5),
    avoid: normalizeStringList(slide?.avoid).slice(0, 4),
  }
}

function normalizeSlide(slide, index) {
  const layout = normalizePptLayout(slide?.layout, index)
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

function normalizePptLayout(value, index) {
  const layout = String(value || '')
  const allowed = ['cover', 'agenda', 'section', 'content', 'two_column', 'comparison', 'timeline', 'quote', 'summary']
  if (allowed.includes(layout)) return layout
  return index === 0 ? 'cover' : 'content'
}

function normalizeSuggestedTemplateRole(value, index, total) {
  const role = String(value || '')
  const allowed = ['cover_candidate', 'toc_candidate', 'chapter_candidate', 'content_candidate', 'ending_candidate']
  if (allowed.includes(role)) return role
  if (index === 0) return 'cover_candidate'
  if (index === total - 1) return 'ending_candidate'
  return 'content_candidate'
}

function inferNarrativeRole(index, total) {
  if (index === 0) return 'cover'
  if (index === total - 1) return 'summary'
  return 'content'
}

function inferVisualDirection(layout) {
  const directions = {
    cover: '大标题少文字',
    agenda: '清晰目录结构',
    section: '章节分隔',
    two_column: '左右分栏',
    comparison: '对比呈现',
    timeline: '时间顺序',
    quote: '一句话强调',
    summary: '结论先行',
    content: '三点递进',
  }
  return directions[layout] || '清晰层级'
}

function normalizeSlideNumber(value, total) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) return null
  if (total && number > total) return total
  return number
}

function inferQualityScore(issues) {
  const penalty = issues.reduce((total, issue) => {
    if (issue.severity === 'high') return total + 18
    if (issue.severity === 'medium') return total + 9
    return total + 4
  }, 0)
  return Math.max(55, 92 - penalty)
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function normalizeHex(value, fallback) {
  const cleaned = String(value || '').replace('#', '').trim().toUpperCase()
  return /^[0-9A-F]{6}$/.test(cleaned) ? cleaned : fallback
}
