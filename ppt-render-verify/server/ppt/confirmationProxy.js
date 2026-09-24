import { ProjectError } from './projectStore.js'

const readPaths = new Set(['/', '/static/index.html', '/static/app.js', '/static/style.css', '/static/catalogs.json',
  '/api/session', '/api/catalogs', '/api/icon-previews', '/api/ai-image-comparison', '/api/recommendations'])

export function rewriteNativeResponse(response, prefix) {
  if (!/text\/(html|css)|javascript|application\/json/.test(response.contentType)) return response.body
  // Only native root-relative resources are rewritten, never user prose or receipts.
  return response.body.toString('utf8').replace(/(["'])\/(static|api|ai-image-comparison)\//g, `$1${prefix}/$2/`)
}

export function mountConfirmationProxy(router, store, controller, bearerToken) {
  const cookieName = (id) => `mw_ppt_${id}`
  const cookieToken = (req) => {
    const key = `${cookieName(req.params.id)}=`
    return (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(key))?.slice(key.length) || ''
  }
  router.post('/projects/:id/confirmation-session', async (req, res) => {
    const token = bearerToken(req)
    await store.authorize(req.params.id, token)
    const prefix = `/api/ppt/projects/${req.params.id}/native`
    res.cookie(cookieName(req.params.id), token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: prefix })
    res.json({ url: `${prefix}/` })
  })
  router.use('/projects/:id/native', async (req, res) => {
    const token = cookieToken(req)
    const record = await store.authorize(req.params.id, token)
    const endpoint = req.path
    if (req.method === 'POST') {
      let origin
      try { origin = new URL(req.headers.origin) } catch { /* Missing origin is not a browser submission. */ }
      if (!origin || origin.host !== req.get('host') || !['http:', 'https:'].includes(origin.protocol)) throw new ProjectError('确认提交来源无效。', 403)
      if (endpoint === '/api/shutdown') {
        if (!record.confirmations.some((item) => item.stage === 2)) throw new ProjectError('最终确认尚未完成。', 409)
        return res.json({ status: 'ok' })
      }
      if (endpoint !== '/api/confirm') throw new ProjectError('原生接口不存在。', 404)
      const response = await controller.confirm(req.params.id, token, req.body)
      return res.status(response.status).type(response.contentType).send(response.body)
    }
    if (req.method !== 'GET' || (!readPaths.has(endpoint) && !/^\/ai-image-comparison\/[a-z-]+\/[\w.-]+\.(png|webp|jpg)$/.test(endpoint))) {
      throw new ProjectError('原生接口不存在。', 404)
    }
    const response = await store.locked(req.params.id, () => controller.runtime.request(record, { path: endpoint }))
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'")
    res.status(response.status).type(response.contentType).send(rewriteNativeResponse(response, `/api/ppt/projects/${req.params.id}/native`))
  })
}
