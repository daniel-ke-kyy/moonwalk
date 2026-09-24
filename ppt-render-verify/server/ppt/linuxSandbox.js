import { chmod, chown, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ProjectError } from './projectStore.js'

export const WORKER_UID = 65534
const mutableDirectories = new Set(['svg_output', 'icons', 'validation', '.worker-tmp', 'notes', 'svg_final', 'exports', '.preview', 'live_preview', 'spec_review'])
const mutableFiles = new Set(['design_spec.md', 'spec_lock.md', 'svg_quality_report.txt', 'animations.json'])
const locks = new Map()

// Permission changes and native writes for the same workspace must not race a
// preview request. Different projects remain independent; there is no job cap.
export async function withLinuxWorkspace(config, action) {
  const marker = `${path.sep}workspace`
  const index = config.project.lastIndexOf(marker)
  const key = index === -1 ? config.project : config.project.slice(0, index + marker.length)
  const previous = locks.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  locks.set(key, current)
  try { return await current } finally { if (locks.get(key) === current) locks.delete(key) }
}

async function permissions(target, writable) {
  const info = await lstat(target)
  if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
    throw new ProjectError('云端制作目录包含不允许的链接或特殊文件。', 409)
  }
  await chown(target, writable ? WORKER_UID : 0, WORKER_UID)
  await chmod(target, info.isDirectory() ? writable ? 0o700 : 0o550 : writable ? 0o600 : 0o440)
  if (info.isDirectory()) for (const entry of await readdir(target)) await permissions(path.join(target, entry), writable)
}

export async function linuxInvocation(config, args) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new ProjectError('云端工具身份隔离尚未配置，未执行制作工具。', 503)
  }
  const root = await realpath(config.project)
  const storeRoot = await realpath(config.storeRoot)
  if (!root.startsWith(storeRoot + path.sep) || root === storeRoot) throw new ProjectError('制作目录不在项目存储中。', 503)
  // Traversal only on parents: workers cannot list projects or read state.json.
  for (let parent = path.dirname(root); parent.startsWith(storeRoot); parent = path.dirname(parent)) {
    await chmod(parent, 0o711)
    if (parent === storeRoot) break
  }
  await mkdir(path.join(root, '.worker-tmp'), { recursive: true, mode: 0o700 })
  for (const entry of await readdir(root)) {
    const writable = config.planning || mutableDirectories.has(entry) || mutableFiles.has(entry)
      || /^\.svg_final\.(candidate|publish)-/.test(entry) || /^\.design_spec\.md\./.test(entry)
    await permissions(path.join(root, entry), writable)
  }
  // A root-owned sticky directory lets tools create atomic staging files while
  // preventing removal/replacement of server-owned receipts and source folders.
  await chown(root, 0, WORKER_UID)
  await chmod(root, 0o1770)
  const python = await realpath(config.python)
  const candidates = [
    '/usr', '/bin', '/lib', '/lib64', '/proc', '/etc/fonts', '/etc/ld.so.cache',
    '/etc/localtime', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/mime.types', '/etc/apache2/mime.types',
    '/etc/ssl/openssl.cnf', '/etc/ssl/certs',
    '/sys/devices/system/cpu', '/sys/devices/system/node', '/sys/fs/cgroup',
    '/var/cache/fontconfig', '/dev/urandom', '/dev/random',
    path.dirname(path.dirname(python)), path.dirname(path.dirname(path.resolve(config.python))),
    await realpath(config.skillRoot), root, ...(config.extraReads || []),
    ...(config.browserRoot ? [await realpath(config.browserRoot)] : []),
  ]
  const read = []
  for (const candidate of candidates) {
    const actual = await realpath(candidate).catch(() => null)
    if (actual && !read.includes(actual)) read.push(actual)
  }
  if (config.renderPort && (!Number.isInteger(config.renderPort) || !config.browserRoot || config.renderPort < 1024 || config.renderPort > 65535)) {
    throw new ProjectError('云端截图沙箱参数无效。', 503)
  }
  return {
    command: process.env.PPT_LINUX_SANDBOX || '/usr/local/bin/ppt-sandbox',
    args: [JSON.stringify({ read, write: [root, '/dev/null'], port: config.renderPort || 0 }), config.python, ...args],
    uid: WORKER_UID, gid: WORKER_UID,
  }
}
