import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, readdir, lstat } from 'node:fs/promises'
import path from 'node:path'

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const idPattern = /^[a-f0-9]{32}$/
const digest = (token) => createHash('sha256').update(token).digest()

export class ProjectError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

// Project state is server-owned. The future worker only receives workspace/.
export class ProjectStore {
  constructor(root, { now = Date.now, storageMode = 'persistent' } = {}) {
    this.root = path.resolve(root)
    this.now = now
    this.storageMode = storageMode
    this.locks = new Map()
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('PPT storage must not be a symlink')
    return this
  }

  directory(id) {
    if (!idPattern.test(id)) throw new ProjectError('项目不存在或恢复凭证无效。', 404)
    return path.join(this.root, id)
  }

  async locked(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve()
    const current = previous.catch(() => {}).then(fn)
    this.locks.set(id, current)
    try { return await current } finally {
      if (this.locks.get(id) === current) this.locks.delete(id)
    }
  }

  async save(record) {
    const directory = this.directory(record.id)
    const temporary = path.join(directory, `.state-${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record, null, 2))
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, path.join(directory, 'state.json'))
  }

  async read(id) {
    const directory = this.directory(id)
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('symlink')
      const statePath = path.join(directory, 'state.json')
      if (!(await lstat(statePath)).isFile()) throw new Error('invalid state')
      const record = JSON.parse(await readFile(statePath, 'utf8'))
      if (record.id !== id || record.schemaVersion !== 1) throw new Error('invalid state')
      return record
    } catch {
      throw new ProjectError(this.storageMode === 'temporary'
        ? '临时项目已不可用或恢复凭证无效。服务休眠、重启或重新部署会清空项目，请新建项目。'
        : '项目不存在或恢复凭证无效。', 404)
    }
  }

  async authorize(id, token) {
    const record = await this.read(id)
    const supplied = digest(typeof token === 'string' ? token : '')
    const expected = Buffer.from(record.tokenHash, 'hex')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new ProjectError('项目不存在或恢复凭证无效。', 404)
    }
    if (record.expiresAt <= this.now()) throw new ProjectError('项目已超过七天保留期限。', 410)
    return record
  }

  publicRecord(record) {
    const { tokenHash: _tokenHash, ...visible } = record
    visible.storageMode = this.storageMode
    // The internal cleanup deadline is not a retention promise on ephemeral hosts.
    if (this.storageMode === 'temporary') visible.expiresAt = null
    if (visible.specApproval) {
      const { text: _text, ...approval } = visible.specApproval
      visible.specApproval = approval
    }
    if (visible.specApprovals) visible.specApprovals = visible.specApprovals.map(({ text: _text, ...approval }) => approval)
    return visible
  }

  async create({ prompt = '', aiProvider, visualReview = true }) {
    if (!['deepseek', 'openai'].includes(aiProvider)) throw new ProjectError('请选择有效的 AI 模型。')
    if (typeof prompt !== 'string' || prompt.length > 100000) throw new ProjectError('提示词不能超过 100000 字符。')
    if (typeof visualReview !== 'boolean') throw new ProjectError('视觉审查设置无效。')
    const id = randomBytes(16).toString('hex')
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const directory = this.directory(id)
    await mkdir(directory, { mode: 0o700 })
    try {
      await mkdir(path.join(directory, 'workspace', 'sources'), { recursive: true, mode: 0o700 })
      const record = {
        schemaVersion: 1, id, tokenHash: digest(token).toString('hex'),
        aiProvider, prompt: prompt.trim(), visualReview,
        status: 'draft', createdAt: now, updatedAt: now, expiresAt: now + RETENTION_MS,
        files: [], confirmations: [],
      }
      await this.save(record)
      return { project: this.publicRecord(record), recoveryToken: token }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async get(id, token) {
    return this.publicRecord(await this.authorize(id, token))
  }

  async addFiles(id, token, files) {
    return this.locked(id, async () => {
      const record = await this.authorize(id, token)
      if (record.status !== 'draft') throw new ProjectError('制作开始后不能替换输入材料。', 409)
      if (!files.length || record.files.length + files.length > 10) throw new ProjectError('每个项目最多上传 10 个文件。')
      const accepted = []
      try {
        for (const file of files) {
          const extension = path.extname(file.originalName).toLowerCase()
          if (!['.pdf', '.docx', '.pptx'].includes(extension)) throw new ProjectError('目前支持 PDF、DOCX、PPTX。')
          if (file.size > 50 * 1024 * 1024 || file.size <= 0) throw new ProjectError('文件不能为空且不能超过 50MB。')
          const name = `${randomBytes(16).toString('hex')}${extension}`
          const target = path.join(this.directory(id), 'workspace', 'sources', name)
          // Uploads originate in a private staging directory on the same volume.
          await rename(file.path, target)
          accepted.push({ name, originalName: file.originalName, size: file.size })
        }
        record.files.push(...accepted)
        record.updatedAt = this.now()
        record.expiresAt = record.updatedAt + RETENTION_MS
        await this.save(record)
      } catch (error) {
        for (const file of accepted) await rm(path.join(this.directory(id), 'workspace', 'sources', file.name), { force: true })
        throw error
      }
      return this.publicRecord(record)
    })
  }

  async delete(id, token) {
    return this.locked(id, async () => {
      const record = await this.authorize(id, token)
      // Never delete files out from underneath a future active worker.
      if (record.status.startsWith('preparing_')) throw new ProjectError('请先停止制作任务再删除项目。', 409)
      await rm(this.directory(id), { recursive: true, force: true })
    })
  }

  async cleanupExpired() {
    let deleted = 0
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue
      await this.locked(entry.name, async () => {
        const record = await this.read(entry.name).catch(() => null)
        if (record && !record.status.startsWith('preparing_') && record.expiresAt <= this.now()) {
          await rm(this.directory(entry.name), { recursive: true, force: true })
          deleted++
        }
      })
    }
    return deleted
  }
}
