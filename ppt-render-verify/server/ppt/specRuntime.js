import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandboxRun } from './localSandbox.js'
import { ProjectError } from './projectStore.js'

const bridge = fileURLToPath(new URL('./specBridge.py', import.meta.url))
export const specHash = (value) => createHash('sha256').update(value).digest('hex')
export const specEntryStates = ['planning_complete', 'draft_ready', 'review_needs_human', 'complete', 'ready_to_export', 'edits_pending']

export function specChanges(before, after) {
  const previous = new Map((before?.blocks || []).map((block) => [block.key, block]))
  const changed = after.blocks.filter((block) => previous.get(block.key)?.text !== block.text)
  const removed = (before?.blocks || []).filter((block) => !after.blocks.some((item) => item.key === block.key))
  const structural = removed.length || after.blocks.filter((b) => b.kind === 'slide').length !== (before?.blocks || []).filter((b) => b.kind === 'slide').length
  // Global decisions may affect every slide; local changes preserve the other SVGs.
  const global = !before || Boolean(structural) || changed.some((b) => b.kind !== 'slide')
  return { global, changed: [...changed, ...removed].map(({ key, title }) => ({ key, title })),
    pages: after.blocks.filter((b) => b.kind === 'slide' && (global || changed.includes(b))).map((b) => Number(b.key.split(':')[1])),
    pageCount: after.blocks.filter((b) => b.kind === 'slide').length }
}

export class SpecRuntime {
  constructor(authoring) { this.authoring = authoring; this.native = authoring.native }
  async call(record, payload, signal) {
    const project = this.native.projectPath(record)
    await mkdir(path.join(project, 'spec_review'), { recursive: true, mode: 0o700 })
    const result = await sandboxRun({ ...this.authoring.config(record), specReview: true, extraReads: [bridge] },
      [bridge, this.native.skillRoot, project], { signal, input: JSON.stringify(payload), timeout: 30000 })
    if (result.code) throw new ProjectError('完整规范审阅工具执行失败，文件已保留。', 502)
    return JSON.parse(result.output)
  }
  async inspect(record, signal) { return this.call(record, { action: 'inspect' }, signal) }
  async prepare(record, signal) { await this.authoring.prepare(record, signal) }
  async begin(record) {
    const id = randomBytes(16).toString('hex')
    const baseline = await this.inspect(record).catch(async (error) => {
      // A missing spec is valid only before initial authoring.
      try { await readFile(path.join(this.native.projectPath(record), 'design_spec.md')) } catch (missing) { if (missing.code === 'ENOENT') return null }
      throw error
    })
    const directory = path.join(this.native.store.directory(record.id), `spec-${id}`)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(path.join(directory, 'baseline.json'), JSON.stringify(baseline), { mode: 0o600 })
    return { id, status: baseline ? 'reviewing' : 'drafting', previousStatus: record.status, createdAt: Date.now() }
  }
  async summary(record) {
    const current = await this.inspect(record)
    const baseline = JSON.parse(await readFile(path.join(this.native.store.directory(record.id), `spec-${record.specReview.id}`, 'baseline.json'), 'utf8'))
    const changes = specChanges(record.specReview.forceGlobal ? null : baseline, current)
    return { sha256: current.sha256, drafts: current.drafts, annotations: current.annotations.length,
      unreadEdits: current.unreadEdits, errors: current.errors, ...changes }
  }
  async approve(record, sha256) {
    const summary = await this.summary(record)
    if (sha256 !== summary.sha256) throw new ProjectError('规范已变化，请重新核对当前版本。', 409)
    if (summary.drafts.length || summary.annotations || summary.unreadEdits) throw new ProjectError('还有未应用的草稿、批注或未复核的直接编辑，请先处理再确认。', 409)
    if (summary.errors.length || !summary.pageCount || summary.pageCount > 100) throw new ProjectError('规范尚未通过原生格式检查，或页数不在 1–100 页范围内。', 409)
    const spec = await this.inspect(record)
    const fields = Object.values(spec.fields || {})[0] || {}
    const enabled = (key, fallback) => {
      const value = String(fields[key] || '').toLowerCase()
      if (value.startsWith('enabled')) return true
      if (value.startsWith('disabled')) return false
      return fallback
    }
    const original = await this.authoring.verifyConfirmation(record)
    const imagePath = String(fields['AI Image Acquisition Path'] || '').trim().toLowerCase()
    // Native table values may append an explanation after the selected value.
    const noImages = /^(?:not applicable|none|n\/a)(?:$|\s*[;；—(（])/.test(imagePath)
    if (spec.imageRows?.length || (imagePath && !noImages)) throw new ProjectError('规范要求图片素材制作，该原生分支尚未接通，请先调整素材要求。', 409)
    const options = {
      proactive_speaker_notes: enabled('Speaker Notes', original.proactive_speaker_notes),
      proactive_custom_animations: enabled('Custom Animations', original.proactive_custom_animations),
      proactive_narration_audio: enabled('Narration Audio', original.proactive_narration_audio),
    }
    if (options.proactive_narration_audio || (fields['Generation Mode'] && fields['Generation Mode'] !== 'continuous')) throw new ProjectError('此规范要求的旁白或分段制作尚未接通，请调整规范后再确认。', 409)
    return { id: record.specReview.id, sha256, confirmedAt: Date.now(), ...summary,
      options,
      // Separate from the immutable original two confirmation receipts.
      text: spec.text }
  }
  async resetGeneration(record) {
    const directory = path.join(this.native.store.directory(record.id), `spec-${record.specApproval.id}`)
    const marker = path.join(directory, 'reset-complete')
    if (await readFile(marker).catch(() => null)) return
    const root = this.native.projectPath(record)
    // Keep a complete recoverable baseline before deleting derived artifacts.
    const backup = path.join(directory, 'generation-backup')
    await mkdir(backup, { recursive: true })
    for (const name of ['svg_output', 'spec_lock.md', 'notes', 'animations.json', 'svg_final', 'exports', 'validation']) {
      try { await cp(path.join(root, name), path.join(backup, name), { recursive: true, force: false, errorOnExist: false }) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const selected = new Set(record.specApproval.pages)
    for (const name of await readdir(path.join(root, 'svg_output'))) {
      if (name.endsWith('.svg') && (record.specApproval.global || selected.has(Number(name.split('_')[0])))) await rm(path.join(root, 'svg_output', name))
    }
    for (const name of ['spec_lock.md', 'animations.json', 'notes', 'svg_final', 'exports', 'validation']) await rm(path.join(root, name), { recursive: true, force: true })
    await mkdir(path.join(root, 'validation'), { recursive: true })
    for (const name of ['authoring-checkpoint.json', 'postprocess-checkpoint.json', 'visual-checkpoint.json']) await rm(path.join(this.native.store.directory(record.id), name), { force: true })
    await writeFile(marker, 'ready', { mode: 0o600 })
  }
}
