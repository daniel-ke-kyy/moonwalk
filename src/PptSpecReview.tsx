import { useEffect, useState } from 'react'
import { Check, MessageSquare, RefreshCw } from 'lucide-react'

type Summary = {
  sha256: string; drafts: string[]; annotations: number; unreadEdits: boolean; errors: string[];
  global: boolean; pages: number[]; pageCount: number; changed: { key: string; title: string }[];
}
type Props = { id: string; token: string; summary?: string; onChanged: () => void }

export function PptSpecReview({ id, token, summary: message, onChanged }: Props) {
  const [url, setUrl] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    const headers = { Authorization: 'Bearer ' + token }
    async function load() {
      try {
        const session = await fetch('/api/ppt/projects/' + id + '/spec-session', { method: 'POST', headers })
        const body = await session.json()
        if (!session.ok) throw new Error(body.error)
        const response = await fetch('/api/ppt/projects/' + id + '/spec/summary', { headers })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error)
        if (alive) { setUrl(body.url); setSummary(result); setError('') }
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : '规范读取失败。') }
    }
    void load()
    return () => { alive = false }
  }, [id, token, attempt])
  async function submit(action: 'apply' | 'confirm') {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/ppt/projects/' + id + '/spec/' + action, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: summary?.sha256 }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      onChanged()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '提交失败。'); setSummary(null) }
    finally { setBusy(false) }
  }
  const pending = !summary || summary.drafts.length > 0 || summary.annotations > 0 || summary.unreadEdits || summary.errors.length > 0
  return <section className="ppt-spec-review" aria-label="完整设计规范审阅">
    <div className="ppt-project-toolbar"><h3>完整设计规范</h3>
      <button disabled={busy} onClick={() => { setSummary(null); setAttempt((n) => n + 1) }}><RefreshCw size={17} />核对最新变更</button>
    </div>
    {message && <p className="ppt-message">{message}</p>}
    {error && <p className="ppt-error" role="alert">{error}</p>}
    {summary && <div className="ppt-spec-summary">
      <p>确认后共 {summary.pageCount} 页 · {summary.global ? '整套重新制作' : summary.pages.length ? '重新制作第 ' + summary.pages.join('、') + ' 页' : '页面内容未变化'} · 重新处理讲稿、动画与导出</p>
      {summary.changed.length > 0 && <details><summary>变更范围（{summary.changed.length} 项）</summary><ul>{summary.changed.map((item) => <li key={item.key}>{item.title.replace(/^#+\s*/, '')}</li>)}</ul></details>}
      {summary.drafts.length > 0 && <p className="ppt-error">还有 {summary.drafts.length} 个暂存草稿未应用。</p>}
      {(summary.annotations > 0 || summary.unreadEdits) && <p className="ppt-message">{summary.annotations} 条待处理批注{summary.unreadEdits ? '，直接编辑的内容还需要关联核对' : ''}。</p>}
      {summary.errors.length > 0 && <details open><summary>规范格式待修正</summary><ul>{summary.errors.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
    </div>}
    <div className="ppt-actions">
      <button disabled={busy || !summary || summary.drafts.length > 0} onClick={() => void submit('apply')}><MessageSquare size={17} />应用批注并核对规范</button>
      <button className="ppt-primary" disabled={busy || pending} onClick={() => void submit('confirm')}><Check size={17} />确认此版规范并制作</button>
    </div>
    {url ? <iframe className="ppt-native-confirm ppt-spec-frame" src={url} title="PPT-master 完整规范编辑与批注" sandbox="allow-scripts allow-same-origin allow-forms" /> : <p role="status">正在打开原生规范编辑页…</p>}
  </section>
}
