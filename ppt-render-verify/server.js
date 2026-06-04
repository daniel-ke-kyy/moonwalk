import express from 'express'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import pptxgen from 'pptxgenjs'

const execFileAsync = promisify(execFile)
const app = express()
const port = Number(process.env.PORT || 10000)

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/verify', async (_req, res) => {
  const startedAt = Date.now()
  try {
    const result = await runVerification()
    res.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      ...result,
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'verification failed',
    })
  }
})

app.listen(port, () => {
  console.log(`PPT render verification service is running on ${port}`)
})

async function runVerification() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ppt-render-verify-'))
  const pptxPath = path.join(workDir, 'moonwalk-template-test.pptx')
  const pdfPath = path.join(workDir, 'moonwalk-template-test.pdf')
  const pngPrefix = path.join(workDir, 'preview')

  await createSamplePptx(pptxPath)

  const sofficeVersion = await getCommandVersion('soffice', ['--version'])
  const pdftoppmVersion = await getCommandVersion('pdftoppm', ['-v'])

  await execFileAsync('soffice', [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    '--convert-to',
    'pdf',
    '--outdir',
    workDir,
    pptxPath,
  ], { timeout: 60000 })

  if (!existsSync(pdfPath)) {
    throw new Error('LibreOffice did not create the expected PDF output.')
  }

  await execFileAsync('pdftoppm', [
    '-png',
    '-r',
    '144',
    pdfPath,
    pngPrefix,
  ], { timeout: 60000 })

  const files = await readdir(workDir)
  const previewFiles = files.filter((file) => /^preview-\d+\.png$/.test(file)).sort()
  if (!previewFiles.length) {
    throw new Error('pdftoppm did not create any PNG preview images.')
  }

  const firstPreviewPath = path.join(workDir, previewFiles[0])
  const [pptxStats, pdfStats, pngStats, firstPreview] = await Promise.all([
    stat(pptxPath),
    stat(pdfPath),
    stat(firstPreviewPath),
    readFile(firstPreviewPath),
  ])

  return {
    commands: {
      sofficeVersion,
      pdftoppmVersion,
    },
    output: {
      pptxBytes: pptxStats.size,
      pdfBytes: pdfStats.size,
      previewCount: previewFiles.length,
      firstPreviewBytes: pngStats.size,
      firstPreviewDataUrl: `data:image/png;base64,${firstPreview.toString('base64')}`,
    },
  }
}

async function createSamplePptx(filePath) {
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Moonwalk verification'
  pptx.subject = 'PPTX render verification'
  pptx.title = 'Moonwalk Render Check'
  pptx.company = 'Moonwalk'
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: 'Noto Sans CJK SC',
    bodyFontFace: 'Noto Sans CJK SC',
    lang: 'zh-CN',
  }

  const slide = pptx.addSlide()
  slide.background = { color: 'FFF8EF' }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.42,
    fill: { color: 'B86232' },
    line: { color: 'B86232' },
  })
  slide.addText('Moonwalk', {
    x: 0.72,
    y: 0.78,
    w: 4.8,
    h: 0.55,
    fontFace: 'Noto Sans CJK SC',
    fontSize: 28,
    bold: true,
    color: '3B281C',
  })
  slide.addText('PPTX -> PDF -> PNG 预览验证', {
    x: 0.72,
    y: 1.42,
    w: 8.5,
    h: 0.46,
    fontFace: 'Noto Sans CJK SC',
    fontSize: 18,
    color: '7B4A25',
  })
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.75,
    y: 2.25,
    w: 11.8,
    h: 3.7,
    rectRadius: 0.08,
    fill: { color: 'FFFFFF', transparency: 8 },
    line: { color: 'EFD7BD', width: 1 },
  })
  slide.addText([
    { text: '验证目标：', options: { bold: true } },
    { text: '确认 Render Docker 环境可以稳定生成与终稿一致的页面预览。' },
    { text: '\n\n验证链路：', options: { bold: true } },
    { text: 'Node 生成 PPTX，LibreOffice 转 PDF，Poppler 转 PNG。' },
  ], {
    x: 1.12,
    y: 2.62,
    w: 10.9,
    h: 2.2,
    fontFace: 'Noto Sans CJK SC',
    fontSize: 20,
    breakLine: false,
    color: '3B281C',
    fit: 'shrink',
  })
  slide.addText('如果这张预览图能在线返回，就说明技术路线可行。', {
    x: 1.12,
    y: 5.1,
    w: 10,
    h: 0.4,
    fontFace: 'Noto Sans CJK SC',
    fontSize: 14,
    color: '986033',
  })

  await pptx.writeFile({ fileName: filePath })
}

async function getCommandVersion(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 15000 })
    return String(stdout || stderr).trim().split('\n')[0]
  } catch (error) {
    return error instanceof Error ? error.message : 'unavailable'
  }
}
