import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { ProjectError } from './projectStore.js'
import { mountConfirmationProxy } from './confirmationProxy.js'
import { mountPreviewProxy } from './previewProxy.js'
import { mountSpecProxy } from './specProxy.js'

export async function createPptRouter(store, { controller = null } = {}) {
  const router = express.Router()
  const staging = path.join(store.root, '.uploads')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const upload = multer({ dest: staging, limits: { files: 10, fileSize: 50 * 1024 * 1024, fields: 0 } })
  const token = (req) => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] || ''

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    next()
  })
  router.get('/capabilities', (_req, res) => {
    res.json({
      projectStorage: true, nativeExecution: false, nativeSpecReview: Boolean(controller?.specRuntime), nativeRevision: Boolean(controller?.revisionRuntime), nativeVisualReview: Boolean(controller?.visualRuntime), nativePostprocess: Boolean(controller?.postprocessRuntime), nativeAuthoring: Boolean(controller?.authoringRuntime), nativePlanning: Boolean(controller), retentionDays: 7,
      storageMode: store.storageMode,
      ...store.storageMode === 'temporary' ? { retentionDays: null } : {},
      supportedExtensions: ['.pdf', '.docx', '.pptx'],
      reason: controller?.revisionRuntime ? '已接通逐页修改确认、首次导出后的原生元素批注及修订后重新检查。修改不能越过已确认的大纲与设计边界。' : controller?.visualRuntime ? '已接通逐页看图审查、最多两轮局部修正与原生导出。' : controller?.postprocessRuntime ? '已接通原生讲稿、动画与 PPTX 导出。开启审查的项目会保留并等待审查。' : controller?.authoringRuntime ? '已接通原生规划、逐页 SVG 制作与只读预览。' : controller ? '原生两阶段规划已接通。' : '独立项目存储已就绪，PPT-master 后台执行器尚未接通。',
    })
  })
  router.post('/projects', async (req, res) => {
    res.status(201).json(await store.create(req.body || {}))
  })
  router.get('/projects/:id', async (req, res) => {
    res.json(await store.get(req.params.id, token(req)))
  })
  router.post('/projects/:id/files', async (req, res, next) => {
    await store.authorize(req.params.id, token(req))
    upload.array('files', 10)(req, res, async (error) => {
      try {
        if (error) throw error
        const files = (req.files || []).map((file) => ({
          path: file.path, size: file.size,
          originalName: /[^\u0000-\u00ff]/.test(file.originalname)
            ? file.originalname : Buffer.from(file.originalname, 'latin1').toString('utf8'),
        }))
        res.json(await store.addFiles(req.params.id, token(req), files))
      } catch (failure) { next(failure) } finally {
        for (const file of req.files || []) await rm(file.path, { force: true }).catch(() => {})
      }
    })
  })
  router.post('/projects/:id/start', async (req, res) => {
    await store.authorize(req.params.id, token(req))
    if (controller) return res.status(202).json(await controller.start(req.params.id, token(req)))
    throw new ProjectError('PPT-master 后台执行器尚未接通，项目已保存，暂不能开始制作。', 503)
  })
  if (controller) {
    router.get('/projects/:id/revision-inputs', async (req, res) => res.json(await controller.revisionInputs(req.params.id, token(req))))
    router.post('/projects/:id/revisions', async (req, res) => res.status(202).json(await controller.proposeRevision(req.params.id, token(req), req.body)))
    router.post('/projects/:id/revisions/:revisionId/confirm', async (req, res) => res.json(await controller.confirmRevision(req.params.id, token(req), req.params.revisionId, req.body?.accept)))
    router.get('/projects/:id/download', async (req, res) => {
      await store.locked(req.params.id, async () => {
        const record = await store.authorize(req.params.id, token(req))
        if (!controller.postprocessRuntime) throw new ProjectError('当前环境尚未启用导出。', 503)
        const file = await controller.postprocessRuntime.download(record)
        res.attachment(file.name).send(file.content)
      })
    })
    router.post('/projects/:id/cancel', async (req, res) => res.json(await controller.cancel(req.params.id, token(req))))
    mountConfirmationProxy(router, store, controller, token)
    if (controller.authoringRuntime) mountPreviewProxy(router, store, controller, token)
    if (controller.specRuntime) mountSpecProxy(router, store, controller, token)
  }
  router.delete('/projects/:id', async (req, res) => {
    await store.delete(req.params.id, token(req))
    res.status(204).end()
  })
  router.use((error, _req, res, _next) => {
    const uploadError = error instanceof multer.MulterError
    const status = uploadError ? 400 : error instanceof ProjectError ? error.status : 500
    res.status(status).json({ error: uploadError
      ? '上传失败：每个项目最多 10 个文件，每个文件不超过 50MB。'
      : status === 500 ? '项目操作失败，请稍后重试。' : error.message })
  })
  return router
}
