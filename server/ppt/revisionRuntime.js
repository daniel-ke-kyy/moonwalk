import { randomBytes } from 'node:crypto'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PostprocessRuntime } from './postprocessRuntime.js'
import { sandboxRun } from './localSandbox.js'
import { ProjectError } from './projectStore.js'

const bridge = fileURLToPath(new URL('./revisionBridge.py', import.meta.url))
export const revisionStates = ['review_needs_human', 'complete', 'edits_pending']

export class RevisionRuntime extends PostprocessRuntime {
  config(record) {
    const config = super.config(record)
    return { ...config, previewWrite: true, extraReads: [...config.extraReads, bridge] }
  }
  stateFile(record) { return path.join(this.native.store.directory(record.id), 'revision-transaction.json') }
  async saveTransaction(record, transaction) {
    const file = this.stateFile(record), temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(transaction), { mode: 0o600 })
    await rename(temporary, file)
  }
  async transaction(record) {
    return readFile(this.stateFile(record), 'utf8').then(JSON.parse).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
  }
  async annotations(record, action = 'scan', items = []) {
    const result = await sandboxRun(this.config(record), [bridge, this.native.skillRoot, this.native.projectPath(record)], {
      input: JSON.stringify({ action, items, revisionId: record.revision?.id }),
    })
    if (result.code) throw new ProjectError('原生批注读取或保存失败，未放行修改。', 409)
    return JSON.parse(result.output)
  }
  async inputs(record) {
    const hashes = await this.snapshot(record)
    const pages = Object.keys(hashes).filter((file) => file.startsWith('svg_output/')).map((file) => path.basename(file))
    const pending = await this.annotations(record)
    const annotations = Object.entries(pending).flatMap(([page, entries]) => entries.map((entry) => ({
      page, elementId: entry.element_id, instruction: entry.annotation, origin: 'annotation',
    })))
    return { pages, annotations, fingerprint: await this.releaseSnapshot(record) }
  }
  async begin(record) {
    const revision = record.revision
    if (!revision?.confirmedAt || revision.status !== 'confirmed') throw new ProjectError('修改尚未由用户确认。', 409)
    const transaction = await this.transaction(record)
    if (transaction?.id === revision.id && transaction.status === 'committed') {
      if (transaction.outcome.fingerprint !== await this.releaseSnapshot(record)) throw new ProjectError('已修订文件发生变化，不能复用旧结果。', 409)
      await this.annotations(record, 'log', revision.items.filter((item) => item.origin === 'annotation'))
      await this.clearCaches(record)
      return transaction.outcome
    }
    await this.rollback(record)
    if (await this.releaseSnapshot(record) !== revision.fingerprint) throw new ProjectError('页面已变化，请重新提交并确认修改。', 409)
    const files = [...new Set(revision.items.map((item) => `svg_output/${item.page}`)), 'notes/total.md', 'animations.json']
    const backup = {}
    for (const name of files) backup[name] = await readFile(path.join(this.native.projectPath(record), name), 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    await this.saveTransaction(record, { id: revision.id, status: 'pending', backup, touched: [], hashes: await this.snapshot(record) })
    return null
  }
  async rollback(record) {
    const transaction = await this.transaction(record)
    if (!transaction || transaction.status !== 'pending') return
    for (const [name, content] of Object.entries(transaction.backup)) {
      if (content === null) await rm(path.join(this.native.projectPath(record), name), { force: true })
      else await super.write(record, name, content)
    }
    await this.saveTransaction(record, { ...transaction, status: 'rolled_back' })
  }
  async write(record, relative, content) {
    const permitted = new Set(record.revision.items.map((item) => `svg_output/${item.page}`))
    if (!permitted.has(relative) && !['notes/total.md', 'animations.json'].includes(relative)) throw new ProjectError('只能修改已确认的页面及配套讲稿、动画；大纲和设计规范保持锁定。', 409)
    const transaction = await this.transaction(record)
    if (transaction?.id !== record.revision.id || transaction.status !== 'pending') throw new ProjectError('修订事务未就绪。', 409)
    const output = await super.write(record, relative, content)
    if (content !== transaction.backup[relative]) {
      transaction.touched = [...new Set([...transaction.touched, relative])]
      await this.saveTransaction(record, transaction)
    }
    return output
  }
  async replace(record, relative, before, after) {
    if (typeof before !== 'string' || !before || typeof after !== 'string') throw new ProjectError('请提供非空、精确的原文和替换内容。')
    const permitted = new Set(record.revision.items.map((item) => `svg_output/${item.page}`))
    if (!permitted.has(relative) && !['notes/total.md', 'animations.json'].includes(relative)) throw new ProjectError('只能替换已确认页面及其讲稿、动画。', 409)
    const current = await readFile(path.join(this.native.projectPath(record), relative), 'utf8')
    if (current.split(before).length !== 2) throw new ProjectError('原文必须在当前文件中精确匹配一次，请重新读取文件。', 409)
    return this.write(record, relative, current.replace(before, () => after))
  }
  async tool(record, name, input = '', signal) {
    if (name === 'check_annotations') return { code: 0, annotations: await this.annotations(record) }
    return super.tool(record, name, input, signal)
  }
  async finishRevision(record, motion, signal) {
    const transaction = await this.transaction(record)
    if (!record.revision.items.every((item) => transaction.touched.includes(`svg_output/${item.page}`))) throw new ProjectError('仍有已确认页面未完成修改。', 409)
    const targets = new Set(record.revision.items.map((item) => `svg_output/${item.page}`))
    const current = await this.snapshot(record)
    if (Object.keys(current).length !== Object.keys(transaction.hashes).length || Object.entries(transaction.hashes).some(([file, hash]) => !targets.has(file) && current[file] !== hash)) throw new ProjectError('非目标页面或已确认规范发生变化，修订不能通过。', 409)
    const annotations = record.revision.items.filter((item) => item.origin === 'annotation')
    await this.annotations(record, 'clear', annotations)
    const pending = await this.annotations(record)
    if (Object.keys(pending).length) throw new ProjectError('仍有未处理的原生批注，不能结束修订。', 409)
    const result = await this.finishPreparation(record, motion, signal)
    if (!result.accepted) return result
    return result
  }
  async commit(record, outcome) {
    const transaction = await this.transaction(record)
    if (outcome.fingerprint !== await this.releaseSnapshot(record)) throw new ProjectError('修订检查后页面发生变化。', 409)
    await this.saveTransaction(record, { ...transaction, status: 'committed', outcome })
    await this.annotations(record, 'log', record.revision.items.filter((item) => item.origin === 'annotation'))
    await this.clearCaches(record)
    return outcome
  }
  async clearCaches(record) {
    // A new, explicitly confirmed revision starts a new bounded review cycle.
    // Ordinary retries keep their budgets; the prior report is retained in project history.
    await rm(path.join(this.native.store.directory(record.id), 'visual-checkpoint.json'), { force: true })
    await rm(path.join(this.native.projectPath(record), '.worker-tmp/preview-annotations.json'), { force: true })
  }
}
