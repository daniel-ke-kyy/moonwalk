import { useEffect, useRef, useState } from 'react'
import { BookOpen, ListChecks, Pause, Play } from 'lucide-react'
import type { PaperSceneController } from './paperSceneEngine'

export function PaperScene({ busy, dragging }: { busy: boolean; dragging: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const controller = useRef<PaperSceneController | null>(null)
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [mode, setMode] = useState<'material' | 'questions'>('material')
  const [ready, setReady] = useState(false)
  const stateRef = useRef({ paused, mode, busy, dragging })

  useEffect(() => {
    stateRef.current = { paused, mode, busy, dragging }
    controller.current?.update(stateRef.current)
  }, [paused, mode, busy, dragging])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const respectPreference = () => setPaused(media.matches)
    media.addEventListener('change', respectPreference)
    let disposed = false
    import('./paperSceneEngine').then(({ createPaperScene }) => {
      if (disposed || !hostRef.current) return
      try {
        controller.current = createPaperScene(hostRef.current, stateRef.current)
        setReady(true)
      } catch {
        // Upload remains fully usable when WebGL is unavailable.
        setReady(false)
      }
    }).catch(() => setReady(false))
    return () => {
      disposed = true
      media.removeEventListener('change', respectPreference)
      controller.current?.dispose()
      controller.current = null
    }
  }, [])

  return (
    <>
      <div className={`mw-scene ${ready ? 'is-ready' : ''}`} ref={hostRef} aria-hidden="true">
        <div className="mw-paper-fallback mw-paper-fallback-left">
          <span>学习材料 / 示例</span><h3>记忆与学习</h3>
          <p>主动回忆</p><p>间隔复习</p><p>反馈修正</p>
        </div>
        <div className="mw-paper-fallback mw-paper-fallback-right">
          <span>开放式追问 / 示例</span><h3>答对了，<br />就理解了吗？</h3>
          <p>什么证据能支持你的判断？</p>
        </div>
      </div>
      <div className="mw-scene-toolbar">
        <div className="mw-scene-tabs" role="group" aria-label="示例场景">
          <button type="button" aria-pressed={mode === 'material'} onClick={() => setMode('material')} disabled={busy}>
            <BookOpen size={15} />材料
          </button>
          <button type="button" aria-pressed={mode === 'questions'} onClick={() => setMode('questions')} disabled={busy}>
            <ListChecks size={15} />问题
          </button>
        </div>
        <span className="mw-scene-caption">示例预览</span>
        <button type="button" className="mw-motion-toggle" onClick={() => setPaused(!paused)}
          aria-label={paused ? '播放场景动画' : '暂停场景动画'} title={paused ? '播放场景动画' : '暂停场景动画'}>
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
      </div>
    </>
  )
}
