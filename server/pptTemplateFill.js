import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import AdmZip from 'adm-zip'
import path from 'node:path'
import posixPath from 'node:path/posix'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pythonBin = process.env.PYTHON_BIN || 'python3'
const templateFillScript = path.join(__dirname, 'vendor/ppt-master/scripts/template_fill_pptx.py')
const structuredSourcesScript = path.join(__dirname, 'vendor/ppt-master/scripts/structured_sources_pptx.py')
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

export async function embedGeneratedImagesInPptx(pptxPath, placements, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const manifestPath = outputPath.replace(/\.pptx$/i, '.images.json')
  await writeFile(manifestPath, `${JSON.stringify(placements || [], null, 2)}\n`, 'utf8')
  try {
    const zip = new AdmZip(pptxPath)
    const slideParts = resolveSlideParts(zip)
    const canvas = readPresentationCanvas(zip)
    const normalizedPlacements = normalizeImagePlacements(placements)
    let mediaNumber = getNextMediaNumber(zip)
    let embeddedCount = 0

    for (const placement of normalizedPlacements) {
      const slidePart = slideParts[placement.slideNumber - 1]
      if (!slidePart) continue
      const imageBuffer = await readFile(placement.imagePath).catch(() => null)
      if (!imageBuffer) continue

      const imageExtension = normalizeImageExtension(placement.imagePath)
      const imagePart = `ppt/media/moonwalk_generated_image_${mediaNumber}.${imageExtension}`
      mediaNumber += 1
      zip.addFile(imagePart, imageBuffer)
      ensureDefaultContentType(zip, imageExtension)

      const relsPart = relsPathForPart(slidePart)
      const relsXml = getZipText(zip, relsPart) || defaultRelationshipsXml()
      const relId = nextRelationshipId(relsXml)
      setZipText(zip, relsPart, appendRelationship(
        relsXml,
        relId,
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        posixPath.relative(posixPath.dirname(slidePart), imagePart),
      ))

      const slideXml = getZipText(zip, slidePart)
      if (!slideXml) continue
      const geometry = placementToEmu(placement, canvas)
      const shapeId = nextShapeId(slideXml)
      const pictureXml = buildPictureXml({
        relId,
        shapeId,
        name: `Moonwalk Generated Image ${embeddedCount + 1}`,
        ...geometry,
      })
      setZipText(zip, slidePart, appendShapeToSlide(slideXml, pictureXml))
      embeddedCount += 1
    }

    if (embeddedCount === 0) {
      throw new Error('没有可嵌入的生成图片。')
    }
    zip.writeZip(outputPath)
    return outputPath
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim()
    throw new Error(detail || '生成图片插入 PPTX 失败。')
  }
}

function resolveSlideParts(zip) {
  const presentationXml = getZipText(zip, 'ppt/presentation.xml')
  const presentationRelsXml = getZipText(zip, 'ppt/_rels/presentation.xml.rels')
  const relationshipLookup = new Map()
  if (presentationRelsXml) {
    for (const tag of presentationRelsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const attrs = parseXmlAttributes(tag[0])
      if (!String(attrs.Type || '').endsWith('/slide') || !attrs.Id || !attrs.Target) continue
      relationshipLookup.set(attrs.Id, normalizePptxPartPath(attrs.Target, 'ppt/presentation.xml'))
    }
  }

  if (presentationXml && relationshipLookup.size) {
    const parts = []
    for (const tag of presentationXml.matchAll(/<p:sldId\b[^>]*>/g)) {
      const attrs = parseXmlAttributes(tag[0])
      const relId = attrs['r:id'] || attrs.id
      const part = relationshipLookup.get(relId)
      if (part) parts.push(part)
    }
    if (parts.length) return parts
  }

  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)\.xml/i)?.[1] || 0) - Number(right.match(/slide(\d+)\.xml/i)?.[1] || 0))
}

function readPresentationCanvas(zip) {
  const xml = getZipText(zip, 'ppt/presentation.xml') || ''
  const match = xml.match(/<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  return {
    width: Number.isFinite(width) && width > 0 ? width : Math.round(13.333333 * 914400),
    height: Number.isFinite(height) && height > 0 ? height : Math.round(7.5 * 914400),
  }
}

function normalizeImagePlacements(placements) {
  if (!Array.isArray(placements)) return []
  return placements
    .map((placement) => {
      const slideNumber = Number(placement?.slideNumber)
      const x = normalizeUnit(placement?.x, 0.08)
      const y = normalizeUnit(placement?.y, 0.18)
      let width = Math.max(0.02, normalizeUnit(placement?.width, 0.32))
      let height = Math.max(0.02, normalizeUnit(placement?.height, 0.16))
      if (x + width > 1) width = Math.max(0.02, 1 - x)
      if (y + height > 1) height = Math.max(0.02, 1 - y)
      return {
        slideNumber,
        imagePath: String(placement?.imagePath || ''),
        x,
        y,
        width,
        height,
      }
    })
    .filter((placement) => Number.isInteger(placement.slideNumber) && placement.slideNumber > 0 && placement.imagePath)
}

function normalizeImageExtension(filePath) {
  const extension = path.extname(String(filePath || '')).replace('.', '').toLowerCase()
  if (extension === 'jpeg') return 'jpg'
  return ['png', 'jpg', 'gif'].includes(extension) ? extension : 'png'
}

function getNextMediaNumber(zip) {
  const used = new Set(zip.getEntries().map((entry) => entry.entryName))
  let number = 1
  while (used.has(`ppt/media/moonwalk_generated_image_${number}.png`)
    || used.has(`ppt/media/moonwalk_generated_image_${number}.jpg`)
    || used.has(`ppt/media/moonwalk_generated_image_${number}.gif`)) {
    number += 1
  }
  return number
}

function ensureDefaultContentType(zip, extension) {
  const contentTypeByExtension = {
    png: 'image/png',
    jpg: 'image/jpeg',
    gif: 'image/gif',
  }
  const contentType = contentTypeByExtension[extension] || 'image/png'
  const contentTypesPath = '[Content_Types].xml'
  const xml = getZipText(zip, contentTypesPath)
  if (!xml || xml.includes(`Extension="${extension}"`)) return
  const defaultXml = `<Default Extension="${escapeXmlAttribute(extension)}" ContentType="${escapeXmlAttribute(contentType)}"/>`
  setZipText(zip, contentTypesPath, xml.replace('</Types>', `${defaultXml}</Types>`))
}

function relsPathForPart(partName) {
  return posixPath.join(posixPath.dirname(partName), '_rels', `${posixPath.basename(partName)}.rels`)
}

function defaultRelationshipsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
}

function nextRelationshipId(relsXml) {
  let maxId = 0
  for (const match of String(relsXml || '').matchAll(/\bId="rId(\d+)"/g)) {
    maxId = Math.max(maxId, Number(match[1]) || 0)
  }
  return `rId${maxId + 1}`
}

function appendRelationship(relsXml, relId, type, target) {
  const relationship = `<Relationship Id="${escapeXmlAttribute(relId)}" Type="${escapeXmlAttribute(type)}" Target="${escapeXmlAttribute(target)}"/>`
  return String(relsXml || defaultRelationshipsXml()).replace('</Relationships>', `${relationship}</Relationships>`)
}

function placementToEmu(placement, canvas) {
  return {
    x: Math.round(canvas.width * placement.x),
    y: Math.round(canvas.height * placement.y),
    cx: Math.round(canvas.width * placement.width),
    cy: Math.round(canvas.height * placement.height),
  }
}

function nextShapeId(slideXml) {
  let maxId = 1
  for (const match of String(slideXml || '').matchAll(/<[^<:\s>]*:?cNvPr\b[^>]*\bid="(\d+)"/g)) {
    maxId = Math.max(maxId, Number(match[1]) || 0)
  }
  return maxId + 1
}

function buildPictureXml({ relId, shapeId, name, x, y, cx, cy }) {
  return [
    '<p:pic>',
    '<p:nvPicPr>',
    `<p:cNvPr id="${shapeId}" name="${escapeXmlAttribute(name)}"/>`,
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>',
    '<p:nvPr/>',
    '</p:nvPicPr>',
    '<p:blipFill>',
    `<a:blip r:embed="${escapeXmlAttribute(relId)}"/>`,
    '<a:stretch><a:fillRect/></a:stretch>',
    '</p:blipFill>',
    '<p:spPr>',
    '<a:xfrm>',
    `<a:off x="${x}" y="${y}"/>`,
    `<a:ext cx="${cx}" cy="${cy}"/>`,
    '</a:xfrm>',
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</p:spPr>',
    '</p:pic>',
  ].join('')
}

function appendShapeToSlide(slideXml, shapeXml) {
  const withNamespaces = ensureSlideRelationshipNamespace(slideXml)
  if (!withNamespaces.includes('</p:spTree>')) {
    throw new Error('PPTX 页面缺少可插入图片的 spTree。')
  }
  return withNamespaces.replace('</p:spTree>', `${shapeXml}</p:spTree>`)
}

function ensureSlideRelationshipNamespace(slideXml) {
  if (/\sxmlns:r=/.test(slideXml)) return slideXml
  return slideXml.replace(
    /<p:sld\b/,
    '<p:sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  )
}

function normalizePptxPartPath(target, basePart) {
  if (String(target || '').startsWith('/')) return String(target).replace(/^\/+/, '')
  return posixPath.normalize(posixPath.join(posixPath.dirname(basePart), String(target || ''))).replace(/^\/+/, '')
}

function parseXmlAttributes(tag) {
  const attrs = {}
  for (const match of String(tag || '').matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function getZipText(zip, entryName) {
  const entry = zip.getEntry(entryName)
  return entry ? entry.getData().toString('utf8') : ''
}

function setZipText(zip, entryName, text) {
  const data = Buffer.from(String(text || ''), 'utf8')
  if (zip.getEntry(entryName)) zip.updateFile(entryName, data)
  else zip.addFile(entryName, data)
}

function escapeXmlAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export async function buildStructuredSourceDeck(manifest, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const manifestPath = outputPath.replace(/\.pptx$/i, '.manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    await execFileAsync(pythonBin, [structuredSourcesScript, manifestPath, outputPath], {
      timeout: commandTimeoutMs,
      maxBuffer: commandMaxBuffer,
    })
    return outputPath
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim()
    throw new Error(detail || '结构化母版源 PPTX 生成失败。')
  }
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
      tables: normalizeTablesForAi(slide.tables),
      charts: normalizeChartsForAi(slide.charts),
    })),
  }
}

export function buildTemplatePageProfiles(library, maxSlides = 60) {
  const slides = Array.isArray(library?.slides) ? library.slides : []
  return slides.slice(0, maxSlides).map((slide, index) => {
    const slots = Array.isArray(slide.slots) ? slide.slots : []
    const textSlots = slots.filter((slot) => String(slot.text || '').trim())
    const roles = countBy(slots.map((slot) => String(slot.role || 'unknown')))
    const density = inferSlideDensity(slots)
    const layoutFamily = inferLayoutFamily(slide, slots, index, slides.length)
    const capacity = estimateSlideTextCapacity(slide)
    const roleScores = scoreTemplateSlideForRoles(slide, index, slides.length)
    const replacementSlots = selectTemplateReplacementSlots(slide, inferPurposeFromPageType(slide, index, slides.length))
    return {
      slide_index: Number(slide.slide_index || index + 1),
      page_type: String(slide.page_type || 'content_candidate'),
      layout_family: layoutFamily,
      density,
      slot_count: slots.length,
      text_slot_count: textSlots.length,
      title_slot_count: roles.title_candidate || 0,
      body_slot_count: roles.body_candidate || 0,
      table_count: Array.isArray(slide.tables) ? slide.tables.length : 0,
      chart_count: Array.isArray(slide.charts) ? slide.charts.length : 0,
      text_sample: trimText(slide.text_summary, 180),
      capacity,
      role_scores: roleScores,
      strongest_role: Object.entries(roleScores).sort((left, right) => right[1] - left[1])[0]?.[0] || 'content_candidate',
      replacement_slot_ids: replacementSlots.map((slot) => slot.slot_id).filter(Boolean).slice(0, 10),
      layout_signals: inferLayoutSignals(slide, slots),
      best_for: inferBestFor(slide, layoutFamily, density),
      avoid: inferAvoid(slide, layoutFamily, density),
    }
  })
}

export function buildTemplateSlideMatchPlan({
  library,
  narrativePlan = null,
  expectedCount = 0,
  structuredPagePlan = null,
  maxCandidates = 5,
} = {}) {
  const slides = Array.isArray(library?.slides) ? library.slides : []
  const total = Number(expectedCount) || Number(narrativePlan?.slides?.length) || 0
  if (!slides.length || total <= 0) {
    return {
      generatedAt: new Date().toISOString(),
      slideCount: total,
      items: [],
    }
  }

  const items = Array.from({ length: total }, (_, index) => {
    const structuredSlide = structuredPagePlan?.slides?.[index] || null
    const narrativeSlide = narrativePlan?.slides?.[index] || null
    const target = buildTemplateMatchTarget({
      index,
      total,
      narrativeSlide,
      structuredSlide,
    })
    const ranked = slides
      .map((slide, slideIndex) => ({
        source_slide: Number(slide.slide_index || slideIndex + 1),
        score: scoreTemplateSlideForTarget(slide, slideIndex, slides.length, target),
        page_type: String(slide.page_type || 'content_candidate'),
        layout_family: inferLayoutFamily(slide, slide.slots || [], slideIndex, slides.length),
        density: inferSlideDensity(slide.slots || []),
        reason: buildTemplateMatchReason(slide, slideIndex, slides.length, target),
      }))
      .sort((left, right) => right.score - left.score)

    let candidates = ranked.slice(0, maxCandidates).map((item) => ({
      source_slide: item.source_slide,
      score: item.score,
      page_type: item.page_type,
      layout_family: item.layout_family,
      density: item.density,
      reason: item.reason,
    }))
    const forcedSource = Number(structuredSlide?.sourceSlide)
    const preferred = forcedSource > 0
      ? candidates.find((item) => item.source_slide === forcedSource) || {
          source_slide: forcedSource,
          score: 999,
          page_type: 'structured_fixed',
          layout_family: structuredSlide?.layout || target.layoutIntent,
          density: 'fixed',
          reason: '五类母版固定页型',
        }
      : candidates[0]
    if (forcedSource > 0 && !candidates.some((item) => Number(item.source_slide) === forcedSource)) {
      candidates = [preferred, ...candidates].slice(0, maxCandidates)
    }

    return {
      slideNumber: index + 1,
      desiredRole: target.desiredRole,
      layoutIntent: target.layoutIntent,
      contentPriority: target.contentPriority,
      visualDirection: target.visualDirection,
      preferredSourceSlide: preferred?.source_slide || 1,
      candidateSourceSlides: candidates,
      strictSourceSlide: forcedSource > 0 ? forcedSource : null,
      keyMessage: trimText(narrativeSlide?.keyMessage, 100),
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    slideCount: total,
    items,
  }
}

export function alignTemplateFillPlanToMatchPlan(plan, library, matchPlan, options = {}) {
  const slideLookup = buildSlideLookup(library)
  const matchItems = Array.isArray(matchPlan?.items) ? matchPlan.items : []
  const originalSlides = Array.isArray(plan?.slides) ? plan.slides : []
  const diagnostics = createTemplateMatchDiagnostics(matchPlan)
  const enforce = options.enforce !== false

  const slides = originalSlides.map((slide, index) => {
    const match = matchItems[index] || null
    if (!match) return slide
    const sourceSlide = Number(slide?.source_slide)
    const preferredSource = Number(match.preferredSourceSlide)
    const currentCandidate = (match.candidateSourceSlides || []).find((candidate) => Number(candidate.source_slide) === sourceSlide)
    const preferredCandidate = (match.candidateSourceSlides || []).find((candidate) => Number(candidate.source_slide) === preferredSource)
    const currentScore = Number(currentCandidate?.score || 0)
    const preferredScore = Number(preferredCandidate?.score || (preferredSource === sourceSlide ? currentScore : 0))
    const isStrictMismatch = Number(match.strictSourceSlide) > 0 && sourceSlide !== Number(match.strictSourceSlide)
    const isLowConfidence = !currentCandidate || (preferredScore - currentScore >= 38 && preferredScore >= 60)
    const shouldRemap = enforce && preferredSource > 0 && sourceSlide !== preferredSource && (isStrictMismatch || isLowConfidence)

    const issue = {
      slideNumber: index + 1,
      desiredRole: match.desiredRole,
      layoutIntent: match.layoutIntent,
      sourceSlide,
      preferredSourceSlide: preferredSource || sourceSlide,
      currentScore,
      preferredScore,
      severity: shouldRemap ? 'high' : currentCandidate ? 'low' : 'medium',
      action: shouldRemap ? 'remapped' : currentCandidate ? 'kept' : 'review',
      reason: currentCandidate ? currentCandidate.reason : '当前源页不在推荐候选中',
      candidates: (match.candidateSourceSlides || []).slice(0, 4),
    }
    diagnostics.slides.push(issue)
    if (issue.severity === 'high') diagnostics.highRisk += 1
    if (issue.severity === 'medium') diagnostics.mediumRisk += 1
    if (shouldRemap) {
      diagnostics.remapped += 1
      return remapTemplateFillSlideToSource(slide, slideLookup.get(preferredSource), preferredSource, match, index)
    }
    return slide
  })

  return {
    plan: {
      ...plan,
      slides,
    },
    diagnostics,
  }
}

export function diagnoseTemplateFillPlanMatches(plan, _library, matchPlan) {
  const matchItems = Array.isArray(matchPlan?.items) ? matchPlan.items : []
  const diagnostics = createTemplateMatchDiagnostics(matchPlan)
  ;(plan?.slides || []).forEach((slide, index) => {
    const match = matchItems[index]
    if (!match) return
    const sourceSlide = Number(slide?.source_slide)
    const candidate = (match.candidateSourceSlides || []).find((item) => Number(item.source_slide) === sourceSlide)
    const strictSource = Number(match.strictSourceSlide)
    const strictMismatch = strictSource > 0 && strictSource !== sourceSlide
    const severity = strictMismatch ? 'high' : candidate ? 'low' : 'medium'
    diagnostics.slides.push({
      slideNumber: index + 1,
      desiredRole: match.desiredRole,
      layoutIntent: match.layoutIntent,
      sourceSlide,
      preferredSourceSlide: strictSource || Number(match.preferredSourceSlide) || sourceSlide,
      currentScore: Number(candidate?.score || 0),
      preferredScore: Number((match.candidateSourceSlides || [])[0]?.score || 0),
      severity,
      action: 'diagnosed',
      reason: candidate?.reason || '当前源页不在推荐候选中',
      candidates: (match.candidateSourceSlides || []).slice(0, 4),
    })
    if (severity === 'high') diagnostics.highRisk += 1
    if (severity === 'medium') diagnostics.mediumRisk += 1
  })
  return diagnostics
}

export function summarizeTemplateSlideMatchPlan(matchPlan) {
  const items = Array.isArray(matchPlan?.items) ? matchPlan.items : []
  return {
    slideCount: Number(matchPlan?.slideCount) || items.length,
    items: items.map((item) => ({
      slideNumber: item.slideNumber,
      desiredRole: item.desiredRole,
      layoutIntent: item.layoutIntent,
      preferredSourceSlide: item.preferredSourceSlide,
      candidateSourceSlides: (item.candidateSourceSlides || []).slice(0, 3).map((candidate) => ({
        source_slide: candidate.source_slide,
        score: candidate.score,
        page_type: candidate.page_type,
        layout_family: candidate.layout_family,
      })),
    })),
  }
}

export function adaptTemplateFillPlanToCapacity(plan, library, narrativePlan = null) {
  const slideLookup = buildSlideLookup(library)
  const slotLookup = buildSlotDetailLookup(library)
  const diagnostics = {
    totalReplacements: 0,
    trimmedReplacements: 0,
    removedEmptyReplacements: 0,
    slideDiagnostics: [],
  }

  const slides = (plan.slides || []).map((slide, index) => {
    const sourceSlide = Number(slide.source_slide)
    const librarySlide = slideLookup.get(sourceSlide)
    const narrativeSlide = narrativePlan?.slides?.[index] || null
    const priority = narrativeSlide?.contentPriority || 'medium'
    const replacements = []
    const slideDiagnostic = {
      slideNumber: index + 1,
      sourceSlide,
      layout: slide.layout,
      narrativeKeyMessage: narrativeSlide?.keyMessage || '',
      replacementCountBefore: Array.isArray(slide.replacements) ? slide.replacements.length : 0,
      replacementCountAfter: 0,
      trimmed: [],
      removed: [],
      density: librarySlide ? inferSlideDensity(librarySlide.slots || []) : 'medium',
      capacityLevel: priority,
    }

    for (const replacement of slide.replacements || []) {
      const slot = slotLookup.get(`${sourceSlide}:${replacement.slot_id}`)
      const rawText = String(replacement.text || '').trim()
      diagnostics.totalReplacements += 1
      if (!rawText) {
        diagnostics.removedEmptyReplacements += 1
        slideDiagnostic.removed.push(replacement.slot_id)
        continue
      }
      const limit = estimateSlotTextLimit(slot, priority)
      const text = compactTextToLimit(rawText, limit)
      if (text !== rawText) {
        diagnostics.trimmedReplacements += 1
        slideDiagnostic.trimmed.push({
          slot_id: replacement.slot_id,
          beforeLength: rawText.length,
          afterLength: text.length,
          limit,
        })
      }
      replacements.push({
        ...replacement,
        text,
      })
    }

    slideDiagnostic.replacementCountAfter = replacements.length
    diagnostics.slideDiagnostics.push(slideDiagnostic)
    return {
      ...slide,
      replacements,
    }
  })

  return {
    plan: {
      ...plan,
      slides,
    },
    diagnostics,
  }
}

export function normalizeTemplateFillPlan(value, library, expectedCount) {
  const slides = Array.isArray(value?.slides) ? value.slides : []
  const availableSlides = new Set((library?.slides || []).map((slide) => Number(slide.slide_index)))
  const slotIdsBySlide = buildSlotLookup(library)
  const tableLookup = buildTableLookup(library)
  const chartLookup = buildChartLookup(library)
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
      table_edits: normalizeTableEdits(slide?.table_edits, tableLookup.get(sourceSlide)),
      chart_edits: normalizeChartEdits(slide?.chart_edits, chartLookup.get(sourceSlide)),
      extra_shapes: normalizeExtraShapes(slide?.extra_shapes),
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

function normalizeExtraShapes(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((shape) => {
      const kind = ['text', 'rect', 'image_placeholder'].includes(shape?.kind) ? shape.kind : 'text'
      return {
        kind,
        x: normalizeUnit(shape?.x, 0.08),
        y: normalizeUnit(shape?.y, 0.18),
        width: normalizeUnit(shape?.width, 0.32),
        height: normalizeUnit(shape?.height, 0.16),
        text: trimText(String(shape?.text || ''), 180),
        image_prompt: trimText(String(shape?.image_prompt || shape?.prompt || ''), 360),
        fill_color: normalizeHex(shape?.fill_color, kind === 'image_placeholder' ? 'F6EFE7' : 'FFF7EE'),
        line_color: normalizeHex(shape?.line_color, 'DCAE80'),
        font_color: normalizeHex(shape?.font_color, '71472A'),
        font_size: normalizeNumber(shape?.font_size, 13, 9, 28),
        fill_transparency: normalizeNumber(shape?.fill_transparency, kind === 'text' ? 100 : 0, 0, 100),
        line_transparency: normalizeNumber(shape?.line_transparency, kind === 'text' ? 100 : 0, 0, 100),
      }
    })
    .filter((shape) => shape.width > 0.02 && shape.height > 0.02)
    .slice(0, 4)
}

function normalizeTablesForAi(tables) {
  if (!Array.isArray(tables)) return []
  return tables.slice(0, 4).map((table) => {
    const rowCount = Number(table?.row_count) || 0
    const columnCount = Number(table?.column_count) || 0
    const sampleCells = []
    for (const row of table?.rows || []) {
      for (const cell of row?.cells || []) {
        if (sampleCells.length >= 18) break
        sampleCells.push({
          row: Number(cell?.row) || 0,
          col: Number(cell?.col) || 0,
          text: trimText(cell?.text, 60),
        })
      }
      if (sampleCells.length >= 18) break
    }
    return {
      table_id: String(table?.table_id || ''),
      row_count: rowCount,
      column_count: columnCount,
      sample_cells: sampleCells,
    }
  }).filter((table) => table.table_id && table.row_count > 0 && table.column_count > 0)
}

function normalizeChartsForAi(charts) {
  if (!Array.isArray(charts)) return []
  return charts.slice(0, 4).map((chart) => ({
    chart_id: String(chart?.chart_id || ''),
    chart_type: String(chart?.chart_type || ''),
    category_count: Number(chart?.category_count) || 0,
    series_count: Number(chart?.series_count) || 0,
    categories: normalizeStringArray(chart?.categories).slice(0, 10),
    series: Array.isArray(chart?.series)
      ? chart.series.slice(0, 4).map((series) => ({
          name: trimText(series?.name, 40),
          values: normalizeNumberArray(series?.values).slice(0, 10),
        }))
      : [],
  })).filter((chart) => chart.chart_id)
}

function normalizeTableEdits(value, tablesById = new Map()) {
  if (!Array.isArray(value) || !(tablesById instanceof Map)) return []
  return value
    .map((edit) => {
      const tableId = String(edit?.table_id || '').trim()
      const table = tablesById.get(tableId)
      if (!table) return null
      const rowCount = Number(table.row_count) || 0
      const columnCount = Number(table.column_count) || 0
      const cells = Array.isArray(edit?.cells)
        ? edit.cells
            .map((cell) => ({
              row: Number(cell?.row),
              col: Number(cell?.col),
              text: trimText(cell?.text, 160),
            }))
            .filter((cell) => (
              Number.isInteger(cell.row)
              && Number.isInteger(cell.col)
              && cell.row >= 0
              && cell.col >= 0
              && cell.row < rowCount
              && cell.col < columnCount
              && cell.text
            ))
            .slice(0, 36)
        : []
      if (!cells.length) return null
      return {
        table_id: tableId,
        cells,
        optional: Boolean(edit?.optional),
      }
    })
    .filter(Boolean)
    .slice(0, 4)
}

function normalizeChartEdits(value, chartsById = new Map()) {
  if (!Array.isArray(value) || !(chartsById instanceof Map)) return []
  return value
    .map((edit) => {
      const chartId = String(edit?.chart_id || '').trim()
      if (!chartsById.has(chartId)) return null
      const categories = normalizeStringArray(edit?.categories).slice(0, 12)
      const series = Array.isArray(edit?.series)
        ? edit.series
            .map((item, index) => ({
              name: trimText(item?.name || `系列${index + 1}`, 40),
              values: normalizeNumberArray(item?.values).slice(0, 12),
            }))
            .filter((item) => item.name && item.values.length === categories.length)
            .slice(0, 4)
        : []
      if (!categories.length || !series.length) return null
      return {
        chart_id: chartId,
        categories,
        series,
        optional: Boolean(edit?.optional),
      }
    })
    .filter(Boolean)
    .slice(0, 4)
}

function buildTableLookup(library) {
  const lookup = new Map()
  for (const slide of library?.slides || []) {
    const slideIndex = Number(slide.slide_index)
    const tablesById = new Map()
    for (const table of slide.tables || []) {
      const tableId = String(table?.table_id || '').trim()
      if (tableId) tablesById.set(tableId, table)
    }
    lookup.set(slideIndex, tablesById)
  }
  return lookup
}

function buildChartLookup(library) {
  const lookup = new Map()
  for (const slide of library?.slides || []) {
    const slideIndex = Number(slide.slide_index)
    const chartsById = new Map()
    for (const chart of slide.charts || []) {
      const chartId = String(chart?.chart_id || '').trim()
      if (chartId) chartsById.set(chartId, chart)
    }
    lookup.set(slideIndex, chartsById)
  }
  return lookup
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => trimText(item, 60)).filter(Boolean)
}

function normalizeNumberArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
}

function normalizeUnit(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(1, number))
}

function normalizeNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function normalizeHex(value, fallback) {
  const cleaned = String(value || '').replace('#', '').trim().toUpperCase()
  return /^[0-9A-F]{6}$/.test(cleaned) ? cleaned : fallback
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
    text_limit: estimateSlotTextLimit(slot, 'medium'),
  }))
}

function buildSlideLookup(library) {
  const lookup = new Map()
  for (const slide of library?.slides || []) {
    lookup.set(Number(slide.slide_index), slide)
  }
  return lookup
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

function buildSlotDetailLookup(library) {
  const lookup = new Map()
  for (const slide of library?.slides || []) {
    const slideIndex = Number(slide.slide_index)
    for (const slot of slide.slots || []) {
      lookup.set(`${slideIndex}:${slot.slot_id}`, slot)
    }
  }
  return lookup
}

function countBy(items) {
  const counts = {}
  for (const item of items) {
    counts[item] = (counts[item] || 0) + 1
  }
  return counts
}

function inferSlideDensity(slots) {
  const count = Array.isArray(slots) ? slots.length : 0
  const textLength = (slots || []).reduce((total, slot) => total + String(slot.text || '').length, 0)
  if (count <= 2 && textLength <= 70) return 'low'
  if (count >= 8 || textLength >= 420) return 'high'
  return 'medium'
}

function inferPurposeFromPageType(slide, index, total) {
  const pageType = String(slide?.page_type || '')
  if (pageType.includes('cover')) return 'cover'
  if (pageType.includes('toc')) return 'agenda'
  if (pageType.includes('chapter')) return 'section'
  if (pageType.includes('ending') || index === total - 1) return 'summary'
  return 'content'
}

function inferLayoutFamily(slide, slots, index, total) {
  const pageType = String(slide?.page_type || '')
  if (pageType.includes('cover')) return 'cover'
  if (pageType.includes('toc')) return 'agenda'
  if (pageType.includes('chapter')) return 'section'
  if (pageType.includes('ending') || index === total - 1) return 'summary'
  const geometries = (slots || []).map((slot) => slot.geometry || {}).filter((geometry) => Number.isFinite(Number(geometry.x)))
  const left = geometries.filter((geometry) => Number(geometry.x) < 480).length
  const right = geometries.filter((geometry) => Number(geometry.x) >= 480).length
  if (left >= 2 && right >= 2) return 'two_column'
  if ((slide?.charts || []).length > 0) return 'chart'
  if ((slide?.tables || []).length > 0) return 'table'
  return 'content'
}

function inferLayoutSignals(slide, slots) {
  const geometries = (slots || [])
    .map((slot) => normalizeGeometry(slot.geometry))
    .filter((geometry) => geometry.width > 0 && geometry.height > 0)
  const canvas = inferCanvasFromGeometries(geometries)
  const left = geometries.filter((geometry) => geometry.x + geometry.width / 2 < canvas.width * 0.46).length
  const middle = geometries.filter((geometry) => {
    const center = geometry.x + geometry.width / 2
    return center >= canvas.width * 0.46 && center <= canvas.width * 0.54
  }).length
  const right = geometries.filter((geometry) => geometry.x + geometry.width / 2 > canvas.width * 0.54).length
  const top = geometries.filter((geometry) => geometry.y < canvas.height * 0.22).length
  const bottom = geometries.filter((geometry) => geometry.y > canvas.height * 0.72).length
  const wide = geometries.filter((geometry) => geometry.width >= canvas.width * 0.55).length
  return {
    columns: left > 0 && right > 0 ? 2 : 1,
    left_slots: left,
    center_slots: middle,
    right_slots: right,
    top_slots: top,
    bottom_slots: bottom,
    wide_slots: wide,
    has_table: Array.isArray(slide?.tables) && slide.tables.length > 0,
    has_chart: Array.isArray(slide?.charts) && slide.charts.length > 0,
  }
}

function scoreTemplateSlideForRoles(slide, index, total) {
  const roles = ['cover_candidate', 'toc_candidate', 'chapter_candidate', 'content_candidate', 'ending_candidate']
  return Object.fromEntries(
    roles.map((role) => [role, scoreTemplateSlideForTarget(slide, index, total, {
      desiredRole: role,
      layoutIntent: roleToLayoutIntent(role),
      contentPriority: 'medium',
      visualDirection: '',
    })]),
  )
}

function buildTemplateMatchTarget({ index, total, narrativeSlide, structuredSlide }) {
  const desiredRole = normalizeDesiredTemplateRole(
    structuredSlide?.suggestedTemplateRole
      || narrativeSlide?.suggestedTemplateRole
      || narrativeSlide?.role
      || inferDesiredRole(index, total),
    index,
    total,
  )
  const layoutIntent = normalizeLayoutIntent(
    structuredSlide?.layout
      || narrativeSlide?.layoutIntent
      || narrativeSlide?.layout
      || roleToLayoutIntent(desiredRole),
    index,
  )
  const contentPriority = ['high', 'medium', 'low'].includes(narrativeSlide?.contentPriority)
    ? narrativeSlide.contentPriority
    : 'medium'
  return {
    desiredRole,
    layoutIntent,
    contentPriority,
    visualDirection: String(narrativeSlide?.visualDirection || ''),
  }
}

function scoreTemplateSlideForTarget(slide, index, total, target) {
  const slots = Array.isArray(slide?.slots) ? slide.slots : []
  const pageType = String(slide?.page_type || 'content_candidate')
  const layoutFamily = inferLayoutFamily(slide, slots, index, total)
  const density = inferSlideDensity(slots)
  const text = normalizeSearchText([slide?.text_summary, ...slots.map((slot) => slot.text)].join(' '))
  const signals = inferLayoutSignals(slide, slots)
  const role = normalizeDesiredTemplateRole(target?.desiredRole, index, total)
  const layoutIntent = normalizeLayoutIntent(target?.layoutIntent, index)
  let score = 0

  if (pageType === role) score += 72
  if (pageType.includes(role.replace('_candidate', ''))) score += 35
  if (layoutFamily === layoutIntent) score += 38
  if (layoutFamily === roleToLayoutIntent(role)) score += 30
  if (layoutCompatible(layoutFamily, layoutIntent)) score += 16

  if (role === 'cover_candidate') {
    if (index === 0) score += 24
    if (density === 'low') score += 18
    if (signals.wide_slots > 0) score += 8
    if (hasKeyword(text, ['封面', '主题', '汇报', '报告', 'presentation'])) score += 12
    if (signals.has_table || signals.has_chart) score -= 28
  }
  if (role === 'toc_candidate') {
    if (hasKeyword(text, ['目录', '议程', '大纲', 'contents', 'agenda', 'outline'])) score += 58
    if (index === 1) score += 16
    if (density === 'medium' || density === 'high') score += 8
    if (signals.left_slots + signals.right_slots >= 4) score += 6
    if (signals.has_chart) score -= 16
  }
  if (role === 'chapter_candidate') {
    if (hasKeyword(text, ['章节', '部分', 'chapter', 'section', 'part'])) score += 42
    if (density === 'low') score += 22
    if (signals.wide_slots > 0) score += 8
    if (signals.has_table || signals.has_chart) score -= 18
  }
  if (role === 'content_candidate') {
    if (pageType === 'content_candidate') score += 30
    if (!hasKeyword(text, ['目录', '议程', 'contents', 'agenda', '谢谢', 'thanks', '答疑'])) score += 18
    if (density === 'medium' || density === 'high') score += 16
    if (signals.has_table || signals.has_chart) score += 16
    if (layoutIntent === 'two_column' && signals.columns >= 2) score += 24
    if ((layoutIntent === 'comparison' || layoutIntent === 'timeline') && (signals.columns >= 2 || signals.has_table)) score += 14
    if (index === 0 || index === total - 1) score -= 32
  }
  if (role === 'ending_candidate') {
    if (index === total - 1) score += 20
    if (hasKeyword(text, ['谢谢', '感谢', '致谢', '答疑', '联系', 'thanks', 'q&a', 'contact'])) score += 62
    if (layoutFamily === 'summary' || density === 'low') score += 18
    if (signals.has_table || signals.has_chart) score -= 20
  }

  if (target?.contentPriority === 'high' && density === 'low' && role === 'content_candidate') score -= 10
  if (target?.contentPriority === 'low' && density === 'high') score -= 12
  return Math.max(0, Math.round(score))
}

function buildTemplateMatchReason(slide, index, total, target) {
  const slots = Array.isArray(slide?.slots) ? slide.slots : []
  const pageType = String(slide?.page_type || 'content_candidate')
  const layoutFamily = inferLayoutFamily(slide, slots, index, total)
  const density = inferSlideDensity(slots)
  const reasons = [`页型 ${pageType}`, `版式 ${layoutFamily}`, `密度 ${density}`]
  const text = normalizeSearchText([slide?.text_summary, ...slots.map((slot) => slot.text)].join(' '))
  if (hasKeyword(text, ['目录', '议程', 'agenda', 'contents'])) reasons.push('含目录信号')
  if (hasKeyword(text, ['谢谢', '感谢', 'thanks', 'q&a'])) reasons.push('含结尾信号')
  if ((slide?.tables || []).length) reasons.push('含原生表格')
  if ((slide?.charts || []).length) reasons.push('含原生图表')
  if (layoutCompatible(layoutFamily, target?.layoutIntent)) reasons.push(`匹配 ${target.layoutIntent}`)
  return reasons.join('；')
}

function createTemplateMatchDiagnostics(matchPlan) {
  return {
    slideCount: Number(matchPlan?.slideCount) || 0,
    remapped: 0,
    highRisk: 0,
    mediumRisk: 0,
    slides: [],
    generatedAt: new Date().toISOString(),
  }
}

function remapTemplateFillSlideToSource(slide, targetSlide, targetSource, match, index) {
  if (!targetSlide) return slide
  const targetSlots = selectTemplateReplacementSlots(targetSlide, layoutIntentToPurpose(match?.layoutIntent, index))
  const originalTexts = [
    ...(slide?.replacements || []).map((replacement) => replacement?.text),
    slide?.notes,
    match?.keyMessage,
  ].map((text) => String(text || '').trim()).filter(Boolean)
  const uniqueTexts = [...new Set(originalTexts)]
  const replacements = targetSlots.slice(0, Math.max(2, uniqueTexts.length)).map((slot, slotIndex) => ({
    slot_id: String(slot.slot_id || ''),
    text: uniqueTexts[slotIndex] || uniqueTexts.at(-1) || '',
  })).filter((replacement) => replacement.slot_id && replacement.text)

  return {
    ...slide,
    source_slide: targetSource,
    purpose: layoutIntentToPurpose(match?.layoutIntent, index),
    layout: normalizeTemplateFillLayout(match?.layoutIntent || slide?.layout, index),
    replacements,
    table_edits: [],
    chart_edits: [],
  }
}

function selectTemplateReplacementSlots(slide, purpose = 'content') {
  const slots = Array.isArray(slide?.slots) ? slide.slots : []
  const replaceable = slots.filter((slot) => isTemplateReplaceableSlot(slot, purpose))
  const fallback = slots.filter((slot) => {
    const role = String(slot?.role || '')
    return role.includes('title') || role.includes('body') || role.includes('label')
  })
  return (replaceable.length ? replaceable : fallback)
    .sort((left, right) => compareSlotPosition(left, right))
    .slice(0, purpose === 'content' ? 10 : 6)
}

function isTemplateReplaceableSlot(slot, purpose) {
  const text = String(slot?.text || '').trim()
  const role = String(slot?.role || '')
  if (isFixedTemplateSlotText(text)) return false
  if (isTemplatePlaceholderText(text)) return true
  if (!text && purpose === 'content' && role.includes('body')) return true
  if (purpose === 'agenda') return role.includes('title') || role.includes('body') || role.includes('label')
  if (purpose === 'cover' || purpose === 'section' || purpose === 'summary') return role.includes('title') || role.includes('body')
  return role.includes('title') || role.includes('body') || role.includes('label')
}

function isTemplatePlaceholderText(text) {
  return /x{2,}|\.{3,}|…{2,}|标题|正文|请输入|占位|单击此处|click\s+to\s+add|lorem|placeholder/i.test(text)
}

function isFixedTemplateSlotText(text) {
  if (!text) return false
  const compact = text.replace(/\s+/g, '')
  if (/^(logo|页码|page|date|日期|copyright|©|品牌标语|slogan)$/i.test(compact)) return true
  if (/(www\.|https?:\/\/|@)/i.test(text)) return true
  if (/^\d{4}[./年-]\d{1,2}/.test(compact)) return true
  if (/^\d{1,2}\s*\/\s*\d{1,2}$/.test(compact)) return true
  return /^[0-9０-９ivxIVX一二三四五六七八九十./\-]+$/.test(compact) && compact.length <= 5
}

function compareSlotPosition(left, right) {
  const leftGeometry = normalizeGeometry(left?.geometry)
  const rightGeometry = normalizeGeometry(right?.geometry)
  if (leftGeometry.y !== rightGeometry.y) return leftGeometry.y - rightGeometry.y
  return leftGeometry.x - rightGeometry.x
}

function normalizeGeometry(geometry) {
  return {
    x: Number(geometry?.x ?? 0),
    y: Number(geometry?.y ?? 0),
    width: Number(geometry?.width ?? geometry?.w ?? 0),
    height: Number(geometry?.height ?? geometry?.h ?? 0),
  }
}

function inferCanvasFromGeometries(geometries) {
  const maxX = Math.max(960, ...geometries.map((geometry) => geometry.x + geometry.width))
  const maxY = Math.max(540, ...geometries.map((geometry) => geometry.y + geometry.height))
  return { width: maxX, height: maxY }
}

function normalizeDesiredTemplateRole(value, index = 0, total = 1) {
  const role = String(value || '')
  const roleMap = {
    cover: 'cover_candidate',
    agenda: 'toc_candidate',
    toc: 'toc_candidate',
    section: 'chapter_candidate',
    chapter: 'chapter_candidate',
    content: 'content_candidate',
    two_column: 'content_candidate',
    comparison: 'content_candidate',
    timeline: 'content_candidate',
    quote: 'content_candidate',
    summary: 'ending_candidate',
    ending: 'ending_candidate',
  }
  const allowed = ['cover_candidate', 'toc_candidate', 'chapter_candidate', 'content_candidate', 'ending_candidate']
  if (allowed.includes(role)) return role
  if (roleMap[role]) return roleMap[role]
  return inferDesiredRole(index, total)
}

function inferDesiredRole(index, total) {
  if (index === 0) return 'cover_candidate'
  if (index === total - 1) return 'ending_candidate'
  if (index === 1) return 'toc_candidate'
  return 'content_candidate'
}

function normalizeLayoutIntent(value, index = 0) {
  const layout = String(value || '')
  const allowed = ['cover', 'agenda', 'section', 'content', 'two_column', 'comparison', 'timeline', 'quote', 'summary']
  if (allowed.includes(layout)) return layout
  return index === 0 ? 'cover' : 'content'
}

function roleToLayoutIntent(role) {
  const normalized = String(role || '')
  if (normalized === 'cover_candidate') return 'cover'
  if (normalized === 'toc_candidate') return 'agenda'
  if (normalized === 'chapter_candidate') return 'section'
  if (normalized === 'ending_candidate') return 'summary'
  return 'content'
}

function layoutIntentToPurpose(layout, index = 0) {
  const normalized = normalizeLayoutIntent(layout, index)
  if (normalized === 'agenda') return 'agenda'
  if (normalized === 'section') return 'section'
  if (normalized === 'summary') return 'summary'
  if (normalized === 'cover') return 'cover'
  return 'content'
}

function layoutCompatible(layoutFamily, layoutIntent) {
  const family = String(layoutFamily || '')
  const intent = String(layoutIntent || '')
  if (family === intent) return true
  if (family === 'table' && ['content', 'comparison', 'two_column'].includes(intent)) return true
  if (family === 'chart' && ['content', 'comparison', 'timeline'].includes(intent)) return true
  if (family === 'content' && ['comparison', 'timeline', 'quote'].includes(intent)) return true
  if (family === 'two_column' && ['comparison', 'content'].includes(intent)) return true
  return false
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

function hasKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(String(keyword).toLowerCase()))
}

function inferBestFor(slide, layoutFamily, density) {
  const best = []
  if (layoutFamily === 'cover') best.push('封面标题', '一句话主题')
  if (layoutFamily === 'agenda') best.push('目录', '章节概览')
  if (layoutFamily === 'section') best.push('章节分隔', '阶段转场')
  if (layoutFamily === 'two_column') best.push('对比', '并列观点', '问题与方案')
  if (layoutFamily === 'chart' || layoutFamily === 'table') best.push('数据说明', '结构化信息')
  if (layoutFamily === 'summary') best.push('总结', '结论', '行动建议')
  if (layoutFamily === 'content') best.push('核心观点', '三点递进')
  if (density === 'low') best.push('强结论', '留白强调')
  if (density === 'high') best.push('信息列表', '多要点展开')
  return [...new Set(best)].slice(0, 5)
}

function inferAvoid(_slide, layoutFamily, density) {
  const avoid = []
  if (layoutFamily === 'cover') avoid.push('长段正文', '复杂列表')
  if (layoutFamily === 'agenda') avoid.push('论证细节')
  if (layoutFamily === 'two_column') avoid.push('三组以上并列信息')
  if (layoutFamily === 'summary') avoid.push('新概念')
  if (density === 'low') avoid.push('超过三个要点')
  if (density === 'high') avoid.push('继续塞入长句')
  return [...new Set(avoid)].slice(0, 4)
}

function estimateSlideTextCapacity(slide) {
  const slots = Array.isArray(slide?.slots) ? slide.slots : []
  const limits = slots.map((slot) => estimateSlotTextLimit(slot, 'medium'))
  return {
    total_chars: limits.reduce((total, limit) => total + limit, 0),
    max_slot_chars: limits.length ? Math.max(...limits) : 0,
    replacement_slots: slots.filter((slot) => String(slot.text || '').trim()).length,
  }
}

function estimateSlotTextLimit(slot, priority = 'medium') {
  const role = String(slot?.role || '')
  const geometry = slot?.geometry || {}
  const width = Number(geometry.width || geometry.w || 0)
  const height = Number(geometry.height || geometry.h || 0)
  const fontSize = Number(slot?.text_metrics?.font_size_px || slot?.font_size_px || 18)
  const paragraphCount = Number(slot?.paragraph_count || slot?.text_metrics?.paragraph_count || 1)
  let base = 22
  if (width > 0 && height > 0 && fontSize > 0) {
    const charsPerLine = Math.max(4, Math.floor(width / Math.max(fontSize * 0.9, 12)))
    const lines = Math.max(1, Math.floor(height / Math.max(fontSize * 1.55, 20)))
    base = charsPerLine * lines
  }
  if (role.includes('title')) base = Math.min(base, 18)
  if (role.includes('label')) base = Math.min(base, 14)
  if (role.includes('body')) base = Math.max(base, 36)
  if (paragraphCount <= 1 && !role.includes('body')) base = Math.min(base, 24)
  const priorityFactor = priority === 'high' ? 1.12 : priority === 'low' ? 0.78 : 1
  return Math.max(6, Math.min(160, Math.round(base * priorityFactor)))
}

function compactTextToLimit(text, limit) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  if (limit <= 8) return normalized.slice(0, limit)
  const separators = ['；', '，', '。', ';', ',', '.']
  for (const separator of separators) {
    const index = normalized.lastIndexOf(separator, limit - 1)
    if (index >= Math.max(4, Math.floor(limit * 0.5))) {
      return normalized.slice(0, index).trim()
    }
  }
  return normalized.slice(0, limit - 1).trim()
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
