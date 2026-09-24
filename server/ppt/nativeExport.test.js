import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import AdmZip from 'adm-zip'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime } from './nativeRuntime.js'
import { PostprocessRuntime } from './postprocessRuntime.js'

// Optional real export smoke test on an isolated COPY, never changing the source
// project's confirmations, review policy or delivery state. No model calls.
test('real original exporter packages slides, speaker notes and animation XML', {
  skip: !['darwin', 'linux'].includes(process.platform) || !process.env.PPT_EXPORT_SAMPLE || !process.env.PPT_MASTER_SKILL_ROOT || !process.env.PPT_PYTHON,
  timeout: 240000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-native-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  const { project } = await store.create({ aiProvider: 'deepseek', prompt: 'ISOLATED EXPORT TEST ONLY', visualReview: false })
  const record = await store.read(project.id)
  const native = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON })
  const runtime = new PostprocessRuntime(native)
  await cp(process.env.PPT_EXPORT_SAMPLE, native.projectPath(record), { recursive: true, dereference: false })
  const receipt = await native.readProject(record, 'confirm_ui/result.json')
  record.confirmations = [{ stage: 1 }, { stage: 2, receipt, sha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') }]
  if (process.env.PPT_EXPORT_RECORD) {
    const source = JSON.parse(await readFile(process.env.PPT_EXPORT_RECORD, 'utf8'))
    record.aiProvider = source.aiProvider
    record.specApproval = source.specApproval
    record.specReview = source.specReview
  }
  await store.save(record)
  const signal = new AbortController().signal
  await runtime.prepare(record, signal)
  record.production = await runtime.finishPreparation(record, { mode: 'sidecar', reason: 'Preserved test fixture animations' }, signal)
  assert.equal(record.production.accepted, true, JSON.stringify(record.production))
  const artifact = await runtime.export(record, signal)
  const file = await readFile(path.join(native.projectPath(record), 'exports', artifact.file))
  const zip = new AdmZip(file)
  const entries = zip.getEntries()
  const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
  const notes = entries.filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName))
  assert.equal(slides.length, Number((await runtime.verifyConfirmation(record)).page_count))
  assert.equal(notes.length, slides.length)
  assert.ok(slides.some((entry) => /<p:timing[\s>]/.test(entry.getData().toString('utf8'))), 'object animation XML missing')
  assert.ok(notes.some((entry) => /[\u4e00-\u9fff]/.test(entry.getData().toString('utf8'))), 'Chinese notes missing')
  if (process.env.PPT_EXPORT_EXPECT_TABLE === 'true') assert.ok(slides.some((entry) => /<a:tbl[\s>]/.test(entry.getData().toString('utf8'))), 'native editable table missing')
  assert.equal(artifact.visualReview, 'disabled')
  record.status = 'complete'; record.artifact = artifact
  assert.deepEqual((await runtime.download(record)).content, file)
  t.diagnostic(`Original PPTX: ${slides.length} slides, ${notes.length} notes, motion XML present; ${artifact.bytes} bytes; ${artifact.status}.`)
})
