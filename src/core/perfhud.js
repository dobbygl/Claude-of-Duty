/**
 * On-device performance HUD.
 *
 * WHY IT EXISTS. Five phases of mobile optimisation shipped without a single
 * number measured on real hardware: this box has no GPU (SwiftShader), so every
 * millisecond claim in the project is an argument from work removed, not a
 * measurement. The user reports "it feels slow" on a phone. That sentence has
 * at least four different causes — vertex/geometry, fragment/fill, CPU, or the
 * 15-40 s procedural BOOT — and they need opposite fixes. This overlay is how
 * that gets decided, by the person holding the phone, with no cable and no
 * DevTools.
 *
 * It lives in `core/` for the same reason `touch.js` does: it is not the game's
 * HUD. It owns its own DOM and its own stylesheet, it reads the engine and the
 * render subsystem through the public surfaces (`engine.profiler`,
 * `ctx.peek('render')`), and nothing in `src/ui` or in any subsystem knows it
 * exists.
 *
 * ---------------------------------------------------------------- guarantees
 *
 * 1. **It does not exist in capture mode.** `src/main.js` does not construct it
 *    under `config.deterministic`, so there is no DOM node, no listener and no
 *    `engine.profiler`. A diagnostic that could move a pixel in the A/B gate
 *    would invalidate the only evidence the last five phases have.
 * 2. **Zero allocation per frame.** The per-frame path is `frameBegin` /
 *    `phase` / `system` / `frameEnd`, and all four only write numbers into
 *    preallocated typed arrays and integers into fields. Strings — which are
 *    allocations — are built only when the panel REPAINTS, at 5 Hz, and only
 *    while it is visible. A HUD that garbages every frame falsifies its own
 *    measurement, which is worse than no HUD.
 * 3. **It never invents a number.** If `EXT_disjoint_timer_query_webgl2` is not
 *    exposed — which is the common case on mobile — the GPU row says so instead
 *    of showing CPU time relabelled.
 *
 * --------------------------------------------------------------- activation
 *
 *   ?perf=1          on   (?perf=0 forces off and clears the sticky flag)
 *   3-finger tap     toggle. A TAP: exactly three fingers, none of them moving
 *                    more than 20 px, all up within 900 ms of the first down.
 *                    Move-stick + look + fire is also three fingers, which is
 *                    why a plain "3 pointers down" test would fire during a
 *                    firefight — a gameplay hand always drags, and always for
 *                    longer than that.
 *   long press       toggle. 700 ms in the top-right corner (18 vmin square).
 *   F8               toggle, for a desktop session.
 *
 * The state is sticky in `localStorage` so a reload on a phone — which is how
 * you get a cold-boot timing — keeps the HUD without retyping a URL.
 */

/** Frame-time ring, in frames. 300 is 5 s at 60 Hz — long enough for a 1% low
 *  to mean "worst 3 frames", short enough to react while you walk around. */
const SAMPLES = 300;

/** Repaint rate. Anything faster is unreadable AND starts to cost real time. */
const PAINT_MS = 200;

/** Timer-query pool. Results land 1-3 frames late, so the pool has to outlive
 *  the latency or every other frame goes unmeasured. */
const GPU_POOL = 4;

/** Phase labels, indexed by the `phase(idx, ms)` contract in engine.js. */
const PHASES = ['input', 'fixed', 'update', 'late', 'render'];

const CSS = `
#ow-perf {
  position: fixed;
  top: max(6px, env(safe-area-inset-top));
  left: max(6px, env(safe-area-inset-left));
  z-index: 2147483000;
  pointer-events: none;
  max-width: min(94vw, 560px);
  padding: 7px 9px 6px;
  background: rgba(4,7,10,.78);
  border: 1px solid rgba(255,176,42,.35);
  border-radius: 3px;
  color: #dfe8ee;
  font: 13px/1.42 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .01em;
  white-space: pre;
  text-shadow: 0 1px 2px rgba(0,0,0,.9);
  -webkit-user-select: none; user-select: none;
  contain: content;
}
#ow-perf .k { color: rgba(150,168,180,.85); }
/* fps and draw calls are the two numbers the reader is looking for, so they
   get their own type tier instead of hiding in the middle of a block. */
#ow-perf .big { font-size: 15px; font-weight: 700; color: #ffb02a; }
#ow-perf .big2 { font-size: 14px; font-weight: 700; color: #cfe4f2; }
#ow-perf .warn { color: #ff7a5a; }
#ow-perf .row { display: block; }
#ow-perf .wrap { white-space: normal; font-size: 11px; line-height: 1.3; }
/* A landscape phone is ~390 css px tall. At the desktop type size this panel
   covered half of it, which is not a diagnostic overlay, it is a wall — the
   FASE 6 probe measured 49 % of the screen on an 844x390 viewport and failed
   its own budget. Type comes down and the padding with it; the two rows that
   read as prose (boot, gpu id) come down further because they are read once,
   not watched. */
@media (max-height: 520px) {
  #ow-perf { font-size: 11.5px; line-height: 1.3; padding: 5px 7px 4px; }
  #ow-perf .big { font-size: 13px; }
  #ow-perf .big2 { font-size: 12.5px; }
  #ow-perf .wrap { font-size: 10px; line-height: 1.25; }
  #ow-perf .bar { margin-top: 3px; }
  #ow-perf .bar button { padding: 6px 9px; font-size: 11px; }
}
#ow-perf .bar { margin-top: 5px; pointer-events: auto; display: flex; gap: 6px; }
#ow-perf .bar button {
  pointer-events: auto;
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  color: #05080b; background: #ffb02a;
  border: 0; border-radius: 2px; padding: 7px 11px;
  /* A thumb target, not a mouse target: 32 px is the floor even in the compact
     phone tier below, where the type shrinks but the button must not. */
  min-height: 32px;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
#ow-perf .bar button.ghost { background: rgba(223,232,238,.22); color: #dfe8ee; }
#ow-perf textarea {
  pointer-events: auto;
  display: block; width: 100%; height: 26vh; margin-top: 6px;
  font: 11px/1.35 ui-monospace, monospace;
  color: #dfe8ee; background: rgba(0,0,0,.6);
  border: 1px solid rgba(255,176,42,.4);
}
`;

/** `perf.now()` deltas are float64; a 300-slot ring is 2.4 kB, allocated once. */
export class PerfHud {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.visible = false;
    this.root = null;
    this.style = null;

    // ---- frame statistics (all preallocated) -------------------------------
    this.frameMs = new Float64Array(SAMPLES);
    this.cpuMs = new Float64Array(SAMPLES);
    /** Scratch for the percentile. TypedArray.sort is in place: no allocation. */
    this.sortBuf = new Float64Array(SAMPLES);
    this.n = 0;
    this.write = 0;
    this._lastEnd = 0;

    this.phaseMs = new Float64Array(PHASES.length);
    this.phaseAcc = new Float64Array(PHASES.length);
    /**
     * This frame's phase times, before they are committed to the accumulator.
     *
     * The breakdown has to describe the SAME frames the fps/cpu ring describes,
     * and the ring throws away anything over 2 s (a tab switch, a debugger, a
     * first frame that compiled something). Accumulating straight into
     * `phaseAcc` did not, and the phone probe caught the result: a report
     * reading `cpu 29.36 ms per frame` directly above `late 28601.70`, because
     * the one 28-second frame was excluded from the ring and included in the
     * breakdown. Two numbers on the same panel, disagreeing by a factor of 1000.
     */
    this.phaseCur = new Float64Array(PHASES.length);
    this.phaseFrames = 0;

    // ---- per-subsystem CPU -------------------------------------------------
    // A Map keyed by the subsystem id string. `Map.get(string)` allocates
    // nothing, which a `{}` property write on a hidden-class miss would.
    this.sysIndex = new Map();
    this.sysNames = [];
    const ordered = engine.registry.ordered ?? [];
    for (let i = 0; i < ordered.length; i++) {
      const id = ordered[i].constructor?.id ?? `sys${i}`;
      this.sysIndex.set(id, i);
      this.sysNames.push(id);
    }
    this.sysAcc = new Float64Array(this.sysNames.length);
    this.sysCur = new Float64Array(this.sysNames.length);
    this.sysMs = new Float64Array(this.sysNames.length);

    // ---- GPU timer ---------------------------------------------------------
    this.gl = null;
    this.gpuExt = null;
    this.gpuStatus = 'unknown';
    this.gpuPool = null;
    this.gpuActive = null;
    this.gpuNext = 0;
    this.gpuMs = 0;
    this.gpuSamples = 0;

    // ---- boot --------------------------------------------------------------
    this.bootText = '';

    // ---- activation --------------------------------------------------------
    this._paintAt = 0;
    this._pointers = [];
    for (let i = 0; i < 6; i++) {
      this._pointers.push({ id: -1, t: 0, x: 0, y: 0, moved: false });
    }
    this._nDown = 0;
    this._tapFirst = 0;
    this._tapCount = 0;
    this._tapOk = true;
    this._holdTimer = 0;
    this._holdId = -1;

    this._bound = {
      down: this._onDown.bind(this),
      move: this._onMove.bind(this),
      up: this._onUp.bind(this),
      key: this._onKey.bind(this),
      /**
       * The pause menu's toggle. It reaches us through `ui:setting` and
       * `config.perfHud` — an event and a config field, the two mechanisms
       * ARCHITECTURE.md already defines — so `src/ui` never imports this file
       * and this file never imports `src/ui`.
       */
      setting: (e) => {
        if (e?.key !== 'perfHud') return;
        if (e.value) this.show();
        else this.hide();
      },
    };

    // Engine-facing profiler object. Bound once; `engine.profiler` is either
    // this object or null, and it is only non-null while the panel is up.
    this.profiler = {
      frameBegin: () => this._frameBegin(),
      phase: (i, ms) => {
        this.phaseCur[i] += ms;
      },
      system: (_p, id, ms) => {
        const i = this.sysIndex.get(id);
        if (i !== undefined) this.sysCur[i] += ms;
      },
      gpuBegin: () => this._gpuBegin(),
      gpuEnd: () => this._gpuEnd(),
      frameEnd: (cpu) => this._frameEnd(cpu),
    };
  }

  // ==========================================================================
  //  lifecycle
  // ==========================================================================

  attach() {
    // Capture phase on `window`, so a subsystem that stops propagation on its
    // own overlay (touch.js captures its pointers) cannot hide the gesture.
    const o = { capture: true, passive: true };
    addEventListener('pointerdown', this._bound.down, o);
    addEventListener('pointermove', this._bound.move, o);
    addEventListener('pointerup', this._bound.up, o);
    addEventListener('pointercancel', this._bound.up, o);
    addEventListener('keydown', this._bound.key, { capture: true });
    this.ctx.events?.on?.('ui:setting', this._bound.setting);
    return this;
  }

  detach() {
    const o = { capture: true, passive: true };
    removeEventListener('pointerdown', this._bound.down, o);
    removeEventListener('pointermove', this._bound.move, o);
    removeEventListener('pointerup', this._bound.up, o);
    removeEventListener('pointercancel', this._bound.up, o);
    removeEventListener('keydown', this._bound.key, { capture: true });
    this.ctx.events?.off?.('ui:setting', this._bound.setting);
    this.hide();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    if (this.visible) return this;
    if (!this.root) this._build();
    document.body.appendChild(this.style);
    document.body.appendChild(this.root);
    this.visible = true;
    this._resetStats();
    this._gpuInit();
    this.engine.profiler = this.profiler;
    // Shared truth with the pause menu's toggle. Written, never announced: the
    // menu re-reads it every time it opens, and emitting here would bounce the
    // event straight back into `_bound.setting`.
    this.ctx.config.perfHud = true;
    this._store('1');
    this._paint();
    return this;
  }

  hide() {
    if (!this.visible) return this;
    this.visible = false;
    // Detaching the profiler is what makes the HUD free when it is off: the
    // engine goes back to its original `for..of` loops with no timing calls.
    if (this.engine.profiler === this.profiler) this.engine.profiler = null;
    this.root?.remove();
    this.style?.remove();
    this.ctx.config.perfHud = false;
    this._store('0');
    return this;
  }

  dispose() {
    this.detach();
    if (this.gl && this.gpuPool) {
      for (let i = 0; i < this.gpuPool.length; i++) this.gl.deleteQuery(this.gpuPool[i].q);
      this.gpuPool = null;
    }
  }

  _store(v) {
    try {
      localStorage.setItem('ow-perf', v);
    } catch {
      /* Safari private mode; the flag is a convenience, not a requirement. */
    }
  }

  // ==========================================================================
  //  per-frame path — nothing below this line may allocate
  // ==========================================================================

  /**
   * Part of the engine's profiler contract; nothing to do here.
   *
   * The frame PERIOD is measured end-to-end, not begin-to-begin, and the reason
   * is a real bug the live probe caught: `frameBegin` fills slot i with the
   * period that ENDED at frame i, while `frameEnd` fills the same slot with the
   * cpu time of frame i itself — one frame apart. On a machine whose frame time
   * is drifting, the mean cpu then comes out ABOVE the mean frame time (measured
   * 255.7 ms of cpu inside a 244.4 ms frame), which is impossible and makes the
   * whole panel untrustworthy. end→end puts both numbers on the same frame, and
   * the cpu span is then a strict subset of the period by construction.
   */
  _frameBegin() {}

  _frameEnd(cpu) {
    const now = performance.now();
    // A frame longer than 2 s is a tab-switch, a debugger or a shader compile
    // stall; 0 is the first frame after the panel opened. Both are stored as 0
    // and skipped below, so a stale slot can never re-enter the ring.
    const dt = this._lastEnd === 0 ? 0 : now - this._lastEnd;
    this._lastEnd = now;
    const keep = dt > 0 && dt < 2000;
    this.frameMs[this.write] = keep ? dt : 0;
    this.cpuMs[this.write] = cpu;
    if (keep) {
      this.write = (this.write + 1) % SAMPLES;
      if (this.n < SAMPLES) this.n++;
      // Commit this frame's breakdown only if the frame itself counted.
      for (let i = 0; i < this.phaseCur.length; i++) this.phaseAcc[i] += this.phaseCur[i];
      for (let i = 0; i < this.sysCur.length; i++) this.sysAcc[i] += this.sysCur[i];
      this.phaseFrames++;
    }
    this.phaseCur.fill(0);
    this.sysCur.fill(0);
    if (now - this._paintAt >= PAINT_MS) {
      this._paintAt = now;
      this._paint();
    }
  }

  // ---------------------------------------------------------------- GPU timer

  _gpuInit() {
    if (this.gpuStatus !== 'unknown') return;
    const renderer = this.ctx.peek('render')?.renderer;
    const gl = renderer?.getContext?.();
    if (!gl) {
      this.gpuStatus = 'no context';
      return;
    }
    this.gl = gl;
    // WebGL2 only. The WebGL1 spelling (EXT_disjoint_timer_query) has a
    // different, uglier API and this engine is WebGL2-only anyway.
    this.gpuExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') ?? null;
    if (!this.gpuExt) {
      // The honest answer, and the common one on mobile: most drivers do not
      // expose it, and Chrome gates it behind a flag on many Android GPUs.
      this.gpuStatus = 'unavailable';
      return;
    }
    this.gpuPool = [];
    for (let i = 0; i < GPU_POOL; i++) {
      this.gpuPool.push({ q: gl.createQuery(), pending: false });
    }
    this.gpuStatus = 'ok';
  }

  _gpuBegin() {
    if (this.gpuStatus !== 'ok' || this.gpuActive !== null) return;
    const slot = this.gpuPool[this.gpuNext];
    if (slot.pending) return; // pool exhausted: skip this frame rather than stall
    try {
      this.gl.beginQuery(this.gpuExt.TIME_ELAPSED_EXT, slot.q);
      this.gpuActive = slot;
    } catch {
      this.gpuStatus = 'failed';
    }
  }

  _gpuEnd() {
    if (this.gpuActive === null) return;
    try {
      this.gl.endQuery(this.gpuExt.TIME_ELAPSED_EXT);
    } catch {
      this.gpuStatus = 'failed';
      this.gpuActive = null;
      return;
    }
    this.gpuActive.pending = true;
    this.gpuActive = null;
    this.gpuNext = (this.gpuNext + 1) % GPU_POOL;

    const gl = this.gl;
    // A disjoint means the GPU was preempted (thermal, another tab, a context
    // switch) and every in-flight result is garbage. Throw them away rather
    // than average a lie into the display.
    const disjoint = gl.getParameter(this.gpuExt.GPU_DISJOINT_EXT);
    for (let i = 0; i < this.gpuPool.length; i++) {
      const s = this.gpuPool[i];
      if (!s.pending) continue;
      if (disjoint) {
        s.pending = false;
        continue;
      }
      if (!gl.getQueryParameter(s.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(s.q, gl.QUERY_RESULT);
      s.pending = false;
      const ms = ns / 1e6;
      // Same 20-frame time constant the dynamic resolution scaler uses, so the
      // two numbers move together and can be read against each other.
      this.gpuMs = this.gpuSamples === 0 ? ms : this.gpuMs + (ms - this.gpuMs) * 0.05;
      this.gpuSamples++;
    }
  }

  // ==========================================================================
  //  statistics
  // ==========================================================================

  _resetStats() {
    this.n = 0;
    this.write = 0;
    this._lastEnd = 0;
    this.frameMs.fill(0);
    this.cpuMs.fill(0);
    this.phaseAcc.fill(0);
    this.phaseCur.fill(0);
    this.phaseMs.fill(0);
    this.sysAcc.fill(0);
    this.sysCur.fill(0);
    this.sysMs.fill(0);
    this.phaseFrames = 0;
    this.gpuSamples = 0;
    this.gpuMs = 0;
  }

  /** Mean of the frame-time ring, ms. */
  _mean(buf) {
    if (this.n === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.n; i++) s += buf[i];
    return s / this.n;
  }

  /**
   * 99th-percentile frame time — "1% low" — plus the worst frame in the window.
   *
   * The percentile is what a player FEELS: an average of 55 fps made of 60 fps
   * with a 200 ms hitch every second reads as broken, and the mean cannot tell
   * you that. `Float64Array.prototype.sort` is numeric and in place, so the
   * only cost is the copy into a buffer that already exists.
   */
  _p99() {
    if (this.n === 0) return 0;
    this.sortBuf.set(this.frameMs.subarray(0, this.n));
    const view = this.sortBuf.subarray(0, this.n);
    view.sort();
    return view[Math.min(this.n - 1, Math.floor(this.n * 0.99))];
  }

  _worst() {
    let m = 0;
    for (let i = 0; i < this.n; i++) if (this.frameMs[i] > m) m = this.frameMs[i];
    return m;
  }

  // ==========================================================================
  //  DOM
  // ==========================================================================

  _row(label) {
    const d = document.createElement('div');
    d.className = 'row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label.padEnd(7, ' ');
    const v = document.createTextNode('');
    d.appendChild(k);
    d.appendChild(v);
    this.root.appendChild(d);
    return v;
  }

  _build() {
    this.style = document.createElement('style');
    this.style.id = 'ow-perf-style';
    this.style.textContent = CSS;

    this.root = document.createElement('div');
    this.root.id = 'ow-perf';

    const fps = document.createElement('div');
    fps.className = 'row big';
    this.tFps = document.createTextNode('');
    fps.appendChild(this.tFps);
    this.root.appendChild(fps);

    // Draw calls sit right under the fps line and in their own type tier: they
    // are the second number the reader is looking for, and the one that says
    // whether a slow frame is the CPU submitting or the GPU shading.
    const draw = document.createElement('div');
    draw.className = 'row big2';
    this.tDraw = document.createTextNode('');
    draw.appendChild(this.tDraw);
    this.root.appendChild(draw);

    this.tCpu = this._row('cpu');
    this.tGpu = this._row('gpu');
    this.tRes = this._row('res');
    this.tPhase = this._row('phase');
    // "top js", not "top": the render SUBSYSTEM does its work inside
    // `renderSystem.render()`, which is the `render` entry on the phase row
    // above, not an `update()`. Labelling this row "top" made 5 ms of physics
    // look like the biggest cost in a frame whose render phase was 26 ms.
    this.tSys = this._row('top js');
    // Heap and the two GPU-object counters share a row: three numbers you
    // glance at once an hour do not each deserve a line on a 390 px screen.
    this.tMem = this._row('mem');

    const boot = document.createElement('div');
    boot.className = 'row wrap';
    const bk = document.createElement('span');
    bk.className = 'k';
    bk.textContent = 'boot   ';
    this.tBoot = document.createTextNode('');
    boot.appendChild(bk);
    boot.appendChild(this.tBoot);
    this.root.appendChild(boot);

    const dev = document.createElement('div');
    dev.className = 'row wrap';
    const dk = document.createElement('span');
    dk.className = 'k';
    dk.textContent = 'gpuid  ';
    this.tDev = document.createTextNode('');
    dev.appendChild(dk);
    dev.appendChild(this.tDev);
    this.root.appendChild(dev);

    const bar = document.createElement('div');
    bar.className = 'bar';
    this.btnCopy = document.createElement('button');
    this.btnCopy.textContent = 'COPY REPORT';
    this.btnClose = document.createElement('button');
    this.btnClose.className = 'ghost';
    this.btnClose.textContent = 'CLOSE';
    bar.appendChild(this.btnCopy);
    bar.appendChild(this.btnClose);
    this.root.appendChild(bar);

    this.area = document.createElement('textarea');
    this.area.readOnly = true;
    this.area.style.display = 'none';
    this.root.appendChild(this.area);

    // `stopPropagation` on the capture-phase listeners above is not enough —
    // these must also never reach the touch overlay or the weapon fires when
    // you tap COPY. The buttons are the only pointer-events:auto part of the
    // panel, so anything that lands here was aimed here.
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    for (const b of [this.btnCopy, this.btnClose]) {
      b.addEventListener('pointerdown', swallow);
      b.addEventListener('pointerup', swallow);
    }
    this.btnCopy.addEventListener('click', (e) => {
      swallow(e);
      this.copyReport();
    });
    this.btnClose.addEventListener('click', (e) => {
      swallow(e);
      this.hide();
    });
  }

  /** Repaint. Runs at 5 Hz and is the ONLY place this file builds a string. */
  _paint() {
    if (!this.visible || !this.root) return;
    // Only re-average when frames have actually been observed since the last
    // paint. Without this guard a second paint in the same tick — which is what
    // any external caller does, `window.__PERF__._paint()` included — divides an
    // already-drained accumulator and blanks the whole breakdown to 0.00.
    if (this.phaseFrames > 0) {
      const frames = this.phaseFrames;
      for (let i = 0; i < this.phaseMs.length; i++) {
        this.phaseMs[i] = this.phaseAcc[i] / frames;
        this.phaseAcc[i] = 0;
      }
      for (let i = 0; i < this.sysMs.length; i++) {
        this.sysMs[i] = this.sysAcc[i] / frames;
        this.sysAcc[i] = 0;
      }
      this.phaseFrames = 0;
    }

    const meanFrame = this._mean(this.frameMs);
    const p99 = this._p99();
    const fps = meanFrame > 0 ? 1000 / meanFrame : 0;
    const low = p99 > 0 ? 1000 / p99 : 0;

    this.tFps.nodeValue =
      `${fps.toFixed(1)} fps   1%low ${low.toFixed(1)}   worst ${this._worst().toFixed(0)}ms`;

    this.tCpu.nodeValue =
      `${this._mean(this.cpuMs).toFixed(2)} ms js   frame ${meanFrame.toFixed(2)} ms`;

    this.tGpu.nodeValue =
      this.gpuStatus === 'ok' && this.gpuSamples > 0
        ? `${this.gpuMs.toFixed(2)} ms  (${this.gpuSamples} q)`
        : this.gpuStatus === 'ok'
          ? 'measuring...'
          : `n/a - EXT_disjoint_timer_query_webgl2 ${this.gpuStatus}`;

    const render = this.ctx.peek('render');
    const info = render?.renderer?.info;
    if (info) {
      const tris = info.render.triangles;
      this.tDraw.nodeValue =
        `${info.render.calls} draws   ${(tris / 1e6).toFixed(2)}M tris   ` +
        `${info.programs?.length ?? 0} prog`;
    }

    const cfg = this.ctx.config;
    if (render) {
      const s = render.screenSize;
      const d = render.displaySize;
      const dyn = render.dynres;
      const rung = dyn && dyn.ladder ? `${dyn.index + 1}/${dyn.ladder.length}` : '-';
      this.tRes.nodeValue =
        `${cfg.quality}  x${(cfg.q.renderScale ?? 1).toFixed(2)} (rung ${rung}` +
        `${dyn ? `, ${dyn.changes} chg` : ''})  ` +
        `${s.width}x${s.height} -> ${d.width}x${d.height}  dpr ${render.renderer.getPixelRatio().toFixed(2)}`;
    }

    let ps = '';
    for (let i = 1; i < PHASES.length; i++) {
      ps += `${PHASES[i]} ${this.phaseMs[i].toFixed(2)}  `;
    }
    this.tPhase.nodeValue = ps;

    this.tSys.nodeValue = this._topSystems(4);

    const mem = performance.memory;
    const tex = info ? `  ${info.memory.textures} tex  ${info.memory.geometries} geo` : '';
    this.tMem.nodeValue = mem
      ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)}/${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB heap${tex}`
      : `heap n/a${tex}`;

    if (this.bootText === '') this.bootText = this._bootSummary();
    this.tBoot.nodeValue = this.bootText;
    if (this.tDev.nodeValue === '') this.tDev.nodeValue = this._gpuName();
  }

  /** Top-N subsystems by mean CPU ms. Linear scans, no sort, no allocation
   *  beyond the one string this returns. */
  _topSystems(n) {
    let out = '';
    let usedMask = 0;
    for (let k = 0; k < n; k++) {
      let best = -1;
      let bestMs = 0;
      for (let i = 0; i < this.sysMs.length; i++) {
        if (usedMask & (1 << i)) continue;
        if (this.sysMs[i] > bestMs) {
          bestMs = this.sysMs[i];
          best = i;
        }
      }
      if (best < 0) break;
      usedMask |= 1 << best;
      out += `${this.sysNames[best]} ${bestMs.toFixed(2)}  `;
    }
    return out || '(no samples)';
  }

  // ==========================================================================
  //  boot + device
  // ==========================================================================

  _bootSummary() {
    const st = this.engine.bootStages;
    if (!st || st.length === 0) return '(not recorded)';
    let total = 0;
    for (let i = 1; i < st.length; i += 2) total += st[i];
    // Sorted descending would be nicer to read, but the ORDER is information:
    // it is the sequence a cold start actually walks. Only the sub-100 ms
    // stages are folded away, and only into a count.
    let out = `${(total / 1000).toFixed(1)}s total = `;
    let hidden = 0;
    for (let i = 0; i < st.length; i += 2) {
      if (st[i + 1] < 100) {
        hidden++;
        continue;
      }
      out += `${st[i]} ${(st[i + 1] / 1000).toFixed(1)}  `;
    }
    if (hidden) out += `+${hidden} under 0.1s`;
    return out;
  }

  /**
   * `WEBGL_debug_renderer_info` where the browser still hands it out, and the
   * plain RENDERER string where it does not (Chrome now unmasks that one by
   * default, Firefox masks both behind a pref). Both are best-effort; the
   * report says which one it got.
   */
  _gpuName() {
    const gl = this.gl ?? this.ctx.peek('render')?.renderer?.getContext?.();
    if (!gl) return 'no gl';
    let name = '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
    } catch {
      /* masked by policy */
    }
    if (!name) {
      try {
        name = `${gl.getParameter(gl.RENDERER)} (masked)`;
      } catch {
        name = 'unknown';
      }
    }
    return name;
  }

  // ==========================================================================
  //  report
  // ==========================================================================

  /**
   * A block of text the user can paste back. No network, no telemetry, no
   * dependency: `navigator.clipboard` if the page has it (it needs a secure
   * context, which `http://<lan-ip>:5173` is NOT on a phone), and a selectable
   * `<textarea>` when it does not — which on a LAN dev server is the path that
   * will actually run.
   */
  report() {
    const cfg = this.ctx.config;
    const render = this.ctx.peek('render');
    const info = render?.renderer?.info;
    const gl = this.gl ?? render?.renderer?.getContext?.();
    const meanFrame = this._mean(this.frameMs);
    const p99 = this._p99();
    const L = [];

    L.push('=== CLAUDE OF DUTY — perf report ===');
    L.push(`when       ${new Date().toISOString()}`);
    L.push(`ua         ${navigator.userAgent}`);
    L.push(
      `screen     ${innerWidth}x${innerHeight} css  dpr ${(globalThis.devicePixelRatio || 1).toFixed(2)}` +
        `  touch ${navigator.maxTouchPoints ?? 0}  cores ${navigator.hardwareConcurrency ?? '?'}`
    );
    L.push(`gpu        ${this._gpuName()}`);
    if (gl) {
      try {
        L.push(
          `gl         maxTex ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}  ` +
            `maxVaryings ${gl.getParameter(gl.MAX_VARYING_VECTORS ?? 0x8dfc)}  ` +
            `maxRT ${gl.getParameter(gl.MAX_DRAW_BUFFERS)}`
        );
      } catch {
        /* some parameters are not queryable on every driver */
      }
    }
    L.push('');
    L.push(`preset     ${cfg.quality}  renderScale ${(cfg.q.renderScale ?? 1).toFixed(3)}`);
    if (render) {
      L.push(
        `size       internal ${render.screenSize.width}x${render.screenSize.height}  ` +
          `backbuffer ${render.displaySize.width}x${render.displaySize.height}  ` +
          `pixelRatio ${render.renderer.getPixelRatio().toFixed(2)}`
      );
      const d = render.dynres;
      if (d) {
        L.push(
          `dynres     ${d.enabled ? 'on' : 'off'}  ladder [${d.ladder.join(', ')}]  ` +
            `at ${d.ladder[d.index]}  steps taken ${d.changes}  ema ${d.ema.toFixed(1)} ms`
        );
      }
      L.push(
        `pipeline   qLevel ${render.qLevel}  shaderTier ${render.shaderTier}  ` +
          `cascades ${render.csm?.cascades ?? '?'}  shadowMap ${cfg.q.shadowMapSize}`
      );
    }
    L.push('');
    L.push(`frames     ${this.n} samples over ${(this.n * meanFrame / 1000).toFixed(1)} s`);
    L.push(
      `fps        avg ${(meanFrame > 0 ? 1000 / meanFrame : 0).toFixed(1)}  ` +
        `1% low ${(p99 > 0 ? 1000 / p99 : 0).toFixed(1)}  worst frame ${this._worst().toFixed(1)} ms`
    );
    L.push(`cpu        ${this._mean(this.cpuMs).toFixed(2)} ms js per frame (engine.step)`);
    L.push(
      `gpu        ${
        this.gpuStatus === 'ok'
          ? this.gpuSamples > 0
            ? `${this.gpuMs.toFixed(2)} ms (${this.gpuSamples} timer queries)`
            : 'NOT MEASURED — timer queries available but none have returned yet'
          : `NOT MEASURED — EXT_disjoint_timer_query_webgl2 ${this.gpuStatus}`
      }`
    );
    let ph = '';
    for (let i = 0; i < PHASES.length; i++) ph += `${PHASES[i]} ${this.phaseMs[i].toFixed(2)}  `;
    L.push(`phases     ${ph}`);
    L.push('subsystem cpu ms/frame:');
    for (let i = 0; i < this.sysNames.length; i++) {
      if (this.sysMs[i] < 0.005) continue;
      L.push(`  ${this.sysNames[i].padEnd(10, ' ')} ${this.sysMs[i].toFixed(3)}`);
    }
    L.push('');
    if (info) {
      L.push(
        `counters   ${info.render.calls} draw calls  ${info.render.triangles} triangles  ` +
          `${info.programs?.length ?? 0} programs  ${info.memory.textures} textures  ` +
          `${info.memory.geometries} geometries`
      );
    }
    const mem = performance.memory;
    if (mem) {
      L.push(
        `heap       ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB used / ` +
          `${(mem.totalJSHeapSize / 1048576).toFixed(1)} MB total / ` +
          `${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB limit`
      );
    }
    L.push('');
    L.push('boot (cold start, ms):');
    const st = this.engine.bootStages ?? [];
    let total = 0;
    for (let i = 0; i < st.length; i += 2) {
      total += st[i + 1];
      L.push(`  ${String(st[i]).padEnd(10, ' ')} ${st[i + 1].toFixed(0)}`);
    }
    L.push(`  ${'TOTAL'.padEnd(10, ' ')} ${total.toFixed(0)}`);
    const warm = globalThis.__PREWARM__;
    if (warm) {
      L.push(
        `  prewarm    ${warm.ms ?? '?'} ms, ${warm.compiled ?? '?'} programs compiled, ` +
          `parallel ${warm.parallel}`
      );
    }
    L.push('=== end ===');
    return L.join('\n');
  }

  copyReport() {
    const text = this.report();
    const fallback = () => {
      this.area.style.display = 'block';
      this.area.value = text;
      this.area.focus();
      this.area.select();
      this.btnCopy.textContent = 'SELECT + COPY';
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => {
            this.btnCopy.textContent = 'COPIED';
            setTimeout(() => (this.btnCopy.textContent = 'COPY REPORT'), 1500);
          },
          fallback
        );
        return text;
      }
    } catch {
      /* clipboard API can throw synchronously on a non-secure origin */
    }
    fallback();
    return text;
  }

  // ==========================================================================
  //  activation gestures
  // ==========================================================================

  _slot(id) {
    for (let i = 0; i < this._pointers.length; i++) {
      if (this._pointers[i].id === id) return this._pointers[i];
    }
    return null;
  }

  _onDown(e) {
    if (e.pointerType === 'mouse') return;
    const free = this._slot(-1);
    if (free) {
      free.id = e.pointerId;
      free.t = e.timeStamp;
      free.x = e.clientX;
      free.y = e.clientY;
      free.moved = false;
    }
    this._nDown++;

    // ---- three-finger TAP -------------------------------------------------
    // Not "three pointers down": stick + look + fire is three pointers, and
    // that combination happens every time the player shoots while moving.
    //
    // The discriminator is MOVEMENT plus total duration, not how tightly the
    // three fingers land. An earlier version also required all three downs
    // inside 400 ms and the live probe caught it: on a loaded main thread the
    // FIRST synthetic pointerdown of a session can take hundreds of ms to
    // dispatch, so a perfectly good tap was rejected once per page. Nothing was
    // gained by it either — a gameplay hand always drags, and a hand that does
    // not drag is still bounded by the 900 ms whole-gesture window in `_onUp`.
    if (this._nDown === 1) {
      this._tapFirst = e.timeStamp;
      this._tapCount = 1;
      this._tapOk = true;
    } else {
      this._tapCount++;
    }

    // ---- corner long press ------------------------------------------------
    const corner = Math.min(innerWidth, innerHeight) * 0.18;
    if (e.clientX > innerWidth - corner && e.clientY < corner) {
      this._holdId = e.pointerId;
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => {
        if (this._holdId === e.pointerId) this.toggle();
      }, 700);
    }
  }

  _onMove(e) {
    if (e.pointerType === 'mouse') return;
    const s = this._slot(e.pointerId);
    if (s && !s.moved) {
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (dx * dx + dy * dy > 400) {
        s.moved = true;
        this._tapOk = false;
        if (this._holdId === e.pointerId) this._holdId = -1;
      }
    }
  }

  _onUp(e) {
    if (e.pointerType === 'mouse') return;
    const s = this._slot(e.pointerId);
    if (s) {
      if (s.moved || e.timeStamp - s.t > 900) this._tapOk = false;
      s.id = -1;
    }
    if (this._holdId === e.pointerId) {
      this._holdId = -1;
      clearTimeout(this._holdTimer);
    }
    this._nDown = Math.max(0, this._nDown - 1);
    if (this._nDown === 0) {
      if (this._tapOk && this._tapCount === 3 && e.timeStamp - this._tapFirst <= 900) {
        this.toggle();
      }
      this._tapCount = 0;
      this._tapOk = true;
    }
  }

  _onKey(e) {
    if (e.code === 'F8') {
      e.preventDefault();
      this.toggle();
    }
  }
}

/**
 * Build and wire the HUD. Returns `null` when it must not exist at all.
 *
 * `deterministic` is the hard gate: under the capture harness there is no
 * object, no listener, no stylesheet and no `engine.profiler`, so the pixel
 * gate cannot see this file.
 */
export function installPerfHud(engine, { params } = {}) {
  const cfg = engine.config;
  if (cfg.deterministic) return null;

  const q = params?.get?.('perf') ?? null;
  let want = q === '1';
  if (q === '0') {
    try {
      localStorage.setItem('ow-perf', '0');
    } catch {
      /* ignore */
    }
  } else if (q === null) {
    try {
      want = localStorage.getItem('ow-perf') === '1';
    } catch {
      /* ignore */
    }
  }

  const hud = new PerfHud(engine).attach();
  if (want) hud.show();
  return hud;
}
