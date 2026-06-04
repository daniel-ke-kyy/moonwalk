import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const renderTimeoutMs = 120000

export async function renderDocumentToPreviews(inputPath, outputDir, options = {}) {
  const extension = String(options.extension || path.extname(inputPath)).toLowerCase()
  await mkdir(outputDir, { recursive: true })
  const pdfPath = extension === '.pdf'
    ? await ensurePdfExtension(inputPath, outputDir)
    : await convertPptxToPdf(inputPath, outputDir)
  const previewPaths = await renderPdfToPngs(pdfPath, outputDir, options)
  return { pdfPath, previewPaths }
}

export async function convertPptxToPdf(pptxPath, outputDir) {
  await mkdir(outputDir, { recursive: true })
  const sourcePath = await ensurePptxExtension(pptxPath, outputDir)
  const profileDir = path.join(outputDir, `lo-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(profileDir, { recursive: true })
  await execFileAsync('soffice', [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to',
    'pdf',
    '--outdir',
    outputDir,
    sourcePath,
  ], { timeout: renderTimeoutMs })

  const expectedPath = path.join(outputDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`)
  if (existsSync(expectedPath)) return expectedPath

  const files = await readdir(outputDir)
  const pdfFile = files.find((file) => file.toLowerCase().endsWith('.pdf'))
  if (!pdfFile) {
    throw new Error('PPTX 已生成，但当前环境暂时无法转换出 PDF 预览。')
  }
  return path.join(outputDir, pdfFile)
}

async function ensurePptxExtension(filePath, outputDir) {
  if (path.extname(filePath).toLowerCase() === '.pptx') return filePath
  const workingPath = path.join(outputDir, 'source.pptx')
  await copyFile(filePath, workingPath)
  return workingPath
}

async function ensurePdfExtension(filePath, outputDir) {
  if (path.extname(filePath).toLowerCase() === '.pdf') return filePath
  const workingPath = path.join(outputDir, 'source.pdf')
  await copyFile(filePath, workingPath)
  return workingPath
}

export async function renderPdfToPngs(pdfPath, outputDir, options = {}) {
  await mkdir(outputDir, { recursive: true })
  const prefix = path.join(outputDir, options.prefix || 'slide')
  const dpi = Number(options.dpi) || 128
  const timeout = Number(options.timeoutMs) || renderTimeoutMs
  const attempts = [
    {
      label: 'pdftoppm',
      command: 'pdftoppm',
      prefix,
      args: buildPdftoppmArgs(pdfPath, prefix, dpi, options),
    },
  ]

  if (options.fallback !== false) {
    const fallbackDpi = Math.min(dpi, 72)
    attempts.push(
      {
        label: 'pdftoppm-low-dpi',
        command: 'pdftoppm',
        prefix: `${prefix}-low`,
        args: buildPdftoppmArgs(pdfPath, `${prefix}-low`, fallbackDpi, options),
      },
      {
        label: 'pdftocairo',
        command: 'pdftocairo',
        prefix: `${prefix}-cairo`,
        args: buildPdftocairoArgs(pdfPath, `${prefix}-cairo`, fallbackDpi, options),
      },
    )
  }

  const failures = []
  for (const attempt of attempts) {
    try {
      await execFileAsync(attempt.command, attempt.args, { timeout })
      const previewPaths = await collectPreviewPaths(outputDir, attempt.prefix)
      if (previewPaths.length) return previewPaths
      failures.push(`${attempt.label}: 未生成预览图片`)
    } catch (error) {
      const partialPreviewPaths = await collectPreviewPaths(outputDir, attempt.prefix)
      if (partialPreviewPaths.length) return partialPreviewPaths
      failures.push(`${attempt.label}: ${formatCommandError(error)}`)
    }
  }

  throw new Error(`PDF 预览转换失败：${failures.join('；')}`)
}

function buildPdftoppmArgs(pdfPath, prefix, dpi, options) {
  return [
    '-png',
    '-r',
    String(dpi),
    ...buildPdfPageRangeArgs(options),
    pdfPath,
    prefix,
  ]
}

function buildPdftocairoArgs(pdfPath, prefix, dpi, options) {
  return [
    '-png',
    '-r',
    String(dpi),
    ...buildPdfPageRangeArgs(options),
    pdfPath,
    prefix,
  ]
}

function buildPdfPageRangeArgs(options) {
  const firstPage = toPositiveInteger(options.firstPage)
  const lastPage = toPositiveInteger(options.lastPage)
  return [
    ...(firstPage ? ['-f', String(firstPage)] : []),
    ...(lastPage ? ['-l', String(lastPage)] : []),
  ]
}

async function collectPreviewPaths(outputDir, prefix) {
  const files = await readdir(outputDir)
  const basename = path.basename(prefix)
  return files
    .filter((file) => file.startsWith(`${basename}-`) && file.toLowerCase().endsWith('.png'))
    .sort((left, right) => getPreviewNumber(left) - getPreviewNumber(right))
    .map((file) => path.join(outputDir, file))
}

function toPositiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function formatCommandError(error) {
  const output = [error.stderr, error.stdout].filter(Boolean).join('\n').trim()
  if (output) return output.replace(/\s+/g, ' ').slice(0, 500)

  const parts = []
  if (error.code) parts.push(`退出码 ${error.code}`)
  if (error.signal) parts.push(`被 ${error.signal} 终止`)
  if (error.killed) parts.push('命令超时或被终止')
  return parts.join('，') || '转换命令没有返回详细信息'
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
