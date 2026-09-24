import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { VisualRuntime } from './visualRuntime.js'
import { PostprocessRuntime } from './postprocessRuntime.js'
import { PlanningController } from './planningController.js'
import { reviewPages, reviewPasses, validateReview, reviewerIdentity, outlinePage, requiredContent } from './visualReview.js'
import { imageMessage, probeVision } from './visionModel.js'
import { sandboxRun } from './localSandbox.js'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const pageName = '01_test.svg'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect x="0" y="0" width="1280" height="720" fill="#fff"/><text id="title" x="40" y="80" font-size="24" fill="#123A63">保留原文</text></svg>'
const clean = () => ({ page: pageName, imageReadable: true, matchesIntent: true, designIntent: '保留原文', findings: [], coverage: [{ item: 0, covered: true, evidenceQuotes: ['保留原文'] }] })
const hit = (rule = 'H2') => ({ ...clean(), findings: [{ rule, element: 2, violated: true, evidence: '文字超出边界', suggestedFix: '左移十像素', requiresConfirmation: false, edit: { attribute: 'x', before: '40', after: '30' } }] })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-visual-test-'))
  if (process.platform === 'linux') await chmod(root, 0o711)
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(path.join(root, 'store')).init()
  const created = await store.create({ aiProvider: 'deepseek', prompt: '测试', visualReview: true })
  const record = await store.read(created.project.id)
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT || path.join(root, 'skill'), python: process.env.PPT_PYTHON || '/usr/bin/python3' })
  const directory = native.projectPath(record)
  for (const name of ['svg_output', '.preview', '.review/backup', '.worker-tmp', 'notes', 'icons', 'validation', 'confirm_ui']) await mkdir(path.join(directory, name), { recursive: true })
  if (!process.env.PPT_MASTER_SKILL_ROOT) {
    await mkdir(path.join(native.skillRoot, 'references'), { recursive: true })
    await writeFile(path.join(native.skillRoot, 'references/visual-review.md'), 'native test rubric')
  }
  await writeFile(path.join(directory, 'design_spec.md'), '## IX. Content Outline\n#### Slide 01 - Test\n- **Page role**: content\n- **Content**: 保留原文\n## X. Notes')
  await writeFile(path.join(directory, 'spec_lock.md'), 'Locked colors and type')
  await writeFile(path.join(directory, 'svg_output', pageName), svg)
  const receipt = { status: 'confirmed', page_count: '1' }
  await writeFile(path.join(directory, 'confirm_ui/result.json'), JSON.stringify(receipt))
  record.confirmations = [{ stage: 1 }, { stage: 2, receipt, sha256: hash(JSON.stringify(receipt)) }]
  record.status = 'awaiting_visual_review'
  record.production = { accepted: true, slideCount: 1, motion: { mode: 'native-default', reason: 'static' } }
  const runtime = new VisualRuntime(native)
  const actualEdit = runtime.edit.bind(runtime)
  runtime.edit = async (_record, content, edits) => edits ? { svg: content.replace(`x="${edits[0].before}" y="80"`, `x="${edits[0].after}" y="80"`) } : [{ tag: 'text', text: '保留原文' }]
  runtime.prepare = async () => {}
  runtime.challenge = async () => ({ code: 'ABCDEFGH', image: 'synthetic test-only PNG' })
  runtime.finishPreparation = async () => ({ ...record.production, fingerprint: await runtime.releaseSnapshot(record) })
  runtime.render = async () => {
    await writeFile(path.join(directory, '.preview/01_test.png'), 'test image bytes')
    return [{ page: pageName, image: 'synthetic test-only PNG', path: '.preview/01_test.png', ok: true, all_background: false,
      canvas: { view_box: [0, 0, 1280, 720], width: 1280, height: 720, png_width: 1280, png_height: 720 } }]
  }
  record.production.fingerprint = await runtime.releaseSnapshot(record)
  await store.save(record)
  const run = (inspect, overrides = {}) => reviewPages({ record, runtime, signal: new AbortController().signal, probe: async () => {}, inspect, ...overrides })
  return { root, store, native, runtime, record, directory, run, actualEdit, token: created.recoveryToken }
}

test('vision payloads use selected provider image protocols and image-only challenge rejects silent ignoring', async () => {
  assert.equal(imageMessage('openai', 'test', ['abc']).content[1].type, 'input_image')
  assert.equal(imageMessage('deepseek', 'test', ['abc']).content[1].type, 'image_url')
  await assert.rejects(probeVision('deepseek', { image: 'abc', code: 'SECRET88' }, { turn: async (_provider, _instructions, history) => {
    assert.ok(!JSON.stringify(history).includes('SECRET88'))
    return [{ name: 'submit_visual_result', arguments: '{"code":"UNAVAILABLE"}' }]
  } }), /未通过图片理解验证/)
  assert.equal((await probeVision('openai', { image: 'abc', code: 'ABCD1234' }, { turn: async () => [{ name: 'submit_visual_result', arguments: '{"code":"ABCD1234"}' }] })).tested, true)
})

test('reports fail closed on wrong pages, invisible images, missing evidence and brand decisions', () => {
  assert.throws(() => validateReview({}, pageName))
  assert.throws(() => validateReview({ ...clean(), page: 'other.svg' }, pageName))
  assert.equal(reviewPasses({ ...clean(), imageReadable: false }), false)
  assert.equal(reviewPasses(hit()), false)
  assert.equal(reviewPasses({ ...hit('S1'), findings: [{ ...hit('S1').findings[0], requiresConfirmation: true }] }), false)
  assert.equal(reviewPasses(clean()), true)
  const ruledOut = hit(); ruledOut.findings[0].violated = false
  assert.equal(reviewPasses(validateReview(ruledOut, pageName)), true)
  assert.equal(outlinePage('No section IX', 1).role, 'content')
  assert.equal(outlinePage('## IX. Content Outline\n#### Slide 01 - 封面\nContent\n## X. Notes', 1).role, 'cover')
})

test('clean review requires actual raster inputs and binds every page to the final source fingerprint', async (t) => {
  const { run, record, runtime } = await fixture(t)
  let calls = 0
  const result = await run(async (provider, _instructions, _context, images) => { calls++; assert.equal(provider, record.aiProvider); assert.equal(images.length, 1); return clean() })
  assert.equal(result.review.status, 'passed')
  assert.equal(result.review.fingerprint, await runtime.releaseSnapshot(record))
  const again = await run(async () => { throw new Error('unchanged reviewed pages should resume') })
  assert.equal(again.review.status, 'passed')
  assert.equal(calls, 1)
})

test('atomic repair re-renders, rechecks notes/motion, and stops after at most two fixes even on resume', async (t) => {
  const { run, runtime, directory, record } = await fixture(t)
  let renders = 0, checks = 0
  const render = runtime.render; runtime.render = async (...args) => { renders++; return render(...args) }
  const finish = runtime.finishPreparation; runtime.finishPreparation = async (...args) => { checks++; return finish(...args) }
  let calls = 0
  const result = await run(async () => { const finding = hit(); finding.findings[0].edit = { attribute: 'x', before: String(40 - 10 * calls), after: String(30 - 10 * calls++) }; return finding })
  assert.equal(result.review.status, 'needs_human')
  assert.equal(result.review.pages[0].repairs, 2)
  assert.equal(renders, 3)
  assert.ok(checks >= 4)
  assert.match(await readFile(path.join(directory, 'svg_output', pageName), 'utf8'), /x="20" y="80"/)
  await runtime.write(record, `svg_output/${pageName}`, svg)
  const again = await run(async () => hit())
  assert.equal(again.review.pages[0].repairs, 2)
})

test('new hard hits introduced by a fix roll back rather than being marked fixed', async (t) => {
  const { run, directory } = await fixture(t)
  let calls = 0
  const result = await run(async () => calls++ === 0 ? hit('H2') : hit('H3'))
  assert.equal(result.review.status, 'needs_human')
  assert.equal(await readFile(path.join(directory, 'svg_output', pageName), 'utf8'), svg)
  assert.match(result.review.pages[0].design_intent_check.note, /回退/)
  assert.equal(result.review.pages[0].findings[0].rule, 'H2')
  assert.ok(!result.review.pages[0].findings.some((finding) => finding.rule === 'H3'))
})

test('content extraction preserves inline, multiline and table content without composition fields', () => {
  assert.deepEqual(requiredContent('- **Content**: 核心结论\n  - 条件\n    补充限制\n  | 产品 | 能力 |\n  | --- | --- |\n  | A | B |\n- **Composition**: 两栏'),
    ['核心结论', '条件\n补充限制', '| 产品 | 能力 |', '| A | B |'])
})

test('review prompt accepts faithful paraphrases but retains scope and ambiguous-spec escalation', async (t) => {
  const { run } = await fixture(t)
  await run(async (_provider, instructions) => {
    assert.match(instructions, /faithful paraphrases/)
    assert.match(instructions, /condition, negation, quantity and scope/)
    assert.match(instructions, /do not demand printing the instruction/)
    assert.match(instructions, /requiresConfirmation=true/)
    return clean()
  })
})

test('native rubric updates invalidate page reports', async (t) => {
  const { run, native, runtime, root } = await fixture(t)
  // Use a private rubric, never modify the pinned native checkout.
  const skill = path.join(root, 'private-skill')
  await mkdir(path.join(skill, 'references'), { recursive: true })
  const rubric = path.join(skill, 'references/visual-review.md')
  await writeFile(rubric, 'first rubric')
  runtime.native = Object.assign(Object.create(Object.getPrototypeOf(native)), native, { skillRoot: skill })
  let calls = 0
  const inspect = async () => { calls++; return clean() }
  await run(inspect)
  await writeFile(rubric, 'updated rubric')
  await run(inspect)
  assert.equal(calls, 2)
})

test('brand or content changes pause without changing the approved SVG', async (t) => {
  const { run, directory } = await fixture(t)
  const finding = hit('H4'); finding.findings[0].requiresConfirmation = true
  const result = await run(async () => finding)
  assert.equal(result.review.status, 'needs_human')
  assert.equal(result.review.pages[0].repairs, 0)
  assert.equal(await readFile(path.join(directory, 'svg_output', pageName), 'utf8'), svg)
  assert.equal(JSON.parse(await readFile(path.join(directory, '.review/brand_review.json'), 'utf8')).length, 1)
})

test('cancelled candidate restores backup and keeps consumed repair budget', async (t) => {
  const { run, directory, store, record } = await fixture(t)
  const abort = new AbortController()
  let calls = 0
  await assert.rejects(run(async () => { if (calls++) { abort.abort(); throw abort.signal.reason } return hit() }, { signal: abort.signal }))
  assert.equal(await readFile(path.join(directory, 'svg_output', pageName), 'utf8'), svg)
  const state = JSON.parse(await readFile(path.join(store.directory(record.id), 'visual-checkpoint.json'), 'utf8'))
  assert.equal(state.pages[pageName].pending, false)
  assert.equal(state.pages[pageName].repairs, 1)
})

test('blank renders and invalid model reports cannot produce a review pass', async (t) => {
  const { run, runtime } = await fixture(t)
  runtime.render = async () => []
  await assert.rejects(run(async () => clean()), /截图未覆盖/)
})

test('content coverage requires actual visible quotes and cannot use related topics or notes as coverage', async (t) => {
  const { run } = await fixture(t)
  const missing = clean(); missing.coverage[0].covered = false; missing.coverage[0].evidenceQuotes = []
  const result = await run(async () => missing)
  assert.equal(result.review.status, 'needs_human')
  assert.ok(result.review.pages[0].findings.some((finding) => finding.rule === 'H9'))
  const invented = clean(); invented.coverage[0].evidenceQuotes = ['只在讲稿中的内容']
  assert.throws(() => validateReview(invented, pageName, { requiredContent: ['保留原文'], visibleText: '保留原文' }), /实际文字/)
})

test('changed assets invalidate cached visual reports without resetting repair budgets', async (t) => {
  const { run, directory } = await fixture(t)
  let calls = 0
  await run(async () => { calls++; return clean() })
  await writeFile(path.join(directory, 'icons/new.svg'), '<svg/>')
  await run(async () => { calls++; return clean() })
  assert.equal(calls, 2)
})

test('changed raster invalidates a report even when SVG and project files are identical', async (t) => {
  const { run, runtime } = await fixture(t)
  let calls = 0
  const inspect = async () => { calls++; return clean() }
  await run(inspect)
  const render = runtime.render
  runtime.render = async (...args) => (await render(...args)).map((page) => ({ ...page, image: 'changed font rendering' }))
  await run(inspect)
  assert.equal(calls, 2)
})

test('export gate rejects manual approval, stale fingerprints and changed providers', async (t) => {
  const { runtime, record } = await fixture(t)
  const fingerprint = await runtime.releaseSnapshot(record)
  const exportRuntime = new PostprocessRuntime(runtime.native)
  record.review = { status: 'manual-approved', fingerprint }
  assert.throws(() => exportRuntime.verifyVisualReview(record, fingerprint), /自动视觉审查/)
  record.review = { status: 'passed', fingerprint, identity: reviewerIdentity(record), pages: [{ page: pageName, status: 'ok' }] }
  exportRuntime.verifyVisualReview(record, fingerprint)
  assert.throws(() => exportRuntime.verifyVisualReview(record, 'changed'), /自动视觉审查/)
  assert.throws(() => exportRuntime.verifyVisualReview({ ...record, aiProvider: 'openai' }, fingerprint), /自动视觉审查/)
})

test('controller resumes waiting review and exports only after a passed result', async (t) => {
  const { store, native, record, token, runtime } = await fixture(t)
  let exports = 0
  const controller = new PlanningController(store, native, { visualRuntime: runtime,
    reviewer: async () => ({ production: record.production, review: { status: 'passed', pages: [] } }),
    postprocessRuntime: { prepare: async () => {}, export: async () => { exports++; return { file: 'test.pptx' } } },
  })
  t.after(() => controller.close())
  await controller.start(record.id, token)
  while (controller.jobs.has(record.id)) await controller.jobs.get(record.id).promise
  assert.equal((await store.read(record.id)).status, 'complete')
  assert.equal(exports, 1)
  assert.equal((await store.read(record.id)).confirmations.length, 2)
})

test('controller exposes unresolved findings without exporting or altering confirmation receipts', async (t) => {
  const { store, native, record, token, runtime } = await fixture(t)
  let exports = 0
  const controller = new PlanningController(store, native, { visualRuntime: runtime,
    reviewer: async () => ({ production: record.production, review: { status: 'needs_human', pages: [{ page: pageName, status: 'needs_human' }] } }),
    postprocessRuntime: { prepare: async () => {}, export: async () => { exports++ } },
  })
  t.after(() => controller.close())
  await controller.start(record.id, token)
  while (controller.jobs.has(record.id)) await controller.jobs.get(record.id).promise
  const current = await store.read(record.id)
  assert.equal(current.status, 'review_needs_human')
  assert.equal(exports, 0)
  assert.equal(current.artifact, null)
  assert.deepEqual(current.confirmations, record.confirmations)
})

test('real edit adapter preserves text, color and group IDs and denies non-geometry changes', {
  skip: !['darwin', 'linux'].includes(process.platform) || !process.env.PPT_MASTER_SKILL_ROOT || !process.env.PPT_PYTHON,
}, async (t) => {
  const { actualEdit, record } = await fixture(t)
  const result = await actualEdit(record, svg, [{ index: 2, attribute: 'x', before: '40', after: '30' }])
  assert.match(result.svg, /x="30" y="80"/)
  assert.match(result.svg, /保留原文/)
  for (const edit of [{ index: 2, attribute: 'fill', before: '#123A63', after: '#000000' },
    { index: 2, attribute: 'font-size', before: '24', after: '12' },
    { index: 2, attribute: 'x', before: '999', after: '30' },
    { index: 0, attribute: 'width', before: '1280', after: '300' }]) await assert.rejects(actualEdit(record, svg, [edit]), /允许范围/)
})

test('real native Chromium renderer returns bounded nonblank PNGs and retains network/file isolation', {
  skip: !['darwin', 'linux'].includes(process.platform) || !process.env.PPT_MASTER_SKILL_ROOT || !process.env.PPT_PYTHON || !process.env.PPT_BROWSER_ROOT,
  timeout: 60000,
}, async (t) => {
  const { runtime, record, directory } = await fixture(t)
  runtime.browserRoot = process.env.PPT_BROWSER_ROOT
  await writeFile(path.join(directory, 'svg_output', pageName), svg.replace('</svg>', '<rect x="400" y="200" width="300" height="200" fill="#123A63"/></svg>'))
  const pages = await VisualRuntime.prototype.render.call(runtime, record, null, new AbortController().signal)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].all_background, false)
  assert.equal(pages[0].canvas.png_width, 1280)
  assert.equal(pages[0].canvas.png_height, 720)
  assert.ok(pages[0].image.length > 100)
  const config = { ...runtime.config(record), renderPort: 43219, browserRoot: runtime.browserRoot }
  for (const code of [
    'import socket;socket.socket().connect(("127.0.0.1",43220))',
    'import socket;socket.socket().connect(("1.1.1.1",443))',
    'from pathlib import Path;Path("../../state.json").read_text()',
  ]) {
    const result = await sandboxRun(config, ['-c', code], { timeout: 3000 })
    assert.notEqual(result.code, 0)
    assert.match(result.error, /PermissionError|Operation not permitted/)
  }
})
