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
import type { SessionProjectionMap } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
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

/** One stat chip rendered in a side column. */
interface StatChip {
  /** Stable render key and displayed label. */
  label: string
  /** Pre-formatted display value. */
  value: string
  /** Hover-only tier: hidden until the whale is hovered. */
  secondary: boolean
}

/** Both side-rail chip columns (primary tier plus hover-only extras). */
interface WhaleStats {
  left: StatChip[]
  right: StatChip[]
  /** Context-occupancy bar (always visible); null until pressure and capacity are both known. */
  context: { percent: number } | null
}

/** Compact token count: 517 / 12.2K / 1.2M (one decimal under three digits). */
function formatTokens(n: number): string {
  const scaled = (v: number): string => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Cache-hit share of the three disjoint prompt-side billing buckets; null while unbilled. */
function cacheHitPercent(usage: TokenUsageProjection): number | null {
  const denominator = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return denominator === 0
    ? null
    : Math.round(usage.cacheReadTokens / denominator * 100)
}

/** Approximate context occupancy percent; null until pressure and capacity are both known. */
function contextOccupancy(pressure: ContextPressureProjection | undefined): number | null {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (used === undefined || pressure?.contextWindow === undefined) return null
  return Math.min(100, Math.round(used / pressure.contextWindow * 100))
}

/** Context-alert threshold as a fraction of the route capacity (0..1). */
const CONTEXT_ALERT_THRESHOLD = 0.4
/** Severity at the threshold: mild, so the ramp stays gentle below it. */
const THRESHOLD_SEVERITY = 0.4
/** Occupancy fraction past the threshold that halves the remaining severity headroom. */
const SEVERITY_HALF_LIFE = 0.1

/**
 * Non-linear context severity: linear (mild) at or below the alert threshold,
 * then an exponential approach to critical above it. The two terms meet at the
 * threshold, so the curve is continuous; each `SEVERITY_HALF_LIFE` of extra
 * occupancy halves the headroom to critical.
 * @param u - context occupancy as a fraction (0..1).
 * @returns severity in 0..1.
 */
function contextSeverity(u: number): number {
  const clamped = Math.min(1, Math.max(0, u))
  if (clamped <= CONTEXT_ALERT_THRESHOLD) {
    return (clamped / CONTEXT_ALERT_THRESHOLD) * THRESHOLD_SEVERITY
  }
  const overshoot = clamped - CONTEXT_ALERT_THRESHOLD
  return 1 - (1 - THRESHOLD_SEVERITY) * 2 ** (-overshoot / SEVERITY_HALF_LIFE)
}

/** Health-bar hue sweep: green (0 severity) → amber → red (1 severity), dark enough for white text. */
function severityColor(severity: number): string {
  const hue = Math.round(130 * (1 - severity))
  return `hsl(${hue} 68% 40%)`
}

/**
 * Build the left/right stat columns from the current session's projection
 * baseline. Primary chips are always visible; secondary chips are the
 * hover-only extras. Returns null while the session has no projection baseline.
 * @param p - the current session's projection values (absent when no session).
 */
function deriveStats(p: Readonly<Partial<SessionProjectionMap>> | undefined): WhaleStats | null {
  if (p === undefined) return null
  const stats = p.sessionStats
  const usage = p.tokenUsage
  const occupancy = contextOccupancy(p.contextPressure)
  const hit = usage === undefined ? null : cacheHitPercent(usage)

  const left: StatChip[] = []
  const right: StatChip[] = []
  if (stats !== undefined) {
    left.push({ label: '步骤', value: String(stats.steps), secondary: false })
  }
  if (hit !== null) {
    right.push({ label: '缓存', value: `${hit}%`, secondary: false })
  }
  if (usage !== undefined) {
    right.push({ label: '输出', value: formatTokens(usage.outputTokens), secondary: false })
  }
  if (stats !== undefined) {
    left.push({ label: '轮次', value: String(stats.turns), secondary: true })
    left.push({ label: '模型', value: formatDuration(stats.llmMs), secondary: true })
    right.push({ label: '工具', value: formatDuration(stats.toolMs), secondary: true })
    if (stats.ttftSteps > 0) {
      right.push({ label: '首字', value: formatDuration(stats.ttftMs / stats.ttftSteps), secondary: true })
    }
  }

  if (left.length === 0 && right.length === 0 && occupancy === null) return null
  return { left, right, context: occupancy === null ? null : { percent: occupancy } }
}

/** Render one text chip (label + value). */
function StatChipView({ chip }: { chip: StatChip }) {
  return (
    <span className={clsx(css.chip, chip.secondary && css.chipSecondary)}>
      <span className={css.chipLabel}>{chip.label}</span>
      <span className={css.chipValue}>{chip.value}</span>
    </span>
  )
}

/** Render the context pill, colored by non-linear severity (content-sized, no fixed track). */
function ContextPill({ percent }: { percent: number }) {
  const background = severityColor(contextSeverity(percent / 100))
  return (
    <span className={css.ctx} style={{ background }} title={`上下文占用 ${percent}%`}>
      <span className={css.ctxLabel}>上下文</span>
      <span className={css.ctxValue}>{percent}%</span>
    </span>
  )
}

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
  const projections = useSessions((s) => {
    const id = s.current
    return id && s.byId[id] ? s.byId[id].projectionValues : undefined
  })
  const cwd = useSessions((s) => {
    const id = s.current
    return id && s.byId[id] ? s.byId[id].cwd : undefined
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
  const stats = deriveStats(projections)

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
      {sessionTitle !== undefined && (
        <div className={css.caption}>
          <div className={css.bubble}>{sessionTitle}</div>
          {cwd !== undefined && <div className={css.cwd} title={cwd}>{cwd}</div>}
        </div>
      )}
      {stats !== null && (
        <>
          <div className={css.statsLeft}>
            {stats.left.filter(chip => !chip.secondary).map(chip => (
              <StatChipView key={chip.label} chip={chip} />
            ))}
            {stats.context !== null && <ContextPill percent={stats.context.percent} />}
            {stats.left.filter(chip => chip.secondary).map(chip => (
              <StatChipView key={chip.label} chip={chip} />
            ))}
          </div>
          <div className={css.statsRight}>
            {stats.right.filter(chip => !chip.secondary).map(chip => (
              <StatChipView key={chip.label} chip={chip} />
            ))}
            {stats.right.filter(chip => chip.secondary).map(chip => (
              <StatChipView key={chip.label} chip={chip} />
            ))}
          </div>
        </>
      )}
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
