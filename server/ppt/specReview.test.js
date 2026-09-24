import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { AuthoringRuntime } from './authoringRuntime.js'
import { SpecRuntime, specChanges, specHash } from './specRuntime.js'
import { PlanningController } from './planningController.js'
import { createPptRouter } from './router.js'
import { refineSpec } from './specAgent.js'

const available = ['darwin', 'linux'].includes(process.platform) && Boolean(process.env.PPT_MASTER_SKILL_ROOT && process.env.PPT_PYTHON && process.env.PPT_EXPORT_SAMPLE)
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-spec-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek', prompt: 'Spec integration test' })
  const record = await store.read(project.id)
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON })
  const directory = native.projectPath(record)
  await mkdir(directory, { recursive: true })
  await cp(process.env.PPT_EXPORT_SAMPLE, directory, { recursive: true })
  await rm(path.join(directory, 'spec_review'), { recursive: true, force: true })
  const receipt = JSON.parse(await readFile(path.join(directory, 'confirm_ui/result.json'), 'utf8'))
  record.confirmations = [{ stage: 1 }, { stage: 2, receipt, sha256: specHash(JSON.stringify(receipt)) }]
  record.status = 'review_needs_human'
  await store.save(record)
  const authoring = new AuthoringRuntime(native)
  const runtime = new SpecRuntime(authoring)
  return { root, store, record, recoveryToken, native, authoring, runtime, directory }
}

test('spec change scope distinguishes slide edits, globals and structural changes', () => {
  const blocks = [{ key: 'section:I', title: 'Project', kind: 'section', text: 'project' },
    { key: 'slide:01', title: 'Slide 1', kind: 'slide', text: 'a' }, { key: 'slide:02', title: 'Slide 2', kind: 'slide', text: 'b' }]
  const before = { blocks }
  assert.deepEqual(specChanges(before, { blocks: blocks.map((b) => ({ ...b })) }).pages, [])
  const local = specChanges(before, { blocks: blocks.map((b) => b.key === 'slide:02' ? { ...b, text: 'new' } : b) })
  assert.equal(local.global, false); assert.deepEqual(local.pages, [2])
  assert.equal(specChanges(before, { blocks: blocks.slice(0, 2) }).global, true)
  assert.equal(specChanges(before, { blocks: blocks.map((b) => b.kind === 'section' ? { ...b, text: 'new' } : b) }).global, true)
})

test('native full-spec bridge persists drafts, rejects stale edits, holds writes and validates', { skip: !available }, async (t) => {
  const { runtime, record, directory } = await fixture(t)
  const initial = await runtime.inspect(record)
  assert.deepEqual(initial.errors, [])
  const block = initial.blocks.find((b) => b.kind === 'slide')
  const request = async (payload) => {
    const result = await runtime.call(record, { hold: false, ...payload })
    return { status: result.status, data: JSON.parse(Buffer.from(result.body, 'base64').toString()) }
  }
  const staged = await request({ path: '/api/drafts/' + block.key, method: 'PUT', body: { text: block.text.replace('Slide 1', 'Slide 1'), sha256: initial.sha256 } })
  assert.equal(staged.status, 200)
  assert.ok((await runtime.inspect(record)).drafts.includes(block.key))
  const conflict = await request({ path: '/api/drafts/' + block.key, method: 'PUT', body: { text: block.text, sha256: initial.sha256 } })
  assert.equal(conflict.status, 409)
  const held = await request({ path: '/api/apply/' + block.key, method: 'POST', hold: true, body: { version: staged.data.version, sha256: initial.sha256 } })
  assert.equal(held.status, 423)
  const applied = await request({ path: '/api/apply/' + block.key, method: 'POST', body: { version: staged.data.version, sha256: initial.sha256 } })
  assert.equal(applied.status, 200)
  assert.deepEqual((await runtime.inspect(record)).drafts, [])
  const changed = block.text + '\nA test review line.\n'
  const second = await request({ path: '/api/drafts/' + block.key, method: 'PUT', body: { text: changed, sha256: initial.sha256 } })
  const appliedSecond = await request({ path: '/api/apply/' + block.key, method: 'POST', body: { version: second.data.version, sha256: initial.sha256 } })
  assert.equal(appliedSecond.status, 200)
  assert.equal((await runtime.inspect(record)).unreadEdits, true)
  assert.match(await readFile(path.join(directory, 'design_spec.md'), 'utf8'), /test review line/)
})

test('approval blocks drafts/comments/unread edits/stale hashes and keeps original receipt immutable', { skip: !available }, async (t) => {
  const { runtime, record, directory, authoring } = await fixture(t)
  const receipt = await readFile(path.join(directory, 'confirm_ui/result.json'))
  record.specReview = await runtime.begin(record)
  const state = await runtime.inspect(record)
  await assert.rejects(runtime.approve(record, 'stale'), /已变化/)
  const annotation = await runtime.call(record, { path: '/api/annotations', method: 'POST', hold: false, body: { key: 'global', body: 'test' } })
  assert.equal(annotation.status, 201)
  await assert.rejects(runtime.approve(record, state.sha256), /未应用/)
  const todo = await runtime.call(record, { action: 'todo' })
  await runtime.call(record, { action: 'applied', id: todo.annotations[0].id })
  record.specApproval = await runtime.approve(record, state.sha256)
  record.specReview.status = 'approved'
  assert.equal((await authoring.verifyConfirmation(record)).page_count, '5')
  await assert.rejects(authoring.write(record, 'design_spec.md', 'bad'), /不可再修改/)
  await assert.rejects(authoring.write(record, 'svg_output/01_cover.svg', '<svg/>'), /修改范围/)
  assert.deepEqual(await readFile(path.join(directory, 'confirm_ui/result.json')), receipt)
})

test('native review proxy checks ownership, origin, allowlist and freezes after approval', { skip: !available }, async (t) => {
  const { store, native, authoring, record, recoveryToken } = await fixture(t)
  const controller = new PlanningController(store, native, { authoringRuntime: authoring })
  t.after(() => controller.close())
  await controller.openSpec(record.id, recoveryToken)
  const app = express(); app.use(express.json()); app.use('/api/ppt', await createPptRouter(store, { controller }))
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const origin = 'http://127.0.0.1:' + server.address().port
  const base = origin + '/api/ppt/projects/' + record.id
  const headers = { Authorization: 'Bearer ' + recoveryToken }
  assert.equal((await fetch(base + '/spec-native/')).status, 404)
  const session = await fetch(base + '/spec-session', { method: 'POST', headers })
  const cookie = session.headers.get('set-cookie').split(';')[0]
  const html = await fetch(base + '/spec-native/', { headers: { Cookie: cookie } })
  assert.match(await html.text(), /spec-native\/static\/app.js/)
  assert.equal((await fetch(base + '/spec-native/api/health', { headers: { Cookie: cookie } })).status, 404)
  assert.equal((await fetch(base + '/spec-native/api/hold', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 404)
  assert.equal((await fetch(base + '/spec-native/api/annotations', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } })).status, 403)
  const current = await store.read(record.id)
  current.status = 'preparing_authoring'; await store.save(current)
  assert.equal((await fetch(base + '/spec-native/api/annotations', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 409)
})

test('review agent cannot touch execution lock and always returns for user confirmation', async () => {
  let round = 0
  const runtime = {
    authoring: { verifyConfirmation: async () => ({ status: 'confirmed' }) },
    native: { read: async () => { throw new Error('should be denied before read') } },
    call: async () => ({ annotations: [], edits: [] }),
    inspect: async () => ({ errors: [], annotations: [], drafts: [], sha256: 'abc' }),
  }
  const result = await refineSpec({ record: { aiProvider: 'deepseek', specReview: { status: 'reviewing' } }, runtime, signal: new AbortController().signal,
    turn: async (_provider, _instructions, history) => {
      if (round++ === 0) return [{ id: '1', name: 'read_file', arguments: JSON.stringify({ scope: 'project', path: 'sources/../spec_lock.md', offset: 0 }) }]
      assert.match(history.at(-1).content, /不可读取/)
      return [{ id: '2', name: 'finish_review_round', arguments: '{"summary":"已核对"}' }]
    } })
  assert.equal(result.accepted, true)
  assert.equal(result.sha256, 'abc')
  assert.equal(result.approved, undefined)
})

test('approved local spec rebuild preserves other pages, backups and retry outputs', { skip: !available }, async (t) => {
  const { runtime, record, directory, authoring, store } = await fixture(t)
  record.specReview = await runtime.begin(record)
  const before = await authoring.snapshot(record)
  record.specApproval = { id: record.specReview.id, global: false, pages: [3] }
  await writeFile(path.join(store.directory(record.id), 'visual-checkpoint.json'), '{}')
  await runtime.resetGeneration(record)
  const page = Object.keys(before).find((name) => name.startsWith('svg_output/03_'))
  await assert.rejects(readFile(path.join(directory, page)), { code: 'ENOENT' })
  const backup = path.join(store.directory(record.id), 'spec-' + record.specReview.id, 'generation-backup')
  assert.equal(specHash(await readFile(path.join(backup, page))), before[page])
  for (const name of Object.keys(before).filter((name) => name.startsWith('svg_output/') && name !== page)) assert.equal(specHash(await readFile(path.join(directory, name))), before[name])
  await writeFile(path.join(directory, page), '<svg/>')
  await runtime.resetGeneration(record)
  assert.equal(await readFile(path.join(directory, page), 'utf8'), '<svg/>')
  await assert.rejects(readFile(path.join(store.directory(record.id), 'visual-checkpoint.json')), { code: 'ENOENT' })
})

test('refine-spec startup stops before authoring and explicit approval launches once', { skip: !available }, async (t) => {
  const { store, native, authoring, runtime, record, directory, recoveryToken } = await fixture(t)
  const receipt = { ...record.confirmations[1].receipt, refine_spec: true }
  record.confirmations[1] = { stage: 2, receipt, sha256: specHash(JSON.stringify(receipt)) }
  await writeFile(path.join(directory, 'confirm_ui/result.json'), JSON.stringify(receipt))
  record.status = 'planning_complete'; await store.save(record)
  let authored = 0
  const controller = new PlanningController(store, native, { authoringRuntime: authoring,
    specRefiner: async () => ({ accepted: true, summary: '测试规范' }),
    author: async () => { authored++; return { accepted: true, slideCount: 5 } } })
  t.after(() => controller.close())
  await controller.start(record.id, recoveryToken)
  await controller.jobs.get(record.id).promise
  assert.equal((await store.read(record.id)).status, 'awaiting_spec_review')
  assert.equal(authored, 0)
  const current = await store.read(record.id)
  const state = await runtime.inspect(current)
  await controller.confirmSpec(record.id, recoveryToken, state.sha256)
  await assert.rejects(controller.confirmSpec(record.id, recoveryToken, state.sha256), /不可确认/)
  await controller.jobs.get(record.id).promise
  assert.equal(authored, 1)
  assert.equal((await store.read(record.id)).status, 'draft_ready')
})

test('confirmed page-count change supersedes original count without rewriting its receipt', { skip: !available }, async (t) => {
  const { runtime, authoring, record, directory } = await fixture(t)
  record.specReview = await runtime.begin(record)
  const before = await runtime.inspect(record)
  const last = before.blocks.filter((b) => b.kind === 'slide').at(-1)
  const text = before.text.replace('| Page Count | 5 |', '| Page Count | 6 |')
    .replace('## X. Speaker Notes Requirements', last.text.replace('Slide 05', 'Slide 06') + '\n## X. Speaker Notes Requirements')
  await authoring.write(record, 'design_spec.md', text)
  const state = await runtime.inspect(record)
  assert.deepEqual(state.errors, [])
  record.specApproval = await runtime.approve(record, state.sha256)
  record.specReview.status = 'approved'
  assert.equal(record.specApproval.global, true)
  assert.equal(record.specApproval.pageCount, 6)
  assert.equal((await authoring.verifyConfirmation(record)).page_count, '6')
  assert.equal(JSON.parse(await readFile(path.join(directory, 'confirm_ui/result.json'), 'utf8')).page_count, '5')
})

test('approved production options use table fields and unsupported image/audio options block', { skip: !available }, async (t) => {
  const { runtime, authoring, record } = await fixture(t)
  record.specReview = await runtime.begin(record)
  const initial = await runtime.inspect(record)
  const text = initial.text.replace('| Speaker Notes | enabled', '| Speaker Notes | disabled')
    .replace('| Custom Animations | enabled', '| Custom Animations | disabled')
  await authoring.write(record, 'design_spec.md', text)
  const approval = await runtime.approve(record, (await runtime.inspect(record)).sha256)
  assert.equal(approval.options.proactive_speaker_notes, false)
  assert.equal(approval.options.proactive_custom_animations, false)
  await authoring.write(record, 'design_spec.md', text.replace('| AI Image Acquisition Path | not applicable |', '| AI Image Acquisition Path | not applicable；不使用外部图片、用户图片或 AI 生成图片。 |'))
  assert.ok(await runtime.approve(record, (await runtime.inspect(record)).sha256))
  await authoring.write(record, 'design_spec.md', text.replace('| AI Image Acquisition Path | not applicable |', '| AI Image Acquisition Path | none-but-generate |'))
  await assert.rejects(runtime.approve(record, (await runtime.inspect(record)).sha256), /图片素材/)
  await authoring.write(record, 'design_spec.md', text.replace('| Narration Audio | disabled', '| Narration Audio | enabled'))
  await assert.rejects(runtime.approve(record, (await runtime.inspect(record)).sha256), /旁白/)
  await authoring.write(record, 'design_spec.md', text.replace('| AI Image Acquisition Path | not applicable |', '| AI Image Acquisition Path | generate |'))
  await assert.rejects(runtime.approve(record, (await runtime.inspect(record)).sha256), /图片素材/)
})

test('failed approved generation can reopen review and requires a complete rebuild', { skip: !available }, async (t) => {
  const { store, native, authoring, runtime, record, recoveryToken } = await fixture(t)
  record.specReview = await runtime.begin(record)
  record.specApproval = await runtime.approve(record, (await runtime.inspect(record)).sha256)
  record.specReview.status = 'approved'
  record.status = 'failed'; record.activeStage = 'authoring'; record.artifact = { file: 'old.pptx' }
  await store.save(record)
  const controller = new PlanningController(store, native, { authoringRuntime: authoring })
  t.after(() => controller.close())
  await controller.openSpec(record.id, recoveryToken)
  const reopened = await store.read(record.id)
  assert.equal(reopened.status, 'awaiting_spec_review')
  assert.equal(reopened.artifact, null)
  assert.equal((await runtime.summary(reopened)).global, true)
  await controller.recover()
  assert.equal((await store.read(record.id)).status, 'awaiting_spec_review')
})
