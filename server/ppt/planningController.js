import { createHash, randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { ProjectError, RETENTION_MS } from './projectStore.js'
import { planStage } from './planningAgent.js'
import { authorPages } from './authoringAgent.js'
import { postprocessPages } from './postprocessAgent.js'
import { reviewPages } from './visualReview.js'
import { revisePages } from './revisionAgent.js'
import { revisionStates } from './revisionRuntime.js'
import { SpecRuntime, specEntryStates } from './specRuntime.js'
import { refineSpec } from './specAgent.js'

export class PlanningController {
  constructor(store, runtime, { planner = planStage, authoringRuntime = null, author = authorPages, postprocessRuntime = null, postprocessor = postprocessPages, visualRuntime = null, reviewer = reviewPages, revisionRuntime = null, revisor = revisePages, specRefiner = refineSpec } = {}) {
    this.store = store
    this.runtime = runtime
    this.planner = planner
    this.authoringRuntime = authoringRuntime
    this.author = author
    this.postprocessRuntime = postprocessRuntime
    this.postprocessor = postprocessor
    this.visualRuntime = visualRuntime
    this.reviewer = reviewer
    this.revisionRuntime = revisionRuntime
    this.revisor = revisor
    this.specRuntime = authoringRuntime ? new SpecRuntime(authoringRuntime) : null
    this.specRefiner = specRefiner
    this.jobs = new Map()
    this.closing = false
  }

  async recover() {
    for (const entry of await readdir(this.store.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue
      await this.store.locked(entry.name, async () => {
        const record = await this.store.read(entry.name)
        await this.reconcileReceipt(record)
        if (record.status.startsWith('preparing_')) {
          if (record.activeStage === 'revision' && this.revisionRuntime) await this.revisionRuntime.rollback(record)
          record.status = 'paused'
          record.error = '服务重启，当前阶段已暂停。可以从已确认的阶段继续。'
          await this.store.save(record)
        }
      })
    }
  }

  async reconcileReceipt(record) {
    if (record.status === 'draft' || record.status === 'planning_complete') return
    const receipt = await this.runtime.readProject(record, 'confirm_ui/result.json').catch(() => null)
    const stage = receipt?.status === 'stage1-confirmed' ? 1 : receipt?.status === 'confirmed' ? 2 : null
    if (!stage || record.confirmations.some((item) => item.stage === stage)) return
    const session = await this.runtime.json(record, '/api/session')
    if (session.result_stage !== (stage === 1 ? 'stage1' : 'final')) throw new ProjectError('原生确认记录与当前建议不一致。', 409)
    record.confirmations.push({ stage, at: this.store.now(),
      sha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), receipt })
    record.status = stage === 1 ? 'paused' : 'planning_complete'
    record.activeStage = stage === 1 ? 2 : null
    await this.store.save(record)
  }

  async start(id, token) {
    if (this.closing) throw new ProjectError('服务正在停止，请稍后继续。', 503)
    const record = await this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      await this.reconcileReceipt(record)
      if (record.status === 'planning_complete' && !this.authoringRuntime) return record
      if (record.status === 'draft_ready' && !this.postprocessRuntime) return record
      if (record.status === 'complete') return record
      if (this.jobs.has(id) || (record.status.startsWith('awaiting_') && !(record.status === 'awaiting_visual_review' && this.visualRuntime))) return record
      if (!['draft', 'failed', 'paused', 'planning_complete', 'draft_ready', 'ready_to_export', 'awaiting_visual_review', 'review_needs_human'].includes(record.status)) throw new ProjectError('当前项目不需要重复启动。', 409)
      if (!record.prompt && !record.files.length) throw new ProjectError('请填写制作需求或上传材料。')
      let stage = ['awaiting_visual_review', 'review_needs_human'].includes(record.status) ? 'visual_review' : record.status === 'draft_ready' ? 'postprocess' : record.status === 'ready_to_export' ? 'export'
        : ['failed', 'paused'].includes(record.status) && ['postprocess', 'export', 'visual_review', 'revision', 'spec'].includes(record.activeStage) ? record.activeStage
          : record.confirmations.some((item) => item.stage === 2) ? 'authoring' : record.confirmations.some((item) => item.stage === 1) ? 2 : 1
      if (stage === 'authoring' && record.confirmations.find((item) => item.stage === 2)?.receipt.refine_spec && !record.specApproval) {
        record.specReview ||= await this.specRuntime.begin(record)
        stage = 'spec'
      }
      if (stage === 'authoring' && !this.authoringRuntime) throw new ProjectError('当前环境未启用原生逐页制作。', 503)
      if (['postprocess', 'export'].includes(stage) && !this.postprocessRuntime) throw new ProjectError('当前环境尚未启用原生后处理与导出。', 503)
      if (stage === 'visual_review' && !this.visualRuntime) throw new ProjectError('当前环境尚未启用视觉审查。', 503)
      if (stage === 'revision' && !this.revisionRuntime) throw new ProjectError('当前环境尚未启用修订。', 503)
      record.status = typeof stage === 'string' ? `preparing_${stage}` : `preparing_stage${stage}`
      record.activeStage = stage
      record.error = null
      record.updatedAt = this.store.now()
      record.expiresAt = record.updatedAt + RETENTION_MS
      await this.store.save(record)
      this.launch(record, stage)
      return record
    })
    return this.store.publicRecord(record)
  }

  launch(record, stage) {
    const abort = new AbortController()
    const job = { abort, promise: null }
    this.jobs.set(record.id, job)
    job.promise = (async () => {
      let nextRecord
      try {
        if (stage === 'spec') await this.specRuntime.prepare(record, abort.signal)
        else if (stage === 'revision') await this.revisionRuntime.prepare(record, abort.signal)
        else if (stage === 'authoring') {
          await this.authoringRuntime.prepare(record, abort.signal)
          if (record.specApproval) await this.specRuntime.resetGeneration(record)
        }
        else if (stage === 'visual_review') await this.visualRuntime.prepare(record, abort.signal)
        else if (['postprocess', 'export'].includes(stage)) await this.postprocessRuntime.prepare(record, abort.signal)
        else await this.runtime.prepare(record, abort.signal)
        if (stage === 2) await this.runtime.installSelected(record, abort.signal)
        const runner = stage === 'spec' ? this.specRefiner : stage === 'revision' ? this.revisor : stage === 'authoring' ? this.author : stage === 'postprocess' ? this.postprocessor
          : stage === 'visual_review' ? this.reviewer
          : stage === 'export' ? ({ record, signal }) => this.postprocessRuntime.export(record, signal) : this.planner
        const outcome = await runner({ record, stage, runtime: stage === 'spec' ? this.specRuntime : stage === 'revision' ? this.revisionRuntime : stage === 'visual_review' ? this.visualRuntime : stage === 'authoring' ? this.authoringRuntime : ['postprocess', 'export'].includes(stage) ? this.postprocessRuntime : this.runtime, signal: abort.signal,
          checkpoint: async (progress) => {
            await this.store.locked(record.id, async () => {
              const current = await this.store.read(record.id)
              if (current.expiresAt <= this.store.now()) throw new ProjectError('项目保留期限已结束。', 410)
              current.progress = progress
              current.updatedAt = this.store.now()
              current.expiresAt = current.updatedAt + RETENTION_MS
              await this.store.save(current)
            })
          },
        })
        abort.signal.throwIfAborted()
        if (['spec', 'authoring', 'postprocess', 'revision'].includes(stage) && !outcome?.accepted) throw new ProjectError('原生检查未通过，不能进入下一阶段。', 409)
        await this.store.locked(record.id, async () => {
          const current = await this.store.read(record.id)
          current.status = stage === 'spec' ? 'awaiting_spec_review' : stage === 'authoring' ? 'draft_ready' : ['postprocess', 'revision'].includes(stage) ? (current.visualReview ? 'awaiting_visual_review' : 'ready_to_export')
            : stage === 'visual_review' ? (outcome.review.status === 'passed' ? 'ready_to_export' : 'review_needs_human')
            : stage === 'export' ? 'complete' : `awaiting_stage${stage}`
          if (stage === 'authoring') current.authoring = outcome
          if (stage === 'spec') { current.specReview.status = 'reviewing'; current.specReview.summary = outcome.summary }
          if (stage === 'postprocess') { current.production = outcome; current.review = null }
          if (stage === 'revision') { current.production = outcome; current.review = null; current.artifact = null; current.revision.status = 'applied'; current.revision.appliedAt = this.store.now() }
          if (stage === 'visual_review') { current.production = outcome.production; current.review = outcome.review; current.artifact = null }
          if (stage === 'export') { current.artifact = outcome; current.hasNativeExport = true }
          const nextStage = stage === 'authoring' && this.postprocessRuntime ? 'postprocess'
            : ['postprocess', 'revision'].includes(stage) ? (!current.visualReview ? 'export' : this.visualRuntime ? 'visual_review' : null)
              : stage === 'visual_review' && outcome.review.status === 'passed' ? 'export' : null
          if (nextStage) {
            current.status = `preparing_${nextStage}`
            current.activeStage = nextStage
            nextRecord = current
          }
          current.error = null
          await this.store.save(current)
        })
      } catch (error) {
        nextRecord = null
        if (stage === 'revision') await this.revisionRuntime.rollback(record)
        await this.store.locked(record.id, async () => {
          const current = await this.store.read(record.id)
          current.status = abort.signal.aborted ? 'paused' : 'failed'
          current.error = abort.signal.aborted ? '任务已暂停，可以继续当前阶段。'
            : error instanceof ProjectError ? error.message : '当前阶段执行失败，请检查模型与原生运行环境后重试。'
          await this.store.save(current)
        })
      } finally {
        if (nextRecord && (abort.signal.aborted || this.closing)) {
          await this.store.locked(record.id, async () => {
            const current = await this.store.read(record.id)
            current.status = 'paused'
            current.error = '任务已暂停，可以继续当前阶段。'
            await this.store.save(current)
          })
        }
        if (this.jobs.get(record.id) === job) this.jobs.delete(record.id)
        if (nextRecord && !abort.signal.aborted && !this.closing) this.launch(nextRecord, nextRecord.activeStage)
      }
    })().catch(() => {})
  }

  async confirm(id, token, payload) {
    let nextRecord
    const response = await this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      const stage = record.status === 'awaiting_stage1' ? 1 : record.status === 'awaiting_stage2' ? 2 : null
      if (!stage) throw new ProjectError('当前阶段不可提交，请等待原生确认页面就绪。', 409)
      if (payload?.stage !== (stage === 1 ? 'stage1' : 'final')) throw new ProjectError('确认阶段不匹配，请刷新当前页面。', 409)
      const response = await this.runtime.request(record, { path: '/api/confirm', method: 'POST', body: payload })
      if (response.status !== 200) return response
      const receipt = await this.runtime.readProject(record, 'confirm_ui/result.json')
      if (receipt.status !== (stage === 1 ? 'stage1-confirmed' : 'confirmed')) throw new ProjectError('原生确认记录不完整。', 409)
      record.confirmations.push({ stage, at: this.store.now(),
        sha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), receipt })
      const autoAuthor = stage === 2 && this.authoringRuntime && receipt.generation_mode !== 'split'
      const refine = autoAuthor && receipt.refine_spec
      if (refine) record.specReview = await this.specRuntime.begin(record)
      record.status = stage === 1 ? 'preparing_stage2' : refine ? 'preparing_spec' : autoAuthor ? 'preparing_authoring' : 'planning_complete'
      record.activeStage = stage === 1 ? 2 : refine ? 'spec' : autoAuthor ? 'authoring' : null
      record.updatedAt = this.store.now()
      record.expiresAt = record.updatedAt + RETENTION_MS
      await this.store.save(record)
      if (stage === 1 || autoAuthor) nextRecord = record
      return response
    })
    if (nextRecord) this.launch(nextRecord, nextRecord.activeStage)
    return response
  }

  async cancel(id, token) {
    await this.store.authorize(id, token)
    while (this.jobs.has(id)) {
      const job = this.jobs.get(id)
      job.abort.abort(); await job.promise
    }
    return this.store.get(id, token)
  }

  async openSpec(id, token) {
    return this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      if (this.specRuntime && !this.jobs.has(id) && ['failed', 'paused'].includes(record.status) && record.activeStage === 'spec' && record.specReview) {
        await this.specRuntime.inspect(record)
        record.specReview.status = 'reviewing'; record.status = 'awaiting_spec_review'; record.error = null
        await this.store.save(record)
        return this.store.publicRecord(record)
      }
      const interruptedGeneration = Boolean(record.specApproval && ['failed', 'paused'].includes(record.status) && ['authoring', 'postprocess', 'visual_review', 'export'].includes(record.activeStage))
      if (!this.specRuntime || this.jobs.has(id) || (!specEntryStates.includes(record.status) && !interruptedGeneration)) throw new ProjectError('请在当前制作阶段完成后打开完整规范。', 409)
      await this.authoringRuntime.verifyConfirmation(record)
      if (this.revisionRuntime && ['complete', 'edits_pending', 'review_needs_human'].includes(record.status) && Object.keys(await this.revisionRuntime.annotations(record)).length) throw new ProjectError('还有未处理的页面元素批注，请先完成逐页修改或撤销批注，再调整完整规范。', 409)
      if (record.specReview) {
        record.specHistory ||= []
        record.specHistory.push(record.specReview)
      }
      record.specReview = await this.specRuntime.begin(record)
      record.specReview.forceGlobal = interruptedGeneration
      record.status = record.specReview.status === 'drafting' ? 'preparing_spec' : 'awaiting_spec_review'
      record.activeStage = 'spec'
      record.artifact = null; record.review = null; record.production = null; record.error = null
      record.updatedAt = this.store.now(); record.expiresAt = record.updatedAt + RETENTION_MS
      await this.store.save(record)
      if (record.status === 'preparing_spec') this.launch(record, 'spec')
      return this.store.publicRecord(record)
    })
  }

  async applySpec(id, token) {
    return this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      if (!this.specRuntime || this.jobs.has(id) || record.status !== 'awaiting_spec_review') throw new ProjectError('当前无法处理规范批注。', 409)
      const state = await this.specRuntime.inspect(record)
      if (state.drafts.length) throw new ProjectError('请先应用或放弃编辑页中暂存的草稿。', 409)
      record.status = 'preparing_spec'; record.activeStage = 'spec'; record.error = null
      await this.store.save(record)
      this.launch(record, 'spec')
      return this.store.publicRecord(record)
    })
  }

  async confirmSpec(id, token, sha256) {
    return this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      if (this.closing || !this.specRuntime || this.jobs.has(id) || record.status !== 'awaiting_spec_review') throw new ProjectError('当前规范不可确认。', 409)
      const approval = await this.specRuntime.approve(record, sha256)
      record.specApprovals ||= []
      if (record.specApproval) record.specApprovals.push(record.specApproval)
      record.specApproval = approval
      record.specReview.status = 'approved'
      record.status = 'preparing_authoring'; record.activeStage = 'authoring'
      record.artifact = null; record.production = null; record.review = null; record.error = null
      record.updatedAt = this.store.now(); record.expiresAt = record.updatedAt + RETENTION_MS
      await this.store.save(record)
      this.launch(record, 'authoring')
      return this.store.publicRecord(record)
    })
  }

  async revisionInputs(id, token) {
    return this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      if (!this.revisionRuntime) throw new ProjectError('当前环境未启用修订。', 503)
      if (!revisionStates.includes(record.status)) throw new ProjectError('请等待当前阶段完成后再提交修改。', 409)
      return this.revisionRuntime.inputs(record)
    })
  }

  async proposeRevision(id, token, payload) {
    return this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      if (!this.revisionRuntime || !revisionStates.includes(record.status) || this.jobs.has(id)) throw new ProjectError('当前阶段不能提交修改。', 409)
      const inputs = await this.revisionRuntime.inputs(record)
      if (payload?.fingerprint !== inputs.fingerprint) throw new ProjectError('页面或批注已变化，请刷新修改列表后重新提交。', 409)
      if (!Array.isArray(payload.requests) || payload.requests.length > 100) throw new ProjectError('修改要求格式无效。')
      const items = payload.requests.map((item) => {
        if (!inputs.pages.includes(item.page) || typeof item.instruction !== 'string' || !item.instruction.trim() || item.instruction.length > 10000) throw new ProjectError('请为有效页面填写 1–10000 字的修改要求。')
        return { page: item.page, instruction: item.instruction.trim(), origin: 'request' }
      })
      if (inputs.annotations.length) {
        if (!record.hasNativeExport && record.status !== 'complete') throw new ProjectError('原生批注需要先完成首次导出。', 409)
        items.push(...inputs.annotations)
      }
      if (!items.length || items.length > 200 || JSON.stringify(items).length > 100000) throw new ProjectError('请填写修改要求，或减少本次批注数量。')
      if (record.status === 'complete') record.hasNativeExport = true
      if (record.revision) {
        record.revisionHistory ||= []
        record.revisionHistory.push(record.revision)
      }
      record.revision = { id: randomBytes(16).toString('hex'), status: 'pending', items, fingerprint: inputs.fingerprint,
        previousStatus: record.status, createdAt: this.store.now() }
      record.status = 'awaiting_revision_confirmation'
      record.updatedAt = this.store.now(); record.expiresAt = record.updatedAt + RETENTION_MS
      await this.store.save(record)
      return this.store.publicRecord(record)
    })
  }

  async confirmRevision(id, token, revisionId, accept) {
    return this.store.locked(id, async () => {
      const record = await this.store.authorize(id, token)
      if (this.closing || !this.revisionRuntime || this.jobs.has(id)) throw new ProjectError('当前无法执行修改。', 409)
      if (accept === false && ['failed', 'paused'].includes(record.status) && record.activeStage === 'revision' && record.revision?.id === revisionId) {
        if ((await this.revisionRuntime.transaction(record))?.status === 'committed') throw new ProjectError('修改已写入并通过结构检查，请继续完成复审。', 409)
        await this.revisionRuntime.rollback(record)
        record.status = record.revision.previousStatus === 'complete' ? 'edits_pending' : record.revision.previousStatus
        record.revision.status = 'cancelled'; record.error = null
        await this.store.save(record)
        return this.store.publicRecord(record)
      }
      if (record.status !== 'awaiting_revision_confirmation' || record.revision?.id !== revisionId || record.revision.status !== 'pending') throw new ProjectError('修改确认已失效，请刷新项目。', 409)
      if (typeof accept !== 'boolean') throw new ProjectError('请选择确认或返回修改。')
      if (!accept) { record.status = record.revision.previousStatus; record.revision.status = 'cancelled' }
      else {
        if (record.revision.fingerprint !== await this.revisionRuntime.releaseSnapshot(record)) throw new ProjectError('页面在确认期间发生变化，请返回修改并重新提交。', 409)
        record.revision.status = 'confirmed'; record.revision.confirmedAt = this.store.now()
        record.revision.previousReview = record.review
        record.status = 'preparing_revision'; record.activeStage = 'revision'; record.artifact = null; record.error = null
      }
      record.updatedAt = this.store.now(); record.expiresAt = record.updatedAt + RETENTION_MS
      await this.store.save(record)
      if (accept) this.launch(record, 'revision')
      return this.store.publicRecord(record)
    })
  }

  async close() {
    this.closing = true
    for (const job of this.jobs.values()) job.abort.abort()
    for (const job of this.jobs.values()) await job.promise
  }
}
