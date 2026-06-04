import { readFile } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import mammoth from 'mammoth'
import { XMLParser } from 'fast-xml-parser'
import { PDFDocument } from 'pdf-lib'
import { PDFParse } from 'pdf-parse'
import mime from 'mime-types'
import {
  MAX_FILE_SIZE,
  MAX_PDF_PAGES,
  MAX_PPTX_SLIDES,
} from './types.js'

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: '#text',
})

export function getExtension(filename) {
  return path.extname(filename || '').toLowerCase()
}

export function normalizeUploadFilename(filename = '') {
  const normalized = path.basename(filename)
  const repaired = Buffer.from(normalized, 'latin1').toString('utf8')
  return looksMojibake(normalized) && repaired.includes('�') === false ? repaired : normalized
}

export function getMimeType(filePath, fallback = 'application/octet-stream') {
  return mime.lookup(filePath) || fallback
}

export async function validateFileBasics(file, extension) {
  if (!file) {
    throw new Error('没有收到上传文件。')
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('文件超过 50MB，请上传更小的材料。')
  }
  if (!['.pdf', '.docx', '.pptx'].includes(extension)) {
    throw new Error('第一版仅支持 PDF、DOCX、PPTX。')
  }
}

export async function inspectDocument(filePath, extension) {
  if (extension === '.pdf') {
    const pageCount = await getPdfPageCount(filePath)
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF 共 ${pageCount} 页，超过第一版 100 页限制。`)
    }
    return { pageCount, slideCount: null }
  }

  if (extension === '.pptx') {
    const slideCount = getPptxSlideCount(filePath)
    if (slideCount > MAX_PPTX_SLIDES) {
      throw new Error(`PPTX 共 ${slideCount} 页幻灯片，超过第一版 100 页限制。`)
    }
    return { pageCount: null, slideCount }
  }

  return { pageCount: null, slideCount: null }
}

export async function prepareDocumentForAi(filePath, _originalName, extension) {
  if (extension === '.pdf') {
    const textContext = await extractPdfText(filePath)
    return {
      textContext,
      processingNotes: [
        'PDF 已本地提取可复制文字后交给 DeepSeek 分析。扫描版图片文字和复杂图表暂不参与理解。',
      ],
    }
  }

  if (extension === '.docx') {
    const textContext = await extractDocxText(filePath)
    return {
      textContext,
      processingNotes: [
        'DOCX 已本地提取正文后交给 DeepSeek 分析。文档内图片和复杂图示暂不参与理解。',
      ],
    }
  }

  const textContext = await extractPptxText(filePath)
  return {
    textContext,
    processingNotes: [
      'PPTX 已本地提取幻灯片文字后交给 DeepSeek 分析。图片、流程图和截图文字暂不参与理解。',
    ],
  }
}

export async function getPdfPageCount(filePath) {
  const bytes = await readFile(filePath)
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return pdf.getPageCount()
}

export function getPptxSlideCount(filePath) {
  const zip = new AdmZip(filePath)
  return zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName)).length
}

export async function extractPdfText(filePath) {
  const buffer = await readFile(filePath)
  const parserInstance = new PDFParse({ data: buffer })
  try {
    const result = await parserInstance.getText()
    return ensureTextContext(trimText(result.text || '', 40000), 'PDF')
  } finally {
    await parserInstance.destroy()
  }
}

export async function extractDocxText(filePath) {
  const result = await mammoth.convertToMarkdown({ path: filePath })
  return ensureTextContext(trimText(result.value || '', 40000), 'DOCX')
}

export async function extractPptxText(filePath) {
  const zip = new AdmZip(filePath)
  const slides = zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort((a, b) => getSlideNumber(a.entryName) - getSlideNumber(b.entryName))

  const slideTexts = slides.map((entry, index) => {
    const xml = entry.getData().toString('utf8')
    const parsed = parser.parse(xml)
    const text = collectText(parsed).join(' ').replace(/\s+/g, ' ').trim()
    return `第 ${index + 1} 页：${text || '未提取到文字'}`
  })

  return ensureTextContext(trimText(slideTexts.join('\n'), 40000), 'PPTX')
}

export async function extractPlainText(filePath) {
  const text = await readFile(filePath, 'utf8')
  return ensureTextContext(trimText(text || '', 40000), 'TXT')
}

function getSlideNumber(entryName) {
  return Number(entryName.match(/slide(\d+)\.xml$/)?.[1] || 0)
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

function trimText(text, maxLength) {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...（内容已截断）` : text
}

function ensureTextContext(text, label) {
  if (!text || text.replace(/\s/g, '').length < 20) {
    throw new Error(`${label} 未提取到足够文字。DeepSeek API 目前不支持直接理解文件图片，请换用可复制文字的材料。`)
  }
  return text
}

function looksMojibake(value) {
  return /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(value)
}
