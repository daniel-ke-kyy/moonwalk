import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { ProjectStore, RETENTION_MS } from './projectStore.js'
import { createPptRouter } from './router.js'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moonwalk-ppt-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = 1000
  const store = await new ProjectStore(root, { now: () => now }).init()
  return { store, root, advance: (ms) => { now += ms } }
}

test('projects survive restart without returning stored capability hashes', async (t) => {
  const { store, root } = await fixture(t)
  const result = await store.create({ prompt: '课程汇报', aiProvider: 'openai' })
  assert.equal(result.project.aiProvider, 'openai')
  assert.equal(result.project.visualReview, true)
  assert.equal(result.project.tokenHash, undefined)
  const restarted = await new ProjectStore(root, { now: () => 1001 }).init()
  assert.deepEqual(await restarted.get(result.project.id, result.recoveryToken), result.project)
})

test('invalid providers and visual review settings are rejected', async (t) => {
  const { store } = await fixture(t)
  await assert.rejects(store.create({ aiProvider: 'unknown' }), { status: 400 })
  await assert.rejects(store.create({ aiProvider: 'deepseek', visualReview: 'false' }), { status: 400 })
})

test('capabilities are project-specific; traversal is rejected', async (t) => {
  const { store } = await fixture(t)
  const one = await store.create({ aiProvider: 'deepseek' })
  const two = await store.create({ aiProvider: 'openai' })
  await assert.rejects(store.get(one.project.id, two.recoveryToken), { status: 404 })
  await assert.rejects(store.get(one.project.id, ''), { status: 404 })
  await assert.rejects(store.get('../state', one.recoveryToken), { status: 404 })
})

test('viewing does not refresh retention; expired projects are cleaned', async (t) => {
  const { store, advance, root } = await fixture(t)
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek' })
  advance(RETENTION_MS - 1)
  assert.equal((await store.get(project.id, recoveryToken)).expiresAt, project.expiresAt)
  advance(1)
  await assert.rejects(store.get(project.id, recoveryToken), { status: 410 })
  assert.equal(await store.cleanupExpired(), 1)
  assert.deepEqual(await readdir(root), [])
})

test('adding files renews retention, preserves names, and uses generated storage paths', async (t) => {
  const { store, advance, root } = await fixture(t)
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek' })
  const upload = path.join(root, 'upload')
  await writeFile(upload, 'example')
  advance(500)
  const updated = await store.addFiles(project.id, recoveryToken, [
    { path: upload, originalName: '../../学习材料.pdf', size: 7 },
  ])
  assert.equal(updated.expiresAt, project.expiresAt + 500)
  assert.match(updated.files[0].name, /^[a-f0-9]{32}\.pdf$/)
  assert.equal(updated.files[0].originalName, '../../学习材料.pdf')
})

test('a failed upload batch rolls back already moved files', async (t) => {
  const { store, root } = await fixture(t)
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek' })
  const upload = path.join(root, 'upload')
  await writeFile(upload, 'example')
  await assert.rejects(store.addFiles(project.id, recoveryToken, [
    { path: upload, originalName: '材料.pdf', size: 7 },
    { path: '/not-used', originalName: 'script.exe', size: 7 },
  ]), { status: 400 })
  assert.deepEqual((await store.get(project.id, recoveryToken)).files, [])
  assert.deepEqual(await readdir(path.join(root, project.id, 'workspace/sources')), [])
})

test('concurrent writes preserve all source files', async (t) => {
  const { store, root } = await fixture(t)
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek' })
  const pending = []
  for (let i = 0; i < 4; i++) {
    const upload = path.join(root, `upload-${i}`)
    await writeFile(upload, 'example')
    pending.push(store.addFiles(project.id, recoveryToken, [{ path: upload, originalName: `${i}.pdf`, size: 7 }]))
  }
  for (const operation of pending) await operation
  assert.equal((await store.get(project.id, recoveryToken)).files.length, 4)
})

test('symlinked project directories and state files are never followed', async (t) => {
  const { store, root } = await fixture(t)
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek' })
  const alias = 'f'.repeat(32)
  await symlink(path.join(root, project.id), path.join(root, alias))
  await assert.rejects(store.get(alias, recoveryToken), { status: 404 })
  const state = path.join(root, project.id, 'state.json')
  await rm(state)
  await symlink(path.join(root, 'missing'), state)
  await assert.rejects(store.get(project.id, recoveryToken), { status: 404 })
})

test('delete requires capability and removes the project', async (t) => {
  const { store } = await fixture(t)
  const { project, recoveryToken } = await store.create({ aiProvider: 'deepseek' })
  await assert.rejects(store.delete(project.id, 'bad'), { status: 404 })
  await store.delete(project.id, recoveryToken)
  await assert.rejects(store.get(project.id, recoveryToken), { status: 404 })
})

test('HTTP API is honest about unavailable execution and cannot synthesize confirmations', async (t) => {
  const { store } = await fixture(t)
  const app = express()
  app.use(express.json())
  app.use('/api/ppt', await createPptRouter(store))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/ppt`
  const capabilities = await (await fetch(`${base}/capabilities`)).json()
  assert.equal(capabilities.nativeExecution, false)
  assert.equal(capabilities.executionEnvironment, 'unavailable')
  const created = await fetch(`${base}/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiProvider: 'openai', prompt: '课程汇报' }),
  })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const { project, recoveryToken } = await created.json()
  const url = `${base}/projects/${project.id}`
  const headers = { Authorization: `Bearer ${recoveryToken}` }
  assert.equal((await fetch(url)).status, 404)
  assert.equal((await fetch(`${base}/projects`)).status, 404)
  assert.equal((await fetch(`${url}/start`, { method: 'POST', headers })).status, 503)
  assert.equal((await fetch(`${url}/confirm`, { method: 'POST', headers })).status, 404)
  const form = new FormData()
  form.append('files', new Blob(['%PDF-1.7']), '学习.pdf')
  const uploaded = await fetch(`${url}/files`, { method: 'POST', headers, body: form })
  assert.equal(uploaded.status, 200)
  const saved = await uploaded.json()
  assert.equal(saved.files[0].originalName, '学习.pdf')
  assert.equal(saved.aiProvider, 'openai')
  assert.equal(saved.status, 'draft')
  assert.deepEqual(saved.confirmations, [])
  assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 204)
})
