// Opt-in real-model verification, isolated from the user's project and approvals.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { AuthoringRuntime } from './authoringRuntime.js'
import { SpecRuntime } from './specRuntime.js'
import { refineSpec } from './specAgent.js'

if (!process.env.PPT_EXPORT_SAMPLE) throw new Error('Set PPT_EXPORT_SAMPLE. This verification makes real model calls.')
const root = await mkdtemp(path.join(os.tmpdir(), 'moonwalk-live-spec-'))
try {
  const source = JSON.parse(await readFile(path.resolve(process.env.PPT_EXPORT_SAMPLE, '../../state.json'), 'utf8'))
  const store = await new ProjectStore(root).init()
  const created = await store.create({ aiProvider: source.aiProvider, prompt: source.prompt, visualReview: true })
  const record = { ...source, ...await store.read(created.project.id), createdAt: source.createdAt, confirmations: source.confirmations }
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON })
  await cp(process.env.PPT_EXPORT_SAMPLE, native.projectPath(record), { recursive: true })
  const authoring = new AuthoringRuntime(native)
  const runtime = new SpecRuntime(authoring)
  record.specReview = await runtime.begin(record)
  const before = await authoring.snapshot(record)
  const state = await runtime.inspect(record)
  await runtime.call(record, { path: '/api/annotations', method: 'POST', hold: false, body: {
    key: 'slide:03', body: '只在本页规范的“怎么算做到”信息块中，明确补充“下一步由谁负责、下次何时同步”，其余内容和全局设计保持不变。不修改 SVG、执行锁或讲稿。' } })
  const outcome = await refineSpec({ record, runtime, signal: AbortSignal.timeout(10 * 60 * 1000),
    checkpoint: (p) => console.log(JSON.stringify(p)) })
  assert.equal(outcome.accepted, true)
  const after = await runtime.inspect(record)
  assert.notEqual(after.sha256, state.sha256)
  assert.equal(after.annotations.length, 0)
  assert.equal(after.unreadEdits, false)
  const files = await authoring.snapshot(record)
  for (const name of Object.keys(before)) if (name !== 'design_spec.md') assert.equal(files[name], before[name], name)
  const summary = await runtime.summary(record)
  console.log(JSON.stringify({ accepted: true, summary: outcome.summary, global: summary.global, affectedPages: summary.pages,
    approval: 'still requires user action', originalProjectUnchanged: true }))
} finally { await rm(root, { recursive: true, force: true }) }
