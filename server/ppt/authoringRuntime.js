import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, lstat, realpath, rm, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ProjectError } from './projectStore.js'
import { confined } from './nativeRuntime.js'
import { checkLocalSandbox, sandboxRun } from './localSandbox.js'

const previewBridge = fileURLToPath(new URL('./previewBridge.py', import.meta.url))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const writable = /^(design_spec\.md|spec_lock\.md|svg_output\/[0-9]{2,3}_[^/\\.]+\.svg)$/u

export function validateSvgInput(content) {
  if (/<!DOCTYPE|<!ENTITY/i.test(content) || XMLValidator.validate(content) !== true) throw new ProjectError('SVG 必须是不含 DTD 的有效 XML。')
  const tree = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false }).parse(content)
  if (!Object.hasOwn(tree, 'svg')) throw new ProjectError('文件必须包含 SVG 根元素。')
  function visit(node) {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (/^(?:.*:)?(script|foreignObject|iframe|object|embed|style|animate|set)$/i.test(key) || /^@_(?:.*:)?on/i.test(key)) throw new ProjectError('SVG 包含不允许执行的网页内容。')
      if (/^@_(?:.*:)?href$/i.test(key) && !/^#[\w.-]+$/.test(String(value))) throw new ProjectError('此制作阶段不允许外部 SVG 引用。')
      if (typeof value === 'string' && /url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) throw new ProjectError('SVG 不允许外部资源 URL。')
      visit(value)
    }
  }
  visit(tree)
}

export class AuthoringRuntime {
  constructor(native) { this.native = native }
  config(record) {
    return { python: this.native.python, skillRoot: this.native.skillRoot,
      project: this.native.projectPath(record), storeRoot: this.native.store.root, extraReads: [previewBridge] }
  }
  async verifyConfirmation(record) {
    const final = record.confirmations.find((item) => item.stage === 2)
    const receipt = await this.native.readProject(record, 'confirm_ui/result.json')
    if (!final || receipt.status !== 'confirmed' || digest(JSON.stringify(receipt)) !== final.sha256) {
      throw new ProjectError('最终确认记录缺失或发生变化，未开始制作。', 409)
    }
    if (record.specApproval && record.specReview?.status === 'approved') {
      const current = await readFile(await confined(this.native.projectPath(record), 'design_spec.md'))
      if (digest(current) !== record.specApproval.sha256) throw new ProjectError('已确认的完整规范发生变化，必须重新审阅确认。', 409)
      return { ...receipt, ...record.specApproval.options, page_count: String(record.specApproval.pageCount), refine_spec: false }
    }
    return receipt
  }
  async prepare(record, signal) {
    await this.verifyConfirmation(record)
    const project = this.native.projectPath(record)
    for (const name of ['svg_output', 'icons', 'validation', '.worker-tmp']) {
      const target = path.join(project, name)
      await mkdir(target, { recursive: true, mode: 0o700 })
      if ((await lstat(target)).isSymbolicLink()) throw new ProjectError('制作目录无效。')
    }
    await checkLocalSandbox(this.config(record))
    signal.throwIfAborted()
    const preview = await this.preview(record, '/api/health', signal)
    if (preview.status !== 200) throw new ProjectError('原生实时预览未能启动，制作已暂停。', 503)
    for (const endpoint of ['/', '/static/app.js', '/static/style.css']) {
      if ((await this.preview(record, endpoint, signal)).status !== 200) throw new ProjectError('原生预览资源加载失败，未开始制作。', 503)
    }
  }
  async write(record, relative, content, { postprocess = false } = {}) {
    if (record.specApproval && record.specReview?.status === 'approved') {
      if (relative === 'design_spec.md') throw new ProjectError('完整规范已经确认，制作阶段不可再修改。', 409)
      if (!postprocess && relative.startsWith('svg_output/') && !record.specApproval.global && !record.specApproval.pages.includes(Number(path.basename(relative).split('_')[0]))) throw new ProjectError('此页面不在已确认的规范修改范围内。', 409)
    }
    const allowed = postprocess ? /^(notes\/total\.md|animations\.json|svg_output\/[0-9]{2,3}_[^/\\.]+\.svg)$/u : writable
    if (!allowed.test(relative) || typeof content !== 'string' || Buffer.byteLength(content) > 512000) throw new ProjectError('不允许写入此制作文件，或文件超过 500KB。')
    if (relative.endsWith('.svg')) validateSvgInput(content)
    const root = await realpath(this.native.projectPath(record))
    const parent = await confined(root, path.dirname(relative))
    const target = path.join(parent, path.basename(relative))
    const existing = await lstat(target).catch(() => null)
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new ProjectError('制作文件必须是普通文件。')
    const temporary = path.join(parent, `.${path.basename(relative)}-${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }) }
    return { written: relative, sha256: digest(content) }
  }
  async tool(record, name, input = '', signal) {
    const project = this.native.projectPath(record)
    let script, args = [], stdin
    if (name === 'validate') { script = 'project_manager.py'; args = ['validate', project] }
    else if (name === 'calibrate') { script = 'text_measure.py'; args = ['calibrate', project, '--outline'] }
    else if (['check_early', 'check_final'].includes(name)) {
      script = 'svg_quality_checker.py'; args = [project, '--canonical-authoring', '--stage', name === 'check_final' ? 'final' : 'early', '--json']
      await rm(path.join(project, 'validation', name === 'check_final' ? 'svg_quality_report.json' : 'svg_quality_early_report.json'), { force: true })
    } else if (name === 'prepare_icons') {
      const icons = JSON.parse(input)
      if (!Array.isArray(icons) || !icons.length || icons.length > 40 || icons.some((icon) => typeof icon !== 'string' || !/^[a-z0-9-]+\/[a-zA-Z0-9_-]+$/.test(icon))) throw new ProjectError('图标参数必须是原生 library/name 列表。')
      script = 'icon_sync.py'; args = [project, ...icons]
    } else if (name === 'describe_shape') {
      if (!/^[A-Za-z][A-Za-z0-9]{0,80}$/.test(input)) throw new ProjectError('请提供原生预设形状名称。')
      script = 'preset_shape_svg.py'; args = ['describe', input, '--compact']
    } else if (name === 'preset_shapes') {
      JSON.parse(input)
      script = 'preset_shape_svg.py'; args = ['render-batch', '--input', '-']; stdin = input
    } else if (name === 'stamp_native_fallbacks') {
      if (!/^svg_output\/[0-9]{2,3}_[^/\\.]+\.svg$/u.test(input)) throw new ProjectError('请选择当前项目的一张 SVG 页面。')
      if (record.specApproval && record.specReview?.status === 'approved' && !record.specApproval.global
        && !record.specApproval.pages.includes(Number(path.basename(input).split('_')[0]))) throw new ProjectError('此页面不在已确认的规范修改范围内。', 409)
      const target = await confined(project, input)
      const info = await lstat(target)
      if (!info.isFile() || info.nlink !== 1) throw new ProjectError('制作文件必须是普通文件。')
      script = 'stamp_native_fallbacks.py'; args = [target, '--write']
    } else throw new ProjectError('当前阶段不支持此工具，不能使用替代流程跳过。', 409)
    const result = await sandboxRun(this.config(record), [path.join(this.native.skillRoot, 'scripts', script), ...args], { signal, input: stdin })
    return { code: result.code, output: result.output.slice(-20000), diagnostic: result.error }
  }
  async preview(record, endpoint, signal, { method = 'GET', body, editable = false } = {}) {
    const result = await sandboxRun({ ...this.config(record), previewWrite: editable }, [previewBridge, this.native.skillRoot, this.native.projectPath(record)], {
      signal, input: JSON.stringify({ path: endpoint, method, body, editable }), timeout: 30000,
    })
    if (result.code) throw new ProjectError('原生预览读取失败，请检查制作运行环境。', 502)
    const response = JSON.parse(result.output)
    if (response.status >= 500) throw new ProjectError(`原生预览服务出错：${result.error.slice(-1200) || '请检查运行环境后重试。'}`, 502)
    return { ...response, body: Buffer.from(response.body, 'base64') }
  }
  async snapshot(record) {
    const root = this.native.projectPath(record)
    const files = ['design_spec.md', 'spec_lock.md', ...(await readdir(path.join(root, 'svg_output'))).filter((x) => x.endsWith('.svg')).sort().map((x) => `svg_output/${x}`)]
    const hashes = {}
    for (const name of files) hashes[name] = digest(await readFile(await confined(root, name)))
    return hashes
  }
  async finish(record, signal) {
    const receipt = await this.verifyConfirmation(record)
    const before = await this.snapshot(record)
    const count = Object.keys(before).filter((name) => name.endsWith('.svg')).length
    if (!count) throw new ProjectError('尚未生成任何幻灯片。', 409)
    const fixedCount = /^\d+$/.test(String(receipt.page_count)) ? Number(receipt.page_count) : null
    if (fixedCount !== null && count !== fixedCount) throw new ProjectError(`已确认 ${fixedCount} 页，当前只有 ${count} 页，不能标记初稿完成。`, 409)
    const validation = await this.tool(record, 'validate', '', signal)
    if (validation.code) return { accepted: false, ...validation }
    const checked = await this.tool(record, 'check_final', '', signal)
    const report = await this.native.readProject(record, 'validation/svg_quality_report.json').catch(() => null)
    if (checked.code || !report || report.stage !== 'final' || report.categories?.blocking?.count !== 0 || report.files?.length !== count) {
      return { accepted: false, ...checked, issues: report?.categories }
    }
    if (JSON.stringify(before) !== JSON.stringify(await this.snapshot(record))) throw new ProjectError('页面在检查过程中发生变化，请重新检查。', 409)
    return { accepted: true, slideCount: count, hashes: before, warnings: report.categories.introduced.count,
      visualReview: record.visualReview ? 'pending' : 'disabled', exportReady: false }
  }
}
