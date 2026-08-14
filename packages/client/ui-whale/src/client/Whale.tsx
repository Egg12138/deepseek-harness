/**
 * The floating whale surface: a draggable, pose-aware overlay entry. Purely
 * presentational — session facts arrive through the framework `useSessions`
 * hook, the New Session action through the registrant inject face, and hover
 * hide delay through a component-local timeout. No business state lives here.
 */
import { useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Whale.module.css'

/** Registrant inject face: the New Session action backed by the workspaces service. */
export interface WhaleInjected {
  newSession: () => void
}

/** Composed component props: the shell.overlay runtime share plus the injected action. */
export type WhaleProps = PropsRuntime<'shell.overlay'> & WhaleInjected

/** One transient bubble particle spawned when a drag releases. */
interface Bubble {
  id: number
  x: number
  y: number
  size: number
  drift: number
  delay: number
}

/** Pointer-drag bookkeeping: grab offset within the sprite plus the gesture origin. */
interface DragState {
  grabX: number
  grabY: number
  startX: number
  startY: number
}

/** Sprite bounding size in px (the container is square). */
const SPRITE_SIZE = 64

/**
 * Render the draggable whale. Position is in-memory only (resets to the
 * anchored corner on reload); `running` drives the active/idle pose.
 * @param props - runtime share (`useSessions`) plus the injected `newSession`.
 * @returns the overlay element, or the reveal pill while hidden.
 */
export function Whale({ useSessions, newSession }: WhaleProps) {
  const sessionTitle = useSessions((s) => {
    const id = s.current
    return id && s.byId[id] ? s.byId[id].displayTitle : undefined
  })
  const running = useSessions((s) => {
    const id = s.current
    return id && s.byId[id] ? s.byId[id].running : false
  })

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [hidden, setHidden] = useState(false)
  const [moved, setMoved] = useState(false)
  const [hover, setHover] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bubbleSeq = useRef(0)

  function clearHide() {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  function onEnter() {
    clearHide()
    setHover(true)
  }
  function onLeave() {
    clearHide()
    hideTimer.current = setTimeout(() => { setHover(false) }, 250)
  }

  function spawnBubbles() {
    const next: Bubble[] = []
    for (let i = 0; i < 10; i++) {
      next.push({
        id: bubbleSeq.current++,
        x: Math.round(Math.random() * 40 - 20),
        y: Math.round(Math.random() * -8),
        size: Math.round(4 + Math.random() * 7),
        drift: Math.round(Math.random() * 60 - 30),
        delay: Math.round(Math.random() * 250),
      })
    }
    setBubbles(b => [...b, ...next])
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    setMoved(false)
    setDrag({ grabX: e.clientX - rect.left, grabY: e.clientY - rect.top, startX: e.clientX, startY: e.clientY })
    setPos({ x: rect.left, y: rect.top })
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag === null) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!moved && dx * dx + dy * dy > 25) setMoved(true)
    const doc = e.currentTarget.ownerDocument
    const maxX = doc.documentElement.clientWidth - SPRITE_SIZE
    const maxY = doc.documentElement.clientHeight - SPRITE_SIZE
    const x = Math.max(0, Math.min(e.clientX - drag.grabX, maxX))
    const y = Math.max(0, Math.min(e.clientY - drag.grabY, maxY))
    setPos({ x, y })
  }
  function onPointerUp() {
    if (moved) spawnBubbles()
    setDrag(null)
    setMoved(false)
  }
  function onDoubleClick() {
    setPos(null)
  }

  if (hidden) {
    return createPortal(
      <button
        type="button"
        className={css.reveal}
        aria-label="Show whale"
        title="Show whale"
        onClick={() => { setHidden(false) }}
      >
        🐳
      </button>,
      document.body,
    )
  }

  const className = clsx(
    css.whale,
    pos === null && css.anchored,
    drag !== null && css.dragging,
    hover && css.hover,
    !running && css.idle,
  )
  const style: CSSProperties | undefined = pos === null
    ? undefined
    : { left: `${pos.x}px`, top: `${pos.y}px` }

  return createPortal(
    <div
      className={className}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {sessionTitle !== undefined && <div className={css.bubble}>{sessionTitle}</div>}
      <div className={css.controls} onPointerDown={(e) => { e.stopPropagation() }}>
        <button type="button" className={css.btn} aria-label="New session" title="New session" onClick={newSession}>
          ➕
        </button>
        <button
          type="button"
          className={css.btn}
          aria-label="Hide whale"
          title="Hide whale"
          onClick={() => { setBubbles([]); setHidden(true) }}
        >
          ✕
        </button>
      </div>
      {bubbles.length > 0 && (
        <div className={css.particles}>
          {bubbles.map(b => (
            <span
              key={b.id}
              className={css.particle}
              style={{
                left: `${b.x}px`,
                top: `${b.y}px`,
                width: `${b.size}px`,
                height: `${b.size}px`,
                '--bx': `${b.drift}px`,
                animationDelay: `${b.delay}ms`,
              } as CSSProperties}
              onAnimationEnd={() => { setBubbles(list => list.filter(x => x.id !== b.id)) }}
            />
          ))}
        </div>
      )}
      {!running && <span className={css.zzz} aria-hidden>💤</span>}
      <div className={css.sprite} aria-hidden>{running ? '🐳' : '🐋'}</div>
    </div>,
    document.body,
  )
}
