import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, realpath, stat, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ProjectError } from './projectStore.js'
import { sandboxRun } from './localSandbox.js'

import { NATIVE_REVISION } from './nativeRevision.js'
export { NATIVE_REVISION } from './nativeRevision.js'
const bridge = fileURLToPath(new URL('./nativeBridge.py', import.meta.url))

export async function confined(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new ProjectError('工具路径越界。')
  }
  const base = await realpath(root)
  const target = await realpath(path.join(base, relative))
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new ProjectError('工具路径越界。')
  return target
}

export function runProcess(command, args, { cwd, input, signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, signal, timeout, killSignal: 'SIGKILL',
      // Native utilities must not inherit website/API credentials.
      env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1', HOME: cwd, TMPDIR: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = [], stderr = []
    let size = 0
    child.on('error', reject)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) child.kill('SIGKILL')
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => { if (stderr.reduce((sum, x) => sum + x.length, 0) < 16000) stderr.push(chunk) })
    child.on('close', (code) => {
      if (code !== 0 || size > 16 * 1024 * 1024) reject(new ProjectError('PPT-master 工具执行失败，请检查运行环境或上传材料。', 502))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export class NativeRuntime {
  constructor(store, { skillRoot, python }) {
    this.store = store
    this.skillRoot = path.resolve(skillRoot)
    this.python = python
  }

  projectPath(record) {
    const day = new Date(record.createdAt).toISOString().slice(0, 10).replaceAll('-', '')
    return path.join(this.store.directory(record.id), 'workspace', `deck_${day}`)
  }

  async check() {
    const repository = path.resolve(this.skillRoot, '../..')
    const revision = await runProcess('git', ['-C', repository, 'rev-parse', 'HEAD'], { cwd: repository })
    if (revision.trim() !== NATIVE_REVISION) throw new Error('PPT-master revision does not match the validated release')
    const dirty = await runProcess('git', ['-C', repository, 'status', '--porcelain', '--', 'skills/ppt-master'], { cwd: repository })
    if (dirty.trim()) throw new Error('PPT-master distribution has local modifications')
    await runProcess(this.python, [path.join(this.skillRoot, 'scripts/attribution_guard.py')], { cwd: repository })
    await runProcess(this.python, ['-c', 'import flask, fitz, mammoth, markdownify, pptx; import sys; assert sys.version_info >= (3, 10)'], { cwd: repository })
  }

  async command(record, script, args, signal) {
    const cwd = path.join(this.store.directory(record.id), 'workspace')
    if (process.platform === 'linux') return this.isolated(record, [path.join(this.skillRoot, 'scripts', script), ...args], { signal })
    return runProcess(this.python, [path.join(this.skillRoot, 'scripts', script), ...args], { cwd, signal })
  }

  async isolated(record, args, options = {}) {
    const result = await sandboxRun({ python: this.python, skillRoot: this.skillRoot,
      storeRoot: this.store.root, project: path.join(this.store.directory(record.id), 'workspace'),
      planning: true, extraReads: [bridge] }, args, { timeout: 120000, ...options })
    if (result.code) throw new ProjectError(`PPT-master 云端工具未完成：${result.error.slice(-1400)}`, 502)
    return result.output
  }

  async prepare(record, signal) {
    const project = this.projectPath(record)
    if (!await stat(project).catch(() => null)) {
      await this.command(record, 'project_manager.py', ['init', path.basename(project), '--dir', path.dirname(project)], signal)
    }
    for (const file of record.files) {
      const source = await confined(path.join(path.dirname(project), 'sources'), file.name)
      const markdown = path.join(project, 'sources', path.parse(file.name).name + '.md')
      if (!await stat(markdown).catch(() => null)) {
        await this.command(record, 'project_manager.py', ['import-sources', project, source], signal)
        if (!await stat(markdown).catch(() => null)) throw new ProjectError(`PPT-master 未能读取材料：${file.originalName}`, 422)
      }
    }
    await writeFile(path.join(project, 'sources', 'user-brief.md'), record.prompt, { mode: 0o600 })
    return project
  }

  async request(record, request, signal) {
    const cwd = path.join(this.store.directory(record.id), 'workspace')
    const args = [bridge, this.skillRoot, this.projectPath(record)]
    const options = { cwd, input: JSON.stringify(request), signal, timeout: 30000 }
    const result = JSON.parse(await (process.platform === 'linux'
      ? this.isolated(record, args, options) : runProcess(this.python, args, options)))
    return { ...result, body: Buffer.from(result.body, 'base64') }
  }

  async json(record, endpoint, signal) {
    const response = await this.request(record, { path: endpoint }, signal)
    if (response.status !== 200) throw new ProjectError('原生确认页面尚未就绪。', 409)
    return JSON.parse(response.body)
  }

  async readProject(record, relative) {
    return JSON.parse(await readFile(await confined(this.projectPath(record), relative), 'utf8'))
  }

  async installSelected(record, signal) {
    const selection = await this.readProject(record, 'confirm_ui/template_selection.json')
    if (selection.mode === 'free_design') return
    const roots = []
    for (const item of selection.selections || []) {
      const relative = path.relative(this.skillRoot, item.workspace_root)
      const root = await confined(this.skillRoot, relative)
      if (!root.startsWith(path.join(this.skillRoot, 'templates') + path.sep)) throw new ProjectError('模板来源不在已安装的原生模板库中。')
      roots.push(root)
    }
    if (!roots.length) throw new ProjectError('未找到已确认的模板。')
    await this.command(record, 'apply_template.py', [this.projectPath(record), ...[...new Set(roots)].flatMap((root) => ['--root', root])], signal)
  }

  async list(record, scope, relative) {
    const root = scope === 'skill' ? this.skillRoot : this.projectPath(record)
    const entries = await readdir(await confined(root, relative), { withFileTypes: true })
    return entries.slice(0, 300).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
  }

  async read(record, scope, relative, offset = 0) {
    if (!/\.(md|json|txt|csv|yaml|yml|svg)$/.test(relative)) throw new ProjectError('只允许读取项目资料或原生文档。')
    if (!['skill', 'project'].includes(scope)) throw new ProjectError('无效的读取范围。')
    const root = scope === 'skill' ? this.skillRoot : this.projectPath(record)
    const file = await confined(root, relative)
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new ProjectError('文件过大，请选择更小的资料。')
    const text = await readFile(file, 'utf8')
    const start = Number.isInteger(offset) && offset >= 0 ? offset : 0
    return { text: text.slice(start, start + 14000), nextOffset: start + 14000 < text.length ? start + 14000 : null }
  }

  async recommend(record, stage, value, signal) {
    const recommendation = JSON.parse(value)
    if (!recommendation || typeof recommendation !== 'object' || Array.isArray(recommendation)) throw new ProjectError('建议内容必须是 JSON 对象。')
    recommendation.stage = `stage${stage}`
    if (stage === 1) {
      recommendation.template_options = { schema_version: 1, phase: 'template', lang: 'zh', default_mode: 'free_design', explicit_workspace_roots: [] }
    } else {
      const selection = await this.readProject(record, 'confirm_ui/template_selection.json')
      recommendation.selection_sha256 = selection.selection_sha256
    }
    const directory = path.join(this.projectPath(record), 'confirm_ui')
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, `recommendations.stage${stage}.json`)
    await writeFile(`${target}.tmp`, JSON.stringify(recommendation), { mode: 0o600 })
    await rename(`${target}.tmp`, target)
    const response = await this.request(record, { path: '/api/recommendations' }, signal)
    const health = await this.json(record, '/api/health', signal)
    if (response.status !== 200 || health.session.status !== 'ready_user') {
      throw new ProjectError(`原生建议校验未通过：${JSON.stringify(health.session).slice(0, 2500)}`, 422)
    }
    return { accepted: true, waitingFor: `stage${stage}` }
  }
}
