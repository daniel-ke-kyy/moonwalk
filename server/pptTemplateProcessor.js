import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
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
const templateAnalysisCache = new Map()
const contentTextCache = new Map()
const maxCacheEntries = 30

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

  const cacheKey = await getFileCacheKey(file, `content:${extension}`)
  const cached = contentTextCache.get(cacheKey)
  if (cached) {
    return {
      text: cached.text,
      fileInfo: {
        originalName,
        extension,
        size: file.size,
      },
      cacheHit: true,
    }
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

  const result = {
    text,
    fileInfo: {
      originalName,
      extension,
      size: file.size,
    },
    cacheHit: false,
  }
  rememberCacheEntry(contentTextCache, cacheKey, { text })
  return result
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
  const previewLimit = options.previewLimit || 6
  const cacheKey = await getFileCacheKey(file, `template:${extension}:preview-${previewLimit}`)
  const cached = templateAnalysisCache.get(cacheKey)
  if (cached && cachedTemplateFilesExist(cached)) {
    return rehydrateCachedTemplate(cached, file, {
      id,
      originalName,
      role: options.role || (index === 0 ? 'main' : 'auxiliary'),
      cacheKey,
    })
  }
  if (cached) templateAnalysisCache.delete(cacheKey)

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
    cacheKey,
    cacheHit: false,
  }

  if (extension === '.pdf') {
    const pageCount = await getPdfPageCount(file.path)
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(`模板 PDF「${originalName}」共 ${pageCount} 页，超过 100 页限制。`)
    }
    const text = await extractPdfText(file.path).catch(() => '')
    const rendered = await renderDocumentToPreviews(file.path, renderDir, {
      prefix: 'page',
      dpi: 96,
      extension,
      firstPage: 1,
      lastPage: Math.min(pageCount, previewLimit),
      timeoutMs: 45000,
    }).catch((error) => {
      console.warn(`PDF 模板「${originalName}」预览生成失败：${error.message}`)
      return { previewPaths: [] }
    })
    const result = {
      ...base,
      pageCount,
      textSample: trimText(text, 1600),
      previewPaths: rendered.previewPaths.slice(0, previewLimit),
    }
    rememberCacheEntry(templateAnalysisCache, cacheKey, result)
    return result
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
  const result = {
    ...base,
    slideCount,
    textSample: trimText(text, 1800),
    detectedColors: style.colors,
    previewPaths: rendered.previewPaths.slice(0, previewLimit),
    assets: style.assets.slice(0, 8),
    slideTexts: style.slideTexts,
  }
  rememberCacheEntry(templateAnalysisCache, cacheKey, result)
  return result
}

async function getFileCacheKey(file, scope) {
  const data = await readFile(file.path)
  const hash = createHash('sha256').update(data).digest('hex')
  return `${scope}:${file.size}:${hash}`
}

function rememberCacheEntry(cache, key, value) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, clonePlain(value))
  while (cache.size > maxCacheEntries) {
    const oldestKey = cache.keys().next().value
    cache.delete(oldestKey)
  }
}

function cachedTemplateFilesExist(cached) {
  const files = [
    ...(cached.previewPaths || []),
    ...(cached.assets || []).map((asset) => asset.path).filter(Boolean),
  ]
  return files.every((filePath) => existsSync(filePath))
}

function rehydrateCachedTemplate(cached, file, overrides) {
  return {
    ...clonePlain(cached),
    id: overrides.id,
    originalName: overrides.originalName,
    size: file.size,
    path: file.path,
    role: overrides.role,
    cacheKey: overrides.cacheKey,
    cacheHit: true,
  }
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value))
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
