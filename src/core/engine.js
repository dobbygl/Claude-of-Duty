import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/**
 * The Engine owns the frame loop and the shared context handed to every
 * subsystem. It does NOT know what any subsystem does — it only sequences them.
 *
 * Frame order:
 *   1. input.beginFrame()
 *   2. fixedUpdate(engine.fixedDt) xN — physics, deterministic gameplay
 *   3. update(dt)                 — animation, cameras, AI decisions
 *   4. lateUpdate(dt)             — anything that must observe final transforms
 *   5. render subsystem draws
 *   6. input.endFrame()
 */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    /**
     * Fixed step, in seconds. Sourced from the quality preset ONCE, here, and
     * never again: every subsystem's damping, friction and integration constants
     * are parameterised on the `h` it is handed, but a few caches (contact
     * lists, animation phase accumulators) assume the step does not change under
     * them mid-session. Changing the rate at runtime is a FASE 5 problem.
     * Deterministic capture runs are unaffected as long as the preset is fixed.
     */
    const hz = config?.q?.physicsHz;
    this.fixedDt = Number.isFinite(hz) && hz > 0 ? 1 / hz : FIXED_DT;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, 1200);
    this.camera.rotation.order = 'YXZ';

    /** Separate scene+camera for the first-person viewmodel, drawn with its own
     *  near plane so hands/weapon never clip into world geometry. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

    this.time = {
      /** Seconds since start, scaled. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Fixed step. Read this, never the FIXED_DT module constant. */ fixed: this.fixedDt,
      /** Interpolation alpha between the last two physics steps, 0..1. */ alpha: 0,
      scale: 1,
      frame: 0,
      /** Wall-clock ms the LAST `step()` spent in JS. See the note in `step`. */
      stepMs: 0,
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._onResize = () => this.resize();

    /**
     * Optional frame profiler. `null` in every normal session — and in EVERY
     * capture session, unconditionally, because the only thing that ever sets it
     * is `src/core/perfhud.js`, which is not constructed under
     * `config.deterministic`.
     *
     * When it is null `step()` runs exactly the code it ran before this field
     * existed: the hot loops keep their original `for..of` form in the `else`
     * branch, and the cost of profiling being OFF is four predictable
     * `!== null` tests per frame.
     *
     * Contract (all optional, all called with primitives — nothing here may
     * allocate):
     *   frameBegin()                start of step()
     *   phase(idx, ms)              0 input, 1 fixed, 2 update, 3 lateUpdate, 4 render
     *   system(phaseIdx, id, ms)    per-subsystem slice of phases 1..3
     *   gpuBegin() / gpuEnd()       bracket the render subsystem's GL work
     *   frameEnd(cpuMs, steps)      end of step()
     */
    this.profiler = null;
    /** Scratch timestamps for the profiler. Scalars, never read when off. */
    this._p0 = 0;
    this._pFrame0 = 0;

    /**
     * Boot stage timings, filled by `init()` and appended to by `src/main.js`.
     * `[label, ms]` pairs in wall-clock order. This is the ONLY record of where
     * a cold start goes, and on a phone a cold start is 15-40 s of black screen
     * — a number the frame HUD cannot show and the one that decides whether a
     * "it feels slow" report is about the frame at all.
     */
    this.bootStages = [];
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  async init() {
    const order = this.registry.resolve();
    for (const sys of order) {
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      const ms = performance.now() - t0;
      // Recorded for every system, not just the slow ones: this list IS the
      // boot profile (materials = texture bakes, world = level geometry,
      // physics = the collision BVH, render = the pipeline + its targets).
      this.bootStages.push(sys.constructor.id, ms);
      if (ms > 50) console.info(`[engine] ${sys.constructor.id} init ${ms.toFixed(0)}ms`);
    }
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    const t = this.time;
    // Clamp so a tab-switch or a breakpoint doesn't teleport the simulation.
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    // Always measured, profiler or not: the dynamic-resolution controller needs
    // to know how much of the frame was JS before it decides that a smaller
    // render target would help. Two `now()` calls a frame, no allocation.
    const cpu0 = performance.now();

    // Profiling is entirely opt-in; `prof` is null in every capture session.
    // `_p0` is a scalar field rather than a local so the marker helper below
    // needs no closure and no allocation.
    const prof = this.profiler;
    if (prof !== null) {
      prof.frameBegin();
      this._pFrame0 = this._p0 = performance.now();
    }

    this.input.beginFrame();

    this._accum += t.dt;
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    const h = this.fixedDt;
    if (prof !== null) {
      const tIn = performance.now();
      prof.phase(0, tIn - this._p0);
      this._p0 = tIn;
      while (this._accum >= h && steps < MAX_SUBSTEPS) {
        for (let i = 0; i < fixedSystems.length; i++) {
          const sys = fixedSystems[i];
          const ta = performance.now();
          sys.fixedUpdate(h, this.ctx);
          prof.system(1, sys.constructor.id, performance.now() - ta);
        }
        this._accum -= h;
        steps++;
      }
    } else {
      while (this._accum >= h && steps < MAX_SUBSTEPS) {
        for (const sys of fixedSystems) sys.fixedUpdate(h, this.ctx);
        this._accum -= h;
        steps++;
      }
    }
    // Shed the backlog rather than spiral — but ONLY when there really is one.
    // The old test fired on `steps === MAX_SUBSTEPS` alone, which is also what a
    // frame that legitimately needed all 8 steps and drained the accumulator on
    // the last one looks like. Throwing the remainder away there loses up to a
    // full step of simulation time and, worse, zeroes `alpha`, so the render
    // interpolation snaps back on exactly the frames that are already long.
    if (steps === MAX_SUBSTEPS && this._accum >= h) this._accum = 0;
    t.alpha = this._accum / h;

    if (prof !== null) {
      let tp = performance.now();
      prof.phase(1, tp - this._p0);
      this._p0 = tp;

      const upd = this.registry.with('update');
      for (let i = 0; i < upd.length; i++) {
        const sys = upd[i];
        const ta = performance.now();
        sys.update(t.dt, this.ctx);
        prof.system(2, sys.constructor.id, performance.now() - ta);
      }
      tp = performance.now();
      prof.phase(2, tp - this._p0);
      this._p0 = tp;

      const late = this.registry.with('lateUpdate');
      for (let i = 0; i < late.length; i++) {
        const sys = late[i];
        const ta = performance.now();
        sys.lateUpdate(t.dt, this.ctx);
        prof.system(3, sys.constructor.id, performance.now() - ta);
      }
      tp = performance.now();
      prof.phase(3, tp - this._p0);
      this._p0 = tp;

      const renderSystem = this.registry.peek('render');
      if (typeof renderSystem?.render === 'function') {
        prof.gpuBegin();
        renderSystem.render(this.ctx);
        prof.gpuEnd();
      }
      tp = performance.now();
      prof.phase(4, tp - this._p0);

      this.input.endFrame();
      prof.frameEnd(performance.now() - this._pFrame0, steps);
    } else {
      for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
      for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);

      const renderSystem = this.registry.peek('render');
      if (typeof renderSystem?.render === 'function') renderSystem.render(this.ctx);

      this.input.endFrame();
    }

    // Read by `render._updateDynRes` on the FOLLOWING frame — this is closed
    // after the render call it would otherwise have to predict.
    t.stepMs = performance.now() - cpu0;
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
