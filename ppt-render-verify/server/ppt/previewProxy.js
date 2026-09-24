import { ProjectError, RETENTION_MS } from './projectStore.js'
import { revisionStates } from './revisionRuntime.js'

const paths = new Set(['/', '/static/index.html', '/static/app.js', '/static/style.css', '/api/config', '/api/slides'])
const readOnlyScript = `document.addEventListener('keydown', function (event) {
  if ((event.ctrlKey || event.metaKey) && ['a', 'z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);`
const annotationScript = `document.addEventListener('mousedown', function (event) {
  if (event.target.closest && event.target.closest('#svg-container')) event.stopImmediatePropagation();
}, true);
document.addEventListener('keydown', function (event) {
  if (event.target.matches && event.target.matches('input, textarea')) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase()))) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);`
const readOnlyStyle = `<style>
#panel-right { display: none !important; }
#svg-container { pointer-events: none; }
@media (max-width: 600px) {
  #panel-left { display: none; }
  #panel-center { min-width: 0; }
  #slide-nav { padding: 6px; gap: 4px; }
  #nav-label { min-width: 0; overflow: hidden; }
}
</style>`
const annotationStyle = `<style>
#element-props, #btn-undo, #btn-exit-preview { display: none !important; }
@media (max-width: 800px) {
  html, body { height: auto; overflow: auto; }
  #app { flex-direction: column; height: auto; min-height: 100vh; width: 100%; }
  #panel-left { display: none; }
  #panel-center { min-width: 0; height: 300px; flex: none; }
  #panel-right { width: auto; min-width: 0; max-height: none; border-left: 0; overflow: visible; }
  #annotation-list { flex: none; max-height: 200px; }
  #slide-nav { gap: 4px; padding: 6px; }
  #nav-label { min-width: 0; overflow: hidden; }
}
</style>`

export function canAnnotate(record, controller) {
  return Boolean(controller.revisionRuntime && (record.hasNativeExport || record.status === 'complete') && revisionStates.includes(record.status))
}

export function mountPreviewProxy(router, store, controller, bearerToken) {
  const cookieName = (id) => `mw_preview_${id}`
  router.post('/projects/:id/preview-session', async (req, res) => {
    const token = bearerToken(req)
    const record = await store.authorize(req.params.id, token)
    await controller.authoringRuntime.verifyConfirmation(record)
    const prefix = `/api/ppt/projects/${record.id}/preview`
    res.cookie(cookieName(record.id), token, { httpOnly: true, sameSite: 'strict', secure: req.secure || process.env.NODE_ENV === 'production', path: prefix })
    res.json({ url: `${prefix}/`, annotations: canAnnotate(record, controller) })
  })
  router.use('/projects/:id/preview', async (req, res) => {
    const name = `${cookieName(req.params.id)}=`
    const token = (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(name))?.slice(name.length) || ''
    return store.locked(req.params.id, async () => {
    const record = await store.authorize(req.params.id, token)
    const editable = canAnnotate(record, controller)
    const write = req.method !== 'GET'
    if (write) {
      let origin
      try { origin = new URL(req.headers.origin) } catch { /* Require a same-origin browser submission. */ }
      if (!origin || origin.host !== req.get('host') || !['http:', 'https:'].includes(origin.protocol)) throw new ProjectError('批注提交来源无效。', 403)
      if (!editable || controller.jobs.has(record.id)) throw new ProjectError('批注仅在首次导出后、任务空闲时开放；请等待任务完成。', 409)
      const annotate = req.method === 'POST' && /^\/api\/slide\/[^/]+\.svg\/annotate$/.test(req.path)
      const remove = req.method === 'DELETE' && /^\/api\/slide\/[^/]+\.svg\/annotate\/[^/]+$/.test(req.path)
      const save = req.method === 'POST' && req.path === '/api/save-all'
      if (!annotate && !remove && !save) throw new ProjectError('此入口只支持原生元素批注，直接编辑尚未开放。', 409)
      if (save) {
        // Invalidate the artifact before native disk writes, including partial failures.
        record.hasNativeExport = true
        record.status = 'edits_pending'; record.artifact = null
        await store.save(record)
      }
    }
    if (req.path === '/static/moonwalk-readonly.js') return res.type('application/javascript').send(editable ? annotationScript : readOnlyScript)
    if (!write && !paths.has(req.path) && !/^\/api\/slide\/[^/]+\.svg$/.test(decodeURIComponent(req.path))) throw new ProjectError('预览接口不存在。', 404)
    const response = await controller.authoringRuntime.preview(record, req.path, undefined, { method: req.method, body: req.body, editable })
    if (write && req.path === '/api/save-all' && response.status === 200) {
      const pending = await controller.revisionRuntime.annotations(record)
      if (!Object.keys(pending).length) {
        record.status = 'draft_ready'; record.review = null
        await store.save(record)
      }
    }
    if (write && response.status === 200) {
      record.updatedAt = store.now(); record.expiresAt = record.updatedAt + RETENTION_MS
      await store.save(record)
    }
    const prefix = `/api/ppt/projects/${record.id}/preview`
    let body = /text\/html|javascript|application\/json/.test(response.contentType)
      ? response.body.toString('utf8').replace(/(["'`])\/(static|api|images)\//g, `$1${prefix}/$2/`) : response.body
    if (editable && req.path === '/static/app.js') body = body
      .replaceAll('回到对话窗口要求应用标注', '在网站上方核对并确认本次修改')
      .replaceAll('Return to the chat and ask to apply annotations', 'Review and confirm the changes above this preview')
      .replaceAll('编辑 / 标注', '元素标注')
      .replaceAll('确认将暂存的直接修改和 AI 标注写入磁盘?', '确认保存这些元素批注？保存后仍需在网站上方确认执行。')
    // Adapt the shell to this milestone's permissions, without editing upstream code.
    if (/text\/html/.test(response.contentType)) {
      body = body.replace('</head>', `${editable ? annotationStyle : readOnlyStyle}<script src="${prefix}/static/moonwalk-readonly.js"></script></head>`)
      if (!editable) body = body.replace('id="svg-container"', 'id="svg-container" inert')
    }
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    res.status(response.status).type(response.contentType).send(body)
    })
  })
}
