import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { openProjectStorage } from './storage.js'
import { createPptRouter } from './router.js'

test('temporary boot roots are isolated, do not promise retention, and never delete persistent data', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ppt-storage-test-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const marker = path.join(parent, 'existing-data')
  await writeFile(marker, 'keep')
  const options = { env: { NODE_ENV: 'production', PPT_STORAGE_MODE: 'temporary' }, temporaryParent: parent }
  const first = await openProjectStorage(options)
  const second = await openProjectStorage(options)
  assert.notEqual(first.store.root, second.store.root)
  assert.equal((await stat(first.store.root)).mode & 0o777, 0o700)
  const { project, recoveryToken } = await first.store.create({ aiProvider: 'openai' })
  assert.equal(project.storageMode, 'temporary')
  assert.equal(project.expiresAt, null)
  assert.equal((await first.store.get(project.id, recoveryToken)).id, project.id)
  await assert.rejects(second.store.get(project.id, recoveryToken), (error) => error.status === 404 && error.message.includes('临时项目'))
  await first.close()
  await assert.rejects(stat(first.store.root), { code: 'ENOENT' })
  assert.equal((await stat(second.store.root)).isDirectory(), true)
  assert.equal(await readFile(marker, 'utf8'), 'keep')

  const app = express()
  app.use(await createPptRouter(second.store))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const result = await (await fetch(`http://127.0.0.1:${server.address().port}/capabilities`)).json()
  assert.equal(result.storageMode, 'temporary')
  assert.equal(result.retentionDays, null)
  assert.equal(result.nativePlanning, false)
  await second.close()
})

test('persistent production storage still requires an explicit root; temporary mode rejects conflicting paths', async () => {
  await assert.rejects(openProjectStorage({ env: { NODE_ENV: 'production' } }), /persistent volume/)
  await assert.rejects(openProjectStorage({ env: { PPT_STORAGE_MODE: 'typo' } }), /Invalid/)
  await assert.rejects(openProjectStorage({ env: { PPT_STORAGE_MODE: 'temporary', PPT_DATA_ROOT: '/existing' } }), /leave it unset/)
})

test('closing persistent storage does not remove project files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppt-storage-persistent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const storage = await openProjectStorage({ env: {}, localRoot: root })
  const { project, recoveryToken } = await storage.store.create({ aiProvider: 'openai' })
  assert.equal(project.storageMode, 'persistent')
  assert.equal(typeof project.expiresAt, 'number')
  await storage.close()
  assert.equal((await storage.store.get(project.id, recoveryToken)).id, project.id)
})
