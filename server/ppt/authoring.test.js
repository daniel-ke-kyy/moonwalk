import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { AuthoringRuntime, validateSvgInput } from './authoringRuntime.js'
import { sandboxRun } from './localSandbox.js'
import { PlanningController } from './planningController.js'
import { authorPages } from './authoringAgent.js'
import { createPptRouter } from './router.js'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-author-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek', prompt: 'Five slides' })
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT || root, python: process.env.PPT_PYTHON || '/usr/bin/python3' })
  const runtime = new AuthoringRuntime(native)
  const directory = native.projectPath(project)
  for (const name of ['confirm_ui', 'svg_output', 'icons', 'validation', '.worker-tmp']) await mkdir(path.join(directory, name), { recursive: true })
  const receipt = { status: 'confirmed', generation_mode: 'continuous', image_usage: ['none'], page_count: '5' }
  await writeFile(path.join(directory, 'confirm_ui/result.json'), JSON.stringify(receipt))
  await writeFile(path.join(directory, 'confirm_ui/template_selection.json'), JSON.stringify({ mode: 'free_design' }))
  project.confirmations = [{ stage: 1 }, { stage: 2, receipt, sha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') }]
  project.status = 'planning_complete'
  // publicRecord lacks tokenHash; preserve it when constructing the fixture state.
  const record = { ...await store.read(project.id), ...project }
  await store.save(record)
  return { root, store, native, runtime, record, recoveryToken, directory }
}

test('authoring requires the actual final receipt with its server-owned digest', async (t) => {
  const { runtime, record, directory } = await fixture(t)
  await runtime.verifyConfirmation(record)
  await assert.rejects(runtime.verifyConfirmation({ ...record, confirmations: [] }), /确认记录/)
  await writeFile(path.join(directory, 'confirm_ui/result.json'), '{"status":"confirmed","page_count":"100"}')
  await assert.rejects(runtime.verifyConfirmation(record), /确认记录/)
})

test('author writes cannot escape, overwrite receipts, or follow symlinks/hardlinks', async (t) => {
  const { runtime, record, directory, root } = await fixture(t)
  await runtime.write(record, 'design_spec.md', 'test')
  for (const target of ['../state.json', '/tmp/out.md', 'confirm_ui/result.json', 'validation/svg_quality_report.json', 'svg_output/../../state.json']) {
    await assert.rejects(runtime.write(record, target, '{}'))
  }
  await writeFile(path.join(root, 'secret'), 'secret')
  await symlink(path.join(root, 'secret'), path.join(directory, 'spec_lock.md'))
  await assert.rejects(runtime.write(record, 'spec_lock.md', 'bad'))
  await rm(path.join(directory, 'spec_lock.md'))
  await link(path.join(root, 'secret'), path.join(directory, 'spec_lock.md'))
  await assert.rejects(runtime.write(record, 'spec_lock.md', 'bad'))
  assert.equal(await readFile(path.join(root, 'secret'), 'utf8'), 'secret')
})

test('SVG authoring rejects executable and external resource content', () => {
  validateSvgInput('<svg xmlns="http://www.w3.org/2000/svg"><g><text>正常中文</text></g></svg>')
  for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>',
    '<svg><foreignObject><div/></foreignObject></svg>', '<svg><image href="https://example.com/a.png"/></svg>',
    '<svg><image href="file:///etc/passwd"/></svg>', '<svg><rect fill="url(https://example.com/x)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>', '<svg>']) assert.throws(() => validateSvgInput(svg))
})

test('native fallback stamping is confined to an approved ordinary SVG file', async (t) => {
  const { runtime, record, directory, root } = await fixture(t)
  for (const target of ['../state.json', 'svg_output', 'design_spec.md', '/tmp/01_test.svg']) {
    await assert.rejects(runtime.tool(record, 'stamp_native_fallbacks', target))
  }
  await writeFile(path.join(root, 'outside.svg'), '<svg/>')
  await symlink(path.join(root, 'outside.svg'), path.join(directory, 'svg_output/01_link.svg'))
  await assert.rejects(runtime.tool(record, 'stamp_native_fallbacks', 'svg_output/01_link.svg'))
  await link(path.join(root, 'outside.svg'), path.join(directory, 'svg_output/02_link.svg'))
  await assert.rejects(runtime.tool(record, 'stamp_native_fallbacks', 'svg_output/02_link.svg'))
  await assert.rejects(runtime.tool({ ...record, specReview: { status: 'approved' },
    specApproval: { global: false, pages: [2] } }, 'stamp_native_fallbacks', 'svg_output/01_test.svg'), /修改范围/)
  assert.equal(await readFile(path.join(root, 'outside.svg'), 'utf8'), '<svg/>')
})

test('resumed authoring explicitly continues with current tools without dropping history', async (t) => {
  const { runtime, record, store } = await fixture(t)
  await writeFile(path.join(store.directory(record.id), 'authoring-checkpoint.json'), JSON.stringify({ history: [
    { role: 'user', content: 'saved request' },
    { type: 'function_call_output', call_id: 'blocked', output: '{"paused":true}' },
  ] }))
  runtime.finish = async () => ({ accepted: true })
  const result = await authorPages({ record, runtime, signal: new AbortController().signal,
    turn: async (_provider, instructions, history, options) => {
      assert.equal(history[0].content, 'saved request')
      assert.match(history.at(-1).content, /resumed this existing task/)
      assert.match(instructions, /stamp_native_fallbacks/)
      assert.ok(options.toolSet.find((item) => item.name === 'native_tool').parameters.properties.name.enum.includes('stamp_native_fallbacks'))
      return [{ id: 'finish', name: 'finish_draft', arguments: '{}' }]
    },
  })
  assert.equal(result.accepted, true)
})

test('draft completion rejects missing pages and missing, stale or failing quality reports', async (t) => {
  const { runtime, record, directory } = await fixture(t)
  await runtime.write(record, 'design_spec.md', 'spec')
  await runtime.write(record, 'spec_lock.md', 'lock')
  await runtime.write(record, 'svg_output/01_test.svg', '<svg/>')
  await assert.rejects(runtime.finish(record), /已确认 5 页/)
  for (let i = 2; i <= 5; i++) await runtime.write(record, `svg_output/0${i}_test.svg`, '<svg/>')
  runtime.tool = async () => ({ code: 0, output: '' })
  assert.equal((await runtime.finish(record)).accepted, false)
  const report = { stage: 'final', categories: { blocking: { count: 0 }, introduced: { count: 0 } }, files: [1, 2, 3, 4, 5] }
  await writeFile(path.join(directory, 'validation/svg_quality_report.json'), JSON.stringify({ ...report, stage: 'early' }))
  assert.equal((await runtime.finish(record)).accepted, false)
  await writeFile(path.join(directory, 'validation/svg_quality_report.json'), JSON.stringify(report))
  const result = await runtime.finish(record)
  assert.equal(result.accepted, true)
  assert.equal(result.exportReady, false)
  assert.equal(result.visualReview, 'pending')
  runtime.tool = async (_record, name) => {
    if (name === 'check_final') await runtime.write(record, 'svg_output/01_test.svg', '<svg><text>changed</text></svg>')
    return { code: 0 }
  }
  await assert.rejects(runtime.finish(record), /发生变化/)
})

test('confirmed projects enter authoring once; completed draft never claims export', async (t) => {
  const { store, native, record, recoveryToken } = await fixture(t)
  let count = 0, finish
  const gate = new Promise((resolve) => { finish = resolve })
  const controller = new PlanningController(store, native, { authoringRuntime: { prepare: async () => {} }, author: async () => {
    count++; await gate; return { accepted: true, slideCount: 5, exportReady: false }
  } })
  t.after(() => controller.close())
  await controller.start(record.id, recoveryToken)
  await controller.start(record.id, recoveryToken)
  assert.equal(count, 1)
  await assert.rejects(store.delete(record.id, recoveryToken), /停止/)
  const job = controller.jobs.get(record.id)
  finish(); await job.promise
  const result = await store.get(record.id, recoveryToken)
  assert.equal(result.status, 'draft_ready')
  assert.equal(result.authoring.exportReady, false)
  await controller.start(record.id, recoveryToken)
  assert.equal(count, 1)
})

test('authoring cancellation and restart retain the confirmed stage', async (t) => {
  const { store, native, record, recoveryToken } = await fixture(t)
  const controller = new PlanningController(store, native, { authoringRuntime: { prepare: async () => {} }, author: async ({ signal }) => {
    signal.throwIfAborted()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  await controller.start(record.id, recoveryToken)
  await controller.cancel(record.id, recoveryToken)
  assert.equal((await store.get(record.id, recoveryToken)).status, 'paused')
  const interrupted = await store.read(record.id)
  interrupted.status = 'preparing_authoring'
  await store.save(interrupted)
  await controller.recover()
  const result = await store.read(record.id)
  assert.equal(result.status, 'paused')
  assert.equal(result.activeStage, 'authoring')
  assert.equal(result.confirmations.length, 2)
})

test('agent enforces spec validation and calibration before writing pages', async (t) => {
  const { runtime, record } = await fixture(t)
  let round = 0, writes = 0
  runtime.write = async () => { writes++; return { written: true } }
  runtime.tool = async () => ({ code: 0 })
  runtime.finish = async () => ({ accepted: true, exportReady: false })
  const calls = [
    ['write_file', { path: 'svg_output/01_test.svg', content: '<svg/>' }],
    ['native_tool', { name: 'validate', input: '' }], ['native_tool', { name: 'calibrate', input: '' }],
    ['write_file', { path: 'svg_output/01_test.svg', content: '<svg/>' }], ['finish_draft', {}],
  ]
  const result = await authorPages({ record, runtime, signal: new AbortController().signal,
    turn: async (_provider, _instructions, history, { toolSet }) => {
      assert.ok(toolSet.some((item) => item.name === 'finish_draft'))
      if (round === 1) assert.match(history.at(-1).content, /validate/)
      const [name, args] = calls[round++]
      return [{ id: `${round}`, name, arguments: JSON.stringify(args) }]
    } })
  assert.equal(writes, 1)
  assert.equal(result.exportReady, false)
})

test('preview requires project capability, denies writes and uses original UI', async (t) => {
  const { store, native, runtime, record, recoveryToken } = await fixture(t)
  runtime.preview = async (_record, endpoint) => ({ status: 200, contentType: 'text/html', body: Buffer.from(`<html><head></head><body><div id="svg-container"></div><script src="/static/app.js"></script>${endpoint}</body></html>`) })
  const controller = new PlanningController(store, native, { authoringRuntime: runtime })
  const app = express(); app.use(express.json()); app.use('/api/ppt', await createPptRouter(store, { controller }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/ppt/projects/${record.id}`
  assert.equal((await fetch(`${base}/preview/`)).status, 404)
  const session = await fetch(`${base}/preview-session`, { method: 'POST', headers: { Authorization: `Bearer ${recoveryToken}` } })
  const cookie = session.headers.get('set-cookie').split(';')[0]
  const response = await fetch(`${base}/preview/`, { headers: { Cookie: cookie } })
  const html = await response.text()
  assert.match(html, new RegExp(`${record.id}/preview/static/app.js`))
  assert.match(html, /id="svg-container" inert/)
  assert.match(html, /moonwalk-readonly.js/)
  assert.equal((await fetch(`${base}/preview/static/moonwalk-readonly.js`)).status, 404)
  const script = await fetch(`${base}/preview/static/moonwalk-readonly.js`, { headers: { Cookie: cookie } })
  assert.match(await script.text(), /stopImmediatePropagation/)
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/)
  assert.equal((await fetch(`${base}/preview/api/save-all`, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(base).origin } })).status, 409)
  assert.equal((await fetch(`${base}/preview/api/health`, { headers: { Cookie: cookie } })).status, 404)
})

const nativeAvailable = ['darwin', 'linux'].includes(process.platform) && Boolean(process.env.PPT_MASTER_SKILL_ROOT && process.env.PPT_PYTHON)
test('real sandbox denies secrets, sibling reads, outside writes, network, and kills timed-out tasks', { skip: !nativeAvailable }, async (t) => {
  const { runtime, record, directory, root } = await fixture(t)
  await runtime.prepare(record, new AbortController().signal)
  const secret = path.join(root, 'sibling-secret')
  await writeFile(secret, 'private')
  const config = runtime.config(record)
  for (const code of [
    `from pathlib import Path; Path(${JSON.stringify(secret)}).read_text()`,
    `from pathlib import Path; Path(${JSON.stringify(path.join(directory, '../../state.json'))}).read_text()`,
    `from pathlib import Path; Path(${JSON.stringify(secret)}).write_text('bad')`,
    `from pathlib import Path; Path('confirm_ui/result.json').write_text('{}')`,
    'import socket; socket.socket().bind(("127.0.0.1",0))',
  ]) assert.notEqual((await sandboxRun(config, ['-c', code])).code, 0, code)
  const clean = await sandboxRun(config, ['-c', 'import os; assert "OPENAI_API_KEY" not in os.environ; assert "DEEPSEEK_API_KEY" not in os.environ; print("ok")'])
  assert.equal(clean.code, 0, clean.error)
  const valid = await sandboxRun(config, ['-c', 'from pathlib import Path; Path("svg_output/01_test.svg").write_text("<svg/>")'])
  assert.equal(valid.code, 0, valid.error)
  await assert.rejects(sandboxRun(config, ['-c', 'import time;time.sleep(60)'], { timeout: 100 }), /上限/)
  const abort = new AbortController()
  const pending = sandboxRun(config, ['-c', 'import time;time.sleep(60)'], { signal: abort.signal })
  setTimeout(() => abort.abort(), 100)
  await assert.rejects(pending)
  assert.equal(await readFile(secret, 'utf8'), 'private')
})
