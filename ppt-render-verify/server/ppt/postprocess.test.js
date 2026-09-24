import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { PostprocessRuntime } from './postprocessRuntime.js'
import { PlanningController } from './planningController.js'
import { createPptRouter } from './router.js'
import { postprocessPages } from './postprocessAgent.js'

const hash = (value) => createHash('sha256').update(value).digest('hex')
async function fixture(t, visualReview = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-postprocess-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek', prompt: 'Test deck', visualReview })
  const record = await store.read(project.id)
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT || root, python: process.env.PPT_PYTHON || '/usr/bin/python3' })
  const runtime = new PostprocessRuntime(native)
  const directory = native.projectPath(record)
  for (const name of ['confirm_ui', 'svg_output', 'notes', 'icons', 'validation', '.worker-tmp', 'exports']) await mkdir(path.join(directory, name), { recursive: true })
  const receipt = { status: 'confirmed', page_count: '1', proactive_speaker_notes: true, proactive_custom_animations: true }
  await writeFile(path.join(directory, 'confirm_ui/result.json'), JSON.stringify(receipt))
  await writeFile(path.join(directory, 'design_spec.md'), 'spec')
  await writeFile(path.join(directory, 'spec_lock.md'), 'lock')
  await runtime.write(record, 'svg_output/01_test.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><text x="20" y="40">测试</text></svg>')
  await runtime.write(record, 'notes/total.md', '# 01_test\n\n本页介绍测试内容。')
  record.status = 'draft_ready'
  record.confirmations = [{ stage: 1 }, { stage: 2, receipt, sha256: hash(JSON.stringify(receipt)) }]
  await store.save(record)
  return { store, native, runtime, record, recoveryToken, directory, root }
}

test('postprocess writes only notes, animation sidecar and safe SVG; fingerprint tracks source inputs', async (t) => {
  const { runtime, record, directory, root } = await fixture(t)
  for (const file of ['design_spec.md', 'spec_lock.md', 'confirm_ui/result.json', 'exports/test.pptx', '../state.json']) await assert.rejects(runtime.write(record, file, 'bad'))
  await assert.rejects(runtime.write(record, 'animations.json', '{'))
  const before = await runtime.releaseSnapshot(record)
  await writeFile(path.join(directory, 'notes/01_test.md'), 'derived')
  assert.equal(await runtime.releaseSnapshot(record), before)
  await runtime.write(record, 'notes/total.md', '# 01_test\n\nChanged')
  assert.notEqual(await runtime.releaseSnapshot(record), before)
  await writeFile(path.join(root, 'secret'), 'private')
  await symlink(path.join(root, 'secret'), path.join(directory, 'icons/external.svg'))
  await assert.rejects(runtime.releaseSnapshot(record), /符号链接/)
})

test('native preparation validates notes without splitting or claiming visual review', async (t) => {
  const { runtime, record, directory } = await fixture(t)
  const calls = []
  runtime.tool = async (_record, name) => {
    calls.push(name)
    if (name === 'check_final') await writeFile(path.join(directory, 'validation/svg_quality_report.json'), JSON.stringify({ stage: 'final', categories: { blocking: { count: 0 }, introduced: { count: 0 } }, files: [{}] }))
    return { code: 0 }
  }
  const result = await runtime.finishPreparation(record, { mode: 'native-default', reason: '静态展示，无需对象动画。' })
  assert.equal(result.accepted, true)
  assert.equal(result.visualReview, 'pending')
  assert.equal(result.exportReady, false)
  assert.ok(calls.includes('validate_notes'))
  assert.ok(!calls.includes('split_notes'))
  await assert.rejects(runtime.finishPreparation(record, { mode: 'sidecar', reason: 'missing file' }), /不一致/)
})

test('export refuses missing preparation, changed sources and unperformed visual review', async (t) => {
  const { runtime, record } = await fixture(t)
  await assert.rejects(runtime.export(record), /后处理/)
  record.production = { accepted: true, fingerprint: await runtime.releaseSnapshot(record) }
  // A claimed manual receipt is not a substitute for requested automatic review.
  record.review = { status: 'manual-approved', fingerprint: record.production.fingerprint }
  await assert.rejects(runtime.export(record), /自动视觉审查/)
  record.visualReview = false
  await runtime.write(record, 'notes/total.md', 'changed')
  await assert.rejects(runtime.export(record), /发生变化|已变化/)
})

test('postprocessing waits for requested review and never adds an automatic confirmation', async (t) => {
  const { store, native, record, recoveryToken } = await fixture(t)
  let attempts = 0
  const controller = new PlanningController(store, native, {
    postprocessRuntime: { prepare: async () => {} },
    postprocessor: async () => { attempts++; return { accepted: true, fingerprint: 'test' } },
  })
  t.after(() => controller.close())
  await controller.start(record.id, recoveryToken)
  await controller.jobs.get(record.id).promise
  const result = await store.get(record.id, recoveryToken)
  assert.equal(result.status, 'awaiting_visual_review')
  assert.equal(result.confirmations.length, 2)
  await controller.start(record.id, recoveryToken)
  assert.equal(attempts, 1)
})

test('review-disabled workflow chains to export, retries export without recreating pages', async (t) => {
  const { store, native, record, recoveryToken } = await fixture(t, false)
  let preparations = 0, exports = 0
  const controller = new PlanningController(store, native, {
    postprocessRuntime: { prepare: async () => {}, export: async () => {
      if (++exports === 1) throw new Error('transient')
      return { file: 'moonwalk_1.pptx' }
    } },
    postprocessor: async () => { preparations++; return { accepted: true } },
  })
  t.after(() => controller.close())
  await controller.start(record.id, recoveryToken)
  while (controller.jobs.has(record.id)) await controller.jobs.get(record.id).promise
  assert.equal((await store.read(record.id)).status, 'failed')
  assert.equal((await store.read(record.id)).activeStage, 'export')
  await controller.start(record.id, recoveryToken)
  while (controller.jobs.has(record.id)) await controller.jobs.get(record.id).promise
  assert.equal((await store.read(record.id)).status, 'complete')
  assert.equal(preparations, 1)
  assert.equal(exports, 2)
})

test('cancel at automatic stage handoff persists paused rather than an orphan running state', async (t) => {
  const { store, native, record, recoveryToken } = await fixture(t, false)
  let exports = 0, interrupted = false
  const controller = new PlanningController(store, native, {
    postprocessRuntime: { prepare: async () => {}, export: async () => { exports++ } },
    postprocessor: async () => ({ accepted: true }),
  })
  const save = store.save.bind(store)
  store.save = async (value) => {
    await save(value)
    if (value.status === 'preparing_export' && !interrupted) {
      interrupted = true
      controller.jobs.get(value.id).abort.abort()
    }
  }
  await controller.start(record.id, recoveryToken)
  await controller.jobs.get(record.id).promise
  const result = await store.read(record.id)
  assert.equal(result.status, 'paused')
  assert.equal(result.activeStage, 'export')
  assert.equal(exports, 0)
  assert.equal(controller.jobs.size, 0)
})

test('agent retains postprocess checkpoint and does not invent approval or export', async (t) => {
  const { runtime, record } = await fixture(t)
  runtime.finishPreparation = async () => ({ accepted: true, exportReady: false, visualReview: 'pending' })
  const result = await postprocessPages({ record, runtime, signal: new AbortController().signal,
    turn: async (_provider, instructions, _history, options) => {
      assert.match(instructions, /Automatic visual review is NOT available/)
      assert.equal(options.deepseekThinking, 'disabled')
      return [{ id: 'finish', name: 'finish_preparation', arguments: JSON.stringify({ motionMode: 'native-default', reason: 'static' }) }]
    },
  })
  assert.equal(result.visualReview, 'pending')
  assert.equal(result.exportReady, false)
})

test('agent rejects hidden finalize tools and invalidates completion if a later call edits files', async (t) => {
  const { runtime, record } = await fixture(t)
  let invoked = 0, round = 0
  runtime.tool = async () => { invoked++; return { code: 0 } }
  runtime.finishPreparation = async () => ({ accepted: true, exportReady: false })
  const finish = { id: 'finish', name: 'finish_preparation', arguments: JSON.stringify({ motionMode: 'native-default', reason: 'static' }) }
  await postprocessPages({ record, runtime, signal: new AbortController().signal,
    turn: async (_provider, _instructions, history) => {
      if (round++ === 0) return [{ id: 'forbidden', name: 'native_tool', arguments: JSON.stringify({ name: 'finalize', input: '' }) }]
      if (round === 2) {
        assert.match(history.at(-1).content, /不能提前/)
        return [finish, { id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'notes/total.md', content: '# 01_test\nChanged' }) }]
      }
      return [{ ...finish, id: 'recheck' }]
    },
  })
  assert.equal(invoked, 0)
  assert.equal(round, 3)
})

test('controller refuses a non-accepted postprocess result and shutdown prevents new work', async (t) => {
  const { store, native, record, recoveryToken } = await fixture(t, false)
  let exports = 0
  const controller = new PlanningController(store, native, {
    postprocessRuntime: { prepare: async () => {}, export: async () => { exports++ } },
    postprocessor: async () => ({ accepted: false }),
  })
  await controller.start(record.id, recoveryToken)
  await controller.jobs.get(record.id).promise
  assert.equal((await store.read(record.id)).status, 'failed')
  assert.equal(exports, 0)
  await controller.close()
  await assert.rejects(controller.start(record.id, recoveryToken), /服务正在停止/)
})

test('download authenticates project, requires current source and exact artifact bytes', async (t) => {
  const { store, native, runtime, record, recoveryToken, directory } = await fixture(t, false)
  const bytes = Buffer.from('synthetic artifact for endpoint test only')
  const file = 'moonwalk_123.pptx'
  await writeFile(path.join(directory, 'exports', file), bytes)
  record.status = 'complete'
  record.artifact = { file, bytes: bytes.length, sha256: hash(bytes), fingerprint: await runtime.releaseSnapshot(record) }
  await store.save(record)
  const controller = new PlanningController(store, native, { postprocessRuntime: runtime })
  const app = express(); app.use(express.json()); app.use('/api/ppt', await createPptRouter(store, { controller }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/ppt/projects/${record.id}/download`
  assert.equal((await fetch(base)).status, 404)
  const headers = { Authorization: `Bearer ${recoveryToken}` }
  const response = await fetch(base, { headers })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition'), /attachment/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), bytes.toString())
  await writeFile(path.join(directory, 'exports', file), Buffer.alloc(bytes.length))
  assert.equal((await fetch(base, { headers })).status, 409)
  await writeFile(path.join(directory, 'exports', file), bytes)
  await runtime.write(record, 'notes/total.md', 'changed')
  assert.equal((await fetch(base, { headers })).status, 409)
})

test('original notes parser rejects uncovered and empty slide scripts without writing per-slide files', {
  skip: !['darwin', 'linux'].includes(process.platform) || !process.env.PPT_MASTER_SKILL_ROOT || !process.env.PPT_PYTHON,
}, async (t) => {
  const { runtime, record, directory } = await fixture(t)
  const signal = new AbortController().signal
  assert.equal((await runtime.tool(record, 'validate_notes', '', signal)).code, 0)
  await assert.rejects(readFile(path.join(directory, 'notes/01_test.md')), { code: 'ENOENT' })
  await runtime.write(record, 'notes/total.md', '# 01_test\n\n')
  assert.notEqual((await runtime.tool(record, 'validate_notes', '', signal)).code, 0)
  await runtime.write(record, 'notes/total.md', '# 02_other\n\nUnmatched')
  assert.notEqual((await runtime.tool(record, 'validate_notes', '', signal)).code, 0)
})
