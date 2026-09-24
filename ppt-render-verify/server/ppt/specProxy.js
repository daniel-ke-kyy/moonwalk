import { ProjectError, RETENTION_MS } from './projectStore.js'
import { rewriteNativeResponse } from './confirmationProxy.js'

const reads = new Set(['/', '/static/index.html', '/static/app.js', '/static/style.css', '/api/state', '/api/blocks', '/api/spec', '/api/annotations'])
export function mountSpecProxy(router, store, controller, token) {
  router.post('/projects/:id/spec/open', async (req, res) => res.json(await controller.openSpec(req.params.id, token(req))))
  router.post('/projects/:id/spec/apply', async (req, res) => res.json(await controller.applySpec(req.params.id, token(req))))
  router.post('/projects/:id/spec/confirm', async (req, res) => res.json(await controller.confirmSpec(req.params.id, token(req), req.body?.sha256)))
  router.get('/projects/:id/spec/summary', async (req, res) => store.locked(req.params.id, async () => {
    const record = await store.authorize(req.params.id, token(req))
    if (record.status !== 'awaiting_spec_review') throw new ProjectError('请等待规范处理完成。', 409)
    res.json(await controller.specRuntime.summary(record))
  }))
  router.post('/projects/:id/spec-session', async (req, res) => {
    const value = token(req)
    const record = await store.authorize(req.params.id, value)
    if (!record.specReview) throw new ProjectError('完整规范尚未打开。', 409)
    const prefix = '/api/ppt/projects/' + record.id + '/spec-native'
    res.cookie('mw_spec_' + record.id, value, { httpOnly: true, sameSite: 'strict', secure: req.secure || process.env.NODE_ENV === 'production', path: prefix })
    res.json({ url: prefix + '/' })
  })
  router.use('/projects/:id/spec-native', async (req, res) => store.locked(req.params.id, async () => {
    const prefix = '/api/ppt/projects/' + req.params.id + '/spec-native'
    const key = 'mw_spec_' + req.params.id + '='
    const value = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(key))?.slice(key.length) || ''
    const record = await store.authorize(req.params.id, value)
    if (!record.specReview) throw new ProjectError('完整规范尚未打开。', 409)
    const hold = record.status !== 'awaiting_spec_review' || controller.jobs.has(record.id)
    const write = req.method !== 'GET'
    if (write) {
      let origin
      try { origin = new URL(req.headers.origin) } catch { /* Reject missing browser origin. */ }
      if (!origin || origin.host !== req.get('host') || !['http:', 'https:'].includes(origin.protocol)) throw new ProjectError('规范编辑来源无效。', 403)
      if (hold) throw new ProjectError('规范已冻结，请等待处理完成或重新打开审阅。', 409)
      const allowed = (['PUT', 'DELETE'].includes(req.method) && /^\/api\/drafts\/[^/]+$/.test(req.path)) ||
        (req.method === 'POST' && /^\/api\/apply\/[^/]+$/.test(req.path)) ||
        (req.method === 'POST' && req.path === '/api/annotations') ||
        (['PUT', 'DELETE'].includes(req.method) && /^\/api\/annotations\/[a-f0-9]+$/.test(req.path))
      if (!allowed) throw new ProjectError('规范接口不存在。', 404)
    } else if (!reads.has(req.path) && !/^\/api\/blocks\/[^/]+$/.test(req.path)) throw new ProjectError('规范接口不存在。', 404)
    const response = await controller.specRuntime.call(record, { path: req.path, method: req.method, body: req.body, hold })
    response.body = Buffer.from(response.body, 'base64')
    let body = rewriteNativeResponse(response, prefix)
    if (req.path === '/static/style.css') body = response.body.toString('utf8') + '\n#exit { display: none; }\n'
    if (req.path === '/static/app.js') body = body.replaceAll('Return to chat', '返回上方确认区域').replaceAll('回到对话', '返回上方确认区域')
    if (write && response.status < 400) {
      record.updatedAt = store.now(); record.expiresAt = record.updatedAt + RETENTION_MS
      await store.save(record)
    }
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    res.set('X-Content-Type-Options', 'nosniff')
    res.status(response.status).type(response.contentType).send(body)
  }))
}
