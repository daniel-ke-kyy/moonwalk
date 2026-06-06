export const PPT_MODES = ['风格复用', '版式套用', '原稿改写']
export const PPT_TYPES = ['课程汇报', '论文答辩', '商业方案', '读书报告', '课堂展示', '培训课件']
export const PPT_MIN_SLIDES = 1
export const PPT_MAX_SLIDES = 30

const PPT_PAGE_TYPES = [
  'cover',
  'agenda',
  'section',
  'problem',
  'insight',
  'argument',
  'comparison',
  'process',
  'timeline',
  'data',
  'case',
  'quote',
  'summary',
  'closing',
]

const PAGE_TYPE_LAYOUT_MAP = {
  cover: 'cover',
  agenda: 'agenda',
  section: 'section',
  problem: 'content',
  insight: 'content',
  argument: 'two_column',
  comparison: 'comparison',
  process: 'timeline',
  timeline: 'timeline',
  data: 'comparison',
  case: 'two_column',
  quote: 'quote',
  summary: 'summary',
  closing: 'summary',
}

export function inferPptDesignIntent(session) {
  const directiveText = [
    session?.requirements,
    session?.masterDescription,
  ].map((text) => String(text || '').trim()).filter(Boolean).join('\n')
  const userText = [
    directiveText,
    session?.contentText,
  ].map((text) => String(text || '').trim()).filter(Boolean).join('\n')
  const materialText = String(session?.contentFileText || '')
  const layoutSkeletonFixed = Boolean(session?.structuredPagePlan)
  const explicitOutline = extractExplicitOutline(userText)
  const materialOutline = explicitOutline.length ? [] : extractMaterialOutline([session?.contentText, materialText].join('\n'))
  const pageTypeHints = extractPageTypeHints(directiveText)
  const explicitConstraints = extractExplicitPptConstraints(directiveText)
  const hasExplicitStructure = explicitOutline.length > 0
    || pageTypeHints.length > 0
    || explicitConstraints.length > 0
    || /(?:按|按照|依照|根据).{0,18}(?:结构|顺序|流程|框架|大纲|章节|目录|逻辑)|(?:不要|不需要|无需|必须|请保留|请使用).{0,18}(?:目录|封面|章节|标题页|结尾|总结|对比|流程|时间线|案例|数据)/i.test(directiveText)
  const hasImplicitOutline = !hasExplicitStructure && materialOutline.length > 0

  return {
    layoutSkeletonFixed,
    structureSource: hasExplicitStructure
        ? 'explicit_user'
        : hasImplicitOutline
          ? 'implicit_material'
          : 'ai_decide',
    planningMode: hasExplicitStructure
      ? 'execute_user_structure'
      : hasImplicitOutline
        ? 'follow_material_outline'
        : 'director_mode',
    aiMayReorganize: !hasExplicitStructure,
    lockedOutline: explicitOutline.length ? explicitOutline : materialOutline,
    pageTypeHints,
    explicitConstraints,
    evidence: buildDesignIntentEvidence({
      layoutSkeletonFixed,
      explicitOutline,
      materialOutline,
      pageTypeHints,
      explicitConstraints,
    }),
  }
}

function buildDesignDirectorBlock(context) {
  return `
PPT 设计导演规则（最高优先级之一，必须贯穿后续所有页面规划）：
- 先判断用户是否已经指定结构、顺序、页面类型、重点或禁忌；用户说清楚的内容必须优先执行，AI 不能擅自重排。
- 如果 designIntent.structureSource 是 explicit_user：你是“执行型设计师”，只能把用户结构做得更像 PPT，不要自作主张改逻辑链。
- 如果 designIntent.structureSource 是 implicit_material：沿用材料本身的大纲/章节顺序，在不破坏原逻辑的前提下压缩和视觉化。
- 只有 designIntent.structureSource 是 ai_decide 时，才由你主动设计整套叙事结构。
- 如果 designIntent.layoutSkeletonFixed 为 true，表示系统已经固定封面、目录、章节标题页、内容页、结尾页这些页面骨架；这只是版式骨架限制，不代表用户指定了叙事内容。你仍要按用户结构优先、材料大纲其次、AI 自行规划最后的规则决定内容逻辑。
- 用户提供的内容和需求如果冲突，优先遵守“PPT 制作需求”和“母版补充说明”，再处理内容文件。

用户结构意图识别结果：
${JSON.stringify(context.designIntent || null, null, 2)}

页面类型库（每一页必须选择一个 pageType，避免整套都是普通 bullet 页）：
- cover：封面，只放标题、副标题、关键信息。
- agenda：目录/议程，展示章节或逻辑路线。
- section：章节标题页，用于切换部分。
- problem：问题页，明确矛盾、痛点、研究问题或待解决缺口。
- insight：观点页，一页只讲一个锋利结论。
- argument：论证页，观点 + 证据/理由。
- comparison：对比页，适合两类对象、方案、前后差异。
- process：流程页，适合步骤、机制、方法路径。
- timeline：时间线页，适合阶段、历史、项目进度。
- data：数据/指标页，适合数字关系、占比、趋势、表格或图表。
- case：案例页，适合具体实例、文本细读、项目样例。
- quote：强调页，适合一句话判断、关键定义、引用。
- summary：总结页，提炼结论和下一步。
- closing：结尾页，感谢、答疑、联系方式或收束。

真正像 PPT 的设计规则：
- 每页必须有一个明确“本页要证明/说明什么”，不要把原文切成段落搬上去。
- 标题要像结论，不要像章节标签；避免“背景介绍”“主要内容”“相关分析”这类空泛标题。
- 先压缩内容，再选版式：长段落要拆成短标题、关键词、对比、流程、案例、结论框或表格。
- 单页默认 2-4 个信息块；除非是目录/数据页，不要超过 5 个主要信息块。
- 保持页面功能变化：内容页之间应有观点页、问题页、对比页、流程页、案例页或数据页的差异，不要连续生成同一种普通页。
- 视觉表达必须服务逻辑：有对立就用 comparison，有步骤就用 process/timeline，有指标就用 data，有文本/案例就用 case，有核心观点就用 insight/quote。
`
}

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
- 如果某一类母版未上传，系统会优先从用户上传模板中挑选相近的可编辑源页；没有合适模板页时才生成该页型的可编辑兜底页。无论来源如何，仍然要按对应页型使用。
- 如果五类母版全部未上传，也必须生成封面、目录、章节标题页、内容页、结尾页这五个逻辑板块，并尽量贴合模板文件风格。
- 五类母版信息里的 source=uploaded-master 表示用户上传母版，必须原位替换/清空可编辑文本；source=template-fallback 表示从用户模板中挑出的可编辑页，必须继承这页结构和风格；source=generated-fallback 表示系统生成的可编辑兜底源页，可以直接填充内容并保持模板风格。
- 不要把目录页当内容页，不要把内容页当目录页，不要把标题页当正文页。
- 用户母版补充说明优先于母版本身，母版优先于模板，模板优先于 AI 自行发挥。

structuredPagePlan：
${JSON.stringify(context.structuredPagePlan, null, 2)}

五类母版信息：
${JSON.stringify(context.structuredMasters || null, null, 2)}
`
}

function buildTemplateFillRepairBlock(context) {
  if (!context.repairMode) return ''
  return `
这是模板填充计划的自动修正任务。上一版 fill_plan 已经通过 check-plan 检查，发现了错误或过多警告；你必须在保留页数、source_slide、页面角色和内容逻辑的前提下修正。

上一版 fill_plan：
${JSON.stringify(context.previousFillPlan || null, null, 2)}

check-plan 摘要：
${JSON.stringify(context.templateFillCheckSummary || null, null, 2)}

修正要求：
- ERROR 必须全部修掉：不要使用不存在的 slot_id、table_id、chart_id，不要写越界表格单元格，不要让图表 series.values 数量和 categories 数量不一致。
- WARN 要尽量减少：缩短过长标题/正文，把长段落改成短句或删掉低价值替换。
- 不要新增页面、删除页面、调换页面顺序；如果提供 structuredPagePlan，source_slide 和 layout 仍必须逐页严格匹配。
- 如果某个槽位反复导致溢出，宁可不替换它，也不要塞满。
`
}

function buildPptImageGenerationRuleBlock(context) {
  const limit = Math.max(0, Math.min(5, Number(context.maxGeneratedImages || 5)))
  if (!context.imageGenerationEnabled || limit <= 0) {
    return `
图片能力：
- 当前 AI 不生成真实图片。不要输出 kind 为 image_placeholder 的 extra_shapes；如果需要视觉辅助，用原生表格、图表、文字层级或简单形状表达。
`
  }
  return `
图片能力：
- 当前选择 GPT-5.5，服务端会根据 extra_shapes 里的 image_placeholder.image_prompt 生成真实配图并嵌入 PPTX。
- 整套 PPT 最多允许 ${limit} 张真实图片；最多输出 ${limit} 个有效 image_placeholder，超过的会被忽略。
- 你不能在 JSON 里输出图片数据、URL 或 Markdown 图片，只能写清楚 image_prompt。
- 只在内容页使用 image_placeholder；封面、目录、章节标题页、结尾页不要新增图片占位。
- image_prompt 必须具体描述画面主体、构图、风格、色调和用途，且要贴合当前模板；不要要求图片中出现可读文字、汉字、logo、水印、截图界面或复杂表格。
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
${buildDesignDirectorBlock(context)}

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
2. 如果用户已经指定结构、顺序、页面类型或重点，必须以用户为准；只在用户没有指定时自行建立叙事主线。
3. 每一页只承载一个清晰核心信息，避免一页堆多个结论。
4. 根据内容选择 layoutIntent，只能是 cover、agenda、section、content、two_column、comparison、timeline、quote、summary。
5. keyMessage 要锋利具体，不要写“介绍背景”“阐述内容”这类空标题。
6. contentPriority 用 high、medium、low 表示这一页信息密度，便于后续控制字数。
7. suggestedTemplateRole 写该页更适合的模板角色：cover_candidate、toc_candidate、chapter_candidate、content_candidate、ending_candidate。
8. visualDirection 写页面表达方式，例如“左右对比”“三点递进”“结论先行”“时间顺序”“大标题少文字”。
9. 如果用户内容不足，可以合理补全结构，但要在 assumptions 中说明，不要假装来自用户材料。
10. 如果提供了 structuredPagePlan，slides[n] 的 role、layoutIntent、suggestedTemplateRole 必须贴合 structuredPagePlan.slides[n]，不能调整顺序。
11. pageType 必须从页面类型库中选择；不要连续 4 页以上使用 insight/content 同类普通观点页。
12. slideClaim 必须写成本页可被观众带走的一句话结论；informationBlocks 描述页面上应出现的 2-4 个信息块。
13. sourceBasis 标明本页主要来自“用户指定”“内容文件”“制作需求”“AI 合理补全”中的哪一类依据。

JSON 格式：
{
  "title": "整套 PPT 标题",
  "subtitle": "副标题",
  "audience": "目标观众",
  "coreMessage": "整套 PPT 最核心的一句话",
  "designStrategy": "整套 PPT 的叙事和视觉策略",
  "userStructureHandling": "如何处理用户已有结构；如果用户未指定，说明由 AI 自行规划",
  "storyline": ["叙事节点 1", "叙事节点 2"],
  "assumptions": ["内容不足时的补全假设"],
  "slides": [
    {
      "slideNumber": 1,
      "role": "cover",
      "pageType": "cover",
      "layoutIntent": "cover",
      "keyMessage": "本页核心信息",
      "slideClaim": "本页要让观众带走的一句话",
      "contentPriority": "high",
      "suggestedTemplateRole": "cover_candidate",
      "visualDirection": "大标题少文字",
      "informationBlocks": ["信息块 1", "信息块 2"],
      "mustSay": ["必须出现的信息"],
      "supportingPoints": ["辅助要点 1", "辅助要点 2"],
      "avoid": ["本页不要塞入的信息"],
      "sourceBasis": "用户指定"
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
  ? '\n重要：当前源文件是五类页型组合成的可编辑 PPTX。第 1 页封面、第 2 页目录、第 3 页标题页、第 4 页内容页、第 5 页结尾页。用户上传的页型必须直接替换原 PPTX 页里的可编辑文本槽位；系统生成的缺失页型也是真实可编辑 PPTX 页，不是背景图。任何情况下都不能把母版当背景图，不能新增白色文本框、色块或遮罩。'
  : ''}
${buildTemplateFillRepairBlock(context)}

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

系统推荐的逐页源页面候选（必须优先参考）：
${JSON.stringify(context.templateSlideMatchPlan || null, null, 2)}

模板页面库：
${JSON.stringify(context.templateFillLibrary, null, 2)}

${buildPptImageGenerationRuleBlock(context)}

规则：
1. 必须刚好生成 ${context.slideCount} 页。
2. 只能使用模板页面库里存在的 source_slide 和 slot_id，不要编造槽位。
3. source_slide 必须优先使用“系统推荐的逐页源页面候选”里的 preferredSourceSlide；如果不用 preferredSourceSlide，只能从 candidateSourceSlides 里选，并且必须确实更适合本页内容。
4. 可以重复使用同一个 source_slide，也可以跳过不适合的源页面；输出顺序必须服务内容逻辑。
5. 第 1 页优先使用 cover_candidate；最后 1 页优先使用 ending_candidate 或总结型页面；中间页面选择最适合表达内容的 content_candidate/toc_candidate/chapter_candidate。
6. replacement 的文字必须根据 narrativePlan.slides[n].pageType、slideClaim、informationBlocks 组织，不要把原文整段搬进槽位。
7. 每个 replacement 的文字必须适合该 slot 的容量。中文尤其要短，标题控制在 4-16 个汉字，标签控制在 2-12 个汉字，正文槽位也尽量用短句。
8. contentPriority 为 high 的页面也不能堆字，宁可表达更锋利；low 页面必须克制留白。
9. 如果 pageType 是 problem/insight/quote，优先少文字、大结论；如果是 comparison/process/timeline/data/case，优先使用结构化块、表格、图表或分组短句。
10. 不要填满所有槽位。只替换真正需要承载内容的槽位；页码、装饰性极短数字、品牌标语如果不确定可以保留原样。
11. notes 写演讲者备注，2-4 句自然中文，不要复制页面文字。
12. 默认不要新增页面元素；只有内容页可以通过 extra_shapes 添加少量透明可编辑文本框。图片占位只在上方“图片能力”允许时使用。
13. 如内容不足，合理补全结构，但不要声称来自用户材料。
14. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
15. 如果源文件是母版 PPTX：保留 logo、页眉页脚、页码、装饰线、背景、数字编号、红色侧栏等固定视觉元素；优先替换 XXXXX、占位标题、占位正文、示例项目名等明显示例文字。
16. 如果源文件是母版 PPTX：不要把“目录”“01”“02”“03”“04”这类结构性文字随意改掉，除非它本身就是该页唯一需要表达的新内容。
17. 如果提供 structuredPagePlan：第 n 页的 source_slide 必须等于 structuredPagePlan.slides[n-1].sourceSlide，layout 必须等于 structuredPagePlan.slides[n-1].layout。
18. 五类母版模式下，封面、目录、标题页、结尾页只替换原有文本槽位；内容页可以使用 extra_shapes 添加少量可编辑元素，但新增文本框必须透明，不得覆盖母版结构。
19. 如果输出 image_placeholder，必须同时填写 image_prompt；text 只写很短的占位说明即可。
20. 如果模板页面库的某页包含 tables，且本页内容是对比、清单、指标、步骤等结构化信息，优先使用 table_edits 修改原生表格，而不是把表格内容塞进普通文本框。
21. table_edits 只能使用模板页面库里该 source_slide 已存在的 table_id；只能修改已有 cell 的 row/col/text，不能增删行列，row 和 col 都从 0 开始。
22. 如果模板页面库的某页包含 charts，且本页内容包含趋势、占比、对比、增长等数字关系，优先使用 chart_edits 修改原生图表数据。
23. chart_edits 只能使用模板页面库里该 source_slide 已存在的 chart_id；必须提供 categories 和 series，且每个 series.values 的数量必须等于 categories 数量，values 必须是数字。
24. 不要编造 table_id、chart_id、slot_id；宁可少改，也不要写不存在的目标。

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
      "table_edits": [
        {
          "table_id": "s01_tbl3",
          "cells": [
            {"row": 0, "col": 0, "text": "指标"},
            {"row": 0, "col": 1, "text": "结论"}
          ]
        }
      ],
      "chart_edits": [
        {
          "chart_id": "s01_ch4",
          "categories": ["第一阶段", "第二阶段"],
          "series": [
            {"name": "完成度", "values": [42, 68]}
          ]
        }
      ],
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
        },
        {
          "kind": "image_placeholder",
          "x": 0.58,
          "y": 0.24,
          "width": 0.32,
          "height": 0.34,
          "text": "配图占位",
          "image_prompt": "一张贴合本页论点的抽象视觉辅助图，暖色浅背景，简洁构图，无文字无水印"
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
${buildDesignDirectorBlock(context)}

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
3. 这个页面计划阶段不要要求生成真实新图片；如选择 GPT-5.5，真实配图只由后续模板填充阶段通过 image_placeholder.image_prompt 触发。
4. 每页 bullets 建议 2-5 条，每条尽量短，适合放在 PPT 上。
5. speakerNotes 可写给演讲者看的补充说明，不要太长。
6. layout 只能从 cover、agenda、section、content、two_column、comparison、timeline、quote、summary 中选择。
7. emphasis 只能从 calm、sharp、warm、formal 中选择。
8. 如果内容不足，请用合理结构补全，但不要假装来自用户材料。
9. 如果上传了母版，layout 要尽量匹配自动识别的母版页类型：封面用 cover，目录用 agenda，章节页用 section，正文页用 content/two_column/comparison/timeline，结尾用 summary。
10. 如果提供了内容叙事大纲，页面标题、核心要点和 layout 必须贴合对应页的 keyMessage、layoutIntent 和 visualDirection。
11. 如果提供 structuredPagePlan，必须按 structuredPagePlan 的页型和顺序生成，不得删除封面、目录、章节标题页或结尾页。
12. pageType 必须贴合 narrativePlan.slides[n].pageType；页面标题尽量写成本页结论，而不是普通标签。
13. 不要把所有 bullets 都写成同一种语法。根据 pageType 使用“问题-后果”“观点-证据”“对象 A-对象 B”“阶段-动作”“指标-结论”等不同结构。

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
      "pageType": "insight",
      "layout": "cover",
      "emphasis": "warm",
      "insight": "本页最核心的一句话结论",
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
2. 是否遵守用户已指定的结构、顺序、页面类型和重点；AI 是否越权重排了用户结构。
3. 是否遵守叙事大纲，是否每页只有一个核心信息。
4. 页面类型是否丰富且服务逻辑，是否整套都像普通 bullet 页。
5. 模板页选择是否匹配页面意图，是否保留模板/母版优先级。
6. 页数、结构、标题层级是否清晰。
7. 单页文字量是否可能过多，是否存在容量压缩痕迹。
8. 标题是否像结论，是否存在“背景介绍/主要内容/相关分析”这类空泛标题。
9. 是否存在内容空泛、重复、逻辑跳跃或结论不足。
10. 如果有模板填充检查 warning/error，要指出风险。

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
  const pageType = normalizePageType(slide?.pageType || slide?.role, index, total)
  const layoutIntent = normalizePptLayout(slide?.layoutIntent || slide?.layout || PAGE_TYPE_LAYOUT_MAP[pageType], index)
  return {
    slideNumber: index + 1,
    role: String(slide?.role || inferNarrativeRole(index, total)),
    pageType,
    layoutIntent,
    keyMessage: String(slide?.keyMessage || slide?.slideClaim || slide?.title || `第 ${index + 1} 页核心信息`),
    slideClaim: String(slide?.slideClaim || slide?.keyMessage || slide?.title || `第 ${index + 1} 页核心结论`),
    contentPriority: ['high', 'medium', 'low'].includes(slide?.contentPriority) ? slide.contentPriority : 'medium',
    suggestedTemplateRole: normalizeSuggestedTemplateRole(slide?.suggestedTemplateRole, index, total),
    visualDirection: String(slide?.visualDirection || inferVisualDirection(layoutIntent)),
    informationBlocks: normalizeStringList(slide?.informationBlocks).slice(0, 5),
    mustSay: normalizeStringList(slide?.mustSay).slice(0, 4),
    supportingPoints: normalizeStringList(slide?.supportingPoints || slide?.bullets).slice(0, 5),
    avoid: normalizeStringList(slide?.avoid).slice(0, 4),
    sourceBasis: String(slide?.sourceBasis || ''),
  }
}

function normalizeSlide(slide, index) {
  const layout = normalizePptLayout(slide?.layout, index)
  const pageType = normalizePageType(slide?.pageType || layout, index)
  const emphasis = ['calm', 'sharp', 'warm', 'formal'].includes(slide?.emphasis)
    ? slide.emphasis
    : 'warm'
  return {
    title: String(slide?.title || `第 ${index + 1} 页`),
    subtitle: String(slide?.subtitle || ''),
    pageType,
    layout,
    emphasis,
    insight: String(slide?.insight || slide?.slideClaim || ''),
    bullets: normalizeStringList(slide?.bullets).slice(0, 6),
    footer: String(slide?.footer || ''),
    speakerNotes: String(slide?.speakerNotes || ''),
  }
}

function normalizePageType(value, index, total = 1) {
  const raw = String(value || '').toLowerCase()
  const map = {
    content: 'insight',
    two_column: 'argument',
    ending: 'closing',
    close: 'closing',
  }
  const candidate = map[raw] || raw
  if (PPT_PAGE_TYPES.includes(candidate)) return candidate
  if (index === 0) return 'cover'
  if (index === total - 1) return 'closing'
  if (raw === 'summary') return 'summary'
  return 'insight'
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

function extractExplicitOutline(text) {
  const source = String(text || '')
  if (!source.trim()) return []
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const outlineLines = lines
    .map((line) => {
      const match = line.match(/^(?:[-*•]\s*|(?:\d+|[一二三四五六七八九十]+)[.、)）]\s*|第[一二三四五六七八九十\d]+[章节部分]\s*)("?[^:：]{2,36}"?)(?:[:：].*)?$/)
      return match ? cleanOutlineTitle(match[1]) : ''
    })
    .filter(Boolean)
  if (outlineLines.length >= 2) return uniqueLimited(outlineLines, 12)

  const structureMatch = source.match(/(?:按照|依照|根据|结构为|大纲为|顺序为|流程为|分为|包括|按)([^。；;\n]{8,160})/i)
  if (!structureMatch) return []
  const outlineText = trimOutlineClause(structureMatch[1])
  const candidates = outlineText
    .split(/(?:→|->|=>|、|，|,|\/|；|;|\s>\s|\s-\s)/)
    .map(cleanOutlineTitle)
    .filter((item) => isLikelyOutlineTitle(item))
  return candidates.length >= 2 ? uniqueLimited(candidates, 12) : []
}

function extractMaterialOutline(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const headings = []
  for (const line of lines.slice(0, 240)) {
    if (line.length > 42) continue
    const heading = line.match(/^(?:#{1,3}\s*|(?:\d+|[一二三四五六七八九十]+)[.、]\s*|第[一二三四五六七八九十\d]+[章节部分]\s*)([^。；;：:]{2,36})/)
    if (heading) headings.push(cleanOutlineTitle(heading[1]))
  }
  return headings.length >= 3 ? uniqueLimited(headings, 10) : []
}

function extractPageTypeHints(text) {
  const source = String(text || '')
  if (!source.trim()) return []
  const hints = []
  const typePatterns = [
    ['agenda', /目录|议程|大纲/ig],
    ['comparison', /对比|比较|竞品|优劣|差异/ig],
    ['process', /流程|步骤|路径|机制|方法/ig],
    ['timeline', /时间线|阶段|进度|历程/ig],
    ['data', /数据|指标|图表|表格|占比|趋势|增长/ig],
    ['case', /案例|例子|样例|个案|文本细读/ig],
    ['problem', /问题|痛点|矛盾|风险|缺口/ig],
    ['summary', /总结|结论|下一步|建议/ig],
  ]
  for (const [pageType, pattern] of typePatterns) {
    if (!pattern.test(source)) continue
    hints.push({
      pageType,
      hint: pageTypeHintLabel(pageType),
      source: 'user_text',
    })
  }

  const slideSpecific = source.matchAll(/第\s*(\d{1,2})\s*页.{0,18}(封面|目录|章节|标题页|内容页|问题页|观点页|对比页|流程页|时间线|数据页|案例页|总结页|结尾)/g)
  for (const match of slideSpecific) {
    hints.push({
      slideNumber: Number(match[1]),
      pageType: normalizeChinesePageType(match[2]),
      hint: match[0],
      source: 'user_slide_hint',
    })
  }
  return hints.slice(0, 12)
}

function extractExplicitPptConstraints(text) {
  const source = String(text || '')
  const constraints = []
  const patterns = [
    /不要.{0,12}(?:目录|封面|结尾|太多字|大段文字|图片|图表)/g,
    /不需要.{0,12}(?:目录|封面|结尾|太多字|大段文字|图片|图表)/g,
    /必须.{0,18}(?:保留|使用|突出|强调|包含|按照|遵守)[^。；;\n]{0,40}/g,
    /请.{0,18}(?:保留|使用|突出|强调|包含|按照|遵守)[^。；;\n]{0,40}/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      constraints.push(match[0].trim())
    }
  }
  return uniqueLimited(constraints, 10)
}

function buildDesignIntentEvidence({ layoutSkeletonFixed, explicitOutline, materialOutline, pageTypeHints, explicitConstraints }) {
  const evidence = []
  if (layoutSkeletonFixed) evidence.push('系统已固定封面、目录、章节标题页、内容页、结尾页的页面骨架。')
  if (explicitOutline.length) evidence.push(`用户明确给出结构：${explicitOutline.join(' / ')}`)
  if (!explicitOutline.length && materialOutline.length) evidence.push(`材料中识别到大纲：${materialOutline.join(' / ')}`)
  if (pageTypeHints.length) evidence.push(`识别到页面类型提示：${pageTypeHints.map((item) => item.hint || item.pageType).join(' / ')}`)
  if (explicitConstraints.length) evidence.push(`识别到显式约束：${explicitConstraints.join(' / ')}`)
  return evidence
}

function cleanOutlineTitle(value) {
  return String(value || '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^(?:和|及|以及|分别是|包括|为|：|:|按照|依照|根据|按)+/g, '')
    .replace(/(?:的)?(?:结构|顺序|流程|框架|大纲|章节|目录)?(?:来做|制作|生成|设计|展开|组织|呈现|做)?$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function trimOutlineClause(value) {
  let text = String(value || '').trim()
  const stop = text.search(/(?:第\s*\d{1,2}\s*页|不要|不需要|无需|必须|请|其中|另外|同时)/)
  if (stop > 0) text = text.slice(0, stop)
  return text.replace(/[，,、：:；;\s]+$/g, '')
}

function isLikelyOutlineTitle(value) {
  const text = String(value || '').trim()
  if (text.length < 2 || text.length > 24) return false
  if (/第\s*\d{1,2}\s*页/.test(text)) return false
  if (/^(?:不要|不需要|无需|必须|请|其中|另外|同时)/.test(text)) return false
  if (/页/.test(text) && /(对比|流程|时间线|数据|案例|总结|封面|目录)/.test(text)) return false
  return true
}

function uniqueLimited(values, limit) {
  const seen = new Set()
  const output = []
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    output.push(text)
    if (output.length >= limit) break
  }
  return output
}

function pageTypeHintLabel(pageType) {
  const labels = {
    agenda: '目录/议程',
    comparison: '对比表达',
    process: '流程/步骤',
    timeline: '时间线/阶段',
    data: '数据/图表',
    case: '案例/样例',
    problem: '问题/痛点',
    summary: '总结/结论',
  }
  return labels[pageType] || pageType
}

function normalizeChinesePageType(value) {
  const text = String(value || '')
  if (text.includes('封面')) return 'cover'
  if (text.includes('目录')) return 'agenda'
  if (text.includes('章节') || text.includes('标题')) return 'section'
  if (text.includes('问题')) return 'problem'
  if (text.includes('观点')) return 'insight'
  if (text.includes('对比')) return 'comparison'
  if (text.includes('流程')) return 'process'
  if (text.includes('时间')) return 'timeline'
  if (text.includes('数据')) return 'data'
  if (text.includes('案例')) return 'case'
  if (text.includes('总结')) return 'summary'
  if (text.includes('结尾')) return 'closing'
  return 'insight'
}
