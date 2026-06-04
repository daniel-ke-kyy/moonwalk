import pptxgen from 'pptxgenjs'

const SLIDE_W = 13.333
const SLIDE_H = 7.5
const FONT = 'Noto Sans CJK SC'

export async function createPptxFromPlan({ plan, outputPath, templateAssets = [], settings }) {
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Moonwalk'
  pptx.company = 'Moonwalk'
  pptx.subject = settings?.pptType || 'Moonwalk generated deck'
  pptx.title = plan.title || 'Moonwalk PPT'
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: FONT,
    bodyFontFace: FONT,
    lang: 'zh-CN',
  }

  const palette = buildPalette(plan.theme)
  plan.slides.forEach((slidePlan, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: palette.background }
    addTemplateAccent(slide, pptx, palette, templateAssets, index)
    addSlideNumber(slide, index + 1, plan.slides.length, palette)

    if (slidePlan.layout === 'cover' || index === 0) {
      drawCover(slide, pptx, slidePlan, plan, palette, templateAssets)
    } else if (slidePlan.layout === 'agenda') {
      drawAgenda(slide, pptx, slidePlan, index, palette)
    } else if (slidePlan.layout === 'section') {
      drawSection(slide, pptx, slidePlan, index, palette)
    } else if (slidePlan.layout === 'two_column') {
      drawTwoColumn(slide, pptx, slidePlan, palette)
    } else if (slidePlan.layout === 'comparison') {
      drawComparison(slide, pptx, slidePlan, palette)
    } else if (slidePlan.layout === 'timeline') {
      drawTimeline(slide, pptx, slidePlan, palette)
    } else if (slidePlan.layout === 'quote') {
      drawQuote(slide, pptx, slidePlan, palette)
    } else if (slidePlan.layout === 'summary') {
      drawSummary(slide, pptx, slidePlan, palette)
    } else {
      drawContent(slide, pptx, slidePlan, palette)
    }

    if (slidePlan.speakerNotes) {
      slide.addNotes(slidePlan.speakerNotes)
    }
  })

  await pptx.writeFile({ fileName: outputPath, compression: true })
}

function buildPalette(theme = {}) {
  const primary = cleanHex(theme.primaryColor, 'B86232')
  const accent = cleanHex(theme.accentColor, 'C77D4D')
  const background = cleanHex(theme.backgroundColor, 'FFF7EE')
  return {
    primary,
    accent,
    background,
    ink: '2B2118',
    muted: '74695E',
    line: 'EAD9C7',
    surface: 'FFFCF8',
    soft: 'FFF0DD',
    green: '2F6B48',
  }
}

function addTemplateAccent(slide, pptx, palette, templateAssets, index) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: 0.13,
    fill: { color: palette.primary },
    line: { color: palette.primary },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: SLIDE_H - 0.13,
    w: SLIDE_W,
    h: 0.13,
    fill: { color: palette.accent, transparency: 18 },
    line: { color: palette.accent, transparency: 18 },
  })

  const asset = templateAssets[index % Math.max(templateAssets.length, 1)]
  if (asset?.path) {
    try {
      slide.addImage({
        path: asset.path,
        x: 10.75,
        y: 0.52,
        w: 1.55,
        h: 1.05,
        transparency: 14,
      })
    } catch {
      // Reusing extracted images is opportunistic; deck generation should continue without them.
    }
  }
}

function addSlideNumber(slide, index, total, palette) {
  slide.addText(`${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, {
    x: 11.42,
    y: 7.02,
    w: 1.45,
    h: 0.24,
    fontFace: FONT,
    fontSize: 8,
    color: palette.muted,
    align: 'right',
    margin: 0,
    breakLine: false,
  })
}

function drawCover(slide, pptx, slidePlan, plan, palette, templateAssets) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.72,
    y: 0.8,
    w: 0.16,
    h: 4.8,
    fill: { color: palette.primary },
    line: { color: palette.primary },
  })
  slide.addText(slidePlan.title || plan.title, {
    x: 1.12,
    y: 1.18,
    w: 7.7,
    h: 1.5,
    fontFace: FONT,
    fontSize: 34,
    bold: true,
    color: palette.ink,
    fit: 'shrink',
    margin: 0,
    breakLine: false,
  })
  slide.addText(slidePlan.subtitle || plan.subtitle || 'Moonwalk 自动生成', {
    x: 1.14,
    y: 2.86,
    w: 7.2,
    h: 0.55,
    fontFace: FONT,
    fontSize: 17,
    color: palette.primary,
    fit: 'shrink',
    margin: 0,
  })
  const bullets = slidePlan.bullets?.length ? slidePlan.bullets : ['基于模板风格生成', '内容结构已重新组织', '终稿可下载为 PPTX']
  addBulletList(slide, bullets.slice(0, 3), {
    x: 1.18,
    y: 4.12,
    w: 6.8,
    h: 1.45,
    fontSize: 14,
    color: palette.muted,
    bulletColor: palette.accent,
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 8.95,
    y: 1.0,
    w: 3.55,
    h: 4.95,
    rectRadius: 0.08,
    fill: { color: palette.surface, transparency: 3 },
    line: { color: palette.line, width: 1 },
  })
  const asset = templateAssets[0]
  if (asset?.path) {
    try {
      slide.addImage({ path: asset.path, x: 9.22, y: 1.32, w: 3.0, h: 2.0, transparency: 2 })
    } catch {
      drawCoverPattern(slide, pptx, palette)
    }
  } else {
    drawCoverPattern(slide, pptx, palette)
  }
  slide.addText('Template-based deck', {
    x: 9.28,
    y: 4.12,
    w: 2.9,
    h: 0.35,
    fontFace: FONT,
    fontSize: 12,
    color: palette.primary,
    bold: true,
    margin: 0,
    breakLine: false,
  })
  slide.addText('Moonwalk', {
    x: 9.28,
    y: 4.54,
    w: 2.9,
    h: 0.36,
    fontFace: FONT,
    fontSize: 15,
    color: palette.ink,
    margin: 0,
    breakLine: false,
  })
}

function drawCoverPattern(slide, pptx, palette) {
  ;[0, 1, 2].forEach((item) => {
    slide.addShape(pptx.ShapeType.rect, {
      x: 9.32 + item * 0.62,
      y: 1.42 + item * 0.28,
      w: 1.78,
      h: 1.16,
      rotate: item * 7,
      fill: { color: item === 0 ? palette.primary : item === 1 ? palette.accent : palette.soft, transparency: item === 2 ? 0 : 9 },
      line: { color: item === 2 ? palette.line : item === 1 ? palette.accent : palette.primary },
    })
  })
}

function drawAgenda(slide, pptx, slidePlan, index, palette) {
  addHeader(slide, slidePlan, palette)
  const bullets = ensureBullets(slidePlan, 5)
  bullets.slice(0, 6).forEach((bullet, itemIndex) => {
    const y = 1.75 + itemIndex * 0.82
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 1.0,
      y,
      w: 0.55,
      h: 0.45,
      rectRadius: 0.05,
      fill: { color: itemIndex % 2 ? palette.accent : palette.primary },
      line: { color: itemIndex % 2 ? palette.accent : palette.primary },
    })
    slide.addText(String(itemIndex + 1).padStart(2, '0'), {
      x: 1.0,
      y: y + 0.1,
      w: 0.55,
      h: 0.2,
      fontFace: FONT,
      fontSize: 11,
      bold: true,
      color: 'FFFFFF',
      align: 'center',
      margin: 0,
    })
    slide.addText(bullet, {
      x: 1.82,
      y: y + 0.04,
      w: 9.8,
      h: 0.35,
      fontFace: FONT,
      fontSize: 18,
      bold: itemIndex === 0,
      color: palette.ink,
      fit: 'shrink',
      margin: 0,
      breakLine: false,
    })
  })
  addFooter(slide, slidePlan.footer || `第 ${index + 1} 页`, palette)
}

function drawSection(slide, pptx, slidePlan, index, palette) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    fill: { color: palette.primary },
    line: { color: palette.primary },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.8,
    y: 0.84,
    w: 11.8,
    h: 5.95,
    fill: { color: palette.background, transparency: 3 },
    line: { color: palette.background, transparency: 100 },
  })
  slide.addText(`0${index + 1}`, {
    x: 1.18,
    y: 1.16,
    w: 1.2,
    h: 0.44,
    fontFace: FONT,
    fontSize: 20,
    bold: true,
    color: palette.accent,
    margin: 0,
  })
  slide.addText(slidePlan.title, {
    x: 1.18,
    y: 2.32,
    w: 8.6,
    h: 1.12,
    fontFace: FONT,
    fontSize: 34,
    bold: true,
    color: palette.ink,
    fit: 'shrink',
    margin: 0,
  })
  slide.addText(slidePlan.subtitle || ensureBullets(slidePlan, 1)[0], {
    x: 1.2,
    y: 3.76,
    w: 8.7,
    h: 0.7,
    fontFace: FONT,
    fontSize: 16,
    color: palette.muted,
    fit: 'shrink',
    margin: 0,
  })
}

function drawContent(slide, pptx, slidePlan, palette) {
  addHeader(slide, slidePlan, palette)
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.82,
    y: 1.54,
    w: 11.86,
    h: 4.96,
    rectRadius: 0.08,
    fill: { color: palette.surface, transparency: 5 },
    line: { color: palette.line, width: 1 },
  })
  addBulletList(slide, ensureBullets(slidePlan, 4), {
    x: 1.25,
    y: 1.98,
    w: 10.9,
    h: 3.98,
    fontSize: 19,
    color: palette.ink,
    bulletColor: palette.primary,
  })
  addFooter(slide, slidePlan.footer, palette)
}

function drawTwoColumn(slide, pptx, slidePlan, palette) {
  addHeader(slide, slidePlan, palette)
  const bullets = ensureBullets(slidePlan, 4)
  const left = bullets.slice(0, Math.ceil(bullets.length / 2))
  const right = bullets.slice(Math.ceil(bullets.length / 2))
  addColumn(slide, pptx, '重点', left, 0.82, palette.primary, palette)
  addColumn(slide, pptx, '展开', right.length ? right : left, 6.82, palette.accent, palette)
  addFooter(slide, slidePlan.footer, palette)
}

function drawComparison(slide, pptx, slidePlan, palette) {
  addHeader(slide, slidePlan, palette)
  const bullets = ensureBullets(slidePlan, 4)
  addColumn(slide, pptx, '现状 / 问题', bullets.slice(0, 3), 0.82, palette.primary, palette)
  addColumn(slide, pptx, '方案 / 价值', bullets.slice(3).length ? bullets.slice(3) : bullets.slice(0, 3), 6.82, palette.green, palette)
  addFooter(slide, slidePlan.footer, palette)
}

function drawTimeline(slide, pptx, slidePlan, palette) {
  addHeader(slide, slidePlan, palette)
  const bullets = ensureBullets(slidePlan, 5).slice(0, 5)
  slide.addShape(pptx.ShapeType.line, {
    x: 1.2,
    y: 4.0,
    w: 10.7,
    h: 0,
    line: { color: palette.line, width: 2 },
  })
  bullets.forEach((bullet, index) => {
    const x = 1.2 + index * (10.7 / Math.max(bullets.length - 1, 1))
    slide.addShape(pptx.ShapeType.ellipse, {
      x: x - 0.18,
      y: 3.82,
      w: 0.36,
      h: 0.36,
      fill: { color: index % 2 ? palette.accent : palette.primary },
      line: { color: index % 2 ? palette.accent : palette.primary },
    })
    slide.addText(bullet, {
      x: x - 0.95,
      y: index % 2 ? 4.32 : 2.68,
      w: 1.9,
      h: 0.72,
      fontFace: FONT,
      fontSize: 12,
      bold: true,
      color: palette.ink,
      align: 'center',
      valign: 'mid',
      fit: 'shrink',
      margin: 0.04,
    })
  })
  addFooter(slide, slidePlan.footer, palette)
}

function drawQuote(slide, pptx, slidePlan, palette) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.72,
    y: 1.0,
    w: 11.9,
    h: 5.35,
    fill: { color: palette.surface, transparency: 3 },
    line: { color: palette.line },
  })
  slide.addText('“', {
    x: 1.05,
    y: 1.16,
    w: 1.0,
    h: 0.8,
    fontFace: 'Georgia',
    fontSize: 48,
    color: palette.accent,
    margin: 0,
  })
  slide.addText(slidePlan.title, {
    x: 1.7,
    y: 1.86,
    w: 9.4,
    h: 1.4,
    fontFace: FONT,
    fontSize: 28,
    bold: true,
    color: palette.ink,
    fit: 'shrink',
    margin: 0,
  })
  addBulletList(slide, ensureBullets(slidePlan, 3), {
    x: 1.8,
    y: 3.7,
    w: 9.3,
    h: 1.45,
    fontSize: 16,
    color: palette.muted,
    bulletColor: palette.primary,
  })
  addFooter(slide, slidePlan.footer, palette)
}

function drawSummary(slide, pptx, slidePlan, palette) {
  addHeader(slide, slidePlan, palette)
  const bullets = ensureBullets(slidePlan, 3).slice(0, 4)
  const cardW = bullets.length > 2 ? 2.75 : 4.1
  bullets.forEach((bullet, index) => {
    const x = 0.92 + index * (cardW + 0.28)
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 2.1,
      w: cardW,
      h: 3.25,
      rectRadius: 0.08,
      fill: { color: index % 2 ? palette.soft : palette.surface },
      line: { color: palette.line },
    })
    slide.addText(String(index + 1), {
      x: x + 0.22,
      y: 2.36,
      w: 0.55,
      h: 0.4,
      fontFace: FONT,
      fontSize: 18,
      bold: true,
      color: palette.primary,
      margin: 0,
    })
    slide.addText(bullet, {
      x: x + 0.28,
      y: 3.08,
      w: cardW - 0.56,
      h: 1.7,
      fontFace: FONT,
      fontSize: 15,
      bold: true,
      color: palette.ink,
      fit: 'shrink',
      margin: 0.04,
    })
  })
  addFooter(slide, slidePlan.footer, palette)
}

function addHeader(slide, slidePlan, palette) {
  slide.addText(slidePlan.title, {
    x: 0.82,
    y: 0.56,
    w: 9.4,
    h: 0.52,
    fontFace: FONT,
    fontSize: 24,
    bold: true,
    color: palette.ink,
    fit: 'shrink',
    margin: 0,
    breakLine: false,
  })
  if (slidePlan.subtitle) {
    slide.addText(slidePlan.subtitle, {
      x: 0.84,
      y: 1.12,
      w: 8.8,
      h: 0.32,
      fontFace: FONT,
      fontSize: 11,
      color: palette.muted,
      fit: 'shrink',
      margin: 0,
      breakLine: false,
    })
  }
}

function addFooter(slide, footer, palette) {
  if (!footer) return
  slide.addText(footer, {
    x: 0.82,
    y: 7.03,
    w: 8.6,
    h: 0.24,
    fontFace: FONT,
    fontSize: 8,
    color: palette.muted,
    margin: 0,
    breakLine: false,
  })
}

function addColumn(slide, pptx, title, bullets, x, color, palette) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y: 1.72,
    w: 5.46,
    h: 4.68,
    rectRadius: 0.08,
    fill: { color: palette.surface, transparency: 5 },
    line: { color: palette.line },
  })
  slide.addText(title, {
    x: x + 0.36,
    y: 2.05,
    w: 4.6,
    h: 0.4,
    fontFace: FONT,
    fontSize: 17,
    bold: true,
    color,
    margin: 0,
  })
  addBulletList(slide, bullets, {
    x: x + 0.42,
    y: 2.76,
    w: 4.76,
    h: 2.78,
    fontSize: 15,
    color: palette.ink,
    bulletColor: color,
  })
}

function addBulletList(slide, bullets, options) {
  const rows = bullets.map((bullet) => ({
    text: bullet,
    options: {
      bullet: { type: 'bullet' },
      breakLine: true,
    },
  }))
  slide.addText(rows.length ? rows : [{ text: '内容待补充', options: { bullet: { type: 'bullet' } } }], {
    x: options.x,
    y: options.y,
    w: options.w,
    h: options.h,
    fontFace: FONT,
    fontSize: options.fontSize,
    color: options.color,
    fit: 'shrink',
    breakLine: false,
    paraSpaceAfterPt: 10,
    bullet: { indent: 14 },
    margin: 0.04,
  })
}

function ensureBullets(slidePlan, count) {
  const bullets = Array.isArray(slidePlan.bullets)
    ? slidePlan.bullets.map((item) => String(item).trim()).filter(Boolean)
    : []
  while (bullets.length < count) {
    bullets.push(slidePlan.subtitle || '围绕核心信息展开说明')
  }
  return bullets
}

function cleanHex(value, fallback) {
  const cleaned = String(value || '').replace('#', '').trim().toUpperCase()
  return /^[0-9A-F]{6}$/.test(cleaned) ? cleaned : fallback
}
