import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
export const STRUCTURED_MASTER_ROLES = [
  { key: 'cover', field: 'masterCover', label: '封面母版', sourceSlide: 1, layout: 'cover', suggestedTemplateRole: 'cover_candidate' },
  { key: 'agenda', field: 'masterAgenda', label: '目录母版', sourceSlide: 2, layout: 'agenda', suggestedTemplateRole: 'toc_candidate' },
  { key: 'section', field: 'masterSection', label: '标题页母版', sourceSlide: 3, layout: 'section', suggestedTemplateRole: 'chapter_candidate' },
  { key: 'content', field: 'masterContent', label: '内容页母版', sourceSlide: 4, layout: 'content', suggestedTemplateRole: 'content_candidate' },
  { key: 'ending', field: 'masterEnding', label: '结尾页母版', sourceSlide: 5, layout: 'summary', suggestedTemplateRole: 'ending_candidate' },
]
const templateAnalysisCache = new Map()
const contentTextCache = new Map()
const maxCacheEntries = 30
const maxDiskCacheEntries = 80
const cacheTtlMs = Number(process.env.PPT_CACHE_TTL_MS || 6 * 60 * 60 * 1000)
let diskCacheRoot = null

export async function configurePptTemplateCache(root) {
  diskCacheRoot = root
  await mkdir(getTemplateDiskCacheRoot(), { recursive: true })
  await mkdir(getContentDiskCacheRoot(), { recursive: true })
  await cleanupDiskCache().catch((error) => {
    console.warn(`PPT 临时缓存清理失败：${error.message}`)
  })
}

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

export async function analyzeStructuredMasterFiles(files, sessionDir) {
  const masters = {}
  for (const role of STRUCTURED_MASTER_ROLES) {
    const file = Array.isArray(files?.[role.field]) ? files[role.field][0] : null
    if (!file) continue
    const master = await analyzeTemplateFile(file, 0, sessionDir, {
      idPrefix: `master_${role.key}`,
      directoryName: path.join('structured-masters', role.key),
      role: `master-${role.key}`,
      allowedExtensions: new Set(['.pptx']),
      invalidExtensionMessage: `${role.label}第一版仅支持 PPTX。`,
      fileLabel: role.label,
      previewLimit: 1,
    })
    if (master.slideCount !== 1) {
      throw new Error(`${role.label}「${master.originalName}」必须是单页 PPTX。请把对应母版单独存成 1 页后再上传。`)
    }
    masters[role.key] = {
      ...master,
      role: role.key,
      masterRole: role.key,
      roleLabel: role.label,
      sourceSlide: role.sourceSlide,
      slideRoles: [{ slideNumber: 1, role: role.key, text: master.slideTexts?.[0]?.text || '' }],
    }
  }
  return masters
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
  const cached = contentTextCache.get(cacheKey) || await readContentDiskCache(cacheKey)
  if (cached) {
    rememberCacheEntry(contentTextCache, cacheKey, cached)
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
  await writeContentDiskCache(cacheKey, { text })
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

export function buildStructuredMasterContext(structuredMasters, description) {
  const items = STRUCTURED_MASTER_ROLES.map((role) => {
    const master = structuredMasters?.[role.key] || null
    return {
      role: role.key,
      label: role.label,
      uploaded: Boolean(master),
      originalName: master?.originalName || '',
      textSample: master?.textSample || '',
      detectedColors: master?.detectedColors || [],
      imageCount: master?.assets?.length || 0,
    }
  })
  if (!items.some((item) => item.uploaded) && !description) return null
  return {
    enabled: items.some((item) => item.uploaded),
    description: description || '',
    roles: items,
  }
}

export function serializeStructuredMasters(structuredMasters, toUrl) {
  const result = {}
  for (const role of STRUCTURED_MASTER_ROLES) {
    const master = structuredMasters?.[role.key]
    result[role.key] = master
      ? {
          role: role.key,
          label: role.label,
          originalName: master.originalName,
          extension: master.extension,
          size: master.size,
          slideCount: master.slideCount,
          detectedColors: master.detectedColors,
          imageCount: master.assets.length,
          previewUrls: master.previewPaths.map((filePath) => toUrl(filePath)),
        }
      : null
  }
  return result
}

export function hasStructuredMasters(structuredMasters) {
  return STRUCTURED_MASTER_ROLES.some((role) => Boolean(structuredMasters?.[role.key]))
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
  const renderDir = path.join(sessionDir, directoryName, id, 'preview')
  const assetDir = path.join(sessionDir, directoryName, id, 'assets')
  const cached = await readTemplateAnalysisCache(cacheKey)
  if (cached && cachedTemplateFilesExist(cached)) {
    await mkdir(assetDir, { recursive: true })
    const copied = await copyCachedTemplateFiles(cached, renderDir, assetDir)
    return rehydrateCachedTemplate(cached, file, copied, {
      id,
      originalName,
      role: options.role || (index === 0 ? 'main' : 'auxiliary'),
      cacheKey,
    })
  }
  if (cached) templateAnalysisCache.delete(cacheKey)

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
    await rememberTemplateAnalysisCache(cacheKey, result)
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
  await rememberTemplateAnalysisCache(cacheKey, result)
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

async function readTemplateAnalysisCache(cacheKey) {
  const memoryHit = templateAnalysisCache.get(cacheKey)
  if (memoryHit) return memoryHit
  const diskHit = await readTemplateDiskCache(cacheKey)
  if (diskHit) rememberCacheEntry(templateAnalysisCache, cacheKey, diskHit)
  return diskHit
}

async function rememberTemplateAnalysisCache(cacheKey, result) {
  const cached = await writeTemplateDiskCache(cacheKey, result).catch((error) => {
    console.warn(`PPT 模板临时缓存写入失败：${error.message}`)
    return result
  })
  rememberCacheEntry(templateAnalysisCache, cacheKey, cached)
}

async function readTemplateDiskCache(cacheKey) {
  if (!diskCacheRoot) return null
  const cacheDir = getTemplateDiskCacheDir(cacheKey)
  const manifestPath = path.join(cacheDir, 'manifest.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (Date.now() - Number(manifest.cachedAt || 0) > cacheTtlMs) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
      return null
    }
    return manifest
  } catch {
    return null
  }
}

async function writeTemplateDiskCache(cacheKey, result) {
  if (!diskCacheRoot) return clonePlain(result)
  const cacheDir = getTemplateDiskCacheDir(cacheKey)
  const previewDir = path.join(cacheDir, 'preview')
  const assetDir = path.join(cacheDir, 'assets')
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(previewDir, { recursive: true })
  await mkdir(assetDir, { recursive: true })

  const cachedPreviewPaths = []
  for (const filePath of result.previewPaths || []) {
    if (!existsSync(filePath)) continue
    const outputPath = path.join(previewDir, path.basename(filePath))
    await copyFile(filePath, outputPath)
    cachedPreviewPaths.push(outputPath)
  }

  const cachedAssets = []
  for (const asset of result.assets || []) {
    if (!asset?.path || !existsSync(asset.path)) continue
    const outputPath = path.join(assetDir, asset.filename || path.basename(asset.path))
    await copyFile(asset.path, outputPath)
    cachedAssets.push({ ...asset, path: outputPath })
  }

  const manifest = {
    ...clonePlain(result),
    path: '',
    previewPaths: cachedPreviewPaths,
    assets: cachedAssets,
    cachedAt: Date.now(),
  }
  await writeFile(path.join(cacheDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function readContentDiskCache(cacheKey) {
  if (!diskCacheRoot) return null
  const filePath = path.join(getContentDiskCacheRoot(), `${hashCacheKey(cacheKey)}.json`)
  try {
    const cached = JSON.parse(await readFile(filePath, 'utf8'))
    if (Date.now() - Number(cached.cachedAt || 0) > cacheTtlMs) {
      await rm(filePath, { force: true }).catch(() => {})
      return null
    }
    return { text: String(cached.text || '') }
  } catch {
    return null
  }
}

async function writeContentDiskCache(cacheKey, value) {
  if (!diskCacheRoot) return
  await mkdir(getContentDiskCacheRoot(), { recursive: true })
  const filePath = path.join(getContentDiskCacheRoot(), `${hashCacheKey(cacheKey)}.json`)
  await writeFile(filePath, `${JSON.stringify({ ...value, cachedAt: Date.now() }, null, 2)}\n`, 'utf8')
}

async function copyCachedTemplateFiles(cached, renderDir, assetDir) {
  await mkdir(renderDir, { recursive: true })
  await mkdir(assetDir, { recursive: true })
  const previewPaths = []
  for (const filePath of cached.previewPaths || []) {
    if (!existsSync(filePath)) continue
    const outputPath = path.join(renderDir, path.basename(filePath))
    await copyFile(filePath, outputPath)
    previewPaths.push(outputPath)
  }
  const assets = []
  for (const asset of cached.assets || []) {
    if (!asset?.path || !existsSync(asset.path)) continue
    const outputPath = path.join(assetDir, asset.filename || path.basename(asset.path))
    await copyFile(asset.path, outputPath)
    assets.push({ ...asset, path: outputPath })
  }
  return { previewPaths, assets }
}

function cachedTemplateFilesExist(cached) {
  const files = [
    ...(cached.previewPaths || []),
    ...(cached.assets || []).map((asset) => asset.path).filter(Boolean),
  ]
  return files.every((filePath) => existsSync(filePath))
}

function rehydrateCachedTemplate(cached, file, copied, overrides) {
  return {
    ...clonePlain(cached),
    id: overrides.id,
    originalName: overrides.originalName,
    size: file.size,
    path: file.path,
    role: overrides.role,
    cacheKey: overrides.cacheKey,
    cacheHit: true,
    previewPaths: copied.previewPaths,
    assets: copied.assets,
  }
}

function getTemplateDiskCacheRoot() {
  return path.join(diskCacheRoot, 'template-analysis')
}

function getContentDiskCacheRoot() {
  return path.join(diskCacheRoot, 'content-text')
}

function getTemplateDiskCacheDir(cacheKey) {
  return path.join(getTemplateDiskCacheRoot(), hashCacheKey(cacheKey))
}

function hashCacheKey(cacheKey) {
  return createHash('sha1').update(cacheKey).digest('hex')
}

async function cleanupDiskCache() {
  if (!diskCacheRoot) return
  await cleanupCacheDirectory(getTemplateDiskCacheRoot(), true)
  await cleanupCacheDirectory(getContentDiskCacheRoot(), false)
}

async function cleanupCacheDirectory(directory, isDirectoryCache) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const items = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (isDirectoryCache && !entry.isDirectory()) continue
    if (!isDirectoryCache && !entry.isFile()) continue
    const info = await stat(fullPath).catch(() => null)
    if (!info) continue
    items.push({ path: fullPath, mtimeMs: info.mtimeMs })
  }

  const now = Date.now()
  await Promise.all(
    items
      .filter((item) => now - item.mtimeMs > cacheTtlMs)
      .map((item) => rm(item.path, { recursive: true, force: true }).catch(() => {})),
  )

  const fresh = items
    .filter((item) => now - item.mtimeMs <= cacheTtlMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  await Promise.all(
    fresh
      .slice(maxDiskCacheEntries)
      .map((item) => rm(item.path, { recursive: true, force: true }).catch(() => {})),
  )
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
