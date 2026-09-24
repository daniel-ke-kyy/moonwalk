import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProjectStore } from './projectStore.js'
import { checkCloudWorker } from './cloudCheck.js'
import { sandboxRun } from './localSandbox.js'

const enabled = process.platform === 'linux' && process.getuid?.() === 0 && process.env.PPT_PYTHON && process.env.PPT_MASTER_SKILL_ROOT

test('cloud startup fails closed unless actual isolation denials pass', { skip: !enabled }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppt-cloud-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  await checkCloudWorker(store, { python: process.env.PPT_PYTHON, skillRoot: process.env.PPT_MASTER_SKILL_ROOT })
})

test('cloud worker cannot replace receipts, read host process credentials, or leave detached children', { skip: !enabled, timeout: 20000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ppt-cloud-denials-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'workspace', 'deck')
  for (const name of ['confirm_ui', 'svg_output']) await mkdir(path.join(project, name), { recursive: true })
  await writeFile(path.join(project, 'confirm_ui/result.json'), 'protected')
  await writeFile(path.join(root, 'secret'), 'private', { mode: 0o600 })
  const config = { project, storeRoot: root, python: process.env.PPT_PYTHON, skillRoot: process.env.PPT_MASTER_SKILL_ROOT }
  for (const code of [
    'import pathlib; pathlib.Path("confirm_ui/result.json").chmod(0o777)',
    'import pathlib; pathlib.Path("confirm_ui/result.json").unlink()',
    'import pathlib; pathlib.Path("confirm_ui").rename("old-confirmation")',
    `import pathlib; pathlib.Path(${JSON.stringify(`/proc/${process.pid}/environ`)}).read_bytes()`,
    'import ctypes; c=ctypes.CDLL(None,use_errno=True); assert c.ptrace(0,0,0,0)==0',
  ]) assert.notEqual((await sandboxRun(config, ['-c', code])).code, 0, code)
  assert.equal(await readFile(path.join(project, 'confirm_ui/result.json'), 'utf8'), 'protected')
  const driver = await sandboxRun(config, ['-c', 'from playwright._impl._driver import compute_driver_executable; import subprocess; node,_=compute_driver_executable(); subprocess.run([node,"--version"],check=True)'])
  assert.equal(driver.code, 0, driver.error)
  const marker = path.join(project, 'svg_output/detached.txt')
  const childCode = `import time,pathlib; time.sleep(2); pathlib.Path(${JSON.stringify(marker)}).write_text('escaped')`
  const parentCode = `import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',${JSON.stringify(childCode)}],start_new_session=True); print('child-started',flush=True); time.sleep(30)`
  await assert.rejects(sandboxRun(config, ['-c', parentCode], { timeout: 900 }), /上限/)
  await delay(2300)
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})
