import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const renderTimeoutMs = 120000

export async function renderDocumentToPreviews(inputPath, outputDir, options = {}) {
  const extension = path.extname(inputPath).toLowerCase()
  await mkdir(outputDir, { recursive: true })
  const pdfPath = extension === '.pdf'
    ? inputPath
    : await convertPptxToPdf(inputPath, outputDir)
  const previewPaths = await renderPdfToPngs(pdfPath, outputDir, options)
  return { pdfPath, previewPaths }
}

export async function convertPptxToPdf(pptxPath, outputDir) {
  await mkdir(outputDir, { recursive: true })
  await execFileAsync('soffice', [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    '--convert-to',
    'pdf',
    '--outdir',
    outputDir,
    pptxPath,
  ], { timeout: renderTimeoutMs })

  const expectedPath = path.join(outputDir, `${path.basename(pptxPath, path.extname(pptxPath))}.pdf`)
  if (existsSync(expectedPath)) return expectedPath

  const files = await readdir(outputDir)
  const pdfFile = files.find((file) => file.toLowerCase().endsWith('.pdf'))
  if (!pdfFile) {
    throw new Error('PPTX 已生成，但当前环境暂时无法转换出 PDF 预览。')
  }
  return path.join(outputDir, pdfFile)
}

export async function renderPdfToPngs(pdfPath, outputDir, options = {}) {
  await mkdir(outputDir, { recursive: true })
  const prefix = path.join(outputDir, options.prefix || 'slide')
  await execFileAsync('pdftoppm', [
    '-png',
    '-r',
    String(options.dpi || 128),
    pdfPath,
    prefix,
  ], { timeout: renderTimeoutMs })

  const files = await readdir(outputDir)
  const basename = path.basename(prefix)
  return files
    .filter((file) => file.startsWith(`${basename}-`) && file.toLowerCase().endsWith('.png'))
    .sort((left, right) => getPreviewNumber(left) - getPreviewNumber(right))
    .map((file) => path.join(outputDir, file))
}

export async function getCommandVersion(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 15000 })
    return String(stdout || stderr).trim().split('\n')[0]
  } catch {
    return null
  }
}

function getPreviewNumber(filename) {
  return Number(filename.match(/-(\d+)\.png$/)?.[1] || 0)
}
