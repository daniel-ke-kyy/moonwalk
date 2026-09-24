import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { VisualRuntime } from './visualRuntime.js'
import { reviewPages } from './visualReview.js'

// Explicit opt-in: calls the configured GPT endpoint on an isolated project copy.
test('live GPT native review reports honestly without modifying the approved source project', {
  skip: !process.env.PPT_LIVE_REVIEW_RECORD,
  timeout: 900000,
}, async (t) => {
  const sourceFile = path.resolve(process.env.PPT_LIVE_REVIEW_RECORD)
  const original = await readFile(sourceFile, 'utf8')
  const source = JSON.parse(original)
  assert.equal(source.aiProvider, 'openai', 'Live acceptance must use GPT')
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-live-review-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  const { project } = await store.create({ aiProvider: 'openai', prompt: 'ISOLATED GPT REVIEW', visualReview: true })
  const record = await store.read(project.id)
  const config = { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON }
  const native = new NativeRuntime(store, config)
  const sourceNative = new NativeRuntime(new ProjectStore(path.dirname(path.dirname(sourceFile))), config)
  await cp(sourceNative.projectPath(source), native.projectPath(record), { recursive: true, dereference: false })
  for (const key of ['confirmations', 'specApproval', 'specReview', 'production']) record[key] = source[key]
  const runtime = new VisualRuntime(native)
  const signal = AbortSignal.timeout(840000)
  await runtime.prepare(record, signal)
  const result = await reviewPages({ record, runtime, signal,
    checkpoint: async (progress) => t.diagnostic(progress.message),
  })
  assert.equal(result.review.provider, 'openai')
  assert.equal(result.review.pages.length, source.production.slideCount)
  assert.equal(result.review.fingerprint, await runtime.releaseSnapshot(record))
  assert.equal(await readFile(sourceFile, 'utf8'), original)
  t.diagnostic(JSON.stringify({ status: result.review.status, model: result.review.model,
    pages: result.review.pages.map((page) => ({ page: page.page, status: page.status, concerns: page.needs_human_items })) }))
  // A successful integration test is NOT a claim that every reviewed slide passed.
})
