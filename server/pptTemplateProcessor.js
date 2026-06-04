import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import {
  extractDocxText,
  extractPdfText,
  extractPlainText,
  extractPptxText,
  getExtension,
  getPdfPageCount,
  getPptxSlideCount,
  normalizeUploadFilename,
} from './documentProcessor.js'
import { MAX_FILE_SIZE, MAX_PDF_PAGES, MAX_PPTX_SLIDES } from './types.js'
import { renderDocumentToPreviews } from './pptRenderer.js'

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text',
})

const templateExtensions = new Set(['.pptx', '.pdf'])
const contentExtensions = new Set(['.txt', '.docx', '.pdf', '.pptx'])

export async function analyzeTemplateFiles(files, sessionDir) {
  if (!files?.length) throw new Error('请至少上传 1 个模板文件。')
  if (files.length > 10) throw new Error('模板文件最多上传 10 个。')

  const templates = []
  for (let index = 0; index < files.length; index += 1) {
    templates.push(await analyzeTemplateFile(files[index], index, sessionDir))
  }
  return templates
}

export async function analyzeMasterFile(file, sessionDir) {
  if (!file) return null
  const master = await analyzeTemplateFile(file, 0, sessionDir, {
    idPrefix: 'master',
    directoryName: 'master',
    role: 'master',
    allowedExtensions: new Set(['.pptx']),
    invalidExtensionMessage: '幻灯片母版第一版仅支持 PPTX。',
    fileLabel: '母版 PPTX',
    previewLimit: MAX_PPTX_SLIDES,
  })
  return {
    ...master,
    role: 'master',
    slideRoles: inferMasterSlideRoles(master.slideTexts || []),
  }
}

export async function extractContentFileText(file) {
  if (!file) return { text: '', fileInfo: null }
  const originalName = normalizeUploadFilename(file.originalname)
  const extension = getExtension(originalName)
  if (!contentExtensions.has(extension)) {
    throw new Error('PPT 内容文件第一版仅支持 TXT、DOCX、PDF、PPTX。')
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('内容文件超过 50MB，请上传更小的文件。')
  }

  let text = ''
  if (extension === '.txt') text = await extractPlainText(file.path)
  if (extension === '.docx') text = await extractDocxText(file.path)
  if (extension === '.pdf') {
    const pageCount = await getPdfPageCount(file.path)
    if (pageCount > MAX_PDF_PAGES) throw new Error(`内容 PDF 共 ${pageCount} 页，超过 100 页限制。`)
    text = await extractPdfText(file.path)
  }
  if (extension === '.pptx') {
    const slideCount = getPptxSlideCount(file.path)
    if (slideCount > MAX_PPTX_SLIDES) throw new Error(`内容 PPTX 共 ${slideCount} 页，超过 100 页限制。`)
    text = await extractPptxText(file.path)
  }

  return {
    text,
    fileInfo: {
      originalName,
      extension,
      size: file.size,
    },
  }
}

export function buildTemplateContext(templates) {
  return templates.map((template) => ({
    id: template.id,
    originalName: template.originalName,
    extension: template.extension,
    pageCount: template.pageCount,
    slideCount: template.slideCount,
    role: template.role,
    textSample: template.textSample,
    detectedColors: template.detectedColors,
    imageCount: template.assets.length,
  }))
}

export function buildMasterContext(master, description) {
  if (!master && !description) return null
  return {
    uploaded: Boolean(master),
    originalName: master?.originalName || '',
    slideCount: master?.slideCount || null,
    textSample: master?.textSample || '',
    detectedColors: master?.detectedColors || [],
    imageCount: master?.assets?.length || 0,
    slideRoles: master?.slideRoles || [],
    description: description || '',
  }
}

async function analyzeTemplateFile(file, index, sessionDir, options = {}) {
  const originalName = normalizeUploadFilename(file.originalname)
  const extension = getExtension(originalName)
  const allowedExtensions = options.allowedExtensions || templateExtensions
  if (!allowedExtensions.has(extension)) {
    throw new Error(options.invalidExtensionMessage || '模板文件第一版仅支持 PPTX 或 PDF。')
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`${options.fileLabel || '模板文件'}「${originalName}」超过 50MB。`)
  }

  const id = `${options.idPrefix || 'tpl'}_${index + 1}`
  const directoryName = options.directoryName || 'templates'
  const renderDir = path.join(sessionDir, directoryName, id, 'preview')
  const assetDir = path.join(sessionDir, directoryName, id, 'assets')
  await mkdir(assetDir, { recursive: true })

  const base = {
    id,
    originalName,
    extension,
    size: file.size,
    path: file.path,
    pageCount: null,
    slideCount: null,
    role: options.role || (index === 0 ? 'main' : 'auxiliary'),
    textSample: '',
    detectedColors: [],
    previewPaths: [],
    assets: [],
    slideTexts: [],
  }

  if (extension === '.pdf') {
    const pageCount = await getPdfPageCount(file.path)
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(`模板 PDF「${originalName}」共 ${pageCount} 页，超过 100 页限制。`)
    }
    const text = await extractPdfText(file.path).catch(() => '')
    const rendered = await renderDocumentToPreviews(file.path, renderDir, { prefix: 'page', dpi: 96, extension })
    return {
      ...base,
      pageCount,
      textSample: trimText(text, 1600),
      previewPaths: rendered.previewPaths.slice(0, options.previewLimit || 6),
    }
  }

  const slideCount = getPptxSlideCount(file.path)
  if (slideCount > MAX_PPTX_SLIDES) {
    throw new Error(`${options.fileLabel || '模板 PPTX'}「${originalName}」共 ${slideCount} 页，超过 100 页限制。`)
  }
  const [text, style] = await Promise.all([
    extractPptxText(file.path).catch(() => ''),
    inspectPptxStyle(file.path, assetDir).catch(() => ({ colors: [], assets: [] })),
  ])
  const rendered = await renderDocumentToPreviews(file.path, renderDir, { prefix: 'slide', dpi: 96, extension })
  return {
    ...base,
    slideCount,
    textSample: trimText(text, 1800),
    detectedColors: style.colors,
    previewPaths: rendered.previewPaths.slice(0, options.previewLimit || 6),
    assets: style.assets.slice(0, 8),
    slideTexts: style.slideTexts,
  }
}

async function inspectPptxStyle(filePath, assetDir) {
  const zip = new AdmZip(filePath)
  const colors = new Map()
  const assets = []
  const slideTexts = []

  for (const entry of zip.getEntries()) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)) {
      const xml = entry.getData().toString('utf8')
      const parsed = parser.parse(xml)
      collectColors(parsed).forEach((color) => {
        colors.set(color, (colors.get(color) || 0) + 1)
      })
      slideTexts.push({
        slideNumber: getSlideNumber(entry.entryName),
        text: collectText(parsed).join(' ').replace(/\s+/g, ' ').trim(),
      })
    }

    if (/^ppt\/media\/image\d+\.(png|jpg|jpeg)$/i.test(entry.entryName)) {
      const extension = path.extname(entry.entryName).toLowerCase()
      const filename = `${path.basename(entry.entryName, extension)}${extension}`
      const outputPath = path.join(assetDir, filename)
      await writeFile(outputPath, entry.getData())
      assets.push({
        path: outputPath,
        filename,
        mimeType: extension === '.png' ? 'image/png' : 'image/jpeg',
      })
    }
  }

  return {
    colors: [...colors.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([color]) => color)
      .slice(0, 8),
    assets,
    slideTexts: slideTexts
      .sort((a, b) => a.slideNumber - b.slideNumber)
      .map((item, index) => ({
        slideNumber: item.slideNumber || index + 1,
        text: trimText(item.text, 500),
      })),
  }
}

function inferMasterSlideRoles(slideTexts) {
  return slideTexts.map((slide, index) => {
    const text = slide.text || ''
    const role = index === 0
      ? 'cover'
      : /目录|agenda|contents?/i.test(text)
        ? 'agenda'
        : /章节|section|part/i.test(text)
          ? 'section'
          : /总结|结论|thanks?|谢谢|尾页|结束/i.test(text)
            ? 'summary'
            : 'content'
    return {
      slideNumber: slide.slideNumber || index + 1,
      role,
      text,
    }
  })
}

function collectColors(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectColors(item, output))
    return output
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((key === '@_val' || key === '@_srgbClr') && typeof item === 'string' && /^[0-9A-Fa-f]{6}$/.test(item)) {
        output.push(item.toUpperCase())
      } else {
        collectColors(item, output)
      }
    }
  }
  return output
}

function collectText(value, output = []) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text) output.push(text)
    return output
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output))
    return output
  }

  if (value && typeof value === 'object') {
    if (typeof value['#text'] === 'string') {
      const text = value['#text'].trim()
      if (text) output.push(text)
    }
    Object.entries(value).forEach(([key, item]) => {
      if (key !== '#text') collectText(item, output)
    })
  }

  return output
}

function getSlideNumber(entryName) {
  return Number(entryName.match(/slide(\d+)\.xml$/)?.[1] || 0)
}

function trimText(text, maxLength) {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（内容已截断）` : text
}
