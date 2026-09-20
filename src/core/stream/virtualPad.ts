/**
 * A software controller that the keyboard and the on-screen buttons both write
 * into.
 *
 * The console only ever sees one input stream, so every source has to converge
 * before encoding. Keeping that merge in one place means a key press, a screen
 * tap and a physical stick all go through identical clamping and deadzone
 * handling, and the encoder never needs to know where a press came from.
 */
import type { InputFrame } from './packet.js'

export type PadButton =
  | 'A'
  | 'B'
  | 'X'
  | 'Y'
  | 'Menu'
  | 'View'
  | 'Nexus'
  | 'DPadUp'
  | 'DPadDown'
  | 'DPadLeft'
  | 'DPadRight'
  | 'LeftShoulder'
  | 'RightShoulder'
  | 'LeftThumb'
  | 'RightThumb'

export type PadAxis =
  | 'LeftThumbXAxis'
  | 'LeftThumbYAxis'
  | 'RightThumbXAxis'
  | 'RightThumbYAxis'
  | 'LeftTrigger'
  | 'RightTrigger'

export const PAD_BUTTONS: PadButton[] = [
  'A', 'B', 'X', 'Y',
  'Menu', 'View', 'Nexus',
  'DPadUp', 'DPadDown', 'DPadLeft', 'DPadRight',
  'LeftShoulder', 'RightShoulder',
  'LeftThumb', 'RightThumb',
]

/** Human-facing names, used by the on-screen pad and the bindings screen. */
export const BUTTON_LABELS: Record<PadButton, string> = {
  A: 'A',
  B: 'B',
  X: 'X',
  Y: 'Y',
  Menu: 'Menu',
  View: 'View',
  Nexus: 'Xbox',
  DPadUp: 'D-pad up',
  DPadDown: 'D-pad down',
  DPadLeft: 'D-pad left',
  DPadRight: 'D-pad right',
  LeftShoulder: 'LB',
  RightShoulder: 'RB',
  LeftThumb: 'L3',
  RightThumb: 'R3',
}

class VirtualPad {
  private buttons = new Set<PadButton>()
  private axes: Record<PadAxis, number> = {
    LeftThumbXAxis: 0,
    LeftThumbYAxis: 0,
    RightThumbXAxis: 0,
    RightThumbYAxis: 0,
    LeftTrigger: 0,
    RightTrigger: 0,
  }
  /** Buttons held by a momentary tap, with the timer that will release them. */
  private pulses = new Map<PadButton, number>()

  press(button: PadButton): void {
    this.buttons.add(button)
  }

  release(button: PadButton): void {
    this.buttons.delete(button)
  }

  setAxis(axis: PadAxis, value: number): void {
    // Triggers are unipolar, sticks bipolar.
    const min = axis === 'LeftTrigger' || axis === 'RightTrigger' ? 0 : -1
    this.axes[axis] = Math.max(min, Math.min(1, value))
  }

  /**
   * Hold a button briefly, for a click or tap that has no natural release.
   * The console needs to observe the press across at least one input frame, so
   * this outlives a single poll tick.
   */
  tap(button: PadButton, holdMs = 120): void {
    const existing = this.pulses.get(button)
    if (existing !== undefined) window.clearTimeout(existing)
    this.press(button)
    const timer = window.setTimeout(() => {
      this.pulses.delete(button)
      this.release(button)
    }, holdMs)
    this.pulses.set(button, timer)
  }

  isActive(): boolean {
    if (this.buttons.size > 0) return true
    return Object.values(this.axes).some((v) => v !== 0)
  }

  /** Merge this pad's state into a frame, without clobbering physical input. */
  mergeInto(frame: InputFrame): void {
    for (const button of this.buttons) frame[button] = 1
    for (const [axis, value] of Object.entries(this.axes) as Array<[PadAxis, number]>) {
      if (value === 0) continue
      // Whichever source is pushing harder wins, so a physical stick is never
      // cancelled out by an idle virtual one.
      frame[axis] = Math.abs(value) > Math.abs(frame[axis]) ? value : frame[axis]
    }
  }

  /** Drop all state — used when the stream ends or focus is lost. */
  reset(): void {
    for (const timer of this.pulses.values()) window.clearTimeout(timer)
    this.pulses.clear()
    this.buttons.clear()
    for (const key of Object.keys(this.axes) as PadAxis[]) this.axes[key] = 0
  }

  /** Snapshot for the on-screen pad's pressed styling. */
  held(): ReadonlySet<PadButton> {
    return this.buttons
  }
}

export const virtualPad = new VirtualPad()
