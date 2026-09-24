import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { RevisionRuntime } from './revisionRuntime.js'
import { PlanningController } from './planningController.js'
import { revisePages } from './revisionAgent.js'
import { createPptRouter } from './router.js'

const page = '01_test.svg'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#fff"/><text id="title" x="40" y="80" font-size="32">原文</text></svg>'
const edited = svg.replace('原文', '已确认的补充')
const digest = (value) => createHash('sha256').update(value).digest('hex')

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-revision-'))
  if (process.platform === 'linux') await chmod(root, 0o711)
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(path.join(root, 'store')).init()
  const created = await store.create({ aiProvider: 'deepseek', prompt: '测试', visualReview: true })
  const record = await store.read(created.project.id)
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT || path.join(root, 'skill'), python: process.env.PPT_PYTHON || '/usr/bin/python3' })
  const directory = native.projectPath(record)
  for (const name of ['svg_output', '.worker-tmp', 'notes', 'icons', 'validation', 'confirm_ui', 'live_preview']) await mkdir(path.join(directory, name), { recursive: true })
  await writeFile(path.join(directory, 'svg_output', page), svg)
  await writeFile(path.join(directory, 'design_spec.md'), 'locked design')
  await writeFile(path.join(directory, 'spec_lock.md'), 'locked execution')
  await writeFile(path.join(directory, 'notes/total.md'), 'original notes')
  const receipt = { status: 'confirmed', page_count: '1' }
  await writeFile(path.join(directory, 'confirm_ui/result.json'), JSON.stringify(receipt))
  record.confirmations = [{ stage: 1 }, { stage: 2, receipt, sha256: digest(JSON.stringify(receipt)) }]
  record.status = 'review_needs_human'
  record.production = { accepted: true, slideCount: 1, motion: { mode: 'native-default', reason: 'static' } }
  const runtime = new RevisionRuntime(native)
  const actualAnnotations = runtime.annotations.bind(runtime)
  runtime.annotations = async (_record, action = 'scan') => action === 'scan' ? {} : { ok: true }
  runtime.prepare = async () => {}
  runtime.finishPreparation = async () => ({ ...record.production, fingerprint: await runtime.releaseSnapshot(record) })
  await store.save(record)
  const controller = new PlanningController(store, native, { revisionRuntime: runtime })
  t.after(() => controller.close())
  const token = created.recoveryToken
  const proposal = async () => controller.proposeRevision(record.id, token, {
    fingerprint: await runtime.releaseSnapshot(record), requests: [{ page, instruction: '补足已确认内容' }],
  })
  return { root, store, record, native, runtime, directory, controller, token, proposal, actualAnnotations }
}

test('revision proposal needs current source, valid target and real explicit confirmation', async (t) => {
  const { controller, record, token, proposal, runtime } = await fixture(t)
  await assert.rejects(controller.proposeRevision(record.id, token, { fingerprint: 'old', requests: [] }), /页面或批注已变化/)
  await assert.rejects(controller.proposeRevision(record.id, token, { fingerprint: await runtime.releaseSnapshot(record), requests: [{ page: '../other.svg', instruction: 'change' }] }), /有效页面/)
  const pending = await proposal()
  assert.equal(pending.status, 'awaiting_revision_confirmation')
  assert.equal(controller.jobs.size, 0)
  await controller.start(record.id, token)
  assert.equal(controller.jobs.size, 0)
  await assert.rejects(controller.confirmRevision(record.id, token, 'stale', true), /失效/)
  const cancelled = await controller.confirmRevision(record.id, token, pending.revision.id, false)
  assert.equal(cancelled.status, 'review_needs_human')
  assert.equal(cancelled.revision.status, 'cancelled')
})

test('source changing after proposal rejects acceptance but allows returning to edit', async (t) => {
  const { proposal, directory, controller, record, token } = await fixture(t)
  const pending = await proposal()
  await writeFile(path.join(directory, 'svg_output', page), edited)
  await assert.rejects(controller.confirmRevision(record.id, token, pending.revision.id, true), /确认期间发生变化/)
  await controller.confirmRevision(record.id, token, pending.revision.id, false)
})

test('native annotations cannot bypass the first-export gate', async (t) => {
  const { runtime, proposal, store, record } = await fixture(t)
  runtime.annotations = async () => ({ [page]: [{ element_id: 'title', annotation: '放大标题' }] })
  await assert.rejects(proposal(), /先完成首次导出/)
  record.hasNativeExport = true; await store.save(record)
  const pending = await proposal()
  assert.equal(pending.revision.items.length, 2)
  assert.equal(pending.revision.items[1].elementId, 'title')
})

async function confirmed(f) {
  const pending = await f.proposal()
  const record = await f.store.read(f.record.id)
  record.revision = { ...pending.revision, status: 'confirmed', confirmedAt: Date.now() }
  return record
}

test('transaction restricts writable pages and restores originals after interruption', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  await f.runtime.begin(record)
  await assert.rejects(f.runtime.write(record, 'design_spec.md', 'changed'), /只能修改/)
  await assert.rejects(f.runtime.write(record, 'svg_output/02_other.svg', edited), /只能修改/)
  await f.runtime.write(record, `svg_output/${page}`, edited)
  await f.runtime.write(record, 'notes/total.md', 'new notes')
  await f.runtime.write(record, 'animations.json', '{}')
  await f.runtime.rollback(record)
  assert.equal(await readFile(path.join(f.directory, 'svg_output', page), 'utf8'), svg)
  assert.equal(await readFile(path.join(f.directory, 'notes/total.md'), 'utf8'), 'original notes')
  await assert.rejects(readFile(path.join(f.directory, 'animations.json')), { code: 'ENOENT' })
  assert.equal(await f.runtime.begin(record), null)
})

test('finishing an untouched revision is rejected, committed recovery is idempotent', async (t) => {
  const f = await fixture(t), record = await confirmed(f), signal = new AbortController().signal
  await f.runtime.begin(record)
  await assert.rejects(f.runtime.finishRevision(record, record.production.motion, signal), /未完成修改/)
  await f.runtime.write(record, `svg_output/${page}`, edited)
  const outcome = await f.runtime.finishRevision(record, record.production.motion, signal)
  await f.runtime.commit(record, outcome)
  await f.runtime.rollback(record)
  assert.deepEqual(await f.runtime.begin(record), outcome)
  assert.equal(await readFile(path.join(f.directory, 'svg_output', page), 'utf8'), edited)
})

test('precise replacements require one exact match and the same confirmed write scope', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  await f.runtime.begin(record)
  await assert.rejects(f.runtime.replace(record, 'design_spec.md', 'locked', 'changed'), /只能替换/)
  await assert.rejects(f.runtime.replace(record, `svg_output/${page}`, '不存在的文字', 'changed'), /精确匹配一次/)
  await f.runtime.replace(record, `svg_output/${page}`, '原文', '已确认的补充')
  assert.equal(await readFile(path.join(f.directory, 'svg_output', page), 'utf8'), edited)
  await f.runtime.rollback(record)
})

test('worker rechecks revisions and cannot claim success after a later unvalidated write', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  let turns = 0
  const result = await revisePages({ record, runtime: f.runtime, signal: new AbortController().signal,
    turn: async () => ++turns === 1 ? [
      { id: 'w', name: 'write_file', arguments: JSON.stringify({ path: `svg_output/${page}`, content: edited }) },
      { id: 'f', name: 'finish_revision', arguments: JSON.stringify({ motionMode: 'native-default', reason: 'preserved' }) },
      { id: 'n', name: 'write_file', arguments: JSON.stringify({ path: 'notes/total.md', content: 'matching updated notes' }) },
    ] : [{ id: 'f2', name: 'finish_revision', arguments: JSON.stringify({ motionMode: 'native-default', reason: 'preserved' }) }],
  })
  assert.equal(turns, 2)
  assert.equal(result.accepted, true)
})

test('worker blocker and cancellation roll back every tentative change', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  let round = 0
  await assert.rejects(revisePages({ record, runtime: f.runtime, signal: new AbortController().signal, turn: async () => ++round === 1
    ? [{ id: 'w', name: 'write_file', arguments: JSON.stringify({ path: `svg_output/${page}`, content: edited }) }]
    : [{ id: 'b', name: 'report_blocker', arguments: '{"reason":"改变大纲需要重新规划"}' }],
  }), /改变大纲/)
  assert.equal(await readFile(path.join(f.directory, 'svg_output', page), 'utf8'), svg)
  const abort = new AbortController()
  await assert.rejects(revisePages({ record, runtime: f.runtime, signal: abort.signal, turn: async () => { abort.abort(); throw abort.signal.reason } }))
  assert.equal(await readFile(path.join(f.directory, 'svg_output', page), 'utf8'), svg)
})

test('revision context uses the effective later specification without rewriting the original receipt', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  const original = JSON.stringify(record.confirmations)
  f.runtime.verifyConfirmation = async () => ({ page_count: '6', refine_spec: false })
  await assert.rejects(revisePages({ record, runtime: f.runtime, signal: new AbortController().signal,
    turn: async (_provider, instructions, history) => {
      assert.equal(JSON.parse(history[0].content).confirmed.page_count, '6')
      assert.match(instructions, /latest approved specification is authoritative/)
      return [{ id: 'stop', name: 'report_blocker', arguments: '{"reason":"test stop"}' }]
    },
  }), /test stop/)
  assert.equal(JSON.stringify(record.confirmations), original)
})

test('confirmed revisions re-enter review, and unresolved results never export', async (t) => {
  const f = await fixture(t)
  let revisions = 0, reviews = 0, exports = 0
  f.controller.revisor = async () => { revisions++; return { accepted: true, slideCount: 1 } }
  f.controller.visualRuntime = { prepare: async () => {} }
  f.controller.reviewer = async () => { reviews++; return { production: {}, review: { status: 'needs_human', pages: [] } } }
  f.controller.postprocessRuntime = { prepare: async () => {}, export: async () => { exports++; return {} } }
  const pending = await f.proposal()
  await f.controller.confirmRevision(f.record.id, f.token, pending.revision.id, true)
  while (f.controller.jobs.has(f.record.id)) await f.controller.jobs.get(f.record.id).promise
  assert.equal(revisions, 1); assert.equal(reviews, 1); assert.equal(exports, 0)
  const final = await f.store.read(f.record.id)
  assert.equal(final.status, 'review_needs_human')
  assert.equal(final.artifact, null)
  assert.equal(final.revision.status, 'applied')
})

test('restart rolls back a half-written revision and pauses rather than reauthoring', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  await f.runtime.begin(record)
  await f.runtime.write(record, `svg_output/${page}`, edited)
  record.status = 'preparing_revision'; record.activeStage = 'revision'
  await f.store.save(record)
  f.controller.reconcileReceipt = async () => {}
  await f.controller.recover()
  assert.equal((await f.store.read(record.id)).status, 'paused')
  assert.equal(await readFile(path.join(f.directory, 'svg_output', page), 'utf8'), svg)
})

test('failed revision can return for new instructions without invoking the worker', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  record.status = 'failed'; record.activeStage = 'revision'
  await f.store.save(record)
  const reopened = await f.controller.confirmRevision(record.id, f.token, record.revision.id, false)
  assert.equal(reopened.status, 'review_needs_human')
  assert.equal(reopened.revision.status, 'cancelled')
  assert.equal(f.controller.jobs.size, 0)
})

test('new confirmed cycles reset visual checkpoint, but interrupted retries do not', async (t) => {
  const f = await fixture(t), record = await confirmed(f)
  const file = path.join(f.store.directory(record.id), 'visual-checkpoint.json')
  await writeFile(file, '{"repairs":2}')
  await f.runtime.begin(record)
  await f.runtime.write(record, `svg_output/${page}`, edited)
  await f.runtime.rollback(record)
  assert.equal(await readFile(file, 'utf8'), '{"repairs":2}')
  await f.runtime.begin(record)
  await f.runtime.write(record, `svg_output/${page}`, edited)
  const result = await f.runtime.finishRevision(record, record.production.motion, new AbortController().signal)
  await f.runtime.commit(record, result)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
})

test('native preview write API enforces auth, origin, stage and endpoint boundaries', async (t) => {
  const f = await fixture(t)
  f.runtime.annotations = async () => ({ [page]: [{ element_id: 'title', annotation: '标题更具体' }] })
  f.record.status = 'complete'; f.record.artifact = { file: 'old.pptx' }; await f.store.save(f.record)
  let writes = 0
  f.controller.authoringRuntime = { verifyConfirmation: async () => {}, preview: async () => { writes++; return { status: 200, contentType: 'application/json', body: Buffer.from('{"status":"ok"}') } } }
  const app = express(); app.use(express.json()); app.use('/api/ppt', await createPptRouter(f.store, { controller: f.controller }))
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`
  const prefix = `/api/ppt/projects/${f.record.id}/preview`
  const headers = { Cookie: `mw_preview_${f.record.id}=${f.token}`, Origin: base, 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + prefix + '/api/save-all', { method: 'POST' })).status, 404)
  assert.equal((await fetch(base + prefix + '/api/save-all', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await fetch(base + prefix + `/api/slide/${page}/edit`, { method: 'POST', headers })).status, 409)
  assert.equal(writes, 0)
  assert.equal((await fetch(base + prefix + '/api/save-all', { method: 'POST', headers })).status, 200)
  const saved = await f.store.read(f.record.id)
  assert.equal(saved.status, 'edits_pending'); assert.equal(saved.artifact, null); assert.equal(saved.hasNativeExport, true)
  saved.status = 'awaiting_revision_confirmation'; await f.store.save(saved)
  assert.equal((await fetch(base + prefix + '/api/save-all', { method: 'POST', headers })).status, 409)
})

test('actual native editor stages across requests, saves SVG annotations, scans and clears natively', { skip: !process.env.PPT_MASTER_SKILL_ROOT || !process.env.PPT_PYTHON || !['darwin', 'linux'].includes(process.platform) }, async (t) => {
  const f = await fixture(t)
  const post = async (endpoint, body) => f.runtime.preview(f.record, endpoint, undefined, { method: 'POST', body, editable: true })
  assert.equal((await post(`/api/slide/${page}/annotate`, { element_id: 'title', annotation: '标题更具体' })).status, 200)
  const reload = await f.runtime.preview(f.record, `/api/slide/${page}`, undefined, { editable: true })
  assert.equal(JSON.parse(reload.body).annotations[0].annotation, '标题更具体')
  assert.equal((await readFile(path.join(f.directory, 'svg_output', page), 'utf8')).includes('data-edit-annotation'), false)
  assert.equal((await post('/api/save-all')).status, 200)
  const saved = await f.actualAnnotations(f.record)
  assert.equal(saved[page][0].annotation, '标题更具体')
  const items = [{ page, elementId: 'title', instruction: '标题更具体' }]
  await f.actualAnnotations(f.record, 'clear', items)
  assert.deepEqual(await f.actualAnnotations(f.record), {})
  f.record.revision = { id: 'test-native-revision' }
  await f.actualAnnotations(f.record, 'log', items)
  await f.actualAnnotations(f.record, 'log', items)
  const log = (await readFile(path.join(f.directory, 'live_preview/annotations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(log.filter((entry) => entry.action === 'annotation_applied').length, 1)
})
