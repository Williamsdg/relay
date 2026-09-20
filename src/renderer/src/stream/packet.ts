/**
 * Binary encoder for the WebRTC `input` data channel.
 *
 * Wire format (all little-endian):
 *
 *   offset 0  uint16   report type bitmask
 *   offset 2  uint32   sequence number
 *   offset 6  float64  client timestamp (ms)
 *   offset 14 …        one section per bit set in the report type, in the
 *                      order Metadata, Gamepad, Pointer
 *
 * Each section starts with a uint8 frame count. A gamepad frame is 23 bytes:
 * index, button bitmask, four thumb axes, two triggers, then two 32-bit
 * "physicality" masks describing which inputs are physically actuated — the
 * console uses those to distinguish a real stick at rest from an absent one.
 */

export const ReportType = {
  None: 0,
  Metadata: 1,
  Gamepad: 2,
  Pointer: 4,
  ClientMetadata: 8,
  ServerMetadata: 16,
  Mouse: 32,
  Keyboard: 64,
  Vibration: 128,
  Sensor: 256,
} as const

/** Bit per input, used for the physicality masks. */
const Physicality = {
  DPadUp: 0x00000001,
  DPadDown: 0x00000002,
  DPadLeft: 0x00000004,
  DPadRight: 0x00000008,
  Menu: 0x00000010,
  View: 0x00000020,
  LeftThumb: 0x00000040,
  RightThumb: 0x00000080,
  LeftShoulder: 0x00000100,
  RightShoulder: 0x00000200,
  Nexus: 0x00000400,
  A: 0x00001000,
  B: 0x00002000,
  X: 0x00004000,
  Y: 0x00008000,
  LeftTrigger: 0x00010000,
  RightTrigger: 0x00020000,
  LeftThumbXAxis: 0x00040000,
  LeftThumbYAxis: 0x00080000,
  RightThumbXAxis: 0x00100000,
  RightThumbYAxis: 0x00200000,
} as const

/** Button bit positions inside the 16-bit button mask. */
const ButtonBit = {
  Nexus: 2,
  Menu: 4,
  View: 8,
  A: 16,
  B: 32,
  X: 64,
  Y: 128,
  DPadUp: 256,
  DPadDown: 512,
  DPadLeft: 1024,
  DPadRight: 2048,
  LeftShoulder: 4096,
  RightShoulder: 8192,
  LeftThumb: 16384,
  RightThumb: 32768,
} as const

export interface InputFrame {
  GamepadIndex: number
  Nexus: number
  Menu: number
  View: number
  A: number
  B: number
  X: number
  Y: number
  DPadUp: number
  DPadDown: number
  DPadLeft: number
  DPadRight: number
  LeftShoulder: number
  RightShoulder: number
  LeftThumb: number
  RightThumb: number
  LeftThumbXAxis: number
  LeftThumbYAxis: number
  RightThumbXAxis: number
  RightThumbYAxis: number
  LeftTrigger: number
  RightTrigger: number
}

export function emptyFrame(index = 0): InputFrame {
  return {
    GamepadIndex: index,
    Nexus: 0,
    Menu: 0,
    View: 0,
    A: 0,
    B: 0,
    X: 0,
    Y: 0,
    DPadUp: 0,
    DPadDown: 0,
    DPadLeft: 0,
    DPadRight: 0,
    LeftShoulder: 0,
    RightShoulder: 0,
    LeftThumb: 0,
    RightThumb: 0,
    LeftThumbXAxis: 0,
    LeftThumbYAxis: 0,
    RightThumbXAxis: 0,
    RightThumbYAxis: 0,
    LeftTrigger: 0,
    RightTrigger: 0,
  }
}

const HEADER_BYTES = 14
const GAMEPAD_FRAME_BYTES = 23

/** Axes arrive as -1..1 and go out as int16. */
function toAxis(value: number): number {
  const scaled = value * 32767
  return Math.max(-32767, Math.min(32767, Math.trunc(scaled)))
}

/** Triggers arrive as 0..1 and go out as uint16. */
function toTrigger(value: number): number {
  if (value <= 0) return 0
  return Math.min(65535, Math.trunc(value * 65535))
}

function buttonMask(f: InputFrame): number {
  let mask = 0
  if (f.Nexus > 0) mask |= ButtonBit.Nexus
  if (f.Menu > 0) mask |= ButtonBit.Menu
  if (f.View > 0) mask |= ButtonBit.View
  if (f.A > 0) mask |= ButtonBit.A
  if (f.B > 0) mask |= ButtonBit.B
  if (f.X > 0) mask |= ButtonBit.X
  if (f.Y > 0) mask |= ButtonBit.Y
  if (f.DPadUp > 0) mask |= ButtonBit.DPadUp
  if (f.DPadDown > 0) mask |= ButtonBit.DPadDown
  if (f.DPadLeft > 0) mask |= ButtonBit.DPadLeft
  if (f.DPadRight > 0) mask |= ButtonBit.DPadRight
  if (f.LeftShoulder > 0) mask |= ButtonBit.LeftShoulder
  if (f.RightShoulder > 0) mask |= ButtonBit.RightShoulder
  if (f.LeftThumb > 0) mask |= ButtonBit.LeftThumb
  if (f.RightThumb > 0) mask |= ButtonBit.RightThumb
  return mask
}

/** Which inputs are actually being actuated this frame. */
function physicalityMask(f: InputFrame): number {
  let mask = 0
  if (f.DPadUp > 0) mask |= Physicality.DPadUp
  if (f.DPadDown > 0) mask |= Physicality.DPadDown
  if (f.DPadLeft > 0) mask |= Physicality.DPadLeft
  if (f.DPadRight > 0) mask |= Physicality.DPadRight
  if (f.Menu > 0) mask |= Physicality.Menu
  if (f.View > 0) mask |= Physicality.View
  if (f.LeftThumb > 0) mask |= Physicality.LeftThumb
  if (f.RightThumb > 0) mask |= Physicality.RightThumb
  if (f.LeftShoulder > 0) mask |= Physicality.LeftShoulder
  if (f.RightShoulder > 0) mask |= Physicality.RightShoulder
  if (f.Nexus > 0) mask |= Physicality.Nexus
  if (f.A > 0) mask |= Physicality.A
  if (f.B > 0) mask |= Physicality.B
  if (f.X > 0) mask |= Physicality.X
  if (f.Y > 0) mask |= Physicality.Y
  if (f.LeftTrigger > 0) mask |= Physicality.LeftTrigger
  if (f.RightTrigger > 0) mask |= Physicality.RightTrigger
  if (f.LeftThumbXAxis !== 0) mask |= Physicality.LeftThumbXAxis
  if (f.LeftThumbYAxis !== 0) mask |= Physicality.LeftThumbYAxis
  if (f.RightThumbXAxis !== 0) mask |= Physicality.RightThumbXAxis
  if (f.RightThumbYAxis !== 0) mask |= Physicality.RightThumbYAxis
  return mask
}

function writeHeader(view: DataView, reportType: number, sequence: number): void {
  view.setUint16(0, reportType, true)
  view.setUint32(2, sequence, true)
  view.setFloat64(6, performance.now(), true)
}

/**
 * The handshake packet, sent once when the input channel opens. Without it the
 * console ignores every gamepad frame that follows.
 */
export function encodeClientMetadata(sequence: number, maxTouchPoints = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + 1)
  const view = new DataView(buffer)
  writeHeader(view, ReportType.ClientMetadata, sequence)
  view.setUint8(HEADER_BYTES, maxTouchPoints)
  return buffer
}

export function encodeGamepadFrames(sequence: number, frames: InputFrame[]): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES * frames.length)
  const view = new DataView(buffer)
  writeHeader(view, ReportType.Gamepad, sequence)

  let offset = HEADER_BYTES
  view.setUint8(offset, frames.length)
  offset += 1

  for (const f of frames) {
    view.setUint8(offset, f.GamepadIndex)
    offset += 1
    view.setUint16(offset, buttonMask(f), true)
    // Y axes are inverted relative to the browser Gamepad API's convention.
    view.setInt16(offset + 2, toAxis(f.LeftThumbXAxis), true)
    view.setInt16(offset + 4, toAxis(-f.LeftThumbYAxis), true)
    view.setInt16(offset + 6, toAxis(f.RightThumbXAxis), true)
    view.setInt16(offset + 8, toAxis(-f.RightThumbYAxis), true)
    view.setUint16(offset + 10, toTrigger(f.LeftTrigger), true)
    view.setUint16(offset + 12, toTrigger(f.RightTrigger), true)
    view.setUint32(offset + 14, physicalityMask(f), true)
    view.setUint32(offset + 18, 0, true) // virtual physicality: touch overlays only
    offset += 22
  }

  return buffer
}
