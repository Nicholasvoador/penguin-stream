/** Strict viewer -> portal boundary. Returns canonical JSON-ready events or null.
 * Input permission is NOT granted here: host opt-in and portal consent are both
 * required. SDL keycodes are layout symbols, not Linux evdev scancodes.
 */
const SDL_MASK = 1 << 30;
const SPECIAL = new Map([
  [8, 0xff08], [9, 0xff09], [13, 0xff0d], [27, 0xff1b], [127, 0xffff],
  [SDL_MASK | 57, 0xffe5], // Caps Lock
  [SDL_MASK | 70, 0xff61], [SDL_MASK | 71, 0xff14], [SDL_MASK | 72, 0xff13],
  [SDL_MASK | 73, 0xff63], [SDL_MASK | 74, 0xff50], [SDL_MASK | 75, 0xff55],
  [SDL_MASK | 77, 0xff57], [SDL_MASK | 78, 0xff56],
  [SDL_MASK | 79, 0xff53], [SDL_MASK | 80, 0xff51],
  [SDL_MASK | 81, 0xff54], [SDL_MASK | 82, 0xff52],
  [SDL_MASK | 83, 0xff7f], [SDL_MASK | 84, 0xffaf], [SDL_MASK | 85, 0xffaa],
  [SDL_MASK | 86, 0xffad], [SDL_MASK | 87, 0xffab], [SDL_MASK | 88, 0xff8d],
  [SDL_MASK | 98, 0xffb0], [SDL_MASK | 99, 0xffae], [SDL_MASK | 101, 0xff67],
  [SDL_MASK | 103, 0xffbd],
  [SDL_MASK | 224, 0xffe3], [SDL_MASK | 225, 0xffe1],
  [SDL_MASK | 226, 0xffe9], [SDL_MASK | 227, 0xffeb],
  [SDL_MASK | 228, 0xffe4], [SDL_MASK | 229, 0xffe2],
  [SDL_MASK | 230, 0xffea], [SDL_MASK | 231, 0xffec],
]);
for (let i = 0; i < 12; i++) SPECIAL.set(SDL_MASK | (58 + i), 0xffbe + i);
for (let i = 0; i < 12; i++) SPECIAL.set(SDL_MASK | (104 + i), 0xffca + i);
for (let i = 0; i < 9; i++) SPECIAL.set(SDL_MASK | (89 + i), 0xffb1 + i);

export function sdlKeycodeToKeysym(keycode) {
  if (!Number.isSafeInteger(keycode)) return null;
  if (keycode >= 32 && keycode <= 126) return keycode;
  return SPECIAL.get(keycode) ?? null;
}

const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const coords = (e) => finite(e.x, 0, 1) && finite(e.y, 0, 1);
const buttons = new Set(['left', 'middle', 'right', 'x1', 'x2']);
const schema = (e, required, optional = []) => required.every((k) => Object.hasOwn(e, k)) &&
  Object.keys(e).every((k) => required.includes(k) || optional.includes(k));

/** Accept parsed viewer objects (not arbitrary keysym events). Unknown fields
 * and coercions are rejected; SDL metadata is checked then stripped.
 */
export function validateInputEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const proto = Object.getPrototypeOf(event);
  if (proto !== Object.prototype && proto !== null) return null;
  // Refuse accessors and symbols; this boundary normally receives JSON.parse.
  if (Reflect.ownKeys(event).some((k) => typeof k !== 'string' ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(event, k), 'value'))) return null;
  switch (event.t) {
    case 'mousemove':
      return schema(event, ['t', 'x', 'y']) && coords(event)
        ? { t: event.t, x: event.x, y: event.y } : null;
    case 'mousebutton':
      return schema(event, ['t', 'button', 'down', 'x', 'y']) && coords(event) &&
        buttons.has(event.button) && typeof event.down === 'boolean'
        ? { t: event.t, button: event.button, down: event.down, x: event.x, y: event.y } : null;
    case 'wheel':
      return schema(event, ['t', 'dx', 'dy']) && finite(event.dx, -100, 100) && finite(event.dy, -100, 100)
        ? { t: event.t, dx: event.dx, dy: event.dy } : null;
    case 'key': {
      if (!schema(event, ['t', 'keycode', 'down'], ['scancode', 'mod']) || typeof event.down !== 'boolean') return null;
      if (Object.hasOwn(event, 'scancode') && (!Number.isInteger(event.scancode) || !finite(event.scancode, 0, 511))) return null;
      if (Object.hasOwn(event, 'mod') && (!Number.isInteger(event.mod) || !finite(event.mod, 0, 65535))) return null;
      const keysym = sdlKeycodeToKeysym(event.keycode);
      return keysym === null ? null : { t: event.t, keysym, down: event.down };
    }
    default: return null;
  }
}

/** Optional per-peer token bucket. Releases bypass rate limiting so a burst
 * cannot strand a held key/button. The parent must send release_all when the
 * input owner disconnects or loses permission (never accept it from a peer).
 */
export function createInputValidator({ rate = 240, burst = 120, now = () => performance.now() } = {}) {
  if (!finite(rate, 1, 10000) || !Number.isInteger(burst) || !finite(burst, 1, 10000) || typeof now !== 'function') {
    throw new TypeError('invalid input rate limits');
  }
  let tokens = burst;
  let last = now();
  if (!Number.isFinite(last)) throw new TypeError('invalid clock');
  return (event) => {
    const valid = validateInputEvent(event);
    if (!valid) return null;
    if ((valid.t === 'key' || valid.t === 'mousebutton') && !valid.down) return valid;
    const time = now();
    if (!Number.isFinite(time)) return null;
    tokens = Math.min(burst, tokens + Math.max(0, time - last) * rate / 1000);
    last = Math.max(last, time);
    if (tokens < 1) return null;
    tokens--;
    return valid;
  };
}
