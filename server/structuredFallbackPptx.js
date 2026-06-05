import pptxgen from 'pptxgenjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const SLIDE_W = 13.333
const SLIDE_H = 7.5
const FONT = 'Noto Sans CJK SC'

const ROLE_COPY = {
  cover: {
    title: '标题',
    subtitle: '副标题',
    kicker: '演示主题',
  },
  agenda: {
    title: '目录',
    items: ['占位目录 1', '占位目录 2', '占位目录 3', '占位目录 4'],
  },
  section: {
    title: '章节标题',
    subtitle: '章节要点',
  },
  content: {
    title: '内容标题',
    body: ['正文要点 1', '正文要点 2', '正文要点 3'],
  },
  ending: {
    title: '总结',
    subtitle: '下一步',
  },
}

export async function createStructuredFallbackRolePptx({ roleKey, outputPath, templates = [] }) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Moonwalk'
  pptx.company = 'Moonwalk'
  pptx.subject = `Moonwalk ${roleKey} fallback master`
  pptx.title = `Moonwalk ${roleKey} fallback master`
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: FONT,
    bodyFontFace: FONT,
    lang: 'zh-CN',
  }

  const palette = buildFallbackPalette(templates)
  const slide = pptx.addSlide()
  slide.background = { color: palette.background }
  drawBaseChrome(slide, pptx, palette)

  if (roleKey === 'cover') drawCover(slide, pptx, palette)
  else if (roleKey === 'agenda') drawAgenda(slide, pptx, palette)
  else if (roleKey === 'section') drawSection(slide, pptx, palette)
  else if (roleKey === 'ending') drawEnding(slide, pptx, palette)
  else drawContent(slide, pptx, palette)

  await pptx.writeFile({ fileName: outputPath, compression: true })
  return outputPath
}

function buildFallbackPalette(templates) {
  const colors = templates
    .flatMap((template) => Array.isArray(template?.detectedColors) ? template.detectedColors : [])
    .map(cleanHex)
    .filter(Boolean)
  const primary = colors.find((color) => isUsableAccent(color)) || 'B86232'
  const accent = colors.find((color) => color !== primary && isUsableAccent(color)) || 'D5965F'
  const light = colors.find((color) => luminance(color) > 0.86 && color !== 'FFFFFF') || 'FFF7EE'
  const ink = luminance(primary) < 0.22 ? '2B2118' : '31261D'
  return {
    primary,
    accent,
    background: light,
    ink,
    muted: '74695E',
    line: softenColor(accent, 'E8CDB6'),
    surface: 'FFFCF8',
    soft: 'FFF0DD',
  }
}

function drawBaseChrome(slide, pptx, palette) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: 0.14,
    fill: { color: palette.primary },
    line: { color: palette.primary },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: SLIDE_H - 0.13,
    w: SLIDE_W,
    h: 0.13,
    fill: { color: palette.accent, transparency: 22 },
    line: { color: palette.accent, transparency: 22 },
  })
  slide.addShape(pptx.ShapeType.arc, {
    x: 10.85,
    y: -0.86,
    w: 3.1,
    h: 3.1,
    adjustPoint: 0.28,
    fill: { color: palette.soft, transparency: 10 },
    line: { color: palette.soft, transparency: 100 },
    rotate: 24,
  })
  slide.addShape(pptx.ShapeType.line, {
    x: 0.72,
    y: 6.72,
    w: 11.7,
    h: 0,
    line: { color: palette.line, transparency: 10, width: 0.8 },
  })
}

function drawCover(slide, pptx, palette) {
  const copy = ROLE_COPY.cover
  slide.addText(copy.kicker, {
    x: 0.88,
    y: 1.08,
    w: 3.2,
    h: 0.32,
    fontFace: FONT,
    fontSize: 13,
    bold: true,
    color: palette.primary,
    margin: 0,
    fit: 'shrink',
  })
  slide.addText(copy.title, {
    x: 0.86,
    y: 1.72,
    w: 8.7,
    h: 1.15,
    fontFace: FONT,
    fontSize: 34,
    bold: true,
    color: palette.ink,
    margin: 0,
    fit: 'shrink',
    breakLine: false,
  })
  slide.addText(copy.subtitle, {
    x: 0.9,
    y: 3.04,
    w: 7.4,
    h: 0.48,
    fontFace: FONT,
    fontSize: 16,
    color: palette.muted,
    margin: 0,
    fit: 'shrink',
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 9.92,
    y: 3.62,
    w: 2.15,
    h: 1.22,
    rectRadius: 0.04,
    fill: { color: palette.surface, transparency: 5 },
    line: { color: palette.line, transparency: 10, width: 1 },
  })
}

function drawAgenda(slide, pptx, palette) {
  const copy = ROLE_COPY.agenda
  addTitle(slide, copy.title, palette)
  copy.items.forEach((item, index) => {
    const y = 1.75 + index * 0.82
    slide.addShape(pptx.ShapeType.rect, {
      x: 1.0,
      y,
      w: 0.42,
      h: 0.42,
      rectRadius: 0.03,
      fill: { color: index % 2 ? palette.accent : palette.primary, transparency: 4 },
      line: { color: index % 2 ? palette.accent : palette.primary, transparency: 20 },
    })
    slide.addText(String(index + 1).padStart(2, '0'), {
      x: 1.08,
      y: y + 0.1,
      w: 0.28,
      h: 0.16,
      fontFace: FONT,
      fontSize: 9,
      bold: true,
      color: 'FFFFFF',
      align: 'center',
      margin: 0,
      fit: 'shrink',
    })
    slide.addText(item, {
      x: 1.62,
      y: y + 0.02,
      w: 8.4,
      h: 0.34,
      fontFace: FONT,
      fontSize: 19,
      bold: true,
      color: palette.ink,
      margin: 0,
      fit: 'shrink',
    })
  })
}

function drawSection(slide, pptx, palette) {
  const copy = ROLE_COPY.section
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.82,
    y: 2.18,
    w: 0.12,
    h: 1.38,
    fill: { color: palette.primary },
    line: { color: palette.primary },
  })
  slide.addText(copy.title, {
    x: 1.16,
    y: 2.2,
    w: 8.2,
    h: 0.76,
    fontFace: FONT,
    fontSize: 30,
    bold: true,
    color: palette.ink,
    margin: 0,
    fit: 'shrink',
    breakLine: false,
  })
  slide.addText(copy.subtitle, {
    x: 1.18,
    y: 3.18,
    w: 7.2,
    h: 0.38,
    fontFace: FONT,
    fontSize: 15,
    color: palette.muted,
    margin: 0,
    fit: 'shrink',
  })
}

function drawContent(slide, pptx, palette) {
  const copy = ROLE_COPY.content
  addTitle(slide, copy.title, palette)
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.82,
    y: 1.56,
    w: 8.25,
    h: 4.62,
    rectRadius: 0.04,
    fill: { color: palette.surface, transparency: 3 },
    line: { color: palette.line, transparency: 14, width: 1 },
  })
  copy.body.forEach((item, index) => {
    const y = 1.94 + index * 0.95
    slide.addShape(pptx.ShapeType.rect, {
      x: 1.18,
      y: y + 0.08,
      w: 0.14,
      h: 0.14,
      fill: { color: palette.primary },
      line: { color: palette.primary },
    })
    slide.addText(item, {
      x: 1.52,
      y,
      w: 6.92,
      h: 0.32,
      fontFace: FONT,
      fontSize: 17,
      color: palette.ink,
      margin: 0,
      fit: 'shrink',
    })
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 9.55,
    y: 1.58,
    w: 2.86,
    h: 4.58,
    rectRadius: 0.04,
    fill: { color: palette.soft, transparency: 0 },
    line: { color: palette.line, transparency: 20 },
  })
  slide.addText('补充观点', {
    x: 9.9,
    y: 1.98,
    w: 2.1,
    h: 0.26,
    fontFace: FONT,
    fontSize: 14,
    bold: true,
    color: palette.primary,
    margin: 0,
    fit: 'shrink',
  })
  slide.addText('占位说明', {
    x: 9.92,
    y: 2.48,
    w: 2.0,
    h: 0.58,
    fontFace: FONT,
    fontSize: 13,
    color: palette.muted,
    margin: 0,
    fit: 'shrink',
  })
}

function drawEnding(slide, pptx, palette) {
  const copy = ROLE_COPY.ending
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.86,
    y: 1.38,
    w: 4.9,
    h: 0.12,
    fill: { color: palette.primary },
    line: { color: palette.primary },
  })
  slide.addText(copy.title, {
    x: 0.86,
    y: 2.02,
    w: 7.8,
    h: 0.86,
    fontFace: FONT,
    fontSize: 32,
    bold: true,
    color: palette.ink,
    margin: 0,
    fit: 'shrink',
    breakLine: false,
  })
  slide.addText(copy.subtitle, {
    x: 0.9,
    y: 3.04,
    w: 7.1,
    h: 0.42,
    fontFace: FONT,
    fontSize: 16,
    color: palette.muted,
    margin: 0,
    fit: 'shrink',
  })
}

function addTitle(slide, text, palette) {
  slide.addText(text, {
    x: 0.82,
    y: 0.7,
    w: 8.9,
    h: 0.52,
    fontFace: FONT,
    fontSize: 24,
    bold: true,
    color: palette.ink,
    margin: 0,
    fit: 'shrink',
    breakLine: false,
  })
}

function cleanHex(value) {
  const text = String(value || '').replace('#', '').trim().toUpperCase()
  return /^[0-9A-F]{6}$/.test(text) ? text : ''
}

function isUsableAccent(color) {
  const luma = luminance(color)
  return luma > 0.08 && luma < 0.82
}

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = [r, g, b].map((value) => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function softenColor(color, fallback) {
  if (!cleanHex(color)) return fallback
  const mixed = [0, 2, 4].map((offset) => {
    const channel = parseInt(color.slice(offset, offset + 2), 16)
    return Math.round(channel * 0.35 + 255 * 0.65).toString(16).padStart(2, '0')
  })
  return mixed.join('').toUpperCase()
}
