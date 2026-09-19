import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInputEvent, sdlKeycodeToKeysym, createInputValidator } from '../../src/media/input.mjs';

const mask = 1 << 30;
const move = { t: 'mousemove', x: 0.25, y: 0.75 };
const key = { t: 'key', keycode: 97, scancode: 4, mod: 0, down: true };

test('SDL ASCII and common special keys map to X keysyms, never evdev codes', () => {
  for (let c = 32; c <= 126; c++) assert.equal(sdlKeycodeToKeysym(c), c);
  for (const [sdl, x] of [[8, 0xff08], [9, 0xff09], [13, 0xff0d], [27, 0xff1b], [127, 0xffff],
    [mask | 57, 0xffe5], [mask | 58, 0xffbe], [mask | 69, 0xffc9],
    [mask | 104, 0xffca], [mask | 115, 0xffd5], [mask | 79, 0xff53],
    [mask | 80, 0xff51], [mask | 81, 0xff54], [mask | 82, 0xff52],
    [mask | 224, 0xffe3], [mask | 225, 0xffe1], [mask | 226, 0xffe9],
    [mask | 227, 0xffeb], [mask | 228, 0xffe4], [mask | 229, 0xffe2],
    [mask | 230, 0xffea], [mask | 231, 0xffec], [mask | 88, 0xff8d],
    [mask | 89, 0xffb1], [mask | 97, 0xffb9], [mask | 98, 0xffb0]]) {
    assert.equal(sdlKeycodeToKeysym(sdl), x);
  }
  for (const bad of [0, -1, 1.5, NaN, Infinity, '97', null, mask | 400, 0xffffffff, 0xffe1]) {
    assert.equal(sdlKeycodeToKeysym(bad), null);
  }
});

test('canonical events preserve normalized positions, booleans and supported buttons', () => {
  assert.deepEqual(validateInputEvent(move), move);
  assert.notEqual(validateInputEvent(move), move);
  for (const button of ['left', 'middle', 'right', 'x1', 'x2']) {
    for (const down of [true, false]) {
      const e = { t: 'mousebutton', button, down, x: 0, y: 1 };
      assert.deepEqual(validateInputEvent(e), e);
    }
  }
  assert.deepEqual(validateInputEvent(key), { t: 'key', keysym: 97, down: true });
  assert.deepEqual(validateInputEvent({ t: 'key', keycode: mask | 225, down: false }),
    { t: 'key', keysym: 0xffe1, down: false });
  const wheel = { t: 'wheel', dx: -100, dy: 100 };
  assert.deepEqual(validateInputEvent(wheel), wheel);
});

test('reject malformed object schemas, unknown fields, accessors and injection types', () => {
  for (const bad of [null, undefined, [], 1, '{}', {}, { t: 'release_all' },
    { t: 'key', keysym: 97, down: true }, { ...move, extra: 1 },
    { ...move, t: 'touch' }, Object.create(move),
    JSON.parse('{"t":"mousemove","x":0,"y":0,"__proto__":{}}'),
    { ...move, [Symbol('x')]: 1 },
    Object.defineProperty({ ...move }, 'x', { get() { throw new Error('must not run'); } })]) {
    assert.equal(validateInputEvent(bad), null);
  }
  const plain = Object.assign(Object.create(null), move);
  assert.deepEqual(validateInputEvent(plain), move);
});

test('numeric bounds and exact booleans fail closed, not clamped or coerced', () => {
  for (const x of [-0.001, 1.001, NaN, Infinity, -Infinity, '0.5', null, true, {}, []]) {
    assert.equal(validateInputEvent({ ...move, x }), null);
    assert.equal(validateInputEvent({ ...move, y: x }), null);
  }
  for (const down of [0, 1, 'true', null, undefined]) {
    assert.equal(validateInputEvent({ ...key, down }), null);
    assert.equal(validateInputEvent({ t: 'mousebutton', button: 'left', down, x: 0, y: 0 }), null);
  }
  for (const button of ['unknown', 'LEFT', 1, '__proto__']) {
    assert.equal(validateInputEvent({ t: 'mousebutton', button, down: true, x: 0, y: 0 }), null);
  }
  for (const dx of [-101, 101, NaN, Infinity, '1', null]) {
    assert.equal(validateInputEvent({ t: 'wheel', dx, dy: 0 }), null);
  }
  for (const [field, values] of [['scancode', [-1, 512, 1.5, '4']], ['mod', [-1, 65536, 1.5, '0']]]) {
    for (const v of values) assert.equal(validateInputEvent({ ...key, [field]: v }), null);
  }
  for (const required of ['keycode', 'down']) {
    const e = { ...key }; delete e[required]; assert.equal(validateInputEvent(e), null);
  }
});

test('optional per-peer rate cap refills and always permits releases', () => {
  let time = 0;
  const validate = createInputValidator({ rate: 10, burst: 2, now: () => time });
  assert.ok(validate(move));
  assert.ok(validate(key));
  assert.equal(validate(move), null);
  assert.ok(validate({ ...key, down: false }));
  assert.ok(validate({ t: 'mousebutton', button: 'left', down: false, x: 0, y: 0 }));
  time = 100;
  assert.ok(validate(move));
  assert.equal(validate(move), null);
  time = -100;
  assert.equal(validate(move), null);
  time = 200;
  assert.ok(validate(move));
  time = Infinity;
  assert.equal(validate(move), null);
  assert.ok(validate({ ...key, down: false }));
  for (const opts of [{ rate: 0 }, { rate: Infinity }, { burst: 0 }, { burst: 1.5 }, { now: 1 }, { now: () => NaN }]) {
    assert.throws(() => createInputValidator(opts), TypeError);
  }
});
