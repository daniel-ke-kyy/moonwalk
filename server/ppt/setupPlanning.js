import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NATIVE_REVISION } from './nativeRevision.js'

const root = fileURLToPath(new URL('../../.ppt-runtime/', import.meta.url))
const repository = path.join(root, 'ppt-master')
const venv = path.join(root, 'venv')
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const upstream = 'https://github.com/hugohe3/ppt-master.git'
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })
mkdirSync(root, { recursive: true, mode: 0o700 })
if (!existsSync(repository)) {
  run('git', ['clone', '--no-checkout', process.env.PPT_BOOTSTRAP_SOURCE || upstream, repository])
  run('git', ['-C', repository, 'checkout', '--detach', NATIVE_REVISION])
  run('git', ['-C', repository, 'remote', 'set-url', 'origin', upstream])
}
const revision = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (revision !== NATIVE_REVISION) throw new Error('Existing runtime has another revision; refusing to overwrite it')
const basePython = process.env.PPT_BOOTSTRAP_PYTHON || 'python3'
run(basePython, ['-c', 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ is required"'])
if (!existsSync(python)) run(basePython, ['-m', 'venv', venv])
run(python, ['-m', 'pip', 'install', '-r', fileURLToPath(new URL('./planning-requirements.txt', import.meta.url))])
run(python, [path.join(repository, 'skills/ppt-master/scripts/attribution_guard.py')])
console.log(`PPT_MASTER_SKILL_ROOT=${path.join(repository, 'skills/ppt-master')}\nPPT_PYTHON=${python}`)
