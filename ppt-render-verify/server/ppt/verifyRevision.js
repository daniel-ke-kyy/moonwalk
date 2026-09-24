// Opt-in live verification on an isolated copy; never modifies the source project.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { RevisionRuntime } from './revisionRuntime.js'
import { VisualRuntime } from './visualRuntime.js'
import { revisePages } from './revisionAgent.js'
import { reviewPages } from './visualReview.js'
import { modelTurn } from './planningAgent.js'

const sample = process.env.PPT_EXPORT_SAMPLE
const page = process.env.PPT_REVISION_PAGE
const instruction = process.env.PPT_REVISION_INSTRUCTION
if (!sample || !page || !instruction) throw new Error('PPT_EXPORT_SAMPLE, PPT_REVISION_PAGE and PPT_REVISION_INSTRUCTION are required; this script makes real model calls.')
const root = await mkdtemp(path.join(os.tmpdir(), 'moonwalk-live-revision-'))
try {
  const source = JSON.parse(await readFile(path.resolve(sample, '../../state.json'), 'utf8'))
  const store = await new ProjectStore(root).init()
  const created = await store.create({ aiProvider: source.aiProvider, prompt: source.prompt, visualReview: true })
  const record = { ...source, ...created.project, tokenHash: (await store.read(created.project.id)).tokenHash,
    createdAt: source.createdAt, confirmations: source.confirmations, production: source.production,
    status: 'preparing_revision', activeStage: 'revision' }
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON })
  await cp(sample, native.projectPath(record), { recursive: true })
  const runtime = new RevisionRuntime(native)
  const originalWrite = runtime.write.bind(runtime)
  runtime.write = async (...args) => {
    try { const result = await originalWrite(...args); console.log(JSON.stringify({ write: args[1], result })); return result }
    catch (error) { console.log(JSON.stringify({ write: args[1], error: error.message })); throw error }
  }
  const before = await runtime.snapshot(record)
  record.revision = { id: 'isolated-live-test', status: 'confirmed', confirmedAt: Date.now(),
    fingerprint: await runtime.releaseSnapshot(record), items: [{ page, instruction, origin: 'request' }] }
  await store.save(record)
  const signal = AbortSignal.timeout(15 * 60 * 1000)
  await runtime.prepare(record, signal)
  const log = (progress) => console.log(JSON.stringify(progress))
  record.production = await revisePages({ record, runtime, signal, checkpoint: log, turn: async (...args) => {
    const calls = await modelTurn(...args)
    console.log(JSON.stringify({ tools: calls.map((call) => { const input = JSON.parse(call.arguments); return { name: call.name, path: input.path, tool: input.name } }) }))
    return calls
  } })
  const after = await runtime.snapshot(record)
  assert.notEqual(after[`svg_output/${page}`], before[`svg_output/${page}`])
  for (const name of Object.keys(before)) if (name !== `svg_output/${page}`) assert.equal(after[name], before[name], `untouched file: ${name}`)
  const visual = new VisualRuntime(native, { browserRoot: process.env.PPT_BROWSER_ROOT })
  await visual.prepare(record, signal)
  const reviewed = await reviewPages({ record, runtime: visual, signal, checkpoint: log })
  record.review = reviewed.review; record.production = reviewed.production
  console.log(JSON.stringify({ review: record.review.status, pages: record.review.pages.map((entry) => ({ page: entry.page, status: entry.status, findings: entry.findings })) }))
  if (record.review.status === 'passed') {
    const artifact = await runtime.export(record, signal)
    console.log(JSON.stringify({ exported: artifact.file, slides: artifact.slideCount, status: artifact.status }))
  }
} finally { await rm(root, { recursive: true, force: true }) }
