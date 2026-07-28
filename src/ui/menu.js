import { el, setText, setStyle, clamp, damp, ease } from './util.js';

/**
 * `mobile` is first because it is BELOW low, not a variant of it (see
 * QUALITY_PRESETS). It is offered on desktop too: it is the only way to see what
 * the phone tier actually looks like without a phone.
 */
const PRESETS = ['mobile', 'low', 'medium', 'high', 'ultra'];

/**
 * The quantised rungs the dynamic-resolution scaler walks.
 *
 * DUPLICATED from `DYNRES_STEPS` in `src/render/index.js` on purpose: `src/ui`
 * must not import another subsystem's module, and the ladder is a documented
 * contract (ARCHITECTURE.md, "Dynamic resolution") rather than a private. The
 * two lists must agree — if a rung is ever added there, add it here.
 *
 * The resolution slider rewrites the ladder's TOP rung. The scaler keeps every
 * rung below it and keeps stepping down when a frame is slow, which is what
 * makes the slider a ceiling rather than a fixed resolution.
 */
const DYNRES_RUNGS = [0.5, 0.6, 0.7, 0.85, 1.0];

/** Backbuffer density options. See the note on `dprCap` in src/core/config.js. */
const DPR_CAPS = [1.0, 1.5, 2.0];

/**
 * Pause / settings menu.
 *
 * Wired straight into `ctx.config`: the quality segments call
 * `config.setQuality`, the sliders write `config.sensitivity` and `config.fov`
 * (and push the FOV into the live camera), and every change is announced on the
 * event bus so render/player can react without importing this module.
 *
 * Events emitted: `ui:pause` {paused}, `ui:quality` {quality},
 * `ui:sensitivity` {value}, `ui:fov` {value}, `ui:setting` {key, value}.
 */
export class PauseMenu {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.root = el('div', 'ow-menu', parent);
    const inner = el('div', 'ow-menu-inner', this.root);

    const h = el('h1', null, inner, 'Paused');
    h.textContent = 'PAUSED';
    el('div', 'sub', inner, 'OVERWATCH — TACTICAL OPERATIONS');
    el('div', 'rule', inner);

    this.rows = el('div', null, inner);

    // ---- quality preset --------------------------------------------------
    this.qBtns = [];
    const qRow = this._row('Graphics Preset');
    const seg = el('div', 'ow-seg', qRow);
    for (const p of PRESETS) {
      const b = el('button', null, seg, p);
      b.type = 'button';
      b.addEventListener('click', () => this.setQuality(p));
      this.qBtns.push(b);
    }

    // A preset switch reaches the render pipeline immediately (resolution,
    // shadows, post chain) but cannot rebuild baked geometry, baked textures,
    // the point-light slot budget or the fixed physics step — those are read
    // once at boot by the subsystems that own them. Say so, rather than letting
    // a player wonder why `mobile` still runs the desktop street.
    el('div', 'hint', this.rows, 'RESTART FOR GEOMETRY, TEXTURES & PHYSICS RATE');

    // ---- resolution ceiling ----------------------------------------------
    /**
     * This slider sets the resolution CEILING, not the resolution.
     *
     * `render.dynres` walks a quantised ladder whose top rung is the preset's
     * own `renderScale`; the slider replaces that top rung, so the scaler still
     * owns everything below it and can still drop to 0.5 on a slow frame. A
     * slider that wrote an absolute scale would either be overwritten by the
     * scaler on the next slow frame or would have to disable it.
     *
     * The label carries the REAL PIXEL COUNT next to the percentage, because
     * "62%" answers no question anyone actually has. It is computed with the
     * same arithmetic `render.resize()` uses (backbuffer = css x min(dpr,
     * dprCap), internal = backbuffer x scale) rather than read back, so it is
     * live while dragging even though the expensive reallocation is debounced.
     */
    this._resCeil = this._currentCeiling();
    this._resSilent = false;
    this._resTimer = 0;
    this.res = this._slider('Resolution', 0.4, 1.0, 0.01, (v) => {
      if (!this._resSilent) this._setResolutionCeiling(v);
      return this._resLabel(v);
    });
    // A drag emits an input event per frame and every one of them would
    // reallocate the whole HDR chain (~8 render targets). The label is
    // arithmetic so it stays instant; the reallocation waits for a pause in the
    // drag, and `change` (thumb released) commits it immediately.
    this.res.input?.addEventListener('change', () => this._commitResolution(true));

    // ---- dynamic resolution ----------------------------------------------
    const dynRow = this._row('Dynamic Resolution');
    const dynSeg = el('div', 'ow-seg', dynRow);
    this.dynBtns = [];
    for (const [label, val] of [['off', false], ['on', true]]) {
      const b = el('button', null, dynSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => this._setDynRes(val));
      this.dynBtns.push([b, val]);
    }
    el('div', 'hint', this.rows, 'ON TRADES SHARPNESS FOR A STEADY FRAME RATE');

    // ---- backbuffer density ----------------------------------------------
    // `dprCap` is the ceiling on devicePixelRatio, i.e. on the size of the
    // BACKBUFFER — which the composite, FXAA and the canvas blit all run at.
    // On a dense phone screen it costs more than `renderScale` does. It is hot:
    // `resize()` calls setPixelRatio/setSize and updates `displaySize` BEFORE
    // its early-out, and everything downstream is sized from the internal
    // target, so a cap change that leaves the internal size alone leaves
    // nothing stale. Verified live in the FASE 6 probe.
    const dprRow = this._row('Backbuffer Density');
    const dprSeg = el('div', 'ow-seg', dprRow);
    this.dprBtns = [];
    for (const v of DPR_CAPS) {
      const b = el('button', null, dprSeg, `${v}x`);
      b.type = 'button';
      b.addEventListener('click', () => this._setDprCap(v));
      this.dprBtns.push([b, v]);
    }

    // ---- performance overlay ---------------------------------------------
    // Reaches `src/core/perfhud.js` through `config.perfHud` + `ui:setting`.
    // No import in either direction; the HUD writes the same field back when
    // its own gesture or F8 toggles it, so this stays in sync.
    const perfRow = this._row('Performance HUD');
    const perfSeg = el('div', 'ow-seg', perfRow);
    this.perfBtns = [];
    for (const [label, val] of [['off', false], ['on', true]]) {
      const b = el('button', null, perfSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.config.perfHud = val;
        this.ctx.events.emit('ui:setting', { key: 'perfHud', value: val });
        this.syncFromConfig();
      });
      this.perfBtns.push([b, val]);
    }
    el('div', 'hint', this.rows, 'FPS, DRAW CALLS, CPU/GPU MS · 3-FINGER TAP OR F8 ALSO TOGGLES');

    // ---- sensitivity -----------------------------------------------------
    this.sens = this._slider('Mouse Sensitivity', 0.2, 3.0, 0.01, (v) => {
      this.ctx.config.sensitivity = 0.0022 * v;
      this.ctx.events.emit('ui:sensitivity', { value: this.ctx.config.sensitivity, multiplier: v });
      return v.toFixed(2);
    });

    // ---- field of view ---------------------------------------------------
    this.fov = this._slider('Field Of View', 65, 120, 1, (v) => {
      this.ctx.config.fov = v;
      const cam = this.ctx.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
      this.ctx.events.emit('ui:fov', { value: v });
      return String(v | 0);
    });

    // ---- invert look -----------------------------------------------------
    const invRow = this._row('Invert Look');
    const invSeg = el('div', 'ow-seg', invRow);
    this.invBtns = [];
    for (const [label, val] of [
      ['off', false],
      ['on', true],
    ]) {
      const b = el('button', null, invSeg, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.ctx.config.invertY = val;
        this.ctx.events.emit('ui:setting', { key: 'invertY', value: val });
        this.syncFromConfig();
      });
      this.invBtns.push([b, val]);
    }

    // ---- buttons ---------------------------------------------------------
    const btns = el('div', 'ow-btns', inner);
    this.resumeBtn = el('button', 'ow-btn primary', btns, 'Resume');
    this.resumeBtn.type = 'button';
    this.resumeBtn.addEventListener('click', () => this.close());
    const reset = el('button', 'ow-btn', btns, 'Defaults');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.sens.set(1);
      this.fov.set(80);
      this.ctx.config.invertY = false;
      this.setQuality('ultra');
    });
    el('div', 'hint', inner, 'ESC RESUME · WASD MOVE · SHIFT SPRINT · R RELOAD · F USE');

    this.open = false;
    this.shown = 0;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'cursor', 'default');

    // The pixel count in the resolution label is a function of the canvas size,
    // so it has to follow a rotation or a window resize. An event, not a
    // per-frame recompute: the string would be a fresh allocation every frame.
    this._onResize = () => this.refreshResolution();
    this.ctx.events?.on?.('resize', this._onResize);

    this.syncFromConfig();
  }

  _row(name) {
    const r = el('div', 'ow-row', this.rows);
    el('div', 'name', r, name.toUpperCase());
    return r;
  }

  _slider(name, min, max, step, apply) {
    const row = this._row(name);
    const wrap = el('div', 'ow-slider', row);
    el('div', 'track', wrap);
    const fill = el('div', 'fill', wrap);
    const knob = el('div', 'knob', wrap);
    const input = el('input', null, wrap);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = el('div', 'val', row, '');

    const paint = (v) => {
      const t = (v - min) / (max - min);
      setStyle(fill, 'width', (t * 100).toFixed(2) + '%');
      setStyle(knob, 'left', (t * 100).toFixed(2) + '%');
      setText(val, apply(v) ?? String(v));
    };
    input.addEventListener('input', () => paint(parseFloat(input.value)));
    const api = {
      set: (v) => {
        const c = clamp(v, min, max);
        input.value = String(c);
        paint(c);
      },
      /** Exposed so a caller can also listen for `change` (thumb released). */
      input,
    };
    return api;
  }

  // ==========================================================================
  //  resolution
  // ==========================================================================

  /** The top rung of the scaler's ladder, i.e. the current ceiling. */
  _currentCeiling() {
    const r = this.ctx.peek?.('render');
    const d = r?.dynres;
    if (d?.ladder?.length) return d.ladder[d.ladder.length - 1];
    return this.ctx.config?.q?.renderScale ?? 1;
  }

  /**
   * `<pct>% · <w>×<h>`, with the internal render-target size computed exactly
   * as `render.resize()` computes it. No readback, so it is correct for a value
   * that has not been applied yet.
   */
  _resLabel(v) {
    const q = this.ctx.config?.q ?? {};
    const pr = Math.min(globalThis.devicePixelRatio || 1, q.dprCap ?? 1.5);
    const cv = this.ctx.canvas;
    const cw = Math.max(1, cv?.clientWidth || globalThis.innerWidth || 1);
    const ch = Math.max(1, cv?.clientHeight || globalThis.innerHeight || 1);
    const rw = Math.max(1, Math.floor(Math.floor(cw * pr) * v));
    const rh = Math.max(1, Math.floor(Math.floor(ch * pr) * v));
    return `${Math.round(v * 100)}% · ${rw}×${rh}`;
  }

  /** Rebuild the ladder around a new ceiling; commit the realloc after a beat. */
  _setResolutionCeiling(v) {
    const c = Math.min(1, Math.max(0.25, Math.round(v * 100) / 100));
    if (Math.abs(c - this._resCeil) < 1e-4) return;
    this._resCeil = c;
    const d = this.ctx.peek?.('render')?.dynres;
    if (d) {
      // Keep every rung strictly below the new ceiling and put the ceiling on
      // top — the same construction `_initDynRes` uses for a preset.
      const ladder = [];
      for (let i = 0; i < DYNRES_RUNGS.length; i++) {
        if (DYNRES_RUNGS[i] < c - 1e-6) ladder.push(DYNRES_RUNGS[i]);
      }
      ladder.push(c);
      d.ladder = ladder;
      d.index = ladder.length - 1;
      d.hold = 0;
      d.ema = (d.downMs + d.upMs) * 0.5;
    }
    clearTimeout(this._resTimer);
    this._resTimer = setTimeout(() => this._commitResolution(false), 120);
  }

  _commitResolution(immediate) {
    clearTimeout(this._resTimer);
    this._resTimer = 0;
    const r = this.ctx.peek?.('render');
    if (!r?.setRenderScale) return;
    const changed = r.setRenderScale(this._resCeil);
    if (changed || immediate) {
      this.ctx.events?.emit?.('ui:setting', { key: 'renderScale', value: this._resCeil });
    }
  }

  _setDynRes(on) {
    const d = this.ctx.peek?.('render')?.dynres;
    if (d) {
      d.enabled = !!on;
      d.hold = 0;
      d.ema = (d.downMs + d.upMs) * 0.5;
      if (!on && d.ladder?.length) {
        // Turning it off must return the picture to the ceiling the player
        // chose, not leave it parked on whatever rung the scaler had reached.
        d.index = d.ladder.length - 1;
        this.ctx.peek('render').setRenderScale(d.ladder[d.index]);
      }
    }
    this.ctx.events?.emit?.('ui:setting', { key: 'dynres', value: !!on });
    this.syncFromConfig();
  }

  _setDprCap(v) {
    const q = this.ctx.config?.q;
    if (!q || q.dprCap === v) return;
    q.dprCap = v;
    // The whole-engine resize path, exactly as a window resize would take it:
    // `render.resize()` re-reads `dprCap`, resizes the backbuffer and
    // reallocates the internal chain if the internal size moved.
    this.ctx.engine?.resize?.();
    this.ctx.events?.emit?.('ui:setting', { key: 'dprCap', value: v });
    this.syncFromConfig();
  }

  /** Repaint the resolution label without applying anything. */
  refreshResolution() {
    if (!this.res) return;
    this._resSilent = true;
    this._resCeil = this._currentCeiling();
    this.res.set(this._resCeil);
    this._resSilent = false;
  }

  setQuality(name) {
    try {
      this.ctx.config.setQuality(name);
      this.ctx.events.emit('ui:quality', { quality: name });
    } catch (err) {
      console.warn('[ui] quality switch failed', err);
    }
    this.syncFromConfig();
  }

  syncFromConfig() {
    const cfg = this.ctx.config;
    for (let i = 0; i < this.qBtns.length; i++)
      this.qBtns[i].classList.toggle('on', PRESETS[i] === cfg.quality);
    for (const [b, v] of this.invBtns) b.classList.toggle('on', !!cfg.invertY === v);
    this.sens?.set((cfg.sensitivity ?? 0.0022) / 0.0022);
    this.fov?.set(cfg.fov ?? 80);

    // A preset switch rebuilds the scaler's ladder from scratch
    // (`render._initDynRes`), so these three are re-read rather than remembered.
    const dyn = this.ctx.peek?.('render')?.dynres;
    if (this.dynBtns) for (const [b, v] of this.dynBtns) b.classList.toggle('on', !!dyn?.enabled === v);
    if (this.dprBtns) {
      const cap = cfg.q?.dprCap ?? 1.5;
      for (const [b, v] of this.dprBtns) b.classList.toggle('on', Math.abs(cap - v) < 1e-6);
    }
    if (this.perfBtns) for (const [b, v] of this.perfBtns) b.classList.toggle('on', !!cfg.perfHud === v);
    this.refreshResolution();
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.syncFromConfig();
    setStyle(this.root, 'display', '');
    document.exitPointerLock?.();
    const t = this.ctx.time;
    if (t) {
      this._prevScale = t.scale;
      t.scale = 0;
    }
    this.ctx.peek('player')?.setControlEnabled?.(false);
    this.ctx.events.emit('ui:pause', { paused: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const t = this.ctx.time;
    if (t) t.scale = this._prevScale ?? 1;
    this.ctx.peek('player')?.setControlEnabled?.(true);
    this.ctx.input?.requestPointerLock?.();
    this.ctx.events.emit('ui:pause', { paused: false });
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    clearTimeout(this._resTimer);
    this.ctx.events?.off?.('resize', this._onResize);
    this.root.remove();
  }
}
