import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Copy, Download, FileText, Loader2, MessageSquare, Pause, Play, RefreshCw, Trash2, UploadCloud, X } from 'lucide-react'
import './PptWorkspace.css'
import { PptSpecReview } from './PptSpecReview'

type Provider = 'deepseek' | 'openai'
type RevisionItem = { page: string; instruction: string; elementId?: string; origin: string }
type RevisionInputs = { pages: string[]; annotations: RevisionItem[]; fingerprint: string }
type Project = {
  id: string; prompt: string; aiProvider: Provider; visualReview: boolean; status: string;
  expiresAt: number | null; storageMode?: 'persistent' | 'temporary'; updatedAt: number; error?: string; activeStage?: number | string; progress?: { round: number; phase: number | string; page?: number; total?: number; message?: string };
  authoring?: { slideCount: number; warnings: number; visualReview: string; exportReady: boolean };
  production?: { notes: string; motion: { mode: string; reason: string }; slideCount: number };
  artifact?: { file: string; slideCount: number; status: string };
  hasNativeExport?: boolean;
  specReview?: { status: string; summary?: string };
  specApproval?: { id: string };
  revision?: { id: string; status: string; items: RevisionItem[]; previousStatus: string };
  review?: { status: string; repairLimit: number; pages: { page: string; status: string; repairs: number; findings: { rule: string; evidence: string }[]; needs_human_items: { rule: string; suggested_fix_summary: string }[] }[] };
  files: { name: string; originalName: string; size: number }[];
}
type Saved = { id: string; token: string; title: string }
const storageKey = 'moonwalk-ppt-projects-v1'
const labels: Record<string, string> = {
  draft: '待开始', preparing_stage1: '正在读取材料并准备目标确认', awaiting_stage1: '请确认目标与模板',
  preparing_stage2: '正在按你的选择规划方案', awaiting_stage2: '请确认设计与制作方案',
  planning_complete: '两次确认已完成', failed: '当前阶段未完成', paused: '任务已暂停',
  preparing_authoring: '正在制作幻灯片', draft_ready: '初稿已通过结构检查',
  preparing_postprocess: '正在整理讲稿与动画', awaiting_visual_review: '待视觉审查',
  preparing_visual_review: '正在逐页审查与修正', review_needs_human: '审查发现问题，需要确认',
  ready_to_export: '已准备好导出', preparing_export: '正在导出并校验 PPTX', complete: 'PPTX 已生成',
  edits_pending: '批注已保存，待确认修改', awaiting_revision_confirmation: '请确认本次修改', preparing_revision: '正在应用已确认的修改',
  preparing_spec: '正在处理完整设计规范', awaiting_spec_review: '请审阅并确认完整设计规范',
}

function loadSaved(): Saved[] {
  try {
    const items = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(items) ? items.filter((item) => /^[a-f0-9]{32}$/.test(item.id) && /^[A-Za-z0-9_-]{43}$/.test(item.token)) : []
  } catch { return [] }
}
function initialSession() {
  const saved = loadSaved()
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const id = fragment.get('project') || new URLSearchParams(window.location.search).get('project')
  const token = fragment.get('key')
  const imported = id && token && /^[a-f0-9]{32}$/.test(id) && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? { id, token, title: '恢复的项目' } : null
  const active = imported || saved.find((entry) => entry.id === id) || null
  return { saved: imported ? [imported, ...saved.filter((entry) => entry.id !== imported.id)] : saved,
    active, imported, error: id && !active ? '此浏览器没有项目凭证，请使用完整恢复链接。' : '' }
}
class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
async function api<T>(url: string, token?: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/ppt${url}`, { ...options, credentials: 'include',
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
  if (response.status === 204) return undefined as T
  const result = await response.json()
  if (!response.ok) throw new ApiError(result.error || '请求失败，请重试。', response.status)
  return result
}

export function PptWorkspace({ provider, onBack }: { provider: Provider; onBack: () => void }) {
  const [initial] = useState(initialSession)
  const [saved, setSaved] = useState(initial.saved)
  const [active, setActive] = useState<Saved | null>(initial.active)
  const [project, setProject] = useState<Project | null>(null)
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [review, setReview] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initial.error)
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<{ key: string; url?: string; error?: string } | null>(null)
  const [confirmAttempt, setConfirmAttempt] = useState(0)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [temporaryStorage, setTemporaryStorage] = useState(false)
  const [authoringAvailable, setAuthoringAvailable] = useState(false)
  const [postprocessAvailable, setPostprocessAvailable] = useState(false)
  const [visualAvailable, setVisualAvailable] = useState(false)
  const [revisionAvailable, setRevisionAvailable] = useState(false)
  const [specAvailable, setSpecAvailable] = useState(false)
  const [revisionData, setRevisionInputs] = useState<(RevisionInputs & { projectId: string }) | null>(null)
  const [revisionAttempt, setRevisionAttempt] = useState(0)
  const [revisionError, setRevisionError] = useState('')
  const [revisionText, setRevisionText] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<{ key: string; url?: string; error?: string } | null>(null)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const revisionInputs = revisionData?.projectId === active?.id ? revisionData : null

  function remember(item: Saved) {
    const items = [item, ...loadSaved().filter((entry) => entry.id !== item.id)]
    setSaved(items)
    try { localStorage.setItem(storageKey, JSON.stringify(items)) } catch {
      setNotice('浏览器无法保存项目记录，请复制恢复链接。')
    }
  }

  useEffect(() => {
    let alive = true
    api<{ storageMode?: string; nativePlanning: boolean; nativeAuthoring: boolean; nativePostprocess: boolean; nativeVisualReview: boolean; nativeRevision: boolean; nativeSpecReview: boolean }>('/capabilities').then((result) => {
      if (alive) setTemporaryStorage(result.storageMode === 'temporary')
      if (alive) { setAvailable(result.nativePlanning); setAuthoringAvailable(result.nativeAuthoring); setPostprocessAvailable(result.nativePostprocess); setVisualAvailable(result.nativeVisualReview); setRevisionAvailable(result.nativeRevision); setSpecAvailable(result.nativeSpecReview) }
    }).catch(() => { if (alive) setAvailable(false) })
    if (initial.imported) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(initial.saved))
        history.replaceState(null, '', `/ppt?project=${initial.imported.id}`)
      } catch { /* Keep the recovery fragment if browser storage is unavailable. */ }
    }
    return () => { alive = false }
  }, [initial])

  useEffect(() => {
    if (!active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await api<Project>(`/projects/${active!.id}`, active!.token)
        if (!alive) return
        setProject(result)
      } catch (failure) {
        if (!alive) return
        setError(failure instanceof Error ? failure.message : '项目读取失败。')
        if (failure instanceof ApiError && [404, 410].includes(failure.status)) {
          const remaining = loadSaved().filter((item) => item.id !== active!.id)
          setSaved(remaining); setProject(null); setActive(null)
          try { localStorage.setItem(storageKey, JSON.stringify(remaining)) } catch { /* Stale history can be ignored. */ }
          history.replaceState(null, '', '/ppt')
          return
        }
      }
      if (alive) timer = setTimeout(refresh, 2500)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [active])

  useEffect(() => {
    if (!active || !['awaiting_stage1', 'awaiting_stage2'].includes(project?.status || '')) return
    let alive = true
    const key = `${active.id}:${project?.status}:${confirmAttempt}`
    api<{ url: string }>(`/projects/${active.id}/confirmation-session`, active.token, { method: 'POST' })
      .then((result) => { if (alive) setConfirmation({ key, url: result.url }) })
      .catch((failure) => { if (alive) setConfirmation({ key, error: failure.message }) })
    return () => { alive = false }
  }, [active, project?.status, confirmAttempt])

  const canRevise = revisionAvailable && ['review_needs_human', 'complete', 'edits_pending'].includes(project?.status || '')
  const annotationMode = revisionAvailable && (project?.hasNativeExport || project?.status === 'complete') && canRevise
  const previewMode = annotationMode ? 'annotations' : 'readonly'
  const canPreview = authoringAvailable && (['authoring', 'postprocess', 'visual_review', 'export', 'revision'].includes(String(project?.activeStage)) || ['draft_ready', 'awaiting_visual_review', 'review_needs_human', 'ready_to_export', 'complete', 'edits_pending', 'awaiting_revision_confirmation'].includes(project?.status || ''))
  useEffect(() => {
    if (!active || !canPreview) return
    let alive = true
    api<{ url: string }>(`/projects/${active.id}/preview-session`, active.token, { method: 'POST' })
      .then((result) => { if (alive) setPreview({ key: `${active.id}:${previewAttempt}:${previewMode}`, url: result.url }) })
      .catch((failure) => { if (alive) setPreview({ key: `${active.id}:${previewAttempt}:${previewMode}`, error: failure.message }) })
    return () => { alive = false }
  }, [active, canPreview, previewAttempt, previewMode])

  useEffect(() => {
    if (!active || !canRevise) return
    let alive = true
    api<RevisionInputs>(`/projects/${active.id}/revision-inputs`, active.token)
      .then((result) => { if (alive) { setRevisionInputs({ ...result, projectId: active.id }); setRevisionError('') } })
      .catch((failure) => { if (alive) { setRevisionInputs(null); setRevisionError(failure.message) } })
    return () => { alive = false }
  }, [active, canRevise, revisionAttempt, project?.status, project?.updatedAt])

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }

  async function create() {
    await perform(async () => {
      const result = await api<{ project: Project; recoveryToken: string }>('/projects', undefined, {
        method: 'POST', body: JSON.stringify({ prompt, aiProvider: provider, visualReview: review }),
      })
      const item = { id: result.project.id, token: result.recoveryToken, title: prompt.trim().slice(0, 30) || files[0]?.name || '未命名项目' }
      remember(item); setActive(item); setProject(result.project)
      history.replaceState(null, '', `/ppt?project=${item.id}`)
      if (files.length) {
        const form = new FormData()
        files.forEach((file) => form.append('files', file))
        await api(`/projects/${item.id}/files`, item.token, { method: 'POST', body: form })
        setFiles([])
      }
      setProject(await api<Project>(`/projects/${item.id}/start`, item.token, { method: 'POST' }))
    })
  }

  async function download() {
    if (!active || !project?.artifact) return
    const response = await fetch(`/api/ppt/projects/${active.id}/download`, {
      credentials: 'include', headers: { Authorization: `Bearer ${active.token}` },
    })
    if (!response.ok) {
      const result = await response.json().catch(() => null)
      throw new Error(result?.error || '下载失败，请重试。')
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = project.artifact.file
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  function select(item: Saved) {
    setProject(null); setActive(item); setError(''); setConfirmation(null); setPreview(null); setFiles([])
    history.replaceState(null, '', `/ppt?project=${item.id}`)
  }
  function newProject() {
    setActive(null); setProject(null); setPrompt(''); setFiles([]); setError(''); setConfirmation(null); setPreview(null)
    history.replaceState(null, '', '/ppt')
  }
  function addFiles(incoming: FileList | null) {
    if (!incoming) return
    const next = [...files, ...Array.from(incoming)]
    if (next.length > 10 || next.some((file) => file.size > 50 * 1024 * 1024 || !/\.(pdf|docx|pptx)$/i.test(file.name))) {
      setError('最多上传 10 个 PDF、DOCX 或 PPTX，每个不超过 50MB。'); return
    }
    setFiles(next); setError('')
  }
  const running = project?.status.startsWith('preparing_')
  const waiting = ['awaiting_stage1', 'awaiting_stage2'].includes(project?.status || '')
  const currentConfirmation = confirmation?.key === `${active?.id}:${project?.status}:${confirmAttempt}` ? confirmation : null
  const currentPreview = preview?.key === `${active?.id}:${previewAttempt}:${previewMode}` ? preview : null

  return <main className="ppt-workspace">
    <header className="ppt-topbar">
      <button className="ppt-text-button" onClick={onBack}><ArrowLeft size={18} />返回首页</button>
      <span className="ppt-brand">Moonwalk</span>
      <span className="ppt-provider">{(project?.aiProvider || provider) === 'openai' ? 'GPT-5.6 Sol' : 'DeepSeek-V4.1-Flash'}</span>
    </header>
    <div className="ppt-heading"><h1>PPT 制作</h1><span>本地验证 · {postprocessAvailable ? '原生制作与导出' : authoringAvailable ? '原生逐页制作' : '原生两阶段规划'}</span></div>
    {available === false && <p className="ppt-message" role="alert">当前环境未启用原生规划。项目制作暂不可用。</p>}
    {temporaryStorage && <p className="ppt-message" role="status">项目仅临时保存，不保证保留七天。服务器休眠、重启或部署会清空材料和结果；制作期间请保持页面打开，完成后及时下载。保持页面打开也不能保证任务不中断。</p>}
    {error && <p className="ppt-error" role="alert">{error}</p>}
    {notice && <p className="ppt-message" role="status">{notice}</p>}
    {!active ? <div className="ppt-input-layout">
      <form onSubmit={(event) => { event.preventDefault(); void create() }} className="ppt-form">
        <label htmlFor="ppt-prompt">制作需求</label>
        <textarea id="ppt-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={100000} rows={8} disabled={busy} placeholder="主题、受众、汇报目的及需要保留的内容" />
        <div className="ppt-upload-heading"><h2>参考材料</h2><span>PDF / DOCX / PPTX</span></div>
        <input ref={input} type="file" multiple accept=".pdf,.docx,.pptx" hidden onChange={(event) => { addFiles(event.target.files); event.target.value = '' }} />
        <button className="ppt-upload" type="button" disabled={busy} onClick={() => input.current?.click()}><UploadCloud size={22} /><span>上传文件</span><small>最多 10 个，每个 50MB</small></button>
        <ul className="ppt-file-list">{files.map((file, index) => <li key={`${index}-${file.name}`}><FileText size={16} /><span>{file.name}</span><button type="button" title={`移除 ${file.name}`} aria-label={`移除 ${file.name}`} disabled={busy} onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={16} /></button></li>)}</ul>
        <label className="ppt-check"><input type="checkbox" checked={review} onChange={(event) => setReview(event.target.checked)} disabled={busy} />视觉审查</label>
        {review && !visualAvailable && <p className="ppt-message">当前环境未启用自动视觉审查。开启后，项目将停在待审查阶段，不会直接导出。</p>}
        <button className="ppt-primary" disabled={!available || busy || (!prompt.trim() && !files.length)}>{busy ? <Loader2 size={18} className="ppt-spin" /> : <ArrowRight size={18} />}开始规划</button>
      </form>
      <aside className="ppt-history"><h2>我的项目</h2>{!saved.length && <p>暂无项目</p>}{saved.map((item) => <button key={item.id} onClick={() => select(item)} disabled={busy}><FileText size={18} /><span>{item.title}</span><ArrowRight size={16} /></button>)}</aside>
    </div> : <section className="ppt-project">
      <div className="ppt-project-toolbar"><h2>{active.title}</h2><div className="ppt-actions">
        <button title="复制恢复链接" onClick={() => void perform(async () => { await navigator.clipboard.writeText(`${location.origin}/ppt#project=${active.id}&key=${active.token}`); setNotice(temporaryStorage ? '链接已复制，仅在临时项目仍存在时有效，不能恢复已清空的文件。' : '恢复链接已复制，请妥善保管。') })}><Copy size={17} />恢复链接</button>
        {running && <button disabled={busy} onClick={() => void perform(async () => { setProject(await api<Project>(`/projects/${active.id}/cancel`, active.token, { method: 'POST' })) })}><Pause size={17} />暂停</button>}
        {!running && <button disabled={busy} onClick={() => {
          if (window.confirm('永久删除此项目及其全部材料？')) void perform(async () => {
            await api(`/projects/${active.id}`, active.token, { method: 'DELETE' })
            const remaining = loadSaved().filter((item) => item.id !== active.id)
            localStorage.setItem(storageKey, JSON.stringify(remaining)); setSaved(remaining); newProject()
          })
        }}><Trash2 size={17} />删除</button>}
        <button onClick={newProject} disabled={busy}>新建项目</button>
      </div></div>
      <div className="ppt-status" role="status">{running && <Loader2 size={20} className="ppt-spin" />}<strong>{project ? labels[project.status] || project.status : '正在读取项目'}</strong>{project && <span>{project.storageMode === 'temporary' ? '临时项目 · 完成后请及时下载' : project.expiresAt ? `保留至 ${new Date(project.expiresAt).toLocaleDateString('zh-CN')}` : ''}</span>}</div>
      {project?.error && <p className="ppt-error">{project.error}</p>}
      {specAvailable && project && (['planning_complete', 'draft_ready', 'review_needs_human', 'complete', 'ready_to_export', 'edits_pending'].includes(project.status) || (['failed', 'paused'].includes(project.status) && (project.activeStage === 'spec' || (project.specApproval && ['authoring', 'postprocess', 'visual_review', 'export'].includes(String(project.activeStage)))))) && <button disabled={busy} onClick={() => void perform(async () => {
        setProject(await api<Project>('/projects/' + active.id + '/spec/open', active.token, { method: 'POST' }))
      })}><FileText size={17} />审阅与修改完整规范</button>}
      {project?.status === 'preparing_spec' && <p className="ppt-message" role="status">{project.progress?.message || '正在准备完整规范'}</p>}
      {project?.status === 'awaiting_spec_review' && <PptSpecReview key={active.id} id={active.id} token={active.token} summary={project.specReview?.summary} onChanged={() => void perform(async () => { setProject(await api<Project>('/projects/' + active.id, active.token)) })} />}
      {project?.status === 'preparing_visual_review' && <p className="ppt-message" role="status">{project.progress?.message || '正在准备实际页面截图'}{project.progress?.page ? ` · 修正 ${project.progress.round}/2 轮` : ''}</p>}
      {project?.status === 'preparing_revision' && <p className="ppt-message" role="status">{project.progress?.message || '正在读取已确认的修改'}</p>}
      {project?.status === 'draft' && <div className="ppt-draft-files">
        <ul className="ppt-file-list">{project.files.map((file) => <li key={file.name}><FileText size={16} /><span>{file.originalName}</span></li>)}</ul>
        <label htmlFor="ppt-retry-files">补充或重试上传材料</label>
        <input id="ppt-retry-files" type="file" multiple accept=".pdf,.docx,.pptx" disabled={busy} onChange={(event) => { setFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
        <ul className="ppt-file-list">{files.map((file, index) => <li key={`${index}-${file.name}`}><FileText size={16} /><span>{file.name}</span><button type="button" disabled={busy} title={`移除 ${file.name}`} aria-label={`移除 ${file.name}`} onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={16} /></button></li>)}</ul>
        {files.length > 0 && <button disabled={busy} onClick={() => void perform(async () => {
          const form = new FormData(); files.forEach((file) => form.append('files', file))
          setProject(await api<Project>(`/projects/${active.id}/files`, active.token, { method: 'POST', body: form })); setFiles([])
        })}><UploadCloud size={17} />上传 {files.length} 个待上传文件</button>}
      </div>}
      {project && ['draft', 'failed', 'paused'].includes(project.status) && <button className="ppt-primary" disabled={busy || !available || (project.status === 'draft' && files.length > 0)} onClick={() => void perform(async () => { setProject(await api<Project>(`/projects/${active.id}/start`, active.token, { method: 'POST' })) })}><Play size={17} />继续当前阶段</button>}
      {project && ['failed', 'paused'].includes(project.status) && project.activeStage === 'revision' && project.revision && <button disabled={busy} onClick={() => void perform(async () => {
        setRevisionText(Object.fromEntries(project.revision!.items.filter((item) => item.origin === 'request').map((item) => [`${active.id}:${item.page}`, item.instruction])))
        setProject(await api<Project>(`/projects/${active.id}/revisions/${project.revision!.id}/confirm`, active.token, { method: 'POST', body: JSON.stringify({ accept: false }) })); setRevisionAttempt((value) => value + 1)
      })}><ArrowLeft size={17} />调整修改要求</button>}
      {waiting && !currentConfirmation && <p role="status">正在打开原生确认页面…</p>}
      {waiting && currentConfirmation?.error && <div><p className="ppt-error" role="alert">{currentConfirmation.error}</p><button onClick={() => setConfirmAttempt((value) => value + 1)}>重新打开确认页</button></div>}
      {waiting && currentConfirmation?.url && <iframe key={`${active.id}-${project?.status}-${confirmAttempt}`} className="ppt-native-confirm" src={currentConfirmation.url} title={project?.status === 'awaiting_stage1' ? 'PPT-master 目标与模板确认' : 'PPT-master 设计与制作方案确认'} sandbox="allow-scripts allow-same-origin allow-forms" />}
      {project?.status === 'planning_complete' && (authoringAvailable
        ? <button className="ppt-primary" disabled={busy} onClick={() => void perform(async () => { setProject(await api<Project>(`/projects/${active.id}/start`, active.token, { method: 'POST' })) })}><Play size={17} />开始逐页制作</button>
        : <p className="ppt-message">规划已确认并保存。当前环境尚未启用逐页制作。</p>)}
      {project?.status === 'draft_ready' && <><p className="ppt-message">已生成 {project.authoring?.slideCount} 页，结构检查通过{project.authoring?.warnings ? `，另有 ${project.authoring.warnings} 项建议待复核` : ''}。当前为初稿。</p>{postprocessAvailable && <button className="ppt-primary" disabled={busy} onClick={() => void perform(async () => { setProject(await api<Project>(`/projects/${active.id}/start`, active.token, { method: 'POST' })) })}><Play size={17} />继续讲稿与动画</button>}</>}
      {project?.production && !['awaiting_spec_review', 'preparing_spec'].includes(project.status) && <div className="ppt-production-summary"><p className="ppt-message">{project.production.notes === 'complete' ? '逐页讲稿已准备。' : '讲稿已按确认设置关闭。'}{project.production.motion.mode === 'sidecar' ? '原生动画配置已通过校验。' : '保留原生默认转场。'}</p><details><summary>查看动画处理记录</summary><p>{project.production.motion.reason}</p></details></div>}
      {project?.status === 'awaiting_visual_review' && (visualAvailable ? <button className="ppt-primary" disabled={busy} onClick={() => void perform(async () => { setProject(await api<Project>(`/projects/${active.id}/start`, active.token, { method: 'POST' })) })}><Play size={17} />开始视觉审查</button> : <p className="ppt-message">页面、讲稿和动画已保存。当前环境未启用视觉审查，暂不放行终稿。</p>)}
      {project?.review && <section className="ppt-review-results" aria-label="视觉审查报告"><h3>视觉审查</h3>
        {project.review.status !== 'passed' && <p className="ppt-error">以下问题未解决。涉及内容、结构或设计方向的调整需要你确认，当前不会导出终稿。</p>}
        {project.review.pages.map((page, index) => <details key={page.page} open={!['ok', 'fixed'].includes(page.status)}><summary>第 {index + 1} 页 · {page.status === 'ok' ? '通过' : page.status === 'fixed' ? '修正后通过' : page.status === 'render_failed' ? '截图检查失败' : '待处理'}{page.repairs ? ` · 已修正 ${page.repairs} 轮` : ''}</summary>
          {page.findings.map((finding, i) => <p key={`finding-${i}`}>{finding.rule}：{finding.evidence}</p>)}
          {page.needs_human_items.map((item, i) => <p key={`suggestion-${i}`}>建议：{item.suggested_fix_summary}</p>)}
          {!page.findings.length && !page.needs_human_items.length && <p>未发现阻止导出的视觉问题。</p>}
        </details>)}
      </section>}
      {project?.status === 'ready_to_export' && postprocessAvailable && <button className="ppt-primary" disabled={busy} onClick={() => void perform(async () => { setProject(await api<Project>(`/projects/${active.id}/start`, active.token, { method: 'POST' })) })}><Download size={17} />导出 PPTX</button>}
      {project?.status === 'complete' && <><p className="ppt-message">{project.artifact?.slideCount} 页 PPTX 已通过原生文件检查。{project.visualReview ? '已通过逐页视觉审查。' : '此项目未启用视觉审查。'}{project.artifact?.status === 'passed-with-warnings' ? '原生检查仍有建议项，建议下载后复核。' : ''}</p><button className="ppt-primary" disabled={busy} onClick={() => void perform(download)}><Download size={17} />下载 PPTX</button></>}
      {project?.status === 'awaiting_revision_confirmation' && project.revision && <section className="ppt-revision" aria-label="确认本次修改">
        <h3>确认本次修改</h3>
        <ol className="ppt-revision-list">{project.revision.items.map((item, index) => <li key={index}><strong>{item.page}{item.elementId ? ` · ${item.elementId}` : ''}</strong><p>{item.instruction}</p></li>)}</ol>
        <p className="ppt-message">仅修改以上页面及配套讲稿、动画。已确认的大纲和设计方向保持不变；若要求冲突，将停止并说明原因。</p>
        <div className="ppt-actions"><button className="ppt-primary" disabled={busy} onClick={() => void perform(async () => {
          setProject(await api<Project>(`/projects/${active.id}/revisions/${project.revision!.id}/confirm`, active.token, { method: 'POST', body: JSON.stringify({ accept: true }) })); setRevisionText({}); setRevisionInputs(null); setPreviewAttempt((value) => value + 1)
        })}><Check size={17} />确认修改并重新检查</button>
        <button disabled={busy} onClick={() => void perform(async () => {
          setRevisionText(Object.fromEntries(project.revision!.items.filter((item) => item.origin === 'request').map((item) => [`${active.id}:${item.page}`, item.instruction])))
          setProject(await api<Project>(`/projects/${active.id}/revisions/${project.revision!.id}/confirm`, active.token, { method: 'POST', body: JSON.stringify({ accept: false }) })); setRevisionAttempt((value) => value + 1)
        })}><ArrowLeft size={17} />返回修改</button></div>
      </section>}
      {canRevise && <section className="ppt-revision" aria-label="逐页修改">
        <div className="ppt-project-toolbar"><h3>逐页修改</h3><button disabled={busy} onClick={() => setRevisionAttempt((value) => value + 1)}><RefreshCw size={17} />刷新批注</button></div>
        {revisionError && <p className="ppt-error" role="alert">{revisionError}</p>}
        {!revisionInputs && !revisionError && <p role="status">正在读取页面与批注…</p>}
        {revisionInputs && <form onSubmit={(event) => { event.preventDefault(); void perform(async () => {
          const requests = revisionInputs.pages.filter((page) => revisionText[`${active.id}:${page}`]?.trim()).map((page) => ({ page, instruction: revisionText[`${active.id}:${page}`] }))
          setProject(await api<Project>(`/projects/${active.id}/revisions`, active.token, { method: 'POST', body: JSON.stringify({ fingerprint: revisionInputs.fingerprint, requests }) }))
        }) }}>
          {revisionInputs.annotations.length > 0 && <div><h4>已保存的元素批注</h4><ul className="ppt-revision-list">{revisionInputs.annotations.map((item, index) => <li key={index}><strong>{item.page} · {item.elementId}</strong><p>{item.instruction}</p></li>)}</ul></div>}
          {revisionInputs.pages.map((page, index) => <details key={page} className="ppt-revision-page" open={project?.review?.pages.find((entry) => entry.page === page)?.status === 'needs_human' || undefined}>
            <summary>第 {index + 1} 页{revisionText[`${active.id}:${page}`]?.trim() ? ' · 已填写修改' : ''}</summary>
            <label htmlFor={`revision-${index}`}>修改要求</label><textarea id={`revision-${index}`} rows={3} maxLength={10000} disabled={busy} value={revisionText[`${active.id}:${page}`] || ''} onChange={(event) => setRevisionText((value) => ({ ...value, [`${active.id}:${page}`]: event.target.value }))} />
          </details>)}
          <button className="ppt-primary" disabled={busy || (!revisionInputs.annotations.length && !revisionInputs.pages.some((page) => revisionText[`${active.id}:${page}`]?.trim()))}><MessageSquare size={17} />核对本次修改</button>
        </form>}
      </section>}
      {canPreview && <div className="ppt-preview-section">
        <div className="ppt-project-toolbar"><h3>原生预览</h3><button disabled={busy} onClick={() => setPreviewAttempt((value) => value + 1)}><RefreshCw size={17} />重新加载</button></div>
        <p className="ppt-message">{annotationMode ? '元素批注已开放；直接编辑尚未开放。批注保存后仍需确认执行。' : '当前阶段为只读预览。'}</p>
        {!currentPreview && <p role="status">正在打开预览…</p>}
        {currentPreview?.error && <p className="ppt-error" role="alert">{currentPreview.error}</p>}
        {currentPreview?.url && <iframe key={currentPreview.key} className={`ppt-native-confirm${annotationMode ? ' ppt-annotation-frame' : ''}`} src={currentPreview.url} title={annotationMode ? 'PPT-master 原生元素批注' : 'PPT-master 原生只读预览'} sandbox="allow-scripts allow-same-origin" />}
      </div>}
    </section>}
  </main>
}
