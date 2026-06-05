import path from 'node:path'
import { renderDocumentToPreviews } from './pptRenderer.js'

const visualExtensions = new Set(['.pdf', '.pptx'])
const defaultMaxPages = 4

export async function buildDocumentVisualContext({
  inputPath,
  extension,
  outputDir,
  label,
  kind = 'material',
  maxPages = defaultMaxPages,
}) {
  const normalizedExtension = String(extension || path.extname(inputPath)).toLowerCase()
  if (!inputPath || !visualExtensions.has(normalizedExtension)) {
    return {
      pages: [],
      notes: [`${label || '文件'} 暂未生成视觉上下文：当前仅支持 PDF/PPTX 页面截图。`],
    }
  }

  try {
    const rendered = await renderDocumentToPreviews(inputPath, outputDir, {
      prefix: kind,
      dpi: 72,
      extension: normalizedExtension,
      firstPage: 1,
      lastPage: maxPages,
      timeoutMs: 60000,
    })
    const pages = rendered.previewPaths.slice(0, maxPages).map((imagePath, index) => ({
      kind,
      label: `${label || '文件'} 第 ${index + 1} 页`,
      pageNumber: index + 1,
      imagePath,
      mimeType: 'image/png',
    }))
    return {
      pages,
      notes: pages.length
        ? [`已为 GPT 生成 ${pages.length} 页视觉上下文截图。`]
        : [`${label || '文件'} 暂未生成可用页面截图。`],
    }
  } catch (error) {
    return {
      pages: [],
      notes: [`${label || '文件'} 视觉上下文生成失败，已自动退回文本理解：${error.message}`],
    }
  }
}

export function visualContextFromPreviewPaths({
  paths,
  label,
  kind = 'template',
  maxPages = defaultMaxPages,
}) {
  const pages = (Array.isArray(paths) ? paths : [])
    .filter(Boolean)
    .slice(0, maxPages)
    .map((imagePath, index) => ({
      kind,
      label: `${label || '文件'} 第 ${index + 1} 页`,
      pageNumber: index + 1,
      imagePath,
      mimeType: 'image/png',
    }))

  return {
    pages,
    notes: pages.length
      ? [`已收集 ${label || '文件'} 的 ${pages.length} 页视觉参考。`]
      : [],
  }
}

export function combineVisualContexts(...contexts) {
  return {
    pages: contexts.flatMap((context) => Array.isArray(context?.pages) ? context.pages : []),
    notes: contexts.flatMap((context) => Array.isArray(context?.notes) ? context.notes : []),
  }
}

export function publicVisualContext(context) {
  const pages = Array.isArray(context?.pages) ? context.pages : []
  const notes = Array.isArray(context?.notes) ? context.notes : []
  if (!pages.length && !notes.length) return null
  return {
    pages: pages.map((page) => ({
      kind: page.kind,
      label: page.label,
      pageNumber: page.pageNumber,
      mimeType: page.mimeType,
    })),
    notes,
  }
}
