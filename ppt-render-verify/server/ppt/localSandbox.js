import { spawn } from 'node:child_process'
import { realpath, readFile } from 'node:fs/promises'
import path from 'node:path'
import { ProjectError } from './projectStore.js'
import { linuxInvocation, withLinuxWorkspace } from './linuxSandbox.js'

const quote = (value) => JSON.stringify(value)

// macOS local adapter. Linux uses an independently checked cloud worker below.
export async function sandboxProfile({ python, skillRoot, project, extraReads = [], renderPort, browserRoot, previewWrite = false, specReview = false }) {
  if (process.platform !== 'darwin') throw new ProjectError('本地制作沙箱仅支持 macOS；当前环境尚未配置独立容器执行器。', 503)
  const executable = await realpath(python)
  const pythonHome = path.dirname(path.dirname(executable))
  const venv = path.dirname(path.dirname(path.resolve(python)))
  const root = await realpath(project)
  const readable = [pythonHome, venv, await realpath(skillRoot), root,
    '/System', '/usr/lib', '/usr/share', '/Library/Fonts', '/Library/Apple/System/Library',
    '/private/var/db/timezone', ...extraReads]
  const directories = ['svg_output', 'icons', 'validation', '.worker-tmp', 'notes', 'svg_final', 'exports']
  const files = ['design_spec.md', 'spec_lock.md', 'svg_quality_report.txt', 'animations.json']
  if (previewWrite) directories.push('live_preview')
  if (specReview) directories.push('spec_review')
  if (renderPort) {
    if (!Number.isInteger(renderPort) || renderPort < 1024 || renderPort > 65535 || !browserRoot) throw new ProjectError('截图沙箱参数无效。')
    readable.push(await realpath(browserRoot))
    directories.push('.preview')
  }
  const finalizationPrefix = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\.svg_final\\.(candidate|publish)-[^/]+(/|$)'
  return `(version 1)
(deny default)
(allow process* sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* ${readable.map((x) => `(subpath ${quote(x)})`).join(' ')})
(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/etc/localtime") (literal "/private/etc/apache2/mime.types") (literal "/etc/apache2/mime.types"))
(allow file-read* file-write* (literal "/dev/null") (subpath "/dev/fd"))
${renderPort ? `(allow mach-register iokit-open iokit-get-properties)\n(allow network-bind network-inbound (local ip "localhost:${renderPort}"))\n(allow network-outbound (remote ip "localhost:${renderPort}"))` : ''}
(allow file-read* file-write* (regex ${quote(`^${finalizationPrefix}`)}))
${specReview ? `(allow file-write* (regex ${quote('^' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\.design_spec\\.md\\.[^/]+$')}))` : ''}
(allow file-write* ${directories.map((x) => `(subpath ${quote(path.join(root, x))})`).join(' ')} ${files.map((x) => `(literal ${quote(path.join(root, x))})`).join(' ')})`
}

export async function sandboxRun(config, args, { signal, input, timeout = 90000 } = {}) {
  if (process.platform === 'linux') return withLinuxWorkspace(config, async () => {
    signal?.throwIfAborted()
    return runSandbox(config, await linuxInvocation(config, args), { signal, input, timeout })
  })
  const profile = await sandboxProfile(config)
  return runSandbox(config, { command: '/usr/bin/sandbox-exec', args: ['-p', profile, config.python, ...args] }, { signal, input, timeout })
}

function runSandbox(config, invocation, { signal, input, timeout }) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: config.project, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      ...(invocation.uid !== undefined ? { uid: invocation.uid, gid: invocation.gid } : {}),
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8', HOME: path.join(config.project, '.worker-tmp'),
        TMPDIR: path.join(config.project, '.worker-tmp'),
        ...(config.browserRoot ? { PLAYWRIGHT_BROWSERS_PATH: config.browserRoot } : {}) },
    })
    const chunks = [], errors = []
    let size = 0, killed = false
    const stop = () => { killed = true; try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already stopped. */ } }
    const timer = setTimeout(stop, timeout)
    signal?.addEventListener('abort', stop, { once: true })
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) stop()
      else (stream === child.stdout ? chunks : errors).push(chunk)
    })
    child.on('error', (error) => { cleanup(); reject(error) })
    child.on('close', (code, exitSignal) => {
      cleanup()
      if (signal?.aborted) return reject(signal.reason)
      if (killed) return reject(new ProjectError('原生制作工具超过时间或输出上限，任务已停止。', 409))
      resolve({ code: code ?? 128, output: Buffer.concat(chunks).toString('utf8'), error: `${Buffer.concat(errors).toString('utf8').slice(-12000)}${exitSignal ? `\nStopped: ${exitSignal}` : ''}` })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export async function checkLocalSandbox(config) {
  const result = await sandboxRun(config, ['-c', 'import flask, pptx; print("sandbox-ready")'])
  if (result.code || !result.output.includes('sandbox-ready')) throw new ProjectError('本地制作沙箱启动失败，未开始制作。', 503)
  // Verify the worker cannot read the server-owned state next to workspace/.
  const secret = path.resolve(config.project, '../../state.json')
  await readFile(secret)
  const denial = await sandboxRun(config, ['-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).read_bytes()', secret])
  if (denial.code === 0) throw new ProjectError('制作沙箱隔离检查失败。', 503)
}
