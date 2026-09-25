/** Strict viewer -> host input boundary.
 *
 * Returns canonical, JSON-ready events or null. Permission is NOT granted here:
 * the host decides separately whether keyboard/mouse and/or controllers are
 * allowed, and the OS layer (Wayland portal consent, ViGEmBus/uinput) must
 * also agree. Keys are physical USB HID usages (== SDL scancodes), so the
 * host's own keyboard layout decides which character a key produces.
 */

const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const unit = (v) => finite(v, 0, 1);
const bool = (v) => typeof v === 'boolean';

export const MOUSE_BUTTONS = new Set(['left', 'middle', 'right', 'x1', 'x2']);
export const PAD_BUTTONS = new Set([
  'a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start', 'guide',
  'ls', 'rs', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
]);
export const PAD_AXES = new Set(['ls_x', 'ls_y', 'rs_x', 'rs_y', 'lt', 'rt']);
export const MAX_PADS = 4;

/** Which permission an event needs: 'kbm' (keyboard+mouse) or 'pad'. */
export function inputClass(event) {
  return event.t.startsWith('pad') ? 'pad' : 'kbm';
}

const exactly = (e, keys) => {
  const own = Object.keys(e);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(e, k));
};

/** Accepts parsed viewer objects only. Unknown fields and coercions are rejected. */
export function validateInputEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const proto = Object.getPrototypeOf(event);
  if (proto !== Object.prototype && proto !== null) return null;
  // Refuse accessors and symbols; this boundary normally receives JSON.parse.
  if (Reflect.ownKeys(event).some((k) => typeof k !== 'string' ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(event, k), 'value'))) return null;
  const e = event;
  switch (e.t) {
    case 'mousemove':
      return exactly(e, ['t', 'x', 'y']) && unit(e.x) && unit(e.y) ? { t: e.t, x: e.x, y: e.y } : null;
    case 'mouserel':
      return exactly(e, ['t', 'dx', 'dy']) && int(e.dx, -4096, 4096) && int(e.dy, -4096, 4096)
        ? { t: e.t, dx: e.dx, dy: e.dy } : null;
    case 'mousebutton':
      if (!MOUSE_BUTTONS.has(e.button) || !bool(e.down)) return null;
      if (exactly(e, ['t', 'button', 'down'])) return { t: e.t, button: e.button, down: e.down };
      return exactly(e, ['t', 'button', 'down', 'x', 'y']) && unit(e.x) && unit(e.y)
        ? { t: e.t, button: e.button, down: e.down, x: e.x, y: e.y } : null;
    case 'wheel':
      return exactly(e, ['t', 'dx', 'dy']) && finite(e.dx, -100, 100) && finite(e.dy, -100, 100)
        ? { t: e.t, dx: e.dx, dy: e.dy } : null;
    case 'key':
      return exactly(e, ['t', 'code', 'down']) && int(e.code, 1, 511) && bool(e.down)
        ? { t: e.t, code: e.code, down: e.down } : null;
    case 'keyrepeat':
      return exactly(e, ['t', 'code']) && int(e.code, 1, 511) ? { t: e.t, code: e.code } : null;
    case 'pad_button':
      return exactly(e, ['t', 'slot', 'button', 'down']) && int(e.slot, 0, MAX_PADS - 1) &&
        PAD_BUTTONS.has(e.button) && bool(e.down)
        ? { t: e.t, slot: e.slot, button: e.button, down: e.down } : null;
    case 'pad_axis': {
      if (!exactly(e, ['t', 'slot', 'axis', 'value']) || !int(e.slot, 0, MAX_PADS - 1) || !PAD_AXES.has(e.axis)) return null;
      const trigger = e.axis === 'lt' || e.axis === 'rt';
      return finite(e.value, trigger ? 0 : -1, 1) ? { t: e.t, slot: e.slot, axis: e.axis, value: e.value } : null;
    }
    case 'pad':
      return exactly(e, ['t', 'slot', 'connected']) && int(e.slot, 0, MAX_PADS - 1) && bool(e.connected)
        ? { t: e.t, slot: e.slot, connected: e.connected } : null;
    default:
      return null;  // includes release_all: only the host itself may issue it
  }
}

const isRelease = (v) =>
  ((v.t === 'key' || v.t === 'mousebutton' || v.t === 'pad_button') && v.down === false) ||
  (v.t === 'pad' && v.connected === false) ||
  (v.t === 'pad_axis' && v.value === 0);

/** Optional per-peer token bucket. Releases bypass rate limiting so a burst
 * cannot strand a held key/button. The parent must send release_all when the
 * input owner disconnects or loses permission (never accept it from a peer).
 * Controllers get their own bucket: analog sticks legitimately produce many
 * small updates and must not starve the keyboard, or vice versa.
 */
export function createInputValidator({ rate = 1000, burst = 400, now = () => performance.now() } = {}) {
  if (!finite(rate, 1, 10000) || !Number.isInteger(burst) || !finite(burst, 1, 10000) || typeof now !== 'function') {
    throw new TypeError('invalid input rate limits');
  }
  const start = now();
  if (!Number.isFinite(start)) throw new TypeError('invalid clock');
  const buckets = { kbm: { tokens: burst, last: start }, pad: { tokens: burst, last: start } };
  return (event) => {
    const valid = validateInputEvent(event);
    if (!valid) return null;
    if (isRelease(valid)) return valid;
    const time = now();
    if (!Number.isFinite(time)) return null;
    const b = buckets[inputClass(valid)];
    b.tokens = Math.min(burst, b.tokens + Math.max(0, time - b.last) * rate / 1000);
    b.last = Math.max(b.last, time);
    if (b.tokens < 1) return null;
    b.tokens--;
    return valid;
  };
}
