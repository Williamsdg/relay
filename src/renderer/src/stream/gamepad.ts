/**
 * Reads physical controllers via the Gamepad API and turns them into input
 * frames. Chromium maps an Xbox controller to the "standard" layout, so the
 * button indices below are fixed rather than per-device.
 */
import { emptyFrame, type InputFrame } from './packet.js'
import { virtualPad } from './virtualPad.js'

const Button = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LeftShoulder: 4,
  RightShoulder: 5,
  LeftTrigger: 6,
  RightTrigger: 7,
  View: 8,
  Menu: 9,
  LeftThumb: 10,
  RightThumb: 11,
  DPadUp: 12,
  DPadDown: 13,
  DPadLeft: 14,
  DPadRight: 15,
  Nexus: 16,
} as const

/**
 * Sticks rest a little off-centre on worn hardware; without a deadzone the
 * console sees constant drift and menus scroll on their own.
 */
const STICK_DEADZONE = 0.08
const TRIGGER_DEADZONE = 0.02

function applyDeadzone(value: number, threshold: number): number {
  if (Math.abs(value) < threshold) return 0
  // Rescale so the usable range still reaches full deflection.
  const sign = value < 0 ? -1 : 1
  return sign * ((Math.abs(value) - threshold) / (1 - threshold))
}

const pressed = (pad: Gamepad, index: number): number =>
  pad.buttons[index]?.pressed ? 1 : 0

const axis = (pad: Gamepad, index: number): number =>
  applyDeadzone(pad.axes[index] ?? 0, STICK_DEADZONE)

function trigger(pad: Gamepad, index: number): number {
  const value = pad.buttons[index]?.value ?? 0
  return applyDeadzone(value, TRIGGER_DEADZONE)
}

export function readGamepads(): InputFrame[] {
  const pads = navigator.getGamepads?.() ?? []
  const frames: InputFrame[] = []

  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i]
    if (!pad || !pad.connected) continue

    const frame = emptyFrame(i)
    frame.A = pressed(pad, Button.A)
    frame.B = pressed(pad, Button.B)
    frame.X = pressed(pad, Button.X)
    frame.Y = pressed(pad, Button.Y)
    frame.LeftShoulder = pressed(pad, Button.LeftShoulder)
    frame.RightShoulder = pressed(pad, Button.RightShoulder)
    frame.View = pressed(pad, Button.View)
    frame.Menu = pressed(pad, Button.Menu)
    frame.LeftThumb = pressed(pad, Button.LeftThumb)
    frame.RightThumb = pressed(pad, Button.RightThumb)
    frame.DPadUp = pressed(pad, Button.DPadUp)
    frame.DPadDown = pressed(pad, Button.DPadDown)
    frame.DPadLeft = pressed(pad, Button.DPadLeft)
    frame.DPadRight = pressed(pad, Button.DPadRight)
    frame.Nexus = pressed(pad, Button.Nexus)
    frame.LeftThumbXAxis = axis(pad, 0)
    frame.LeftThumbYAxis = axis(pad, 1)
    frame.RightThumbXAxis = axis(pad, 2)
    frame.RightThumbYAxis = axis(pad, 3)
    frame.LeftTrigger = trigger(pad, Button.LeftTrigger)
    frame.RightTrigger = trigger(pad, Button.RightTrigger)

    frames.push(frame)
  }

  return frames
}

/** True when nothing is actuated, so idle frames can be skipped. */
export function isNeutral(f: InputFrame): boolean {
  return (
    f.A === 0 &&
    f.B === 0 &&
    f.X === 0 &&
    f.Y === 0 &&
    f.LeftShoulder === 0 &&
    f.RightShoulder === 0 &&
    f.View === 0 &&
    f.Menu === 0 &&
    f.LeftThumb === 0 &&
    f.RightThumb === 0 &&
    f.DPadUp === 0 &&
    f.DPadDown === 0 &&
    f.DPadLeft === 0 &&
    f.DPadRight === 0 &&
    f.Nexus === 0 &&
    f.LeftThumbXAxis === 0 &&
    f.LeftThumbYAxis === 0 &&
    f.RightThumbXAxis === 0 &&
    f.RightThumbYAxis === 0 &&
    f.LeftTrigger === 0 &&
    f.RightTrigger === 0
  )
}

/**
 * Every input source, merged into the frames the console receives.
 *
 * Physical controllers map one-to-one onto controller slots. The virtual pad
 * (keyboard, mouse and on-screen buttons) folds into slot 0, so using the
 * keyboard while a controller is plugged in does not create a phantom second
 * player.
 */
export function collectFrames(): InputFrame[] {
  const frames = readGamepads()
  const virtualActive = virtualPad.isActive()

  if (frames.length === 0) {
    // No physical controller: the virtual pad becomes player one. Emit a frame
    // even when idle so the console keeps seeing a connected controller.
    const frame = emptyFrame(0)
    if (virtualActive) virtualPad.mergeInto(frame)
    return [frame]
  }

  if (virtualActive) virtualPad.mergeInto(frames[0])
  return frames
}
