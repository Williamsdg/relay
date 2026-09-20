import { useCallback, useEffect, useState } from 'react'
import { virtualPad, type PadButton } from '../stream/virtualPad.js'

/**
 * On-screen controller buttons.
 *
 * The Xbox button matters most: without a physical controller there is no
 * other way to open the guide, and the guide is how you close a game, switch
 * accounts, or get back to the dashboard.
 *
 * Presses are held while the pointer is down rather than fired on click, so
 * holding a direction actually scrolls a menu the way it would on a pad.
 */

interface PadKeyProps {
  button: PadButton
  label: string
  title?: string
  className?: string
}

function PadKey({ button, label, title, className = '' }: PadKeyProps) {
  const [held, setHeld] = useState(false)

  const down = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      // Keep receiving the release even if the pointer slides off the button.
      event.currentTarget.setPointerCapture(event.pointerId)
      setHeld(true)
      virtualPad.press(button)
    },
    [button],
  )

  const up = useCallback(() => {
    setHeld(false)
    virtualPad.release(button)
  }, [button])

  // A press must not survive the component unmounting mid-hold.
  useEffect(() => () => virtualPad.release(button), [button])

  return (
    <button
      className={`padkey ${className} ${held ? 'held' : ''}`}
      title={title ?? label}
      aria-label={title ?? label}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      {label}
    </button>
  )
}

export function ControlPad({ onClose }: { onClose: () => void }) {
  return (
    <div className="controlpad" role="group" aria-label="On-screen controller">
      <div className="controlpad-head">
        <span className="muted small">On-screen controller</span>
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>
          Hide
        </button>
      </div>

      <div className="controlpad-body">
        <div className="dpad" role="group" aria-label="D-pad">
          <PadKey button="DPadUp" label="↑" title="D-pad up" className="dpad-up" />
          <PadKey button="DPadLeft" label="←" title="D-pad left" className="dpad-left" />
          <PadKey button="DPadRight" label="→" title="D-pad right" className="dpad-right" />
          <PadKey button="DPadDown" label="↓" title="D-pad down" className="dpad-down" />
        </div>

        <div className="system-keys">
          <PadKey button="View" label="View" />
          <PadKey button="Nexus" label="Xbox" title="Xbox button — opens the guide" className="nexus" />
          <PadKey button="Menu" label="Menu" />
        </div>

        <div className="face-keys" role="group" aria-label="Face buttons">
          <PadKey button="Y" label="Y" className="face-y" />
          <PadKey button="X" label="X" className="face-x" />
          <PadKey button="B" label="B" className="face-b" />
          <PadKey button="A" label="A" className="face-a" />
        </div>

        <div className="shoulder-keys">
          <PadKey button="LeftShoulder" label="LB" />
          <PadKey button="RightShoulder" label="RB" />
        </div>
      </div>
    </div>
  )
}
