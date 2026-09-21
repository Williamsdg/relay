import { useCallback, useEffect, useRef, useState } from 'react'
import { virtualPad, type PadButton } from '@core/stream/virtualPad.js'

/**
 * Touch controls, laid out for thumbs rather than a mouse.
 *
 * The sticks are floating rather than fixed: wherever a thumb lands inside the
 * zone becomes the centre, and the stick tracks relative to that. A fixed
 * centre forces the user to look down to find it, which is exactly what you
 * cannot do while playing.
 *
 * Every touch handler is passive:false and calls preventDefault, because iOS
 * will otherwise treat a fast drag as a scroll or a double-tap as a zoom and
 * steal the input mid-game.
 */

/** Travel in pixels that counts as full deflection. */
const STICK_RADIUS = 52

interface StickProps {
  side: 'left' | 'right'
  xAxis: 'LeftThumbXAxis' | 'RightThumbXAxis'
  yAxis: 'LeftThumbYAxis' | 'RightThumbYAxis'
  press: PadButton
}

function Stick({ side, xAxis, yAxis, press }: StickProps) {
  const zoneRef = useRef<HTMLDivElement>(null)
  const touchId = useRef<number | null>(null)
  const origin = useRef({ x: 0, y: 0 })
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null)
  const tapStart = useRef(0)

  useEffect(() => {
    const zone = zoneRef.current
    if (!zone) return

    const begin = (event: TouchEvent) => {
      if (touchId.current !== null) return
      const touch = event.changedTouches[0]
      touchId.current = touch.identifier
      origin.current = { x: touch.clientX, y: touch.clientY }
      tapStart.current = performance.now()
      setKnob({ x: 0, y: 0 })
      event.preventDefault()
    }

    const move = (event: TouchEvent) => {
      if (touchId.current === null) return
      for (const touch of Array.from(event.changedTouches)) {
        if (touch.identifier !== touchId.current) continue
        const dx = touch.clientX - origin.current.x
        const dy = touch.clientY - origin.current.y
        const distance = Math.hypot(dx, dy)
        const scale = distance > STICK_RADIUS ? STICK_RADIUS / distance : 1
        const cx = dx * scale
        const cy = dy * scale
        setKnob({ x: cx, y: cy })
        virtualPad.setAxis(xAxis, cx / STICK_RADIUS)
        // Screen Y grows downward; the encoder inverts again for the wire, so
        // pass the browser-facing sign here.
        virtualPad.setAxis(yAxis, cy / STICK_RADIUS)
        event.preventDefault()
      }
    }

    const end = (event: TouchEvent) => {
      if (touchId.current === null) return
      for (const touch of Array.from(event.changedTouches)) {
        if (touch.identifier !== touchId.current) continue
        const travelled = Math.hypot(
          touch.clientX - origin.current.x,
          touch.clientY - origin.current.y,
        )
        // A quick tap that barely moved is a stick click, not a nudge.
        if (travelled < 12 && performance.now() - tapStart.current < 250) {
          virtualPad.tap(press)
        }
        touchId.current = null
        setKnob(null)
        virtualPad.setAxis(xAxis, 0)
        virtualPad.setAxis(yAxis, 0)
        event.preventDefault()
      }
    }

    const opts = { passive: false } as const
    zone.addEventListener('touchstart', begin, opts)
    zone.addEventListener('touchmove', move, opts)
    zone.addEventListener('touchend', end, opts)
    zone.addEventListener('touchcancel', end, opts)
    return () => {
      zone.removeEventListener('touchstart', begin)
      zone.removeEventListener('touchmove', move)
      zone.removeEventListener('touchend', end)
      zone.removeEventListener('touchcancel', end)
      virtualPad.setAxis(xAxis, 0)
      virtualPad.setAxis(yAxis, 0)
    }
  }, [xAxis, yAxis, press])

  return (
    <div ref={zoneRef} className={`stick-zone stick-${side}`}>
      <div className={`stick-base ${knob ? 'active' : ''}`}>
        <div
          className="stick-knob"
          style={knob ? { transform: `translate(${knob.x}px, ${knob.y}px)` } : undefined}
        />
      </div>
    </div>
  )
}

function TouchButton({
  button,
  label,
  className = '',
}: {
  button: PadButton
  label: string
  className?: string
}) {
  const [held, setHeld] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const down = (e: TouchEvent) => {
      setHeld(true)
      virtualPad.press(button)
      e.preventDefault()
    }
    const up = (e: TouchEvent) => {
      setHeld(false)
      virtualPad.release(button)
      e.preventDefault()
    }
    const opts = { passive: false } as const
    el.addEventListener('touchstart', down, opts)
    el.addEventListener('touchend', up, opts)
    el.addEventListener('touchcancel', up, opts)
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchend', up)
      el.removeEventListener('touchcancel', up)
      // A press must not survive the control disappearing.
      virtualPad.release(button)
    }
  }, [button])

  return (
    <button ref={ref} className={`touch-btn ${className} ${held ? 'held' : ''}`}>
      {label}
    </button>
  )
}

/** Triggers are analogue on a real pad; a touch reports full deflection. */
function TouchTrigger({
  axis,
  label,
  className = '',
}: {
  axis: 'LeftTrigger' | 'RightTrigger'
  label: string
  className?: string
}) {
  const [held, setHeld] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const down = (e: TouchEvent) => {
      setHeld(true)
      virtualPad.setAxis(axis, 1)
      e.preventDefault()
    }
    const up = (e: TouchEvent) => {
      setHeld(false)
      virtualPad.setAxis(axis, 0)
      e.preventDefault()
    }
    const opts = { passive: false } as const
    el.addEventListener('touchstart', down, opts)
    el.addEventListener('touchend', up, opts)
    el.addEventListener('touchcancel', up, opts)
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchend', up)
      el.removeEventListener('touchcancel', up)
      virtualPad.setAxis(axis, 0)
    }
  }, [axis])

  return (
    <button ref={ref} className={`touch-btn trigger ${className} ${held ? 'held' : ''}`}>
      {label}
    </button>
  )
}

export function TouchPad({ visible }: { visible: boolean }) {
  // Never leave a control latched when the overlay is dismissed.
  useEffect(() => {
    if (!visible) virtualPad.reset()
  }, [visible])

  const stop = useCallback((e: React.TouchEvent) => e.stopPropagation(), [])

  if (!visible) return null

  return (
    <div className="touchpad" onTouchStart={stop}>
      <div className="shoulder-row left">
        <TouchTrigger axis="LeftTrigger" label="LT" />
        <TouchButton button="LeftShoulder" label="LB" />
      </div>
      <div className="shoulder-row right">
        <TouchButton button="RightShoulder" label="RB" />
        <TouchTrigger axis="RightTrigger" label="RT" />
      </div>

      <Stick side="left" xAxis="LeftThumbXAxis" yAxis="LeftThumbYAxis" press="LeftThumb" />
      <Stick side="right" xAxis="RightThumbXAxis" yAxis="RightThumbYAxis" press="RightThumb" />

      <div className="dpad-cluster">
        <TouchButton button="DPadUp" label="▲" className="d-up" />
        <TouchButton button="DPadLeft" label="◀" className="d-left" />
        <TouchButton button="DPadRight" label="▶" className="d-right" />
        <TouchButton button="DPadDown" label="▼" className="d-down" />
      </div>

      <div className="face-cluster">
        <TouchButton button="Y" label="Y" className="f-y" />
        <TouchButton button="X" label="X" className="f-x" />
        <TouchButton button="B" label="B" className="f-b" />
        <TouchButton button="A" label="A" className="f-a" />
      </div>

      <div className="system-row">
        <TouchButton button="View" label="View" className="small" />
        <TouchButton button="Nexus" label="Xbox" className="small nexus" />
        <TouchButton button="Menu" label="Menu" className="small" />
      </div>
    </div>
  )
}
