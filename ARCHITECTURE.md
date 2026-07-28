# OVERWATCH — engine contract

**Every agent must read this before writing code. It is the only coordination mechanism.**

Target: a browser FPS whose *visual and tactile quality* stands next to a modern
Call of Duty. WebGL2 + Three.js r180, no external art assets — all textures,
meshes, animation and audio are generated procedurally at load time.

## Hard rules

1. **You own your directory. Never edit files outside it.** Another agent owns
   every other directory and your edit will be clobbered or will break them.
2. **Never import another subsystem's module.** Get it at runtime:
   `const fx = ctx.get('fx')`. This is what makes parallel work safe.
3. **No new npm dependencies.** `three` only. No CDN fetches, no external
   images/HDRIs/models/audio files — the game must run fully offline.
4. **No `Math.random()` in gameplay or visuals.** Use `ctx.rng` (see
   `src/core/rng.js`) or a `ctx.rng.fork()` you keep. Capture reproducibility
   depends on it.
5. **Allocate nothing per-frame.** Preallocate vectors, matrices and arrays in
   `init()` and reuse. A `new THREE.Vector3()` inside `update()` is a bug.
6. **Dispose what you create.** Geometries, materials, textures and render
   targets get freed in `dispose()`.
7. `npm run build` must pass and `node tools/capture.mjs` must produce a frame
   after your change. If you break the boot, nobody else can work.

## Subsystem interface

```js
export class MySystem {
  static id = 'mysystem';       // unique; how others reach you
  static deps = ['render'];     // ids that must init before you

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // optional, 120 Hz, deterministic gameplay
  update(dt, ctx) {}            // optional, once per frame
  lateUpdate(dt, ctx) {}        // optional, after all update()
  resize(w, h, ctx) {}          // optional
  dispose() {}                  // optional
}
```

`ctx` provides: `scene`, `camera`, `viewScene`, `viewCamera`, `canvas`,
`config`, `events`, `input`, `time`, `rng`, `get(id)`, `peek(id)`, `has(id)`.

- `scene` / `camera` — the world. `viewScene` / `viewCamera` — the first-person
  weapon, drawn separately so it can never clip through walls.
- `time` — `{ elapsed, raw, dt, fixed, alpha, scale, frame }`. Use `alpha` to
  interpolate rendered transforms between physics steps.
- `config.q` — the active quality preset (see `src/core/config.js`). Respect
  `q.taa`, `q.gtao`, `q.ssr`, `q.volumetrics`, `q.shadowMapSize`,
  `q.particleBudget`, `q.decalBudget`. Never exceed a budget.

## Ownership map

| id | directory | owns |
|---|---|---|
| `render` | `src/render/` | WebGLRenderer, HDR pipeline, all post-processing, CSM shadows, the final composite |
| `materials` | `src/materials/` | procedural PBR texture generation, the shared material library, triplanar/detail mapping |
| `sky` | `src/sky/` | physical sky, sun/moon, time of day, IBL/env map generation, volumetric fog & light shafts |
| `world` | `src/world/` | level geometry, the modular building kit, props, set dressing, static collision meshes |
| `physics` | `src/physics/` | broadphase, raycasts, character controller collision, rigid bodies, ragdolls, penetration |
| `player` | `src/player/` | movement state machine, camera feel, sprint/slide/mantle/lean, health |
| `weapons` | `src/weapons/` | weapon meshes, viewmodel rig, ADS, recoil, sway, bob, reload & inspect animation, ballistics |
| `fx` | `src/fx/` | GPU particles, muzzle flash, tracers, impacts, decals, smoke, blood, shells |
| `ai` | `src/ai/` | enemy characters, navigation, perception, cover selection, combat behaviour |
| `ui` | `src/ui/` | HUD, crosshair, hitmarkers, damage indicators, ammo, killfeed, menus |
| `audio` | `src/audio/` | synthesized weapon/foley audio, spatialisation, reverb, occlusion, mix |

Shared, owned by the lead (do not edit): `src/core/`, `src/main.js`,
`src/dev/`, `tools/`, `vite.config.js`.

## Cross-subsystem events

Emit and listen via `ctx.events`. Payloads are plain objects. The canonical set:

| event | payload | emitted by |
|---|---|---|
| `weapon:fire` | `{ weapon, origin: Vector3, dir: Vector3, seed }` | weapons |
| `weapon:reload` | `{ weapon, phase: 'start'\|'magout'\|'magin'\|'end' }` | weapons |
| `weapon:shell` | `{ position, velocity }` | weapons |
| `bullet:impact` | `{ point, normal, surface, incident, damage }` | physics |
| `bullet:tracer` | `{ from, to, speed }` | weapons |
| `damage:dealt` | `{ target, amount, headshot, killed, point }` | ai / physics |
| ↳ | means *damage dealt **to** `target`*. `target` is the local player when an enemy round connects (`'player'`, the player system, or anything with `isPlayer === true`) — filter it out before drawing a hitmarker. Damage is applied by the target's own listener, never by the emitter as well. | |
| `damage:taken` | `{ amount, from: Vector3, health }` | player |
| `actor:death` | `{ actor, point, impulse }` | ai |
| `player:land` | `{ velocity, surface }` | player |
| `player:footstep` | `{ position, surface, running }` | player |
| `player:state` | `{ stance, sprinting, sliding, ads }` | player |
| `explosion` | `{ position, radius, damage }` | any |
| `resize` | `{ width, height }` | engine |
| `ui:quality` | `{ quality }` | ui |
| ↳ | announced *after* `config.setQuality()` has already rewritten `config.q`. A listener re-reads `ctx.config.q` and applies what it can honour live; it must not assume the change is safe to apply, only that the numbers moved. See "Runtime quality changes". | |

If you need an event that is not listed, add a row here in the same commit.

## Surface types

Shared vocabulary for impact FX, decals, audio and footsteps. Physics tags every
collider with one of: `concrete`, `metal`, `wood`, `dirt`, `sand`, `glass`,
`water`, `foliage`, `fabric`, `flesh`, `rubber`, `plaster`.

## Render integration

`render` exposes these to other subsystems:

```js
const r = ctx.get('render');
r.renderer            // THREE.WebGLRenderer — do not change its state outside a frame
r.registerPass(pass)  // insert a custom post pass
r.addLight(light)     // register a punctual light so it participates in culling/budgets
r.requestEnvMap()     // PMREM env map currently in use
r.screenSize          // { width, height } of the internal render target
r.depthTexture        // linear depth, for soft particles / SSR
r.velocityTexture     // motion vectors, for TAA / motion blur
r.setHurt(d,b,f,beat) // screen-space hurt state, 0..1 each, into the composite
r.setQuality(name)    // apply a preset to the LIVE pipeline; returns what was
                      // applied and what still needs a page reload
r.setRenderScale(s)   // internal-resolution scale; forces the reallocation
r.dynres              // dynamic-resolution state (?dynres=0 to disable)
```

`setHurt(desaturation, bloodVignette, hitFlash, heartbeat)` is what `ui` calls
every frame instead of stacking DOM layers over the canvas. A full-screen
`backdrop-filter`, `mix-blend-mode` or SVG `filter` over the canvas cannot be
cached in a composited layer — its input redraws every frame — so the browser
reads back the framebuffer and reruns the filter graph on every one. Anything
that wants to tint, desaturate or vignette the whole frame belongs in the
composite, not in the HUD. All four at zero is bit-identical to no effect.

Anything drawn into `viewScene` is composited after the world with a cleared
depth buffer.

Per-object opt-outs, honoured every frame by `render._collect`:

```js
mesh.userData.owNoPrepass = true  // keep out of the depth/normal/velocity prepass
mesh.userData.owNoShadow  = true  // do not cast into the CSM cascades
```

`owNoShadow` is the ONLY shadow-caster switch: the cascades draw with
`scene.overrideMaterial` and never consult `mesh.castShadow`. `src/ai` relies on
this for its off-screen actor LOD.

### The point-light count is a shader permutation key

`r.addLight()` puts a light under distance culling, and the cull sets
`light.visible = false` once the fade reaches zero. Three bakes the number of
**visible** point lights into every material's program cache key, so one lamp
crossing its radius recompiles every lit material in the scene — measured at
+33 to +36 programs and 640-900 ms on that single frame, five times in 900
frames. Anything that registers distance-culled point lights must keep the
visible count constant. Two ways, both pixel-exact:

- drive `intensity` to 0 and leave `visible` true (what `src/fx/lights.js` does), or
- park zero-intensity "ballast" lights and top the count up to a fixed slot
  budget every `lateUpdate` (what `src/world` does for its 17 practicals — see
  `_stabiliseLightCount`, which mirrors the renderer's own fade test because the
  cull runs *after* `lateUpdate`).

A light whose colour × intensity is exactly 0 adds a float `0.0` to the
irradiance accumulator, so extra lit slots cannot move a pixel.

### Runtime quality changes

`ui:quality` is a **broadcast, not a command**. The pause menu writes
`config.q` and announces it; every subsystem that can honour a field live
subscribes and re-reads what it owns. Four do today — `render`, `sky`,
`physics`, `audio` — and the rule for what may go in that list is the same one
the point-light note above is about:

> **A preset field is hot only if changing it changes no shader define.**

Hot, and applied the moment the button is pressed: internal `renderScale`,
`dprCap`, `shadowMapSize`, `shadowDistance`, the entire screen-space effect set
(GTAO / SSR / TAA / motion blur / DOF / contact shadows / bloom — their
material-side terms are gated by the `owFeat` **uniform**, so switching them off
costs nothing and switching them on costs only that effect's own passes), the
prepass attachment set, the volumetric march, the rigid-body substep budget and
the panner model.

Reload-only, and **reported** by `render.setQuality()` rather than silently
dropped: the cascade COUNT (`OW_CASCADES` is a define in the material-patch
chunk *and* in the sky's volumetric march), the shadow tap tier
(`OW_PCF_TAPS` / `OW_PCSS`), `lightSlots`, and everything a subsystem bakes into
geometry, textures or the fixed step at boot — `textureScale`,
`simpleMaterials`, `propDensity`, `drawDistance`, `physicsHz`, the particle and
decal budgets, `anisotropy`. `RenderSystem` therefore keeps two tiers: `qLevel`
follows the live preset and gates which effect OBJECTS exist, while
`shaderTier` is frozen at boot and gates what is compiled INTO a lit material.

Because of that split, `CascadedShadowMaps` must be **mutated, never replaced**
(`csm.setMapSize()`): `MaterialPatcher` and `sky/volumetrics.js` both spread
`csm.uniforms` into their own uniform sets *by reference*, so handing out a new
instance leaves both of them sampling a disposed texture.

### Dynamic resolution

`render.dynres` walks `renderScale` down a quantised ladder
(0.5 / 0.6 / 0.7 / 0.85 / 1.0) on an EMA of the unscaled frame time, with a
30-frame hysteresis window. The preset's own `renderScale` truncates the top of
the ladder: it is a **ceiling**, never a target to climb past, so the scaler is
invisible — and bit-identical to not existing — on a machine that is keeping up.
Quantised and hysteretic because every step reallocates the whole HDR chain.

**It is off under `config.deterministic`**, unconditionally. A scaler that
reallocated mid-shot would make every A/B pixel gate in this repo meaningless.

### Pre-warm

`src/core/prewarm.js` runs before the first frame and calls
`prewarmMaterials(ctx)` on every subsystem that implements it (`render`,
`world`, `ai`). The contract: **build and compile every material the subsystem
can produce, without spawning gameplay objects, drawing a gameplay frame, or
touching the clock/RNG.** `renderer.compileAsync(scene, camera)` alone only
reaches the forward lit variant — not the CSM depth pass, the MRT prepass, or
the post chain. Two traps:

- A render target must be bound while compiling. `outputColorSpace` and
  `toneMapping` are part of the cache key and are read off the *currently bound*
  target, so compiling with the canvas bound warms the wrong variant.
- `fx` is excluded and self-warms on frame 2: its key depends on the visible
  light count, which is only settled inside the first rendered frame.

## Quality bar

Every visual subsystem is reviewed by an adversarial critic against real CoD
frames. Non-negotiables:

- **No flat/untextured surfaces.** Every material needs albedo variation, a
  normal map, roughness variation, and a detail layer visible at 0.5 m.
- **No uniform lighting.** Contact shadows, bounce, ambient occlusion, and a
  clear key/fill/rim separation.
- **Physically plausible values.** Albedo in 0.02–0.9, metals are 0 or 1,
  real-world light intensities, exposure-driven not multiplier-driven.
- **Nothing perfectly straight, clean, or repeated.** Edge wear, grime in
  crevices, subtle warp, varied instance rotation/scale.
- **Every action has weight.** Recoil, camera shake, screen-space impulse,
  audio transient, and a visual FX on every impact.
