/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

/**
 * Default fixed-step rate. The ACTIVE rate is `config.q.physicsHz`, read once by
 * `Engine` at construction into `engine.fixedDt` / `ctx.time.fixed`; these two
 * exports are the fallback for a harness that builds an Engine without a preset.
 * Nothing should import FIXED_DT to do per-step maths — use `ctx.time.fixed`.
 */
export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

/**
 * `dprCap` is the ceiling on `devicePixelRatio`, i.e. on the size of the
 * BACKBUFFER — not of the HDR chain, which `renderScale` sizes. The final
 * composite, FXAA and the canvas blit all run at the backbuffer, so on a phone
 * reporting DPR 3 a cap of 1.5 makes those passes cover 2.25x the pixels of
 * everything upstream of them. Anything running on a small, dense, thermally
 * limited screen wants 1.0.
 *
 * The fields below `decalBudget` are the ones a phone actually needs, and every
 * one of them is a NO-OP at low/medium/high/ultra — they are written out at the
 * value each subsystem already hardcoded, so adding them cannot move a pixel on
 * the existing presets. Only `mobile` deviates.
 *
 *   physicsHz      fixed-step rate. `Engine` reads it once at construction.
 *   bodySubsteps   ceiling on a rigid body's discrete CCD substeps per step.
 *                  12 is what rigidbody.js hardcoded; a phone spends that budget
 *                  on debris nobody is looking at.
 *   drawDistance   metres past which a chunked instance cloud is not drawn.
 *                  0 = unlimited (what every preset did before this existed).
 *   lodBias        multiplier on each prop prototype's own `maxDist`.
 *   propDensity    fraction of OPTIONAL scatter instances to keep, 0..1.
 *                  Only prototypes flagged `optional` in props.js are thinned,
 *                  and none of them carries collision — see Assembler.place().
 *   geoDetail      geometry detail tier for the world's own generators, 1 =
 *                  full. Below 1, a thin member loses its chamfer (44 -> 12
 *                  triangles), cylinders and lathes lose segments, and the
 *                  window sill/lintel/shutter kit drops to its cheap form.
 *                  It is the complement of `propDensity`: that one removes
 *                  whole instances, this one makes the instance cheaper — so it
 *                  is the knob for the props that are NOT optional, which is
 *                  where the triangles actually are (two tyres and three crates
 *                  were 27 % of the prop cloud). Consumes no rng, so the level
 *                  it builds is bit-identical whatever the tier.
 *   textureScale   procedural bake resolution multiplier (1 = 1K reference).
 *   simpleMaterials  drop POM, triplanar, de-tiling and the macro relief /
 *                  big-band layers out of every world material.
 *   lightSlots     the world's fixed point-light slot budget. THIS IS A SHADER
 *                  PERMUTATION KEY (see ARCHITECTURE.md) — it must be constant
 *                  for the whole session, which is why it lives in the preset
 *                  and not in anything adaptive.
 *   skyQuality     1 = full screen dome, 0 = reduced octave counts.
 *   hrtf           false swaps every 3D panner to `equalpower`.
 */
export const QUALITY_PRESETS = {
  /**
   * Phone/tablet tier. Not a smaller `low`: it is the only preset that changes
   * the SHAPE of the frame — geometry is distance-culled and thinned, materials
   * lose their dependent-fetch layers, the lit-fragment light loop drops from 20
   * slots to 8, and the fixed step drops from 120 Hz to 50.
   */
  mobile: {
    renderScale: 0.62,
    dprCap: 1.0,
    shadowMapSize: 512,
    cascades: 2,
    shadowDistance: 40,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: false,
    anisotropy: 2,
    particleBudget: 600,
    decalBudget: 32,
    physicsHz: 50,
    bodySubsteps: 4,
    drawDistance: 55,
    lodBias: 0.55,
    propDensity: 0.5,
    geoDetail: 0.5,
    textureScale: 0.25,
    simpleMaterials: true,
    lightSlots: 8,
    skyQuality: 0,
    hrtf: false,
  },
  low: {
    renderScale: 0.72,
    dprCap: 1.0,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
    physicsHz: 120,
    bodySubsteps: 12,
    drawDistance: 0,
    lodBias: 1,
    propDensity: 1,
    geoDetail: 1,
    textureScale: 0.5,
    simpleMaterials: false,
    lightSlots: 20,
    skyQuality: 1,
    hrtf: true,
  },
  medium: {
    renderScale: 0.85,
    dprCap: 1.5,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
    physicsHz: 120,
    bodySubsteps: 12,
    drawDistance: 0,
    lodBias: 1,
    propDensity: 1,
    geoDetail: 1,
    textureScale: 0.75,
    simpleMaterials: false,
    lightSlots: 20,
    skyQuality: 1,
    hrtf: true,
  },
  high: {
    renderScale: 1.0,
    dprCap: 1.5,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
    physicsHz: 120,
    bodySubsteps: 12,
    drawDistance: 0,
    lodBias: 1,
    propDensity: 1,
    geoDetail: 1,
    textureScale: 1,
    simpleMaterials: false,
    lightSlots: 20,
    skyQuality: 1,
    hrtf: true,
  },
  ultra: {
    renderScale: 1.0,
    dprCap: 1.5,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
    physicsHz: 120,
    bodySubsteps: 12,
    drawDistance: 0,
    lodBias: 1,
    propDensity: 1,
    geoDetail: 1,
    textureScale: 1,
    simpleMaterials: false,
    lightSlots: 20,
    skyQuality: 1,
    hrtf: true,
  },
};

export const DEFAULTS = {
  quality: 'low',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /**
   * Diagnostic overlay (`src/core/perfhud.js`). Lives in the config so the
   * pause menu and the HUD's own gestures share one source of truth without
   * either side importing the other: the menu writes it and announces
   * `ui:setting`, the HUD listens and also writes it back when a gesture or F8
   * toggles it. Forced off in capture mode, where the HUD is not constructed.
   */
  perfHud: false,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
