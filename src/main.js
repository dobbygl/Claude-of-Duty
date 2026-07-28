import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

/**
 * First-boot preset.
 *
 * `(pointer: coarse)`, not `navigator.maxTouchPoints > 0` — which is what
 * `src/core/touch.js` uses, and deliberately still does. The two questions are
 * not the same one. The overlay asks "can this person only touch?", where a
 * false positive on a touchscreen laptop is recoverable in one mouse click
 * (see `usingTouch`). This asks "is this a phone?", where a false positive
 * costs a whole session at 0.62 render scale with the geometry thinned and the
 * materials stripped, and cannot be undone without a reload. A touchscreen
 * laptop reports `maxTouchPoints > 0` and `(pointer: fine)`: its PRIMARY
 * pointer is a mouse, and that is exactly the distinction that matters here.
 *
 * `?q=` always wins, so the capture harness and any explicit link are
 * unaffected, and `capture` short-circuits the query anyway.
 */
const coarsePointer =
  !capture && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const quality = params.get('q') ?? (coarsePointer ? 'mobile' : 'low');

const config = createConfig({
  quality,
  deterministic: capture,
});

const canvas = document.getElementById('game');

/**
 * The static boot screen in index.html. Boot is pure computation — every
 * texture, mesh, animation and sound is synthesised here — which is seconds on a
 * desktop and an estimated 15-40 s on a phone, all of it a black screen without
 * this. It is markup in the document rather than something built here so it
 * paints before this module has even been fetched.
 */
const clearBoot = () => document.getElementById('ow-boot')?.remove();

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  clearBoot();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
const warmup = params.get('prewarm') === '0' ? { ok: false, reason: 'disabled by ?prewarm=0' } : await prewarm(engine);
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  clearBoot();
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      clearBoot();
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

/**
 * Suspend everything while the page is not on screen.
 *
 * On a phone this is not a nicety. A backgrounded tab still gets its rAF on some
 * browsers and gets none on others, so the accumulator either burns battery or
 * banks a spike; and — the reason this exists — an iOS AudioContext that is
 * interrupted (call, lock screen, app switch) without being suspended first goes
 * to the `interrupted` state and never produces a sample again for the life of
 * the page. Suspending on the way out and resuming on the way back is the only
 * documented recovery.
 *
 * Never installed in a capture session: a headless page can report
 * `visibilityState === 'hidden'`, which would stop the engine under the harness.
 */
if (!capture) {
  let pausedByVisibility = false;
  const setHidden = (hidden) => {
    const actx = engine.ctx.peek('audio')?.actx;
    if (hidden) {
      if (pausedByVisibility) return;
      pausedByVisibility = true;
      engine.stop();
      actx?.suspend?.().catch(() => {});
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      // start() re-stamps `_last`, so the first frame back is a normal dt
      // rather than however long the phone was in someone's pocket.
      engine.start();
      actx?.resume?.().catch(() => {});
    }
  };
  // On `document`, which is where the spec fires it — it reaches `window` only
  // because it bubbles, and that is a detail not worth depending on.
  document.addEventListener('visibilitychange', () =>
    setHidden(document.visibilityState === 'hidden')
  );
  // pagehide/pageshow rather than unload: bfcache restores the page live, and
  // an audio graph that was not suspended on the way in comes back mute.
  addEventListener('pagehide', () => setHidden(true));
  addEventListener('pageshow', () => setHidden(false));
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
