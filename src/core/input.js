/**
 * Input aggregation: keyboard, mouse (pointer-locked), gamepad and touch,
 * exposed as a stable per-frame snapshot so gameplay never touches raw DOM
 * events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 *
 * All four devices converge on the SAME two channels, which is why no gameplay
 * system knows how many of them exist: held action codes (`down`, fed by
 * `_pendingDown`/`_pendingUp`) and analog state (`look`, `stick`). The on-screen
 * controls in `./touch.js` write into exactly those and change no API here.
 */

import { TouchControls } from './touch.js';

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Digit1', 'Digit2', 'Tab'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

const EMPTY_PADS = [];
const padDeadzone = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
const padCurve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;

/**
 * Standard-mapping gamepad buttons, as `[index, action code]`. The pad used to
 * publish axes and nothing else, which meant a controller could walk and look
 * but could not shoot, jump, reload, or open the menu.
 *
 * Layout follows the console shooter convention: triggers fire and aim, face
 * buttons jump / crouch / reload / swap, sticks sprint and melee.
 */
const PAD_BUTTONS = [
  [0, 'Space'], // A      jump
  [1, 'ControlLeft'], // B      crouch
  [2, 'KeyR'], // X      reload
  [3, 'Tab'], // Y      swap weapon
  [4, 'KeyF'], // LB     use
  [5, 'KeyG'], // RB     grenade
  [6, 'Mouse2'], // LT     ads
  [7, 'Mouse0'], // RT     fire
  [9, 'Escape'], // Start  pause
  [10, 'ShiftLeft'], // L3     sprint
  [11, 'KeyV'], // R3     melee
];

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
    this._padActive = false;
    this._padProbe = 0;
    /** Which PAD_BUTTONS entries the pad is currently holding down. */
    this._padHeld = new Uint8Array(PAD_BUTTONS.length);

    /**
     * On-screen controls. Only built on a device that actually has a touch
     * screen, and never in a deterministic (capture) session — the pixel gate
     * must not grow an overlay. See src/core/touch.js.
     */
    this.touch = null;

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    if (
      !this.config?.deterministic &&
      typeof navigator !== 'undefined' &&
      navigator.maxTouchPoints > 0
    ) {
      this.touch = new TouchControls(this);
      this.touch.attach();
    }
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
    this.touch?.detach();
    this.touch = null;
  }

  requestPointerLock() {
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(e.code);
  }

  /**
   * A touch generates *compatibility* mouse events on top of the pointer
   * events, so without the `usingTouch` guard every tap anywhere on a phone
   * would arrive here as button 0 and fire the weapon. TouchControls also calls
   * preventDefault(), which suppresses them on conforming browsers; this is the
   * belt to that pair of braces, and it also keeps the pointer-lock request from
   * being made on a platform that has no Pointer Lock API.
   */
  _onMouseDown(e) {
    if (!this.enabled || this.touch?.usingTouch) return;
    if (!this.pointerLocked && e.button === 0) this.requestPointerLock();
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled || this.touch?.usingTouch) return;
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this._onBlur();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    for (const code of this.down) this._pendingUp.add(code);
    this._rawLook.x = 0;
    this._rawLook.y = 0;
    this._padHeld.fill(0);
    this.touch?.releaseAll();
  }

  beginFrame() {
    // BEFORE the pending sets are drained, not after: the pad now injects action
    // codes as well as axes, and polling afterwards would land every button
    // press one frame late.
    this._pollGamepad();

    this._pressed.clear();
    this._released.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    this.look.x = this.frozen ? 0 : this._rawLook.x * s;
    this.look.y = this.frozen ? 0 : this._rawLook.y * s * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    // Last word on the move stick: only while a finger is actually on it. With
    // no finger down `_pollGamepad` has already left the correct value there —
    // the controller's, or zero.
    this.touch?.applyStick(this.stick);
  }

  endFrame() {}

  /**
   * `navigator.getGamepads()` allocates a fresh array (and a fresh Gamepad
   * snapshot per slot) on every call, and the two arrow functions below were
   * rebuilt with it — every frame, on every machine, whether or not a controller
   * exists. Once one IS connected we still poll every frame, because a Gamepad
   * snapshot is not live and stick input must not lag; until then we look every
   * 30 frames, which is twice as often as a human can plug something in.
   */
  _pollGamepad() {
    if (!this._padActive) {
      this._padProbe = (this._padProbe + 1) % 30;
      if (this._padProbe !== 0) return;
    }
    const pads = navigator.getGamepads?.() ?? EMPTY_PADS;
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      if (this._padActive) this._releasePadButtons();
      this._padActive = false;
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    this._padActive = true;
    this.stick.moveX = padDeadzone(pad.axes[0] ?? 0);
    this.stick.moveY = padDeadzone(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    this.stick.lookX = padCurve(padDeadzone(pad.axes[2] ?? 0));
    this.stick.lookY = padCurve(padDeadzone(pad.axes[3] ?? 0));

    // Buttons. `_padHeld` is what makes this composable with the keyboard: we
    // only ever post a release for a code the PAD pressed, so an unpressed B
    // button cannot cancel the Ctrl the player is holding on the keyboard.
    if (!this.enabled) return;
    const buttons = pad.buttons;
    if (!buttons) return;
    for (let i = 0; i < PAD_BUTTONS.length; i++) {
      const b = buttons[PAD_BUTTONS[i][0]];
      // Triggers are analog: `pressed` is a full pull on some drivers.
      const on = b ? b.pressed === true || (b.value ?? 0) > 0.5 : false;
      if (on === !!this._padHeld[i]) continue;
      this._padHeld[i] = on ? 1 : 0;
      (on ? this._pendingDown : this._pendingUp).add(PAD_BUTTONS[i][1]);
    }
  }

  /** A pad that vanished mid-hold must not leave the player firing forever. */
  _releasePadButtons() {
    for (let i = 0; i < PAD_BUTTONS.length; i++) {
      if (!this._padHeld[i]) continue;
      this._padHeld[i] = 0;
      this._pendingUp.add(PAD_BUTTONS[i][1]);
    }
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0');
  }

  get firePressed() {
    return this._pressed.has('Mouse0');
  }

  get ads() {
    return this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
