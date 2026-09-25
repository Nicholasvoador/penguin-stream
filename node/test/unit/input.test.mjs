import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInputEvent, createInputValidator, inputClass } from '../../src/media/input.mjs';

const move = { t: 'mousemove', x: 0.25, y: 0.75 };
const key = { t: 'key', code: 4, down: true };           // HID usage 4 = physical "A"

test('canonical keyboard/mouse events keep exact values and supported buttons', () => {
  assert.deepEqual(validateInputEvent(move), move);
  assert.notEqual(validateInputEvent(move), move, 'a fresh canonical object, never the input');
  for (const button of ['left', 'middle', 'right', 'x1', 'x2']) {
    for (const down of [true, false]) {
      const positioned = { t: 'mousebutton', button, down, x: 0, y: 1 };
      assert.deepEqual(validateInputEvent(positioned), positioned);
      const relative = { t: 'mousebutton', button, down };   // game mode: no position
      assert.deepEqual(validateInputEvent(relative), relative);
    }
  }
  assert.deepEqual(validateInputEvent(key), key);
  assert.deepEqual(validateInputEvent({ t: 'key', code: 135, down: false }), { t: 'key', code: 135, down: false },
    'ABNT2 "/?" key (HID International1) must be accepted');
  assert.deepEqual(validateInputEvent({ t: 'keyrepeat', code: 4 }), { t: 'keyrepeat', code: 4 });
  assert.deepEqual(validateInputEvent({ t: 'wheel', dx: -100, dy: 100 }), { t: 'wheel', dx: -100, dy: 100 });
  assert.deepEqual(validateInputEvent({ t: 'wheel', dx: 0, dy: 0.25 }), { t: 'wheel', dx: 0, dy: 0.25 });
  assert.deepEqual(validateInputEvent({ t: 'mouserel', dx: -5, dy: 12 }), { t: 'mouserel', dx: -5, dy: 12 });
});

test('controller events validate slots, buttons, axes and trigger ranges', () => {
  const btn = { t: 'pad_button', slot: 3, button: 'dpad_left', down: true };
  assert.deepEqual(validateInputEvent(btn), btn);
  assert.deepEqual(validateInputEvent({ t: 'pad_axis', slot: 0, axis: 'ls_y', value: -1 }),
    { t: 'pad_axis', slot: 0, axis: 'ls_y', value: -1 });
  assert.deepEqual(validateInputEvent({ t: 'pad_axis', slot: 1, axis: 'rt', value: 1 }),
    { t: 'pad_axis', slot: 1, axis: 'rt', value: 1 });
  assert.deepEqual(validateInputEvent({ t: 'pad', slot: 2, connected: false }), { t: 'pad', slot: 2, connected: false });
  for (const bad of [
    { ...btn, slot: 4 }, { ...btn, slot: -1 }, { ...btn, slot: 0.5 }, { ...btn, button: 'turbo' },
    { t: 'pad_axis', slot: 0, axis: 'lt', value: -0.1 },          // triggers are 0..1
    { t: 'pad_axis', slot: 0, axis: 'ls_x', value: 1.5 },
    { t: 'pad_axis', slot: 0, axis: 'gyro', value: 0 },
    { t: 'pad', slot: 0, connected: 'yes' },
    { t: 'gamepad_button', button: 'a', down: true },              // 0.9 wire format
  ]) {
    assert.equal(validateInputEvent(bad), null, JSON.stringify(bad));
  }
  assert.equal(inputClass(btn), 'pad');
  assert.equal(inputClass(key), 'kbm');
  assert.equal(inputClass(move), 'kbm');
});

test('reject malformed schemas, unknown fields, accessors and host-only events', () => {
  for (const bad of [null, undefined, [], 1, '{}', {}, { t: 'release_all' },
    { t: 'key', keycode: 97, scancode: 4, mod: 0, down: true },    // 0.9 wire format
    { ...key, extra: 1 }, { ...move, extra: 1 },
    { ...move, t: 'touch' }, Object.create(move),
    JSON.parse('{"t":"mousemove","x":0,"y":0,"__proto__":{}}'),
    { ...move, [Symbol('x')]: 1 },
    Object.defineProperty({ ...move }, 'x', { get() { throw new Error('must not run'); } }),
    { t: 'mousebutton', button: 'left', down: true, x: 0 }]) {    // half a position
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
  for (const code of [0, -1, 512, 1.5, '4', null]) {
    assert.equal(validateInputEvent({ ...key, code }), null);
  }
  for (const dx of [4097, -4097, 0.5, '1']) {
    assert.equal(validateInputEvent({ t: 'mouserel', dx, dy: 0 }), null);
  }
});

test('rate cap refills, always permits releases, and keeps keyboard and controllers apart', () => {
  let time = 0;
  const validate = createInputValidator({ rate: 10, burst: 2, now: () => time });
  assert.ok(validate(move));
  assert.ok(validate(key));
  assert.equal(validate(move), null);
  assert.ok(validate({ ...key, down: false }));
  assert.ok(validate({ t: 'mousebutton', button: 'left', down: false, x: 0, y: 0 }));
  // A busy keyboard does not starve the controller bucket.
  assert.ok(validate({ t: 'pad_axis', slot: 0, axis: 'ls_x', value: 0.5 }));
  assert.ok(validate({ t: 'pad_axis', slot: 0, axis: 'ls_x', value: 0.6 }));
  assert.equal(validate({ t: 'pad_axis', slot: 0, axis: 'ls_x', value: 0.7 }), null);
  // Returning a stick to centre, releasing a button or unplugging is never dropped.
  assert.ok(validate({ t: 'pad_axis', slot: 0, axis: 'ls_x', value: 0 }));
  assert.ok(validate({ t: 'pad_button', slot: 0, button: 'a', down: false }));
  assert.ok(validate({ t: 'pad', slot: 0, connected: false }));
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
