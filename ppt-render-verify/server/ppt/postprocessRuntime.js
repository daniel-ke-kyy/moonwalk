import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, lstat, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthoringRuntime } from './authoringRuntime.js'
import { confined } from './nativeRuntime.js'
import { sandboxRun } from './localSandbox.js'
import { ProjectError } from './projectStore.js'
import { reviewerIdentity } from './visualReview.js'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const notesValidation = fileURLToPath(new URL('./notesValidation.py', import.meta.url))

export class PostprocessRuntime extends AuthoringRuntime {
  verifyVisualReview(record, fingerprint) {
    if (!record.visualReview) return
    const review = record.review
    if (review?.status !== 'passed' || review.fingerprint !== fingerprint || review.identity !== reviewerIdentity(record)
      || !Array.isArray(review.pages) || review.pages.length !== record.production?.slideCount
      || new Set(review.pages.map((page) => page.page)).size !== review.pages.length
      || review.pages.some((page) => !['ok', 'fixed'].includes(page.status))) throw new ProjectError('自动视觉审查尚未通过或文件已变化，不能跳过审查导出终稿。', 409)
  }
  config(record) {
    const config = super.config(record)
    return { ...config, extraReads: [...config.extraReads, notesValidation] }
  }
  async prepare(record, signal) {
    await super.prepare(record, signal)
    for (const name of ['notes', 'exports']) {
      const target = path.join(this.native.projectPath(record), name)
      await mkdir(target, { recursive: true, mode: 0o700 })
      if (!(await lstat(target)).isDirectory()) throw new ProjectError('后处理目录无效。')
    }
  }

  async write(record, relative, content) {
    if (relative === 'animations.json') JSON.parse(content)
    return super.write(record, relative, content, { postprocess: true })
  }

  async tool(record, name, input = '', signal) {
    const project = this.native.projectPath(record)
    let script, args
    if (name === 'validate_notes') {
      const result = await sandboxRun(this.config(record), [notesValidation, this.native.skillRoot, project], { signal })
      return { code: result.code, output: result.output, diagnostic: result.error }
    }
    if (name === 'animation_groups') { script = 'animation_config.py'; args = ['list-groups', project] }
    else if (name === 'animation_validate') { script = 'animation_config.py'; args = ['validate', project] }
    else if (['describe_effect', 'describe_transition'].includes(name)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/.test(input)) throw new ProjectError('动画名称无效。')
      script = 'pptx_animations.py'; args = [name === 'describe_effect' ? '--describe' : '--describe-transition', input]
    } else if (name === 'split_notes') { script = 'total_md_split.py'; args = [project] }
    else if (name === 'finalize') { script = 'finalize_svg.py'; args = [project] }
    else return super.tool(record, name, input, signal)
    const result = await sandboxRun(this.config(record), [path.join(this.native.skillRoot, 'scripts', script), ...args], { signal })
    return { code: result.code, output: result.output.slice(-20000), diagnostic: result.error }
  }

  async releaseSnapshot(record) {
    const root = this.native.projectPath(record)
    const hashes = await this.snapshot(record)
    const visit = async (relative) => {
      const target = path.join(root, relative)
      const info = await lstat(target).catch((error) => { if (error.code !== 'ENOENT') throw error })
      if (!info) return
      if (info.isSymbolicLink()) throw new ProjectError('制作资源不能是符号链接。')
      if (info.isDirectory()) {
        for (const name of (await readdir(target)).sort()) await visit(`${relative}/${name}`)
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size > 50 * 1024 * 1024) throw new ProjectError('制作资源类型或大小无效。')
        hashes[relative] = hash(await readFile(await confined(root, relative)))
      }
    }
    // Per-slide notes are deterministic export outputs, not review inputs.
    for (const directory of ['notes/total.md', 'icons', 'images', 'animations.json']) await visit(directory)
    return hash(JSON.stringify(hashes))
  }

  async finishPreparation(record, motion, signal) {
    const receipt = await this.verifyConfirmation(record)
    const quality = await super.finish(record, signal)
    if (!quality.accepted) return quality
    const root = this.native.projectPath(record)
    const notesEnabled = receipt.proactive_speaker_notes !== false || receipt.proactive_narration_audio === true
    if (notesEnabled) {
      if (!await stat(path.join(root, 'notes/total.md')).catch(() => null)) throw new ProjectError('已确认需要讲稿，但完整讲稿尚未生成。', 409)
      const checked = await this.tool(record, 'validate_notes', '', signal)
      if (checked.code !== 0) return { accepted: false, ...checked }
    }
    const hasAnimations = Boolean(await stat(path.join(root, 'animations.json')).catch(() => null))
    if (hasAnimations) {
      const animation = await this.tool(record, 'animation_validate', '', signal)
      if (animation.code !== 0) return { accepted: false, ...animation }
    }
    if (!motion || !['sidecar', 'native-default'].includes(motion.mode) || typeof motion.reason !== 'string' || !motion.reason.trim()) throw new ProjectError('必须说明原生动画处理结果，不能默默跳过。', 409)
    if ((motion.mode === 'sidecar') !== hasAnimations) throw new ProjectError('动画处理说明与实际动画文件不一致。', 409)
    return { accepted: true, slideCount: quality.slideCount, warnings: quality.warnings,
      notes: notesEnabled ? 'complete' : 'disabled', motion, fingerprint: await this.releaseSnapshot(record),
      visualReview: record.visualReview ? 'pending' : 'disabled', exportReady: false }
  }

  async export(record, signal) {
    const receipt = await this.verifyConfirmation(record)
    const fingerprint = await this.releaseSnapshot(record)
    if (!record.production?.accepted || fingerprint !== record.production.fingerprint) throw new ProjectError('页面或素材已变化，需重新完成后处理后再导出。', 409)
    this.verifyVisualReview(record, fingerprint)
    if (receipt.proactive_narration_audio) throw new ProjectError('已确认需要旁白音频，该原生能力尚未接通，不能将无旁白文件作为终稿。', 409)
    const preparation = await this.finishPreparation(record, record.production.motion, signal)
    if (!preparation.accepted) throw new ProjectError('导出前原生检查未通过，请回到后处理阶段。', 409)
    if (fingerprint !== preparation.fingerprint) throw new ProjectError('导出前文件发生变化，需重新审查。', 409)
    if (preparation.notes === 'complete') {
      const split = await this.tool(record, 'split_notes', '', signal)
      if (split.code !== 0) throw new ProjectError('原生逐页讲稿整理失败，不能导出。', 409)
    }
    const finalized = await this.tool(record, 'finalize', '', signal)
    if (finalized.code !== 0) throw new ProjectError(`原生预览整合失败：${finalized.diagnostic || finalized.output}`.slice(0, 2500), 502)
    const project = this.native.projectPath(record)
    const stem = `moonwalk_${Date.now()}`
    const output = path.join(project, 'exports', `${stem}.pptx`)
    const args = [path.join(this.native.skillRoot, 'scripts/svg_to_pptx.py'), project, '-o', output, '--native-charts-and-tables']
    if (preparation.notes === 'disabled') args.push('--no-notes')
    if (receipt.proactive_custom_animations === false) args.push('-a', 'none')
    const result = await sandboxRun(this.config(record), args, { signal, timeout: 180000 })
    if (result.code !== 0) throw new ProjectError(`原生 PPTX 导出失败：${result.error || result.output}`.slice(-2500), 502)
    const report = await this.native.readProject(record, `validation/${stem}.report.json`)
    if (report.schema !== 'ppt-master.pptx-postflight-report.v1' || !['passed', 'passed-with-warnings'].includes(report.status)
      || report.checks?.quality_gate !== 'passed' || report.checks?.zip_integrity !== 'passed'
      || report.checks?.slide_count !== 'passed' || report.package?.slides !== preparation.slideCount) {
      throw new ProjectError('PPTX 文件未通过原生导出检查，暂不可下载。', 409)
    }
    const target = await confined(project, `exports/${stem}.pptx`)
    const info = await stat(target)
    if (!info.size || await this.releaseSnapshot(record) !== fingerprint) throw new ProjectError('导出产物为空或制作文件已变化。', 409)
    return { file: `${stem}.pptx`, report: `${stem}.report.json`, bytes: info.size,
      sha256: hash(await readFile(target)), fingerprint, status: report.status,
      slideCount: preparation.slideCount, visualReview: record.visualReview ? 'passed' : 'disabled' }
  }

  async download(record) {
    if (record.status !== 'complete' || !record.artifact) throw new ProjectError('终稿尚未就绪。', 409)
    const artifact = record.artifact
    if (!/^moonwalk_\d+\.pptx$/.test(artifact.file) || await this.releaseSnapshot(record) !== artifact.fingerprint) throw new ProjectError('制作文件已变化，旧终稿不可下载。', 409)
    this.verifyVisualReview(record, artifact.fingerprint)
    const file = await confined(this.native.projectPath(record), `exports/${artifact.file}`)
    const info = await lstat(file)
    if (!info.isFile() || info.nlink !== 1 || info.size !== artifact.bytes || info.size > 200 * 1024 * 1024) throw new ProjectError('终稿文件无效，请重新导出。', 409)
    const content = await readFile(file)
    if (hash(content) !== artifact.sha256) throw new ProjectError('终稿文件校验失败，请重新导出。', 409)
    return { name: artifact.file, content }
  }
}
