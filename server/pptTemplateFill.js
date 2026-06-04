import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pythonBin = process.env.PYTHON_BIN || 'python3'
const templateFillScript = path.join(__dirname, 'vendor/ppt-master/scripts/template_fill_pptx.py')
const commandTimeoutMs = 180000
const commandMaxBuffer = 20 * 1024 * 1024

export async function analyzeTemplateFillLibrary(pptxPath, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  await runTemplateFillCommand(['analyze', pptxPath, '-o', outputPath])
  return readJson(outputPath)
}

export async function checkTemplateFillPlan(libraryPath, planPath, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const result = await runTemplateFillCommand(['check-plan', libraryPath, planPath, '-o', outputPath], {
    allowFailure: true,
  })
  const report = await readJson(outputPath)
  return {
    ...report,
    commandOutput: [result.stderr, result.stdout].filter(Boolean).join('\n').trim(),
  }
}

export async function applyTemplateFillPlan(pptxPath, planPath, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const result = await runTemplateFillCommand(['apply', pptxPath, planPath, '-o', outputPath])
  return findAppliedPptxPath(outputPath, result.stderr)
}

export async function normalizePptxForRendering(pptxPath) {
  const normalizedPath = pptxPath.replace(/\.pptx$/i, '.normalized.pptx')
  const script = [
    'from pptx import Presentation',
    'import sys',
    'presentation = Presentation(sys.argv[1])',
    'presentation.save(sys.argv[2])',
  ].join('\n')
  try {
    await execFileAsync(pythonBin, ['-c', script, pptxPath, normalizedPath], {
      timeout: commandTimeoutMs,
      maxBuffer: commandMaxBuffer,
    })
    return normalizedPath
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim()
    console.warn(`PPTX 规范化失败，继续使用原始模板填充文件：${detail || '没有返回详细信息'}`)
    return pptxPath
  }
}

export async function writeTemplateFillPlan(planPath, plan) {
  await mkdir(path.dirname(planPath), { recursive: true })
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
}

export function pruneSlideLibraryForAi(library, maxSlides = 60) {
  const slides = Array.isArray(library?.slides) ? library.slides : []
  return {
    schema: library?.schema || 'template_fill_pptx_library.v1',
    slide_count: Number(library?.slide_count) || slides.length,
    canvas_px: library?.canvas_px || null,
    slides: slides.slice(0, maxSlides).map((slide) => ({
      slide_index: Number(slide.slide_index),
      page_type: String(slide.page_type || 'content_candidate'),
      text_summary: trimText(slide.text_summary, 260),
      slots: normalizeSlotsForAi(slide.slots),
      table_count: Array.isArray(slide.tables) ? slide.tables.length : 0,
      chart_count: Array.isArray(slide.charts) ? slide.charts.length : 0,
    })),
  }
}

export function normalizeTemplateFillPlan(value, library, expectedCount) {
  const slides = Array.isArray(value?.slides) ? value.slides : []
  const availableSlides = new Set((library?.slides || []).map((slide) => Number(slide.slide_index)))
  const slotIdsBySlide = buildSlotLookup(library)
  const normalizedSlides = slides.slice(0, expectedCount).map((slide, index) => {
    const requestedSource = Number(slide?.source_slide)
    const sourceSlide = availableSlides.has(requestedSource)
      ? requestedSource
      : selectFallbackSourceSlide(index, library, expectedCount)
    const validSlotIds = slotIdsBySlide.get(sourceSlide) || new Set()
    const replacements = Array.isArray(slide?.replacements)
      ? slide.replacements
          .map((replacement) => ({
            slot_id: String(replacement?.slot_id || '').trim(),
            text: String(replacement?.text || '').trim(),
          }))
          .filter((replacement) => replacement.slot_id && validSlotIds.has(replacement.slot_id))
          .slice(0, 24)
      : []

    return {
      source_slide: sourceSlide,
      purpose: String(slide?.purpose || inferPurpose(index, expectedCount)),
      layout: normalizeTemplateFillLayout(slide?.layout, index),
      notes: String(slide?.notes || slide?.speakerNotes || ''),
      transition: 'keep',
      replacements,
      table_edits: Array.isArray(slide?.table_edits) ? slide.table_edits : [],
      chart_edits: Array.isArray(slide?.chart_edits) ? slide.chart_edits : [],
    }
  })

  if (normalizedSlides.length !== expectedCount) {
    throw new Error(`AI 返回了 ${normalizedSlides.length} 页模板填充计划，未达到要求的 ${expectedCount} 页。`)
  }

  return {
    schema: 'template_fill_pptx_plan.v1',
    title: String(value?.title || 'Moonwalk PPT'),
    subtitle: String(value?.subtitle || ''),
    slides: normalizedSlides,
  }
}

export function templateFillPlanToPptPlan(plan, fallbackTitle = 'Moonwalk PPT') {
  return {
    title: String(plan?.title || fallbackTitle),
    subtitle: String(plan?.subtitle || ''),
    theme: {
      tone: '继承用户模板',
      primaryColor: 'B86232',
      accentColor: 'C77D4D',
      backgroundColor: 'FFF7EE',
    },
    slides: (plan?.slides || []).map((slide, index) => {
      const texts = (slide.replacements || []).map((item) => item.text).filter(Boolean)
      return {
        title: texts[0] || `第 ${index + 1} 页`,
        subtitle: '',
        layout: normalizeTemplateFillLayout(slide.layout, index),
        emphasis: 'formal',
        bullets: texts.slice(1, 6),
        footer: '',
        speakerNotes: String(slide.notes || ''),
      }
    }),
  }
}

export function summarizeTemplateFillCheck(report) {
  const summary = report?.summary || {}
  const warnings = Array.isArray(report?.results)
    ? report.results.filter((item) => item.status === 'WARN').slice(0, 8)
    : []
  const errors = Array.isArray(report?.results)
    ? report.results.filter((item) => item.status === 'ERROR').slice(0, 8)
    : []
  return {
    ok: Number(summary.ok) || 0,
    warn: Number(summary.warn) || 0,
    error: Number(summary.error) || 0,
    warnings: warnings.map((item) => ({
      plan_slide: item.plan_slide,
      source_slide: item.source_slide,
      slot_id: item.slot_id || item.selector || '',
      message: item.message || '',
      old_text: trimText(item.old_text, 80),
      new_text: trimText(item.new_text, 80),
    })),
    errors: errors.map((item) => ({
      plan_slide: item.plan_slide,
      source_slide: item.source_slide,
      slot_id: item.slot_id || item.selector || '',
      message: item.message || '',
    })),
  }
}

async function runTemplateFillCommand(args, options = {}) {
  try {
    return await execFileAsync(pythonBin, [templateFillScript, ...args], {
      timeout: commandTimeoutMs,
      maxBuffer: commandMaxBuffer,
    })
  } catch (error) {
    if (options.allowFailure) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message || '',
      }
    }
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim()
    throw new Error(detail || 'PPT Master 模板填充命令执行失败。')
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function findAppliedPptxPath(requestedPath, stderr) {
  const match = String(stderr || '').match(/Template-filled PPTX -> (.+\.pptx)/)
  if (match?.[1]) return match[1].trim()

  const outputDir = path.dirname(requestedPath)
  const expectedBasename = path.basename(requestedPath)
  const files = await readdir(outputDir)
  if (files.includes(expectedBasename)) return requestedPath

  const stem = path.basename(requestedPath, '.pptx')
  const generated = files
    .filter((file) => file.startsWith(stem) && file.toLowerCase().endsWith('.pptx'))
    .sort()
    .at(-1)
  if (generated) return path.join(outputDir, generated)
  return requestedPath
}

function normalizeSlotsForAi(slots) {
  if (!Array.isArray(slots)) return []
  return slots.slice(0, 28).map((slot) => ({
    slot_id: String(slot.slot_id || ''),
    role: String(slot.role || ''),
    text: trimText(slot.text, 100),
    paragraph_count: Number(slot.paragraph_count) || 0,
    geometry: slot.geometry || null,
    font_size_px: slot.text_metrics?.font_size_px || null,
  }))
}

function buildSlotLookup(library) {
  const lookup = new Map()
  for (const slide of library?.slides || []) {
    lookup.set(
      Number(slide.slide_index),
      new Set((slide.slots || []).map((slot) => String(slot.slot_id)).filter(Boolean)),
    )
  }
  return lookup
}

function selectFallbackSourceSlide(index, library, expectedCount) {
  const slides = library?.slides || []
  if (!slides.length) return 1
  if (index === 0) {
    return Number(slides.find((slide) => String(slide.page_type).includes('cover'))?.slide_index || slides[0].slide_index)
  }
  if (index === expectedCount - 1) {
    return Number(slides.find((slide) => String(slide.page_type).includes('ending'))?.slide_index || slides.at(-1).slide_index)
  }
  const content = slides.filter((slide) => String(slide.page_type).includes('content'))
  return Number((content[index % Math.max(content.length, 1)] || slides[index % slides.length]).slide_index)
}

function inferPurpose(index, total) {
  if (index === 0) return 'cover'
  if (index === total - 1) return 'summary'
  return 'content'
}

function normalizeTemplateFillLayout(value, index) {
  const layout = String(value || '')
  const allowed = ['cover', 'agenda', 'section', 'content', 'two_column', 'comparison', 'timeline', 'quote', 'summary']
  if (allowed.includes(layout)) return layout
  return index === 0 ? 'cover' : 'content'
}

function trimText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}
