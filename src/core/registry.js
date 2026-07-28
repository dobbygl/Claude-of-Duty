/**
 * Subsystem registry + shared context.
 *
 * CONTRACT — every subsystem is a class with:
 *   static id      : string, unique. Other systems fetch it via ctx.get(id).
 *   static deps    : string[] of subsystem ids that must init first.
 *   async init(ctx): build resources. May await asset loads.
 *   update(dt,ctx) : variable-rate, once per frame, before render.
 *   fixedUpdate(h,ctx): fixed-rate (PHYSICS_HZ), 0..N times per frame. Optional.
 *   lateUpdate(dt,ctx): after all update(), before render. Optional.
 *   resize(w,h,ctx): viewport changed. Optional.
 *   dispose()      : free GPU/CPU resources. Optional.
 *
 * Subsystems MUST NOT import each other directly — go through ctx.get(id).
 * That keeps the dependency graph explicit and lets agents own files in isolation.
 */

export class Registry {
  #systems = new Map();
  #order = [];

  add(system) {
    const id = system.constructor.id;
    if (!id) throw new Error(`${system.constructor.name} is missing a static id`);
    if (this.#systems.has(id)) throw new Error(`duplicate subsystem id "${id}"`);
    this.#systems.set(id, system);
    return this;
  }

  get(id) {
    const s = this.#systems.get(id);
    if (!s) throw new Error(`subsystem "${id}" not registered`);
    return s;
  }

  /** Non-throwing lookup for optional dependencies. */
  peek(id) {
    return this.#systems.get(id) ?? null;
  }

  has(id) {
    return this.#systems.has(id);
  }

  /** Topological sort over static deps; throws on cycles or missing deps. */
  resolve() {
    const seen = new Map(); // id -> 0 visiting, 1 done
    const out = [];
    const visit = (id, from) => {
      const state = seen.get(id);
      if (state === 1) return;
      if (state === 0) throw new Error(`dependency cycle at "${id}" (via ${from})`);
      const sys = this.#systems.get(id);
      if (!sys) throw new Error(`"${from}" depends on unregistered subsystem "${id}"`);
      seen.set(id, 0);
      for (const d of sys.constructor.deps ?? []) visit(d, id);
      seen.set(id, 1);
      out.push(sys);
    };
    for (const id of this.#systems.keys()) visit(id, '<root>');
    this.#order = out;
    return out;
  }

  get ordered() {
    return this.#order.length ? this.#order : this.resolve();
  }

  /** Systems that implement `method`, in dependency order. Cached per method. */
  #cache = new Map();
  with(method) {
    let list = this.#cache.get(method);
    if (!list) {
      list = this.ordered.filter((s) => typeof s[method] === 'function');
      this.#cache.set(method, list);
    }
    return list;
  }

  invalidate() {
    this.#cache.clear();
  }
}

/**
 * Minimal typed event bus. Handlers are called synchronously.
 *
 * ZERO-ALLOCATION DISPATCH. `emit` used to iterate `[...set]` — a fresh array
 * (plus a Set iterator) on every dispatch, and `bullet:impact` alone runs
 * hundreds of times a second in a firefight, so the copies were a steady GC
 * drip during exactly the frames that could least afford one. Handlers now live
 * in a dense array walked by index.
 *
 * The copy existed so a handler could unsubscribe during dispatch. That is
 * preserved by *deferring* the removal: `off()` inside a dispatch flags the slot
 * and the list is compacted when the outermost dispatch returns, so
 *   - the in-flight dispatch still sees exactly the handler set it started with,
 *     which is what the array copy did;
 *   - the list is never mutated while it is being walked;
 *   - the next `emit` sees the removal.
 * `emit` also snapshots the length, so a handler subscribing during dispatch is
 * not called by that same dispatch — again matching the old copy.
 */
export class EventBus {
  #map = new Map();

  /** @returns {{fns: Function[], dead: boolean[], depth: number, pending: number}} */
  #list(type) {
    let l = this.#map.get(type);
    if (!l) {
      l = { fns: [], dead: [], depth: 0, pending: 0 };
      this.#map.set(type, l);
    }
    return l;
  }

  on(type, fn) {
    const l = this.#list(type);
    // Set semantics: subscribing the same function twice is a no-op.
    const i = l.fns.indexOf(fn);
    if (i < 0) {
      l.fns.push(fn);
      l.dead.push(false);
    } else if (l.dead[i]) {
      // re-subscribed before the deferred removal landed: cancel the removal
      l.dead[i] = false;
      l.pending--;
    }
    return () => this.off(type, fn);
  }

  once(type, fn) {
    // The fired guard, not the unsubscribe, is what makes this fire exactly
    // once: a re-entrant emit of the same type would otherwise re-enter the
    // handler before the deferred removal has been applied.
    let fired = false;
    const off = this.on(type, (e) => {
      if (fired) return;
      fired = true;
      off();
      fn(e);
    });
    return off;
  }

  off(type, fn) {
    const l = this.#map.get(type);
    if (!l) return;
    const i = l.fns.indexOf(fn);
    if (i < 0) return;
    if (l.depth > 0) {
      // Mid-dispatch: leave the slot in place (the running dispatch keeps the
      // handler set it started with, exactly as the array copy did) and compact
      // when it unwinds.
      if (!l.dead[i]) {
        l.dead[i] = true;
        l.pending++;
      }
      return;
    }
    l.fns.splice(i, 1);
    l.dead.splice(i, 1);
  }

  emit(type, payload) {
    const l = this.#map.get(type);
    if (l === undefined) return;
    const fns = l.fns;
    const n = fns.length;
    if (n === 0) return;
    l.depth++;
    for (let i = 0; i < n; i++) {
      const fn = fns[i];
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw:`, err);
      }
    }
    if (--l.depth === 0 && l.pending > 0) {
      const dead = l.dead;
      let w = 0;
      for (let i = 0; i < fns.length; i++) {
        if (dead[i]) continue;
        fns[w] = fns[i];
        dead[w] = false;
        w++;
      }
      fns.length = w;
      dead.length = w;
      l.pending = 0;
    }
  }

  clear() {
    this.#map.clear();
  }
}
