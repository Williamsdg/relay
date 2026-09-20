/**
 * Keyboard and mouse as a controller.
 *
 * Bindings are keyed by `KeyboardEvent.code` rather than `key`, so they follow
 * physical key position and keep working on non-QWERTY layouts and when a
 * modifier is held.
 *
 * The sticks are the interesting part: a keyboard has no analogue range, so a
 * held direction ramps toward full deflection instead of snapping, which makes
 * menus and camera movement far less twitchy than a raw on/off axis.
 */
import { virtualPad, type PadAxis, type PadButton } from './virtualPad.js'

/** Either a button press or a push along one axis. */
export type Binding =
  | { kind: 'button'; button: PadButton }
  | { kind: 'axis'; axis: PadAxis; value: number }

export type Bindings = Record<string, Binding>

export const DEFAULT_BINDINGS: Bindings = {
  // Left stick — movement
  KeyW: { kind: 'axis', axis: 'LeftThumbYAxis', value: -1 },
  KeyS: { kind: 'axis', axis: 'LeftThumbYAxis', value: 1 },
  KeyA: { kind: 'axis', axis: 'LeftThumbXAxis', value: -1 },
  KeyD: { kind: 'axis', axis: 'LeftThumbXAxis', value: 1 },

  // D-pad — arrows
  ArrowUp: { kind: 'button', button: 'DPadUp' },
  ArrowDown: { kind: 'button', button: 'DPadDown' },
  ArrowLeft: { kind: 'button', button: 'DPadLeft' },
  ArrowRight: { kind: 'button', button: 'DPadRight' },

  // Face buttons
  Space: { kind: 'button', button: 'A' },
  KeyF: { kind: 'button', button: 'B' },
  KeyR: { kind: 'button', button: 'X' },
  KeyC: { kind: 'button', button: 'Y' },

  // Shoulders and triggers
  KeyQ: { kind: 'button', button: 'LeftShoulder' },
  KeyE: { kind: 'button', button: 'RightShoulder' },
  ShiftLeft: { kind: 'axis', axis: 'LeftTrigger', value: 1 },
  KeyG: { kind: 'axis', axis: 'RightTrigger', value: 1 },

  // Sticks pressed in
  KeyZ: { kind: 'button', button: 'LeftThumb' },
  KeyV: { kind: 'button', button: 'RightThumb' },

  // System buttons. Escape is deliberately not bound — it releases pointer
  // lock, and stealing it would trap the cursor.
  Enter: { kind: 'button', button: 'Menu' },
  Backspace: { kind: 'button', button: 'View' },
  Home: { kind: 'button', button: 'Nexus' },
}

export interface KeyboardOptions {
  bindings: Bindings
  /** Right-stick degrees of travel per pixel of mouse movement. */
  mouseSensitivity: number
  /** Whether mouse movement drives the right stick. */
  mouseLook: boolean
}

export const DEFAULT_KEYBOARD_OPTIONS: KeyboardOptions = {
  bindings: DEFAULT_BINDINGS,
  mouseSensitivity: 0.06,
  mouseLook: true,
}

/** How fast a held key ramps a stick from centre to full, in seconds. */
const STICK_RAMP_SECONDS = 0.12
/** How fast the right stick falls back to centre once the mouse stops. */
const MOUSE_DECAY_PER_SECOND = 8

/**
 * Attach keyboard and mouse handling to an element. Returns a teardown
 * function; call it when the stream ends so no keys stay stuck down.
 */
export function attachKeyboard(
  target: HTMLElement,
  options: KeyboardOptions,
): () => void {
  const held = new Set<string>()
  /** Current ramped value per axis, so keys and mouse can share the axes. */
  const axisValue = new Map<PadAxis, number>()
  let mouseX = 0
  let mouseY = 0
  let raf = 0
  let last = performance.now()

  const bindingFor = (code: string): Binding | undefined => options.bindings[code]

  const onKeyDown = (event: KeyboardEvent) => {
    const binding = bindingFor(event.code)
    if (!binding) return
    // Let the user still reach the browser's own shortcuts.
    if (event.metaKey || event.ctrlKey) return
    event.preventDefault()
    if (held.has(event.code)) return
    held.add(event.code)
    if (binding.kind === 'button') virtualPad.press(binding.button)
  }

  const onKeyUp = (event: KeyboardEvent) => {
    const binding = bindingFor(event.code)
    if (!binding) return
    event.preventDefault()
    held.delete(event.code)
    if (binding.kind === 'button') virtualPad.release(binding.button)
  }

  /** Releasing everything on blur prevents a key latching on while away. */
  const onBlur = () => {
    for (const code of held) {
      const binding = bindingFor(code)
      if (binding?.kind === 'button') virtualPad.release(binding.button)
    }
    held.clear()
    axisValue.clear()
    mouseX = mouseY = 0
    virtualPad.reset()
  }

  const onMouseMove = (event: MouseEvent) => {
    if (!options.mouseLook) return
    if (document.pointerLockElement !== target) return
    mouseX += event.movementX * options.mouseSensitivity
    mouseY += event.movementY * options.mouseSensitivity
  }

  const onMouseDown = (event: MouseEvent) => {
    if (document.pointerLockElement !== target) {
      // First click captures the pointer; only then does the mouse aim.
      void target.requestPointerLock?.()
      return
    }
    if (event.button === 0) virtualPad.setAxis('RightTrigger', 1)
    if (event.button === 2) virtualPad.setAxis('LeftTrigger', 1)
  }

  const onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) virtualPad.setAxis('RightTrigger', 0)
    if (event.button === 2) virtualPad.setAxis('LeftTrigger', 0)
  }

  /** Suppress the context menu so right-click can act as the left trigger. */
  const onContextMenu = (event: Event) => event.preventDefault()

  /** Ramp axes toward their target every frame. */
  const tick = () => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now

    // Sum the keyboard's contribution per axis, so opposite keys cancel.
    const targets = new Map<PadAxis, number>()
    for (const code of held) {
      const binding = bindingFor(code)
      if (binding?.kind !== 'axis') continue
      targets.set(binding.axis, (targets.get(binding.axis) ?? 0) + binding.value)
    }

    const axes: PadAxis[] = [
      'LeftThumbXAxis',
      'LeftThumbYAxis',
      'RightThumbXAxis',
      'RightThumbYAxis',
      'LeftTrigger',
      'RightTrigger',
    ]

    for (const axis of axes) {
      const isStick = axis.endsWith('Axis')
      const target = Math.max(-1, Math.min(1, targets.get(axis) ?? 0))
      const current = axisValue.get(axis) ?? 0

      // Triggers are binary from a key, so skip the ramp for them.
      let next: number
      if (!isStick) {
        next = target
      } else {
        const step = dt / STICK_RAMP_SECONDS
        next = target > current ? Math.min(target, current + step)
             : target < current ? Math.max(target, current - step)
             : target
      }
      axisValue.set(axis, next)
      if (axis !== 'LeftTrigger' && axis !== 'RightTrigger') {
        virtualPad.setAxis(axis, next)
      } else if (target !== 0) {
        virtualPad.setAxis(axis, next)
      }
    }

    // Mouse drives the right stick and decays back to centre.
    if (options.mouseLook) {
      const decay = Math.max(0, 1 - MOUSE_DECAY_PER_SECOND * dt)
      mouseX *= decay
      mouseY *= decay
      if (Math.abs(mouseX) < 0.001) mouseX = 0
      if (Math.abs(mouseY) < 0.001) mouseY = 0
      const rx = Math.max(-1, Math.min(1, mouseX))
      const ry = Math.max(-1, Math.min(1, mouseY))
      if (rx !== 0 || (axisValue.get('RightThumbXAxis') ?? 0) === 0) {
        virtualPad.setAxis('RightThumbXAxis', rx)
      }
      if (ry !== 0 || (axisValue.get('RightThumbYAxis') ?? 0) === 0) {
        virtualPad.setAxis('RightThumbYAxis', ry)
      }
    }

    raf = requestAnimationFrame(tick)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  target.addEventListener('mousemove', onMouseMove)
  target.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  target.addEventListener('contextmenu', onContextMenu)
  raf = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    target.removeEventListener('mousemove', onMouseMove)
    target.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('mouseup', onMouseUp)
    target.removeEventListener('contextmenu', onContextMenu)
    if (document.pointerLockElement === target) document.exitPointerLock()
    onBlur()
  }
}

/** Pretty-print a key code for the bindings screen. */
export function formatKeyCode(code: string): string {
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Arrow/, '')
    .replace(/Left$/, ' (L)')
    .replace(/Right$/, ' (R)')
}
