/**
 * On-screen controls for touch devices.
 *
 * This is part of INPUT, not of the HUD: it owns its own overlay and its own
 * stylesheet and it writes straight into the `Input` snapshot, so nothing in
 * `src/ui` has to know it exists and no gameplay system changes at all.
 *
 * Every control lands on a path the engine already had:
 *
 *   move stick   -> `input.stick.moveX/moveY`, the same field the gamepad left
 *                   stick writes, consumed by `Input.moveVector()`.
 *   look drag    -> `input._rawLook`, the same accumulator the mouse writes.
 *                   `beginFrame` scales it by `config.sensitivity` into
 *                   `input.look`, which `src/player` consumes. IT DOES NOT NEED
 *                   POINTER LOCK — iOS has no Pointer Lock API at all, so a
 *                   look implementation built on `movementX` can never work
 *                   there.
 *   buttons      -> `_pendingDown` / `_pendingUp` with the code the keyboard or
 *                   the mouse would have produced (`Mouse0`, `Space`, `KeyR`,
 *                   ...). The menu button posts `Escape`, which `src/ui` already
 *                   turns into `menu.toggle()`.
 *
 * Stacking: the overlay sits at z-index 9, one below `.ow-hud`. The HUD root is
 * `pointer-events: none`, so taps fall through to us while the game is running;
 * the pause menu is `pointer-events: auto` and paints above us, so it takes its
 * own taps first. That is the whole coordination — no events, no imports.
 *
 * Allocation: every element and every pointer slot is built in the constructor.
 * Nothing here allocates during a gesture, let alone during a frame.
 */

/** Max simultaneous fingers we track. Two sticks + two buttons is four. */
const MAX_POINTERS = 6;

const KIND_NONE = 0;
const KIND_MOVE = 1;
const KIND_LOOK = 2;
const KIND_BUTTON = 3;

/**
 * Touch look is a drag, not a stick, so it reuses the mouse sensitivity — but a
 * thumb travels a fraction of the distance a mouse does before it runs out of
 * screen, so it needs a gain on top of it.
 */
const LOOK_GAIN = 2.4;

/** Fraction of the shorter viewport edge the move stick can be pushed. */
const STICK_RADIUS_VMIN = 0.17;

/**
 * label, action code, toggle?, css class.
 *
 * `toggle` buttons latch on tap (ADS and crouch): holding a button down with a
 * thumb that also has to work a stick is not a control scheme.
 */
const BUTTONS = [
  ['FIRE', 'Mouse0', false, 'fire'],
  ['ADS', 'Mouse2', true, 'ads'],
  ['JUMP', 'Space', false, 'jump'],
  ['RLD', 'KeyR', false, 'reload'],
  ['CRCH', 'ControlLeft', true, 'crouch'],
  ['SWAP', 'Tab', false, 'swap'],
  ['≡', 'Escape', false, 'menu'],
];

const CSS = `
#ow-touch {
  position: fixed; inset: 0; z-index: 9;
  pointer-events: none;
  touch-action: none;
  overscroll-behavior: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  font-family: "Avenir Next Condensed","DIN Alternate","Arial Narrow","Helvetica Neue",Inter,system-ui,sans-serif;
  font-weight: 600; text-transform: uppercase; letter-spacing: .14em;
  color: rgba(238,244,247,.82);
  text-shadow: 0 1px 2px rgba(0,0,0,.9);
}
#ow-touch .z { position: absolute; pointer-events: auto; }
#ow-touch .z-move { left: 0; bottom: 0; width: 44%; height: 66%; }
#ow-touch .z-look { right: 0; top: 0; width: 56%; height: 100%; }

#ow-touch .stick, #ow-touch .knob {
  position: absolute; left: 0; top: 0; pointer-events: none;
  border-radius: 50%; opacity: 0;
}
#ow-touch .stick {
  width: 34vmin; height: 34vmin; margin: -17vmin 0 0 -17vmin;
  border: 1px solid rgba(255,255,255,.20);
  background: rgba(8,12,16,.18);
}
#ow-touch .knob {
  width: 14vmin; height: 14vmin; margin: -7vmin 0 0 -7vmin;
  border: 1px solid rgba(255,255,255,.38);
  background: rgba(226,238,247,.26);
}

#ow-touch .btn {
  position: absolute; pointer-events: auto;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.26);
  background: rgba(8,12,16,.26);
  font-size: 2.6vmin;
}
#ow-touch .btn.on { background: rgba(255,176,42,.30); border-color: rgba(255,176,42,.75); color: #fff; }
#ow-touch .btn.hit { background: rgba(238,246,252,.34); }

#ow-touch .b-fire   { right: 4vmin;  bottom: 7vmin;  width: 22vmin; height: 22vmin; font-size: 3vmin; }
#ow-touch .b-ads    { right: 28vmin; bottom: 5vmin;  width: 15vmin; height: 15vmin; }
#ow-touch .b-jump   { right: 5vmin;  bottom: 31vmin; width: 14vmin; height: 14vmin; }
#ow-touch .b-reload { right: 23vmin; bottom: 23vmin; width: 14vmin; height: 14vmin; }
#ow-touch .b-crouch { right: 44vmin; bottom: 4vmin;  width: 13vmin; height: 13vmin; }
#ow-touch .b-swap   { right: 41vmin; bottom: 19vmin; width: 12vmin; height: 12vmin; font-size: 2.2vmin; }
#ow-touch .b-menu   { right: 2vmin;  top: 2vmin;     width: 10vmin; height: 10vmin; font-size: 3.4vmin; letter-spacing: 0; }
`;

export class TouchControls {
  /** @param {import('./input.js').Input} input */
  constructor(input) {
    this.input = input;
    this.usingTouch = false;

    this.style = document.createElement('style');
    this.style.id = 'ow-touch-style';
    this.style.textContent = CSS;

    const root = document.createElement('div');
    root.id = 'ow-touch';
    this.root = root;

    const zone = (cls, kind) => {
      const n = document.createElement('div');
      n.className = 'z ' + cls;
      n._owKind = kind;
      root.appendChild(n);
      return n;
    };
    this.moveZone = zone('z-move', KIND_MOVE);
    this.lookZone = zone('z-look', KIND_LOOK);

    this.stickBase = document.createElement('div');
    this.stickBase.className = 'stick';
    root.appendChild(this.stickBase);
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'knob';
    root.appendChild(this.stickKnob);

    /** Latched state of each toggle button, by BUTTONS index. */
    this._latched = new Uint8Array(BUTTONS.length);
    this.buttons = new Array(BUTTONS.length);
    for (let i = 0; i < BUTTONS.length; i++) {
      const [label, , , cls] = BUTTONS[i];
      const b = document.createElement('div');
      b.className = 'btn b-' + cls;
      b.textContent = label;
      b._owKind = KIND_BUTTON;
      b._owIndex = i;
      root.appendChild(b);
      this.buttons[i] = b;
    }

    // Fixed pointer table — a linear scan over six slots, never a Map, so a
    // 120 Hz pointermove stream cannot allocate.
    this._slots = new Array(MAX_POINTERS);
    for (let i = 0; i < MAX_POINTERS; i++) {
      this._slots[i] = { id: -1, kind: KIND_NONE, index: -1, x: 0, y: 0 };
    }
    this._stickSlot = null;
    /** True while our move values are the ones sitting in `input.stick`. */
    this._stickWrote = false;

    this.moveX = 0;
    this.moveY = 0;
    this.radius = 64;

    this._bound = {
      down: this._onDown.bind(this),
      move: this._onMove.bind(this),
      up: this._onUp.bind(this),
      menu: (e) => e.preventDefault(),
      resize: () => this._measure(),
    };
  }

  attach() {
    document.body.appendChild(this.style);
    document.body.appendChild(this.root);
    // Non-passive on purpose: preventDefault() on a pointer event is what stops
    // the browser synthesising the compatibility mouse events that would
    // otherwise fire the weapon on every tap (Input._onMouseDown), and what
    // stops double-tap zoom and the long-press callout.
    const o = { passive: false };
    this.root.addEventListener('pointerdown', this._bound.down, o);
    this.root.addEventListener('pointermove', this._bound.move, o);
    this.root.addEventListener('pointerup', this._bound.up, o);
    this.root.addEventListener('pointercancel', this._bound.up, o);
    this.root.addEventListener('contextmenu', this._bound.menu);
    addEventListener('resize', this._bound.resize);
    this._measure();
  }

  detach() {
    const o = { passive: false };
    this.root.removeEventListener('pointerdown', this._bound.down, o);
    this.root.removeEventListener('pointermove', this._bound.move, o);
    this.root.removeEventListener('pointerup', this._bound.up, o);
    this.root.removeEventListener('pointercancel', this._bound.up, o);
    this.root.removeEventListener('contextmenu', this._bound.menu);
    removeEventListener('resize', this._bound.resize);
    this.root.remove();
    this.style.remove();
  }

  _measure() {
    this.radius = Math.max(24, Math.min(innerWidth, innerHeight) * STICK_RADIUS_VMIN);
  }

  /* ------------------------------------------------------------- pointers -- */

  _claim(e, kind, index) {
    for (let i = 0; i < MAX_POINTERS; i++) {
      const s = this._slots[i];
      if (s.id !== -1) continue;
      s.id = e.pointerId;
      s.kind = kind;
      s.index = index;
      s.x = e.clientX;
      s.y = e.clientY;
      return s;
    }
    return null;
  }

  _find(id) {
    for (let i = 0; i < MAX_POINTERS; i++) if (this._slots[i].id === id) return this._slots[i];
    return null;
  }

  _onDown(e) {
    // A mouse on a touchscreen laptop keeps the desktop controls: the window
    // level mouse/keyboard listeners are unaffected by this overlay, and we
    // hand `usingTouch` back so `Input._onMouseDown` starts firing again. One
    // stray screen tap must not cost the mouse for the rest of the session.
    if (e.pointerType === 'mouse') {
      this.usingTouch = false;
      return;
    }
    const kind = e.target?._owKind ?? KIND_NONE;
    if (!kind) return;
    e.preventDefault();
    this.usingTouch = true;

    const s = this._claim(e, kind, e.target._owIndex ?? -1);
    if (!s) return;
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimisation; the root listeners still see the stream */
    }

    if (kind === KIND_MOVE) {
      this._stickSlot = s;
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.stickBase.style.opacity = '1';
      this.stickKnob.style.opacity = '1';
      this._knob(0, 0);
      this.moveX = 0;
      this.moveY = 0;
    } else if (kind === KIND_BUTTON) {
      this._press(s.index);
    }
  }

  _onMove(e) {
    if (e.pointerType === 'mouse') return;
    const s = this._find(e.pointerId);
    if (!s) return;
    e.preventDefault();

    if (s.kind === KIND_MOVE) {
      let dx = e.clientX - s.x;
      let dy = e.clientY - s.y;
      const r = this.radius;
      const len = Math.hypot(dx, dy);
      if (len > r) {
        dx = (dx / len) * r;
        dy = (dy / len) * r;
      }
      this._knob(dx, dy);
      // Gamepad convention: forward is -Y, which is what `moveVector` subtracts.
      this.moveX = dx / r;
      this.moveY = dy / r;
    } else if (s.kind === KIND_LOOK) {
      const raw = this.input._rawLook;
      raw.x += (e.clientX - s.x) * LOOK_GAIN;
      raw.y += (e.clientY - s.y) * LOOK_GAIN;
      s.x = e.clientX;
      s.y = e.clientY;
    }
  }

  _onUp(e) {
    const s = this._find(e.pointerId);
    if (!s) return;
    e.preventDefault();

    if (s.kind === KIND_MOVE) {
      this.moveX = 0;
      this.moveY = 0;
      this._stickSlot = null;
      this.stickBase.style.opacity = '0';
      this.stickKnob.style.opacity = '0';
    } else if (s.kind === KIND_BUTTON) {
      this._release(s.index);
    }
    s.id = -1;
    s.kind = KIND_NONE;
    s.index = -1;
  }

  _knob(dx, dy) {
    const base = this.stickBase;
    this.stickKnob.style.left = `${parseFloat(base.style.left || '0') + dx}px`;
    this.stickKnob.style.top = `${parseFloat(base.style.top || '0') + dy}px`;
  }

  /* -------------------------------------------------------------- buttons -- */

  _press(i) {
    if (i < 0) return;
    const [, code, toggle] = BUTTONS[i];
    const btn = this.buttons[i];
    if (toggle) {
      const on = !this._latched[i];
      this._latched[i] = on ? 1 : 0;
      (on ? this.input._pendingDown : this.input._pendingUp).add(code);
      btn.classList.toggle('on', on);
    } else {
      this.input._pendingDown.add(code);
      btn.classList.add('hit');
    }
  }

  _release(i) {
    if (i < 0) return;
    const [, code, toggle] = BUTTONS[i];
    if (toggle) return; // latched until the next tap
    this.input._pendingUp.add(code);
    this.buttons[i].classList.remove('hit');
  }

  /* ---------------------------------------------------------------- frame -- */

  /**
   * Merge into the shared stick snapshot, AFTER `_pollGamepad` has had its say.
   *
   * We clear our OWN contribution on release rather than assume the gamepad poll
   * will. It will not: with no controller connected that poll reads the pad only
   * every 30 frames and returns early — without touching `stick` — on the other
   * 29, so a lifted thumb left the player sprinting forward for up to half a
   * second. Measured, not theorised; it is what the live probe caught.
   *
   * One zeroing frame, then hands off, so a controller plugged into the same
   * session still owns the field.
   */
  applyStick(stick) {
    if (this._stickSlot) {
      stick.moveX = this.moveX;
      stick.moveY = this.moveY;
      this._stickWrote = true;
    } else if (this._stickWrote) {
      this._stickWrote = false;
      stick.moveX = 0;
      stick.moveY = 0;
    }
  }

  /** Drop every held code — the same contract as `Input._onBlur`. */
  releaseAll() {
    for (let i = 0; i < BUTTONS.length; i++) {
      if (this._latched[i]) {
        this._latched[i] = 0;
        this.input._pendingUp.add(BUTTONS[i][1]);
        this.buttons[i].classList.remove('on');
      }
    }
    this.moveX = 0;
    this.moveY = 0;
  }
}
