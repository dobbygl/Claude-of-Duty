import * as THREE from 'three';

import { hdrTarget, blit } from './pass.js';
import { CascadedShadowMaps } from './csm.js';
import { MaterialPatcher } from './materialpatch.js';
import { GBuffer } from './prepass.js';
import { Gtao } from './gtao.js';
import { ContactShadows } from './contact.js';
import { Ssr } from './ssr.js';
import { Taa } from './taa.js';
import { MotionBlur } from './motionblur.js';
import { DepthOfField } from './dof.js';
import { Bloom } from './bloom.js';
import { AutoExposure } from './exposure.js';
import { createGradeLut } from './lut.js';
import { createComposite, createFxaa, createDebug, createViewComposite } from './composite.js';
import { buildFallbackEnvironment } from './env.js';
import { RenderProbeScene } from './probe.js';

/**
 * Ordinal quality tier, used for the effects that are not a single preset flag
 * (contact shadows, DOF, bloom levels, viewmodel MSAA, cascade tap counts).
 *
 * `mobile` is -1, i.e. BELOW low, not equal to it: every `>= 1` gate below
 * already excludes it, and the negative value is what `csmShaderChunk` keys its
 * 4-tap PCF kernel off. An unknown preset name still falls back to 3 (ultra),
 * so a typo degrades to "too expensive", never to "silently broken".
 */
const QUALITY_LEVEL = { mobile: -1, low: 0, medium: 1, high: 2, ultra: 3 };

/**
 * Registration range at or below which a punctual light counts as a room/street
 * PRACTICAL rather than as an effect flash. See `settings.practicalGain`.
 */
const PRACTICAL_RANGE = 30;

/**
 * Rungs of the dynamic-resolution ladder, ascending. Quantised on purpose: a
 * continuous controller would reallocate the entire HDR chain (8 render targets
 * plus the gbuffer, the AO history, the bloom pyramid...) on almost every frame,
 * which costs far more than the pixels it saves. Five rungs, and the preset's
 * own `renderScale` truncates the top of the list — see `_initDynRes`.
 */
const DYNRES_STEPS = [0.5, 0.6, 0.7, 0.85, 1.0];

// Full-daylight key intensity (SUN_ILLUMINANCE_TOP through a clear atmosphere).
// Only used to normalise the viewmodel rig, never to light anything.
const REF_DAYLIGHT = 4.6;

/**
 * OVERWATCH renderer.
 *
 * Frame order (everything HDR, linear, float, until the very last write):
 *
 *   1  scene walk        collect draw/hide lists, patch new materials
 *   2  CSM               N stabilised cascades into one R32F array texture
 *   3  jitter            sub-pixel offset on the WORLD camera for TAA
 *   4  prepass           MRT: view normal + velocity + linear depth
 *   5  GTAO              horizon-arc AO, temporally accumulated
 *   6  contact shadows   short depth-buffer ray march toward the sun
 *   7  SSR               marched against depth, coloured from last frame
 *   8  forward world     lit with 2/5/6/7 injected into every material
 *   9  viewmodel         same lighting, into its OWN MSAA colour+depth target
 *  10  TAA               velocity reprojection + YCoCg variance clipping
 *  11  motion blur       velocity-tile reconstruction filter
 *  12  ADS depth of field gather CoC blur, only while the sights are up
 *  13  custom passes     whatever fx/ui/sky registered
 *  14  viewmodel resolve premultiplied composite over the world, FXAA'd
 *  15  metering          GPU log-luminance reduction -> EV100 -> exposure
 *  16  bloom             Karis pyramid with a soft-knee highlight threshold
 *  17  composite         AgX + LUT + vignette + CA + grain -> sRGB
 *  18  FXAA              only when TAA is off
 *
 * Why the viewmodel is resolved separately (steps 9 + 14): everything in
 * `viewScene` moves in VIEW space — the ADS transition, sway, bob, recoil — and
 * a velocity buffer built from camera view-projection matrices describes none of
 * it. Those pixels emitted zero motion, so TAA reprojected them onto a stale
 * history sample holding the static background and blended it in at ~85%. That
 * is what made the optic tube, the mount pedestal and the glove semi-transparent
 * with balcony rails and power lines legible straight through them. Compositing
 * after the resolve removes the whole failure mode instead of tuning around it,
 * and as a bonus keeps the weapon out of the volumetric fog and the ADS DOF.
 *
 * Nothing in the chain uses three's examples/jsm post stack.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const r = ctx.get('render')`
 * ---------------------------------------------------------------------------
 *   r.renderer                THREE.WebGLRenderer (do not change state mid-frame)
 *   r.screenSize              { width, height } of the internal HDR target
 *   r.displaySize             { width, height } of the canvas backbuffer
 *   r.depthTexture            R32F linear view depth in METRES (positive).
 *                             Always present.
 *   r.velocityTexture         RG16F screen-space velocity as a UV delta, or
 *                             NULL when no enabled effect consumes it (the
 *                             `low` preset: no TAA, no motion blur, no
 *                             volumetrics). Test before you sample it.
 *   r.normalTexture           RGBA16F oct-encoded VIEW normal (xy), coverage (z:
 *                             1 = static geometry, 0.7 = skinned/morphed, 0 =
 *                             nothing; test against 0.5 for "is there a
 *                             surface"), material id (w). NULL at `low` for the
 *                             same reason as velocity.
 *   r.aoTexture               R16F GTAO visibility, or null
 *   r.exposureTexture         1x1 float, .r = exposure scalar, .g = EV100
 *   r.hdrTexture              the pre-post HDR colour target
 *   r.prewarmMaterials()      compile the shadow/prepass/post programs up front
 *                             (loading screen only; advances no simulation)
 *   r.registerPass(pass)      pass.render(renderer, inTex, outTarget, r);
 *                             optional .order, .enabled, .resize(w,h).
 *                             Returns an unregister function.
 *   r.addLight(light, opts)   register a punctual light for distance culling
 *   r.requestEnvMap()         the PMREM environment currently in use
 *   r.setEnvMap(tex)          install a new PMREM (sky subsystem)
 *   r.patchMaterials(root)    force-inject shadows/AO/SSR into new materials
 *                             (happens automatically within a frame anyway)
 *   r.setExposureBias(ev)     +1 EV = one stop darker
 *   r.setQuality(name)        apply a preset to the LIVE pipeline. Returns what
 *                             was applied and what still needs a page reload;
 *                             also the `ui:quality` listener. See the method.
 *   r.setRenderScale(s)       internal-resolution scale, forces the realloc
 *   r.dynres                  dynamic-resolution state (ladder, EMA, hysteresis)
 *                             `render.dynres.enabled = false` or `?dynres=0`
 *                             turns it off; always off under `deterministic`
 *   r.settings                live tuning: bloomStrength, bloomThreshold,
 *                             bloomKnee, vignette, adsVignette, grain,
 *                             chromatic, sharpen, shutter, aoRadius,
 *                             aoIntensity, contactLength, contactStrength,
 *                             shadowStrength, sunSoftness,
 *                             exposureKey, autoExposure, skyFill, groundFill,
 *                             bounceFill, viewKeyScale/Max/Gamma,
 *                             viewFillRatio, viewRimRatio, viewHemiRatio,
 *                             viewFillOcclusion, dofMaxCoc, dofNearRatio,
 *                             dofFocusMin/Max, dofFarStart, dofFarRange,
 *                             dofNearScale
 *
 * Note on colour space: chromatic aberration, bloom and the cos^4 lens vignette
 * are LINEAR-light lens effects and happen before the tone map — a vignette
 * applied to code values is a flat multiply that makes display white
 * unreachable everywhere but the centre of the frame. The composite then
 * tone-maps, encodes to sRGB, and applies the grade LUT, grain and dither in
 * DISPLAY space: the LUT is authored display-referred (additive toe and
 * split-tone offsets in code values), so anything added to that tail belongs
 * after the encode too.
 *   r.debugView               'ao'|'normal'|'velocity'|'depth'|'ssr'|'ssrmask'|
 *                             'contact'|'bloom'|'view'|'viewalpha'|null
 *                             (also ?rview=)
 *
 * Per-object opt-outs, set on the Object3D:
 *   userData.owNoPrepass = true   keep out of depth/normal/velocity (particles)
 *   userData.owNoShadow  = true   do not cast into the cascades
 *   userData.owMatId     = 0..1   written to the gbuffer alpha for custom fx
 * Transparent materials are excluded from the prepass and shadows automatically.
 */
export class RenderSystem {
  static id = 'render';
  static deps = [];

  async init(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config;
    const q = cfg.q;
    this.q = q;
    this.qLevel = QUALITY_LEVEL[cfg.quality] ?? 3;
    /**
     * The quality tier the *lit-material shader chunk* was generated at, frozen
     * for the session. `qLevel` follows the live preset and gates which effect
     * OBJECTS exist; `shaderTier` gates PCF/PCSS tap counts inside every lit
     * material, and moving it would re-key `MaterialPatcher` and recompile all
     * ~170 of them mid-frame. See `setQuality()`.
     */
    this.shaderTier = this.qLevel;
    this.rng = ctx.rng.fork();
    this.frame = 0;

    // ---- renderer -------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({
      canvas: ctx.canvas,
      antialias: false, // TAA/FXAA handle this; MSAA cannot resolve HDR post
      alpha: false,
      // The backbuffer's depth attachment is never used: every depth-tested draw
      // in the engine goes into `hdrRt` or `viewRt`, and the only things ever
      // drawn to the canvas are the composite and FXAA full-screen triangles,
      // both with depthTest and depthWrite off. Asking for one allocated a
      // full-resolution depth surface (and on many mobile drivers forced the
      // backbuffer into a slower configuration) for nothing.
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    if (!renderer.capabilities.isWebGL2) {
      throw new Error('[render] WebGL2 is required');
    }
    // WebGL2 guarantees you can *sample* a float texture; it does NOT guarantee
    // you can RENDER to one. That takes EXT_color_buffer_float, which a handful
    // of mobile GLES3 parts still do not expose — and without it every
    // FloatType render target in this file silently comes back incomplete and
    // the frame is black. Detect it once here so the affected buffers can pick a
    // half-float layout instead of failing.
    this.canRenderFloat = !!renderer.getContext().getExtension('EXT_color_buffer_float');
    if (!this.canRenderFloat) {
      console.warn(
        '[render] EXT_color_buffer_float missing — metering falls back to half float'
      );
    }
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.info.autoReset = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // we tonemap in the composite
    renderer.shadowMap.enabled = true; // for spot/point lights owned by others
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x000000, 1);
    this.renderer = renderer;

    // ---- make every pre-compile see the FINAL program -----------------------
    // MEASURED: 26 of 144 live programs were unpatched duplicates of a lit
    // material — compiled once by a caller that pre-compiles the world scene
    // (src/core/prewarm.js does exactly this), then thrown away and compiled
    // again the moment the first real frame walked the scene and injected the
    // shadow/AO/SSR chunk, because `patch()` sets `needsUpdate`. That is 18% of
    // the boot's compile budget spent on programs that are never used to draw
    // anything. Patching before the compile makes the pre-compiled program the
    // one the frame loop actually wants. Restricted to the world and viewmodel
    // scenes so a subsystem baking a texture through its own scene is untouched.
    const rawCompile = renderer.compile.bind(renderer);
    renderer.compile = (target, cam, targetScene) => {
      if (target === ctx.scene) this._patchLikeFrame(ctx.scene, false);
      else if (target === ctx.viewScene) this._patchLikeFrame(ctx.viewScene, true);
      return rawCompile(target, cam, targetScene);
    };

    this.maxAnisotropy = Math.min(
      q.anisotropy,
      renderer.capabilities.getMaxAnisotropy()
    );

    // ---- subsystems of the pipeline --------------------------------------
    this.csm = new CascadedShadowMaps(renderer, {
      cascades: q.cascades,
      mapSize: q.shadowMapSize,
      maxDistance: q.shadowDistance,
    });
    this.patcher = new MaterialPatcher(this.csm.uniforms, {
      cascades: this.csm.cascades,
      quality: this.shaderTier,
    });

    // The prepass writes 20 bytes per pixel across three attachments, and at the
    // low preset SIXTEEN OF THEM HAVE NO READER: gtao, ssr, contact, taa,
    // motionBlur and the sky's volumetric reprojection are all off, and they are
    // the entire consumer list for the normal and velocity channels. Decide the
    // attachment set from the effects that are actually being constructed below,
    // so the pass is depth-only at low and unchanged everywhere else. Depth is
    // never optional — it is public API (soft particles, fog) and the exposure
    // meter's sky rejection.
    const usesNormal = !!(q.gtao || q.ssr || this.qLevel >= 1 /* contact shadows */);
    const usesVelocity = !!(q.taa || q.motionBlur || q.volumetrics);
    this.gbuffer = new GBuffer({ normal: usesNormal, velocity: usesVelocity });
    this.gtao = q.gtao ? new Gtao() : null;
    this.contact = this.qLevel >= 1 ? new ContactShadows() : null;
    this.ssr = q.ssr ? new Ssr() : null;
    this.taa = q.taa ? new Taa() : null;
    this.motionBlur = q.motionBlur ? new MotionBlur() : null;
    // ADS depth of field. Cheap (half-res gather, 32 taps) and only ever runs
    // while the sights are actually up, so it costs nothing in hipfire.
    this.dof = this.qLevel >= 1 ? new DepthOfField() : null;
    this.bloom = q.bloom ? new Bloom(this.qLevel >= 2 ? 6 : 5) : null;
    this.exposure = new AutoExposure(this.canRenderFloat);
    // Headroom for a physically-scaled sky (sunlit scenes reach ~5000 cd/m2).
    // The lower limit is the night exposure lock: a moonlit street meters at
    // EV100 -5.2, and letting the meter chase that turns night into an overcast
    // afternoon. Daylight shots meter between -1 and -2.1, so this only ever
    // binds after dark.
    this.exposure.setLimits(-4.3, 20);
    this.lut = createGradeLut('default');
    /**
     * The two passes that touch every backbuffer pixel and do nothing but
     * colour: tonemap+grade+lens, and the edge filter over the result. On the
     * phone tier they compile at mediump — see the note on `Pass`. Everything
     * that reconstructs a position from depth keeps highp, and is off here
     * anyway.
     */
    const postPrecision = this.qLevel < 0 ? 'mediump' : undefined;
    this.composite = createComposite(this.lut, q.taa === true, postPrecision);
    this.viewComposite = createViewComposite(postPrecision);
    this.fxaa = q.taa ? null : createFxaa(postPrecision);
    // MSAA on the viewmodel target only. It is the one buffer whose geometric
    // edges no longer get a temporal filter, and 4x on a single small pass is
    // far cheaper than any spatial substitute at the same quality.
    this._viewSamples = this.qLevel >= 2 ? 4 : this.qLevel >= 1 ? 2 : 0;

    // Always on: depthTexture/velocityTexture are part of the public contract
    // (soft particles, SSR, motion blur) even when our own effects are off.
    this.needsPrepass = true;

    this.hdrRt = null;
    this.viewRt = null;
    this.ldrRt = null;
    this.pingRt = [null, null];
    this._pingIndex = 0;
    this._adsT = 0;
    this._weapons = null;

    this._tmpV3 = new THREE.Vector3();
    this._tmpV3b = new THREE.Vector3();
    this._fillHue = new THREE.Vector3();
    this._fillHue2 = new THREE.Vector3();
    this._fillSkySave = new THREE.Vector3();
    this._fillGroundSave = new THREE.Vector3();
    this._ambLevel = 0.6;
    this._roomsReady = false;
    this._skyExposureBias = 0;

    // ---- lighting defaults ------------------------------------------------
    // The sky subsystem normally owns the sun. Until it does, we provide one
    // so the world is never lit by nothing; it hides itself the moment a
    // brighter directional light shows up in the scene.
    this.sun = new THREE.DirectionalLight(0xffe8c4, 4.3);
    this.sun.name = 'ow-fallback-sun';
    this.sun.position.set(-42, 46, 26);
    this.sun.castShadow = false;
    this.sun.target.position.set(0, 0, 0);
    ctx.scene.add(this.sun);
    ctx.scene.add(this.sun.target);
    this.activeSun = this.sun;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunDirView = new THREE.Vector3(0, 1, 0);

    // ---- viewmodel light rig ---------------------------------------------
    // The weapon lives in its own scene. Handing it one copy of the world sun
    // means that whenever the sun is behind the gun the camera-facing side gets
    // nothing, and weapon albedos are physically correct (anodised aluminium is
    // 0.026 linear) so it goes to a black silhouette. It gets a real 3-point
    // rig instead, with every direction fixed in VIEW space so the weapon reads
    // identically at any world sun azimuth — which is what every shipped FPS
    // does, and the reason their guns are always legible.
    this.viewSun = new THREE.DirectionalLight(0xffe8c4, 2.0);
    this.viewSun.name = 'ow-viewmodel-key';
    this.viewKeyFill = new THREE.DirectionalLight(0x9ec4ff, 0.6);
    this.viewKeyFill.name = 'ow-viewmodel-fill';
    this.viewRim = new THREE.DirectionalLight(0xffd7a8, 1.0);
    this.viewRim.name = 'ow-viewmodel-rim';
    this.viewFill = new THREE.HemisphereLight(0x8fb6ff, 0x36302a, 0.35);
    // Warm bounce off the ground/street, arriving from BELOW. Without it, any
    // part of the weapon or hands that sits in the gun's own cast shadow — the
    // support glove under the handguard is the worst case — is lit by nothing
    // but the cool sky fill, so a warm glove albedo still renders blue. A real
    // street throws a stop of warm light back up; this is that term.
    this.viewBounce = new THREE.DirectionalLight(0xffb87a, 0.5);
    this.viewBounce.name = 'ow-viewmodel-bounce';
    // View-space directions the light arrives FROM: key upper-front-left,
    // fill lower-front-right, rim from behind to catch the top edges of the
    // receiver, rail and optic body, bounce from below-front.
    this._viewKeyDir = new THREE.Vector3(-0.45, 0.75, 0.55).normalize();
    this._viewFillDir = new THREE.Vector3(0.6, -0.15, 0.5).normalize();
    this._viewRimDir = new THREE.Vector3(0.2, 0.35, -0.9).normalize();
    this._viewBounceDir = new THREE.Vector3(-0.2, -0.86, 0.47).normalize();
    this._tmpV3c = new THREE.Vector3();
    for (const l of [this.viewSun, this.viewKeyFill, this.viewRim, this.viewBounce]) {
      l.castShadow = false;
      ctx.viewScene.add(l, l.target);
    }
    ctx.viewScene.add(this.viewFill);
    // The frame loop skips the viewmodel pass when nothing but our own rig is
    // in there; remember how many children that is.
    this._viewRigChildren = ctx.viewScene.children.length;

    const env = buildFallbackEnvironment(renderer, this._dirFromLight(this.sun, this.sunDir));
    this.envTarget = env.target;
    this.envEquirect = env.equirect;
    this.envMap = this.envTarget.texture;
    if (!ctx.scene.environment) ctx.scene.environment = this.envMap;
    if (!ctx.scene.background) ctx.scene.background = this.envEquirect;
    ctx.viewScene.environment = ctx.scene.environment;
    this._assignedViewEnv = ctx.scene.environment;

    // ---- bookkeeping ------------------------------------------------------
    this.passes = [];
    this.lights = [];
    this._draw = [];
    this._nDraw = 0;
    this._hide = [];
    this._nHide = 0;
    this._noShadow = [];
    this._nNoShadow = 0;
    this._dirLights = [];
    this._nDirLights = 0;
    this._foreignMeshes = 0;

    this._currVP = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
    this._invVP = new THREE.Matrix4();
    this._camPos = new THREE.Vector3();
    this._jitterSaved = new THREE.Vector2();
    this._viewVisible = false;
    this._readback = new Float32Array(4);
    this._readback2 = new Float32Array(4);
    this._jittered = false;
    this._firstFrame = true;

    this.screenSize = { width: 1, height: 1 };
    this.displaySize = { width: 1, height: 1 };
    this.depthTexture = null;
    this.velocityTexture = null;
    this.normalTexture = null;
    this.aoTexture = null;
    this.exposureTexture = this.exposure.texture;

    this.settings = {
      exposureBias: 0, // EV; positive = darker
      exposureKey: 1.06,
      autoExposure: true,
      // The pyramid is ADDED now, not mixed, and it is soft-knee thresholded at
      // `bloomThreshold` in exposure-scaled linear light — so this is the gain on
      // light that is genuinely above display white (sun disc, glints, muzzle
      // flash), not a whole-frame veiling-glare percentage. 0.048 of a mix() was
      // invisible; 0.12 of an additive thresholded pyramid is a specular event.
      bloomStrength: 0.14,
      // 1.6, not 0.85. A daylight sky lands around 1.0-1.5 in exposure-scaled
      // linear light, so at 0.85 the SKY was the brightest thing in the pyramid
      // and the widest mip smeared it four or five pixels over every roofline and
      // every silhouette in front of it — an enemy on a balcony measured 3%
      // contrast against the cloud he was standing in front of. At 1.6 the sky is
      // below the knee and the pyramid is back to what it is for: the sun disc,
      // glints, tracers, muzzle flash.
      bloomThreshold: 1.6,
      bloomKnee: 0.9,
      // Lateral CA. Kept small: it is a lens signature, and at 0.0018 the R/B
      // split reached most of a pixel in the corners, which the sharpen filter
      // then turned into visible fringing on every high-contrast edge.
      chromatic: 0.0011,
      // Vignette and grain are applied in DISPLAY space (see composite.js), so
      // these are code-value amplitudes, not linear-light ones.
      vignette: 0.24,
      // Closes in while the sights are up: the frame has to tell you your eye is
      // behind a tube, not just that the gun moved.
      adsVignette: 0.34,
      grain: 0.010,
      // ---- ADS depth of field (see dof.js) ---------------------------------
      // maxCoc is in pixels at 1080p and is reached well beyond focusMax, so
      // geometry past ~25 m goes visibly soft while the optic — composited after
      // the pass — stays pin sharp.
      // 3.3 px at 1080p, down 40%: at 5.5 the near and mid ground of an ADS frame
      // was a watercolour smear that hid the very thing the sights are pointed at.
      dofMaxCoc: 3.3,
      dofNearRatio: 0.38,
      dofFocusMin: 3.0,
      dofFocusMax: 18.0,
      dofFarStart: 1.15,
      dofFarRange: 18.0,
      dofNearScale: 0.55,
      sharpen: 0.25,
      lutStrength: 1.0,
      shutter: 0.42,
      aoRadius: 1.35,
      // Occlusion is a shaping tool, not a darkening tool: 1.7 with no bounce
      // fill behind it was what turned every corner into a black hole.
      aoIntensity: 1.1,
      // Screen-space contact shadows. The length is a world-space ray in metres
      // at 1x distance scaling (see contact.js): it has to resolve the 0-40 cm
      // range, because that is the gap a cascade texel cannot see and the
      // difference between a crate sitting on the floor and a crate stickered
      // onto it. Debuggable with ?rview=contact.
      contactLength: 0.4,
      contactStrength: 1.0,
      // Hemispheric sky/ground fill, and the warm anti-sun bounce wrap, as a
      // fraction of the key's intensity (see _updateBounceFill).
      //
      // These are a *budget*, and the budget is what sets the key:fill ratio.
      // Real direct sun runs 5-8:1 against its own shade; at skyFill 0.09 /
      // groundFill 0.055 / iblDiffuse 1.0 the indirect terms were supplying 42%
      // of every lit value and the ratio collapsed to 2.4:1 — a frame with no
      // sun in it, only a bright ambient. Cut hard and let the beam carry it.
      // Cool skylight band. This is the frame's ONLY strongly chromatic
      // indirect term — the PMREM integrates a blue upper hemisphere against a
      // warm ground plane and comes back very nearly achromatic on a vertical
      // wall — so it is deliberately the biggest one now, and iblDiffuse below
      // came down by the same amount to pay for it. Measured on the 16:30
      // frame: a shaded facade went from B-R = 0.0002 (4.5% saturation, "dead
      // neutral regardless of surroundings") to a legible cool cast.
      skyFill: 0.32,
      // Warm bounce off the street, onto soffits, undersides and low faces.
      groundFill: 0.013,
      // ...and the wrap term: the shaded side of the street lit by the sunlit
      // side of it. Both up hard, because this is the "warm kick where a shadow
      // faces a sunlit surface" that was missing entirely.
      bounceFill: 0.008,
      // The PMREM sky cubemap is the single biggest indirect term in the frame
      // (materials ship envMapIntensity 1.6). Scaling its *diffuse* here is the
      // only place the total indirect budget can actually be controlled from.
      // Specular radiance is left alone — that is reflection, not fill.
      iblDiffuse: 0.030,
      // Indirect floor inside a coarse interior volume. Skylight does not reach
      // the middle of a closed room; without this the doorway reads as a hole
      // cut in a card because the room is brighter than the street outside it.
      interiorIndirect: 0.035,
      // Global trim on room and street practicals (see PRACTICAL_RANGE).
      //
      // Twenty interior bulbs and twenty-two sodium lamps are the ONLY light in
      // a closed room and by far the loudest thing in a night street, so they
      // are what actually sets two of this renderer's headline ratios:
      // interior-to-exterior through a doorway, and warm-pool-to-cool-ambient
      // after dark. At unity an interior metered within 1.3 stops of the sunlit
      // facade framed in its own opening (a real one runs 4-5) and every
      // surface in the night frame took its hue from a lamp. Half a stop off
      // them buys most of both, and it is applied here rather than at the
      // source because the balance is a lighting decision, not an art one.
      practicalGain: 0.55,
      // Sky the viewmodel can actually see, past the shooter's own body.
      viewFillOcclusion: 0.45,
      // Viewmodel 3-point rig. The key is scaled off the scene's own light
      // level (see _updateViewRig); fill, rim and hemisphere are ratios of it.
      viewKeyScale: 0.55,
      viewKeyMax: 2.6,
      viewFillRatio: 0.3,
      viewRimRatio: 0.5,
      // 0.35 hemisphere against a ~2.2 daylight key, expressed as a ratio so it
      // follows the time of day instead of blowing the gun out at night.
      viewHemiRatio: 0.16,
      // Warm ground bounce from below. Sized to lift the glove out of the
      // handguard's cast shadow without competing with the key: at 0.34 of the
      // key it is ~1.5 stops down, which is about what a sand street returns.
      viewBounceRatio: 0.34,
      viewKeyGamma: 0.65,
      shadowStrength: 1.0,
      sunSoftness: 0.024,
    };
    this._applySettings();

    this.probe = new RenderProbeScene(this.rng.fork());
    this.probeActive = false;
    // In capture mode print the metering chain so a bad exposure is obvious
    // in the harness log rather than something to guess at from the PNG.
    this._probeExposure = ctx.config.deterministic === true;
    this.debugView = new URLSearchParams(location.search).get('rview') || null;
    this._debugPass = null;

    // `?owNoCascadeCull=1` puts every caster back into every cascade. Kept as
    // the A/B switch the pixel gate was run through, and the escape hatch if a
    // subsystem ever ships geometry whose bounds lie about where it is.
    this._noCascadeCull = /[?&]owNoCascadeCull=1/.test(location.search);
    this._visit = this._visit.bind(this);
    this._visitView = this._visitView.bind(this);

    // ---- runtime quality scaling -----------------------------------------
    this._reallocate = false;
    this._cssW = 1;
    this._cssH = 1;
    this._built = this._snapshotBuilt();
    this._initDynRes(ctx);
    this._inQuality = false;
    this._onQuality = () => {
      if (!this._inQuality) this._applyQuality();
    };
    ctx.events.on('ui:quality', this._onQuality);

    const w = ctx.canvas.clientWidth || 1920;
    const h = ctx.canvas.clientHeight || 1080;
    this.resize(w, h, ctx);

    console.info(
      `[render] WebGL2 · ${cfg.quality} · ${this.csm.cascades}x${this.csm.mapSize} CSM · ` +
        `taa:${!!this.taa} gtao:${!!this.gtao} ssr:${!!this.ssr} mb:${!!this.motionBlur}`
    );
  }

  // ==========================================================================
  //  public API (see ARCHITECTURE.md "Render integration")
  // ==========================================================================

  /**
   * Insert a custom post pass.
   * `pass.render(renderer, inputTexture, outputTarget, renderSystem)` must
   * write a full-screen result into `outputTarget`.
   * `pass.order` (default 0) controls ordering; `pass.enabled !== false`.
   */
  registerPass(pass) {
    this.passes.push(pass);
    this.passes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (pass.resize) pass.resize(this.screenSize.width, this.screenSize.height);
    return () => {
      const i = this.passes.indexOf(pass);
      if (i >= 0) this.passes.splice(i, 1);
    };
  }

  /** Register a punctual light so it participates in culling and budgets. */
  addLight(light, opts = {}) {
    if (!light || this.lights.some((l) => l.light === light)) return light;
    this.lights.push({
      light,
      range: opts.range ?? light.distance ?? 25,
      priority: opts.priority ?? 1,
      baseIntensity: light.intensity,
    });
    return light;
  }

  removeLight(light) {
    const i = this.lights.findIndex((l) => l.light === light);
    if (i >= 0) this.lights.splice(i, 1);
  }

  /** The PMREM environment currently in use. */
  requestEnvMap() {
    return this.ctx?.scene.environment ?? this.envMap;
  }

  /**
   * Screen-space hurt state, all 0..1, folded into the final composite.
   *
   *   desat  world desaturation / contrast / brightness pull
   *   blood  blood vignette + corner smears
   *   flash  on-hit red flash (screen-blended)
   *   beat   heartbeat ring, and the swell it puts on the vignette
   *
   * `ui` pushes these once a frame (src/ui/index.js -> src/ui/health.js). They
   * used to be five stacked DOM layers over the canvas, each one a
   * `backdrop-filter`, an SVG filter or a `mix-blend-mode` — none of which can
   * be cached, because their input is a canvas that redraws every frame. All
   * four at zero is the exact no-op: the shader branch is not taken.
   *
   * Zero allocation: writes straight into the uniform's Vector4.
   */
  setHurt(desat = 0, blood = 0, flash = 0, beat = 0) {
    this.composite.uniforms.uHurt.value.set(desat, blood, flash, beat);
  }

  /** Let the sky subsystem hand us its PMREM. */
  setEnvMap(texture) {
    this.ctx.scene.environment = texture;
    this.ctx.viewScene.environment = texture;
    this.envMap = texture;
  }

  /** Force every lit material in a subtree to be patched immediately. */
  patchMaterials(root) {
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) for (const mm of m) this.patcher.patch(mm);
      else this.patcher.patch(m);
    });
  }

  /**
   * Patch exactly the set of materials the frame loop's own scene walk would
   * patch, and no more.
   *
   * `patchMaterials()` is the public, deliberately-broad version: it reaches
   * every material in a subtree. That is the wrong tool for pre-compiling,
   * because injecting the shadow/AO/fill chunk into a material the frame loop
   * never patches CHANGES HOW THAT MATERIAL SHADES — measured at 0.04% of
   * pixels, up to 26/255, when this used `traverse()`. Mirroring `_visit` /
   * `_visitView` exactly (same traversal, same object-type predicate) makes
   * pre-patching a pure reordering of *when* the identical set is patched.
   */
  _patchLikeFrame(root, isViewScene) {
    root.traverseVisible((o) => {
      if (isViewScene) {
        if (o.isMesh !== true) return;
      } else if (
        o.isMesh !== true &&
        o.isPoints !== true &&
        o.isSprite !== true &&
        o.isLine !== true
      ) {
        return;
      }
      const m = o.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.patcher.patch(m[i]);
      else if (m) this.patcher.patch(m);
    });
  }

  setExposureBias(ev) {
    this.settings.exposureBias = ev;
  }

  /**
   * Compile every program this subsystem can reach, without drawing a gameplay
   * frame. Call it from the loading screen (src/core/prewarm.js).
   *
   * WHY THE ENGINE'S OWN PRE-WARM IS NOT ENOUGH — measured, not guessed.
   * `renderer.compileAsync(scene, camera)` only reaches the *forward lit*
   * program of each material. It does not reach:
   *
   *   - the CSM depth variant of a material (skinned / morphed / instanced /
   *     batched are four separate programs off one ShaderMaterial),
   *   - the MRT prepass variant, same four,
   *   - a single one of the ~25 full-screen post programs, because those are
   *     not in any scene graph.
   *
   * Those are exactly the ones that used to land mid-play: profiling showed up
   * to 30 programs compiling on ONE frame, and that frame took 3.1-3.9 s on a
   * cold shader cache.
   *
   * NOTHING HERE ADVANCES THE SIMULATION. It never calls `engine.step()`, never
   * touches `time`, `rng`, the TAA history, the exposure adaptation buffers,
   * the velocity history or `this.frame`. It draws into the shadow array, the
   * gbuffer and a 4x4 scratch target — all three of which the next real frame
   * overwrites in full before anything reads them — so it is invisible to the
   * pixel-diff gate.
   *
   * PIXEL GATE, measured with tools/baseline.mjs at 1920x1080 on all 11 shots:
   * the patch + `compileAsync` step and the post-chain step are bit-identical.
   * The depth/shadow step is NOT, when it is called after frames have already
   * been drawn: on the `night` shot it moves 26 pixels by 2/255, which survives
   * snapshotting and restoring the whole cascade fit and the sun takeover, so
   * the residue is in the shadow-array / gbuffer contents themselves. It is
   * therefore only ON by default at `frame === 0` — before a single frame has
   * been drawn there is no cascade fit, no gbuffer and no shadow array to
   * disturb — and has to be asked for explicitly at any other time.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.post=true]   compile the full-screen pass chain
   * @param {boolean} [opts.shadow]      compile the CSM depth + prepass variants;
   *                                     defaults to true only before frame 1
   * @returns {Promise<object>} { ok, ms, programsBefore, programsAfter, compiled }
   */
  async prewarmMaterials({ post = true, shadow = this.frame === 0 } = {}) {
    const t0 = performance.now();
    const renderer = this.renderer;
    const ctx = this.ctx;
    if (!renderer || !ctx) return { ok: false, reason: 'not initialised' };
    const programsBefore = renderer.info.programs?.length ?? 0;
    const prevTarget = renderer.getRenderTarget();

    try {
      // 1. Patch first, ALWAYS. A program compiled off an unpatched material is
      //    thrown away by the first frame that walks the scene (see the
      //    renderer.compile wrapper in init) — pure waste of the boot budget.
      this._patchLikeFrame(ctx.scene, false);
      this._patchLikeFrame(ctx.viewScene, true);

      // 2. Forward lit programs. compileAsync uses KHR_parallel_shader_compile
      //    where the driver has it, so this does not block the main thread.
      try {
        await renderer.compileAsync(ctx.scene, ctx.camera);
        await renderer.compileAsync(ctx.viewScene, ctx.viewCamera);
      } catch {
        renderer.compile(ctx.scene, ctx.camera);
        renderer.compile(ctx.viewScene, ctx.viewCamera);
      }

      // 3. Depth-only variants. There is no compile-time API for an override
      //    material, so the only way to reach them is to actually run the two
      //    depth passes once — which is cheap, writes only to buffers the next
      //    frame clears, and advances nothing.
      if (shadow) {
        const camera = ctx.camera;
        camera.updateMatrixWorld();
        this._collect(ctx.scene);
        this._syncSun(camera);
        const bg = ctx.scene.background;
        // Fitting the cascades out of frame is not free: `update()` leaves a fit
        // behind and the next frame's refit does not fully overwrite it (see
        // CascadedShadowMaps.snapshotFit — measured at 1.3 M pixels, up to
        // 26/255). Take the fit, use it, hand it straight back.
        const fit = this.csm.snapshotFit();
        // ...and the same for the sun takeover `_syncSun` performs, so a prewarm
        // cannot hand the next frame a different active sun / fallback state
        // than the one it would have computed for itself.
        const sunSave = {
          dir: this.sunDir.clone(),
          dirView: this.sunDirView.clone(),
          active: this.activeSun,
          fallbackVisible: this.sun.visible,
          ambLevel: this._ambLevel,
        };
        ctx.scene.background = null;
        this._hideList(this._hide, this._nHide);
        this._hideList(this._noShadow, this._nNoShadow);
        this.csm.update(camera, this.sunDir, this.settings.sunSoftness);
        this.csm.render(renderer, ctx.scene, this._draw, this._nDraw);
        this._showList(this._noShadow, this._nNoShadow);
        this.gbuffer.render(
          renderer,
          ctx.scene,
          camera,
          this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
          this._currVP,
          true
        );
        this._showList(this._hide, this._nHide);
        ctx.scene.background = bg;
        this.csm.restoreFit(fit);
        this.sunDir.copy(sunSave.dir);
        this.sunDirView.copy(sunSave.dirView);
        this.activeSun = sunSave.active;
        this.sun.visible = sunSave.fallbackVisible;
        this._ambLevel = sunSave.ambLevel;
      }

      // 4. The post chain. A pass's program does not depend on the size of what
      //    it is drawn into, so a 4x4 scratch target compiles it for free.
      if (post) {
        const scratch = hdrTarget(4, 4, { name: 'prewarm-scratch' });
        const mats = [];
        this._collectPassMaterials(mats);
        for (const m of mats) {
          try {
            blit(renderer, m, scratch);
          } catch {
            /* a pass with an unsatisfiable uniform must not stop the rest */
          }
        }
        scratch.dispose();
      }
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    } finally {
      renderer.setRenderTarget(prevTarget);
    }

    const programsAfter = renderer.info.programs?.length ?? 0;
    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      programsBefore,
      programsAfter,
      compiled: programsAfter - programsBefore,
      parallel: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
    };
  }

  /** Every full-screen material this subsystem owns, for prewarmMaterials(). */
  _collectPassMaterials(out) {
    const add = (p) => {
      if (p && p.material) out.push(p.material);
    };
    add(this.composite);
    add(this.viewComposite);
    add(this.fxaa);
    if (this.gtao) {
      add(this.gtao.core);
      add(this.gtao.temporal);
      add(this.gtao.blur);
    }
    if (this.contact) {
      add(this.contact.pass);
      add(this.contact.blur);
    }
    if (this.ssr) {
      add(this.ssr.pass);
      add(this.ssr.blur);
    }
    if (this.taa) add(this.taa.pass);
    if (this.motionBlur) {
      add(this.motionBlur.tilePass);
      add(this.motionBlur.blurPass);
    }
    if (this.dof) {
      add(this.dof.pre);
      add(this.dof.gather);
      add(this.dof.combine);
    }
    if (this.bloom) {
      add(this.bloom.down);
      add(this.bloom.up);
    }
    add(this.exposure.logPass);
    add(this.exposure.reducePass);
    add(this.exposure.adaptPass);
    return out;
  }

  get hdrTexture() {
    return this.hdrRt?.texture ?? null;
  }

  /**
   * Read back a block of the pre-post HDR buffer, in SCENE RADIANCE UNITS
   * (i.e. before exposure). Diagnostic only — this stalls the pipeline, so it
   * is never called from a frame. Coordinates are fractions of the screen.
   *
   * This exists because every tone/lighting argument in this subsystem is an
   * argument about *ratios of scene radiance* — key:fill, sky:sunlit-wall,
   * interior:exterior — and reading them off a graded PNG means inverting the
   * tone curve by hand and getting it wrong.
   */
  probeHdr(u0, v0, u1, v1) {
    const rt = this.hdrRt;
    if (!rt) return null;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const x = Math.max(0, Math.round(u0 * W));
    // GL origin is bottom-left; screen v is top-down.
    const y = Math.max(0, Math.round((1 - v1) * H));
    const w = Math.max(1, Math.min(W - x, Math.round((u1 - u0) * W)));
    const h = Math.max(1, Math.min(H - y, Math.round((v1 - v0) * H)));
    const half = rt.texture.type === THREE.HalfFloatType;
    const buf = half ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, x, y, w, h, buf);
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    let r = 0;
    let g = 0;
    let b = 0;
    let mx = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const cr = dec(buf[i * 4]);
      const cg = dec(buf[i * 4 + 1]);
      const cb = dec(buf[i * 4 + 2]);
      r += cr;
      g += cg;
      b += cb;
      mx = Math.max(mx, cr, cg, cb);
    }
    return { r: r / n, g: g / n, b: b / n, max: mx, n };
  }

  /** Whole HDR buffer box-downsampled to cols x rows, row 0 = top. Diagnostic. */
  probeHdrGrid(cols = 32, rows = 18) {
    const rt = this.hdrRt;
    if (!rt) return null;
    const W = this.screenSize.width;
    const H = this.screenSize.height;
    const half = rt.texture.type === THREE.HalfFloatType;
    const buf = half ? new Uint16Array(W * H * 4) : new Float32Array(W * H * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    const out = new Float32Array(cols * rows * 3);
    const cnt = new Float32Array(cols * rows);
    for (let y = 0; y < H; y++) {
      const gy = Math.min(rows - 1, Math.floor(((H - 1 - y) / H) * rows));
      for (let x = 0; x < W; x++) {
        const gx = Math.min(cols - 1, Math.floor((x / W) * cols));
        const s = (y * W + x) * 4;
        const d = (gy * cols + gx) * 3;
        out[d] += dec(buf[s]);
        out[d + 1] += dec(buf[s + 1]);
        out[d + 2] += dec(buf[s + 2]);
        cnt[gy * cols + gx]++;
      }
    }
    const res = [];
    for (let i = 0; i < cols * rows; i++) {
      const c = Math.max(1, cnt[i]);
      res.push([out[i * 3] / c, out[i * 3 + 1] / c, out[i * 3 + 2] / c]);
    }
    return { cols, rows, cells: res };
  }

  _applySettings() {
    const s = this.settings;
    const cu = this.composite.uniforms;
    cu.uLens.value.set(s.chromatic, s.vignette, s.grain, 0);
    cu.uGrade.value.set(s.bloomStrength, s.lutStrength, this.taa ? s.sharpen : 0, this.lut.size);
    this.csm.setStrength(s.shadowStrength);
    if (this.bloom) {
      this.bloom.threshold = s.bloomThreshold;
      this.bloom.knee = s.bloomKnee;
    }
    if (this.gtao) {
      this.gtao.setRadius(s.aoRadius);
      this.gtao.setIntensity(s.aoIntensity);
    }
    if (this.contact) {
      this.contact.setLength(s.contactLength);
      this.contact.setStrength(s.contactStrength);
    }
  }

  // ==========================================================================
  //  runtime quality (see ARCHITECTURE.md "Runtime quality changes")
  // ==========================================================================

  /** Everything `init()` baked out of the preset, so `setQuality` can diff it. */
  _snapshotBuilt() {
    const q = this.q;
    return {
      quality: this.ctx.config.quality,
      cascades: this.csm.cascades,
      shadowMapSize: this.csm.mapSize,
      qLevel: this.qLevel,
      taa: !!q.taa,
      gtao: !!q.gtao,
      ssr: !!q.ssr,
      motionBlur: !!q.motionBlur,
      volumetrics: !!q.volumetrics,
      bloomLevels: this.bloom ? this.bloom.levels : 0,
      postPrecision: this.qLevel < 0 ? 'mediump' : undefined,
      hasNormal: this.gbuffer.hasNormal,
      hasVelocity: this.gbuffer.hasVelocity,
      viewSamples: this._viewSamples,
      anisotropy: q.anisotropy,
      renderScale: q.renderScale,
      dprCap: q.dprCap,
    };
  }

  /**
   * Apply a quality preset to the LIVE pipeline.
   *
   * Called with a name it switches `config` first; called with `null` it assumes
   * `config.q` has already been updated (that is the `ui:quality` path — the
   * menu writes the config and announces it, and this subsystem is the
   * listener). `config.q` is the same object `this.q` points at, so by the time
   * we get here the numbers have already moved under us and the diff is against
   * `this._built`, which records what was actually CONSTRUCTED.
   *
   * ---------------------------------------------------------------------------
   * WHAT IS HOT AND WHAT NEEDS A RELOAD — this is the whole design, and it is
   * decided by one question: does the field change a shader DEFINE, and if so,
   * in how many programs?
   * ---------------------------------------------------------------------------
   * HOT (no lit-material recompile; the only programs that can compile here are
   * full-screen post passes, bounded at ~14):
   *   renderScale, dprCap   sizes only -> `resize()` with the early-out defeated
   *   shadowMapSize         array texture realloc; `owCsmMapSize` is a uniform
   *   shadowDistance        cascade fit only
   *   gtao/ssr/taa/motionBlur/bloom/contact/dof  effect OBJECTS; the material
   *                         side of all three screen-space terms is gated by the
   *                         `owFeat` UNIFORM, not by a define, so switching them
   *                         off costs nothing and switching them on costs only
   *                         that effect's own passes
   *   bloom levels          JS-side mip pyramid, same two programs
   *   viewmodel MSAA        target realloc, not a program key
   *   gbuffer attachments   ONE prepass ShaderMaterial (up to 4 variants)
   *   composite/fxaa        3 programs, and only when `taa` or the post
   *                         precision tier actually flips
   *
   * RELOAD (each one re-keys every lit material in the scene — ARCHITECTURE.md
   * measures that class of event at 640-900 ms of stall, and there are ~170 of
   * them):
   *   cascades       `OW_CASCADES` is a define in the patcher chunk AND in the
   *                  sky's volumetric march pass. `this.csm.cascades` is
   *                  therefore frozen for the session; a preset that asks for a
   *                  different count keeps the one it booted with.
   *   quality tier   PCF/PCSS tap counts (`csmShaderChunk`) are defines. Frozen
   *                  as `this.shaderTier`; `qLevel` still moves so the EFFECT
   *                  gating follows the preset.
   *   lightSlots     the visible point-light count, i.e. the permutation key
   *                  ARCHITECTURE.md is about. Owned by `world`.
   *   textureScale / simpleMaterials / propDensity / drawDistance / physicsHz /
   *   particleBudget / decalBudget / anisotropy / skyQuality — baked into
   *   geometry, textures or the fixed step by their own subsystems at init.
   *
   * Everything in the second list is REPORTED, not silently ignored.
   *
   * @param {string|null} name  preset to switch to, or null to re-read config
   * @returns {object} { ok, quality, applied[], reload[], programs, ms }
   */
  setQuality(name) {
    const cfg = this.ctx.config;
    if (name && name !== cfg.quality) {
      try {
        cfg.setQuality(name);
      } catch (err) {
        console.warn('[render] setQuality', err);
        return { ok: false, reason: String(err.message ?? err) };
      }
    }
    const res = this._applyQuality();
    // `ui:quality` is a BROADCAST (ARCHITECTURE.md): sky, physics and audio each
    // own a piece of the same change. Calling this method directly — the dev
    // console, a probe, an auto-scaler — must reconfigure the whole engine, not
    // just the renderer, or those three silently keep the old preset's budget.
    // The guard stops our own listener from doing the work a second time; the
    // menu path never reaches here at all, it emits and we listen.
    this._inQuality = true;
    try {
      this.ctx.events.emit('ui:quality', { quality: cfg.quality });
    } finally {
      this._inQuality = false;
    }
    return res;
  }

  /** The render half of a quality change. See `setQuality`. */
  _applyQuality() {
    const cfg = this.ctx.config;
    const t0 = performance.now();
    const renderer = this.renderer;
    const q = this.q;
    const was = this._built;
    const programsBefore = renderer.info.programs?.length ?? 0;
    const applied = [];
    const reload = [];

    this.qLevel = QUALITY_LEVEL[cfg.quality] ?? 3;

    // ---- what this subsystem cannot do without a reload -------------------
    if (q.cascades !== was.cascades) reload.push(`cascades ${was.cascades}->${q.cascades}`);
    if (this.qLevel !== this.shaderTier) reload.push('shadow tap tier');
    if (q.anisotropy !== was.anisotropy) reload.push('anisotropy (textures are baked)');
    this.maxAnisotropy = Math.min(q.anisotropy, renderer.capabilities.getMaxAnisotropy());

    // ---- cascades: resolution and distance are both hot -------------------
    if (this.csm.setMapSize(q.shadowMapSize)) applied.push(`shadowMapSize=${this.csm.mapSize}`);
    if (this.csm.maxDistance !== q.shadowDistance) {
      this.csm.maxDistance = q.shadowDistance;
      applied.push(`shadowDistance=${q.shadowDistance}`);
    }

    // ---- effect objects ---------------------------------------------------
    const swap = (key, want, make, teardown) => {
      if (!!this[key] === want) return;
      if (want) {
        this[key] = make();
      } else {
        this[key].dispose();
        this[key] = null;
        teardown?.();
      }
      applied.push(`${key}=${want}`);
    };
    const u = this.patcher.uniforms;
    swap('gtao', !!q.gtao, () => new Gtao(), () => {
      // The sampler must not be left pointing at a disposed texture. The shader
      // never reaches it (owFeat.x gates the fetch) but the renderer still binds
      // whatever is in the uniform.
      u.owAoTex.value = null;
      this.aoTexture = null;
    });
    swap('ssr', !!q.ssr, () => new Ssr(), () => { u.owSsrTex.value = null; });
    swap('contact', this.qLevel >= 1, () => new ContactShadows(), () => { u.owContactTex.value = null; });
    swap('taa', !!q.taa, () => new Taa());
    swap('motionBlur', !!q.motionBlur, () => new MotionBlur());
    swap('dof', this.qLevel >= 1, () => new DepthOfField());

    const wantBloom = q.bloom ? (this.qLevel >= 2 ? 6 : 5) : 0;
    if (wantBloom !== (this.bloom ? this.bloom.levels : 0)) {
      this.bloom?.dispose();
      this.bloom = wantBloom ? new Bloom(wantBloom) : null;
      applied.push(`bloom=${wantBloom}`);
    }

    // ---- the two passes whose PROGRAM depends on the preset ---------------
    const postPrecision = this.qLevel < 0 ? 'mediump' : undefined;
    const wantSharpen = q.taa === true;
    if (postPrecision !== was.postPrecision || wantSharpen !== was.taa) {
      this.composite.dispose();
      this.composite = createComposite(this.lut, wantSharpen, postPrecision);
      this.viewComposite.dispose();
      this.viewComposite = createViewComposite(postPrecision);
      applied.push('composite');
    }
    if (!!this.fxaa !== !q.taa || (this.fxaa && postPrecision !== was.postPrecision)) {
      this.fxaa?.dispose();
      this.fxaa = q.taa ? null : createFxaa(postPrecision);
      applied.push(`fxaa=${!!this.fxaa}`);
    }

    // ---- prepass attachments (FASE 1 baked these at construction) ---------
    const usesNormal = !!(q.gtao || q.ssr || this.qLevel >= 1);
    const usesVelocity = !!(q.taa || q.motionBlur || q.volumetrics);
    if (usesNormal !== this.gbuffer.hasNormal || usesVelocity !== this.gbuffer.hasVelocity) {
      this.gbuffer.dispose();
      this.gbuffer = new GBuffer({ normal: usesNormal, velocity: usesVelocity });
      applied.push(`gbuffer=${usesNormal ? 'n' : ''}${usesVelocity ? 'v' : ''}d`);
    }

    const wantSamples = this.qLevel >= 2 ? 4 : this.qLevel >= 1 ? 2 : 0;
    if (wantSamples !== this._viewSamples) {
      this._viewSamples = wantSamples;
      this.viewRt?.dispose();
      this.viewRt = null; // rebuilt lazily by _ensureViewRt
      applied.push(`viewMsaa=${wantSamples}`);
    }

    // ---- resolution ladder + the realloc ----------------------------------
    if (cfg.quality !== was.quality) this._initDynRes(this.ctx);
    else q.renderScale = this.dynres.ladder[this.dynres.index];
    this._reallocate = true;
    this.resize(this._cssW, this._cssH, this.ctx);
    this._applySettings();
    // The velocity history and the SSR/TAA reprojection sources were just
    // thrown away; treat the next frame as the first one.
    this._firstFrame = true;

    this._built = this._snapshotBuilt();
    const programs = renderer.info.programs?.length ?? 0;
    const out = {
      ok: true,
      quality: cfg.quality,
      applied,
      reload,
      programsBefore,
      programs,
      ms: Math.round(performance.now() - t0),
    };
    console.info(
      `[render] quality -> ${cfg.quality} · ${applied.length} applied · ` +
        `${reload.length} need a reload${reload.length ? ` (${reload.join(', ')})` : ''}`
    );
    return out;
  }

  // ==========================================================================
  //  dynamic resolution
  // ==========================================================================

  /**
   * Set the internal render scale and REALLOCATE.
   *
   * `resize()` early-outs when the internal size it computes matches the one it
   * already has, which is right for a window resize and wrong for this: the
   * scale is an input to that computation, so without `_reallocate` a runtime
   * change was silently a no-op (the whole reason this method exists).
   *
   * @returns {boolean} true if the chain was reallocated.
   */
  setRenderScale(s) {
    const c = Math.min(2, Math.max(0.25, s));
    if (Math.abs(c - this.q.renderScale) < 1e-4) return false;
    this.q.renderScale = c;
    this._reallocate = true;
    this.resize(this._cssW, this._cssH, this.ctx);
    return true;
  }

  /**
   * Build the resolution ladder for the current preset.
   *
   * The preset's own `renderScale` is the CEILING, never a starting point to
   * climb past: `mobile` asking for 0.62 means 0.62 is as sharp as that preset
   * ever gets, so its ladder is 0.5 / 0.6 / 0.62 and `high` gets all five steps.
   * The scaler starts at the top, which is what makes it invisible on a machine
   * that is keeping up — and bit-identical to no scaler at all.
   */
  _initDynRes(ctx) {
    const base = this.q.renderScale;
    const ladder = [];
    for (let i = 0; i < DYNRES_STEPS.length; i++) {
      if (DYNRES_STEPS[i] < base - 1e-6) ladder.push(DYNRES_STEPS[i]);
    }
    ladder.push(base);
    const params = new URLSearchParams(location.search);
    this.dynres = {
      /**
       * OFF in capture mode, unconditionally. The pixel gate advances frames by
       * hand under SwiftShader where every frame reads as the engine's 100 ms
       * clamp; a scaler that believed that would reallocate the whole HDR chain
       * mid-shot and no A/B comparison would mean anything again.
       */
      enabled: !ctx.config.deterministic && params.get('dynres') !== '0',
      ladder,
      index: ladder.length - 1,
      /** EMA of the UNSCALED frame time, ms. */
      ema: 1000 / 60,
      /** EMA of the JS half of that frame time, on the same time constant. */
      cpuEma: 0,
      /** ~20-frame time constant. */
      alpha: 0.05,
      /** Frames of agreement required before any step. */
      holdFrames: 30,
      hold: 0,
      /** Sustained ms/frame that buys a step down (below ~50 fps)... */
      downMs: 20,
      /** ...and the one that buys a step back up (above ~59 fps). The gap is
       *  the hysteresis: a display vsynced at exactly 60 sits between them. */
      upMs: 17,
      changes: 0,
    };
    this._dynPrevRaw = ctx.time.raw;
    this.q.renderScale = base;
  }

  /**
   * One EMA sample, and at most one quantised step per `holdFrames`.
   *
   * Quantised because every change reallocates ~8 render targets, and hysteretic
   * because the frame that does the reallocating is itself slow: a naive
   * controller reads its own realloc as evidence that it should scale down
   * again. After a step the EMA is re-seeded to the middle of the dead band, so
   * the next move needs a full window of fresh evidence rather than inheriting
   * the average that triggered this one.
   *
   * Zero allocation: scalars in a preallocated object.
   */
  _updateDynRes(ctx) {
    const d = this.dynres;
    if (!d.enabled || d.ladder.length < 2) return;
    const raw = ctx.time.raw;
    const dt = raw - this._dynPrevRaw;
    this._dynPrevRaw = raw;
    // `time.raw` is already clamped to 0.1 s a frame by the engine, so a
    // tab-switch cannot inject a spike here; 0 happens on the first frame and
    // whenever the harness pumps without advancing the clock.
    if (dt <= 0) return;
    d.ema += (dt * 1000 - d.ema) * d.alpha;
    d.cpuEma += ((ctx.time.stepMs || 0) - d.cpuEma) * d.alpha;
    if (d.hold < d.holdFrames) {
      d.hold++;
      return;
    }
    let i = d.index;
    // `renderScale` sizes the HDR chain and NOTHING else: it cannot remove a
    // draw call, a physics step or an IK solve. So when JS alone already spends
    // more than the down threshold, even a GPU that finished instantly would
    // miss the target, and every step down is image quality traded for nothing.
    // Measured on a Mali-G78 at the `mobile` preset: 25.8 ms of JS in a 36.5 ms
    // frame, the ladder walked to its 0.5 floor, and the EMA stayed at 39.4 ms.
    // Deliberately blocks only the DOWN direction — the up test needs a frame
    // that is already fast, which a CPU-bound one never is.
    const cpuBound = d.cpuEma >= d.downMs;
    if (d.ema > d.downMs && !cpuBound) i--;
    else if (d.ema < d.upMs) i++;
    if (i === d.index || i < 0 || i >= d.ladder.length) return;
    d.index = i;
    d.hold = 0;
    d.ema = (d.downMs + d.upMs) * 0.5;
    d.changes++;
    this.setRenderScale(d.ladder[i]);
  }

  // ==========================================================================
  //  sizing
  // ==========================================================================

  resize(w, h, ctx) {
    // The DPR cap is a QUALITY decision, not a constant. The composite, FXAA and
    // the canvas blit all run at the full backbuffer, so a 1.5 cap on a phone
    // (which reports 2.6-3.0) means those passes cover 2.25x the pixels of the
    // internal render target — the single largest fixed cost left in a mobile
    // frame, and one `renderScale` does nothing about because it only sizes the
    // HDR chain.
    const pr = Math.min(globalThis.devicePixelRatio || 1, this.q.dprCap ?? 1.5);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    // Remembered so `setRenderScale` / `setQuality` can re-enter this method
    // without the engine handing them the canvas size again.
    this._cssW = w;
    this._cssH = h;

    const dw = Math.max(1, Math.floor(w * pr));
    const dh = Math.max(1, Math.floor(h * pr));
    const rw = Math.max(1, Math.floor(dw * this.q.renderScale));
    const rh = Math.max(1, Math.floor(dh * this.q.renderScale));

    const displayChanged = this.displaySize.width !== dw || this.displaySize.height !== dh;
    this.displaySize.width = dw;
    this.displaySize.height = dh;
    // `_reallocate` is the escape hatch for a RUNTIME change: `renderScale`,
    // `dprCap` and the effect set are all inputs to the sizes computed above, so
    // a size-equality test is not evidence that the buffers are still right.
    const forced = this._reallocate;
    this._reallocate = false;
    if (!forced && this.screenSize.width === rw && this.screenSize.height === rh && this.hdrRt) {
      return;
    }
    this.screenSize.width = rw;
    this.screenSize.height = rh;

    this.hdrRt?.dispose();
    this.hdrRt = hdrTarget(rw, rh, { depthBuffer: true, name: 'hdr' });
    // The viewmodel target is allocated LAZILY, on the first frame something
    // other than our own light rig is in `viewScene` (see `_ensureViewRt`).
    // It is a full-resolution half-float colour buffer plus depth plus up to 4x
    // MSAA — 40 MB at 1080p — and for the whole of the loading screen, every
    // menu frame and every capture-harness shot that does not draw a weapon,
    // nothing ever samples it.
    this.viewRt?.dispose();
    this.viewRt = null;
    this.pingRt[0]?.dispose();
    this.pingRt[1]?.dispose();
    this.pingRt[0] = hdrTarget(rw, rh, { name: 'ping0' });
    this.pingRt[1] = hdrTarget(rw, rh, { name: 'ping1' });
    // Only the no-TAA path composites through an LDR intermediate; with TAA on,
    // `fxaa` is null and this was a full-resolution RGBA8 target (13 MB at 3.34
    // MP) allocated on every resize and never sampled once.
    this.ldrRt?.dispose();
    this.ldrRt = null;
    if (this.fxaa) this.ldrRt = new THREE.WebGLRenderTarget(rw, rh, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.gbuffer.setSize(rw, rh);
    this.gtao?.setSize(rw, rh);
    this.contact?.setSize(rw, rh);
    this.ssr?.setSize(rw, rh);
    this.taa?.setSize(rw, rh);
    this.motionBlur?.setSize(rw, rh);
    this.dof?.setSize(rw, rh);
    this.bloom?.setSize(rw, rh);

    this.patcher.setScreenSize(rw, rh);
    this.viewComposite.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.composite.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    this.composite.uniforms.uResolution.value.set(rw, rh);
    if (this.fxaa) this.fxaa.uniforms.uTexel.value.set(1 / rw, 1 / rh);

    this.depthTexture = this.gbuffer.depthTexture;
    this.velocityTexture = this.gbuffer.velocityTexture;
    this.normalTexture = this.gbuffer.normalTexture;

    for (const p of this.passes) p.resize?.(rw, rh);
    this.taa?.reset();
    // The metering chain is 64x64 -> 8x8 -> 1x1 and its adaptation state is a
    // 1x1 float: NONE of it is a function of the screen size. Resetting it on a
    // pure `renderScale` step would snap the exposure instead of easing it,
    // which is the one thing a resolution scaler must not be visible as. A real
    // window/backbuffer change still resets, exactly as before.
    if (displayChanged) this.exposure.reset();
  }

  /**
   * The viewmodel's own MSAA colour+depth target, built on demand.
   * Cleared to TRANSPARENT black by the frame loop so the composite has real
   * coverage to work with.
   */
  _ensureViewRt() {
    if (this.viewRt) return this.viewRt;
    this.viewRt = hdrTarget(this.screenSize.width, this.screenSize.height, {
      depthBuffer: true,
      samples: this._viewSamples,
      name: 'viewmodel',
    });
    return this.viewRt;
  }

  // ==========================================================================
  //  scene walk
  // ==========================================================================

  _visit(o) {
    if (o.isMesh === true || o.isPoints === true || o.isSprite === true || o.isLine === true) {
      const mat = o.material;
      let transparent = false;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) {
          this.patcher.patch(mat[i]);
          if (mat[i] && mat[i].transparent === true) transparent = true;
        }
      } else if (mat) {
        this.patcher.patch(mat);
        transparent = mat.transparent === true;
      }

      if (o.isMesh !== true) transparent = true;
      if (o.userData.owProbe !== true) this._foreignMeshes++;

      const ud = o.userData;
      if (transparent || ud.owNoPrepass === true) {
        this._hide[this._nHide++] = o;
      } else {
        this._draw[this._nDraw++] = o;
        if (ud.owNoShadow === true) this._noShadow[this._nNoShadow++] = o;
      }
    } else if (o.isDirectionalLight === true) {
      this._dirLights[this._nDirLights++] = o;
    }
  }

  _collect(scene) {
    this._nDraw = 0;
    this._nHide = 0;
    this._nNoShadow = 0;
    this._nDirLights = 0;
    this._foreignMeshes = 0;
    scene.traverseVisible(this._visit);
  }

  _hideList(list, n) {
    for (let i = 0; i < n; i++) list[i].visible = false;
  }
  _showList(list, n) {
    for (let i = 0; i < n; i++) list[i].visible = true;
  }

  _dirFromLight(light, out) {
    light.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(light.matrixWorld);
    if (light.target) {
      light.target.updateWorldMatrix(true, false);
      this._tmpV3b.setFromMatrixPosition(light.target.matrixWorld);
      out.sub(this._tmpV3b);
    }
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  /** Pick whichever directional light is acting as the sun and take it over. */
  _syncSun(camera) {
    let best = null;
    let bestI = -1;
    for (let i = 0; i < this._nDirLights; i++) {
      const l = this._dirLights[i];
      if (l === this.sun) continue;
      if (l.intensity > bestI) {
        best = l;
        bestI = l.intensity;
      }
    }

    if (best && bestI > 0.01) {
      // Somebody else (the sky) owns the sun now: drop ours and take over its
      // shadowing, because three's single-frustum shadow map cannot compete
      // with cascades.
      if (this.sun.visible) this.sun.visible = false;
      if (best.castShadow) best.castShadow = false;
      this.activeSun = best;
    } else {
      this.sun.visible = true;
      this.activeSun = this.sun;
    }

    this._dirFromLight(this.activeSun, this.sunDir);
    this.sunDirView.copy(this.sunDir).transformDirection(camera.matrixWorldInverse).normalize();
  }

  /**
   * Point the viewmodel's 3-point rig. Directions are authored in VIEW space
   * and rotated into the viewmodel scene every frame, so the weapon's key/fill/
   * rim separation is invariant to where the world sun happens to be.
   */
  _updateViewRig(viewCamera) {
    const s = this.settings;
    // Reference light level for the rig. It has to include the ambient, not just
    // the key: at night the key IS the moon at 0.075, and a rig with an absolute
    // floor would put a glowing white rifle in a moonlit street. Everything in
    // the rig — hemisphere included — is a ratio of this, so autoexposure keeps
    // the weapon at a constant relative brightness at every time of day.
    const ref = Math.max(this.activeSun.intensity, this._ambLevel / 0.15);
    // Sub-linear in the scene level: the meter is exposure-locked after dark, so
    // a rig that tracked the light exactly would put the weapon back in
    // silhouette at night. Every shipped shooter biases the viewmodel up in the
    // dark; gamma 0.65 is that bias, and it is a no-op in full daylight.
    const shaped = REF_DAYLIGHT * Math.pow(Math.min(ref / REF_DAYLIGHT, 1), s.viewKeyGamma);
    const keyI = Math.min(shaped * s.viewKeyScale, s.viewKeyMax);
    this.viewSun.color.copy(this.activeSun.color);
    this.viewSun.intensity = keyI;

    // Fill takes the cool sky hue, rim the warm key hue, so the gun sits in the
    // same light as the street rather than looking like a studio render.
    const h = this._fillHue;
    this.viewKeyFill.color.setRGB(h.x, h.y, h.z);
    this.viewKeyFill.intensity = keyI * s.viewFillRatio;
    const sc = this.activeSun.color;
    this.viewRim.color.setRGB(sc.r, sc.g * 0.94, sc.b * 0.82);
    this.viewRim.intensity = keyI * s.viewRimRatio;
    this.viewFill.intensity = keyI * s.viewHemiRatio;

    // Warm bounce takes the ground-bounce hue the world's own lower fill band
    // uses (_updateBounceFill writes it into _fillHue2), so the gun and gloves
    // pick up the same sand-off-the-street colour the buildings do.
    const g = this._fillHue2;
    if (Math.max(g.x, g.y, g.z) > 1e-5) {
      this.viewBounce.color.setRGB(g.x, g.y * 0.86, g.z * 0.62);
    }
    this.viewBounce.intensity = keyI * s.viewBounceRatio;

    this._placeViewLight(this.viewSun, this._viewKeyDir, viewCamera);
    this._placeViewLight(this.viewKeyFill, this._viewFillDir, viewCamera);
    this._placeViewLight(this.viewRim, this._viewRimDir, viewCamera);
    this._placeViewLight(this.viewBounce, this._viewBounceDir, viewCamera);
  }

  _placeViewLight(light, dirView, viewCamera) {
    const d = this._tmpV3c.copy(dirView).transformDirection(viewCamera.matrixWorld);
    light.target.position.setFromMatrixPosition(viewCamera.matrixWorld);
    light.position.copy(light.target.position).addScaledVector(d, 4);
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  }

  /**
   * Drive the two-band bounce fill from the live sky.
   *
   * The engine has exactly one indirect term — the PMREM sky cubemap — and
   * GTAO multiplies it, so a wall in shade received almost nothing. This adds
   * the two things a real street has: a cool hemisphere of skylight, and the
   * warm light the sunlit side of the street throws back at the shaded side.
   * Both are scaled off the key's intensity so they follow time of day for
   * free, and both are colour-matched to the sky's own published ambient.
   */
  _updateBounceFill() {
    const s = this.settings;
    const u = this.patcher.uniforms;
    const sunI = Math.max(0, this.activeSun.intensity);

    // Hue of the whole-sky band. `sky.ambientColor` is the sky subsystem's own
    // CPU stand-in for it; without a sky system we fall back to the key colour.
    const sky = this.ctx.peek('sky');
    const amb = sky?.ambientColor;
    const hue = this._fillHue;
    if (amb && Math.max(amb.r, amb.g, amb.b) > 1e-5) {
      hue.set(amb.r, amb.g, amb.b);
      // Published whole-sky level, ~15% of the beam. Used as the "how much light
      // is in this scene at all" reference for the viewmodel rig.
      this._ambLevel = Math.max(hue.x, hue.y, hue.z);
    } else {
      hue.set(0.36, 0.56, 1.0);
      this._ambLevel = 0.15 * sunI;
    }
    hue.divideScalar(Math.max(hue.x, hue.y, hue.z));
    // `sky.ambientColor` is the WHOLE-sky average — zenith Rayleigh blue mixed
    // with a horizon band that is nearly achromatic by day and the sunset
    // itself at dusk. This band is not the whole sky: it is what an up-facing
    // or vertical surface sees of the UPPER hemisphere, which is the bluest
    // part of it. Pushing the chroma out from its own luminance recovers that
    // without inventing a hue, and it is what turns a shaded facade from the
    // measured B-R of +0.0002 (4.5% saturation, indistinguishable from grey)
    // into something that reads as skylight.
    {
      const l = 0.2126 * hue.x + 0.7152 * hue.y + 0.0722 * hue.z;
      const k = 1.18;
      hue.set(
        Math.max(0, l + (hue.x - l) * k),
        Math.max(0, l + (hue.y - l) * k),
        Math.max(0, l + (hue.z - l) * k)
      );
      hue.divideScalar(Math.max(hue.x, hue.y, hue.z, 1e-6));
    }

    // The cool band rides the sky's own published irradiance, NOT the key: at
    // night the key is a 0.05 moon and a band scaled off it is nothing, which is
    // how a night frame ends up with a fifth of its pixels under code value 12.
    // `skyFill` stays a fraction of the *beam* by construction, because the sky
    // publishes its ambient as 15% of the beam in daylight.
    const skyRef = this._ambLevel / 0.15;
    const skyLevel = s.skyFill * skyRef;
    u.owSkyFill.value.set(hue.x * skyLevel, hue.y * skyLevel, hue.z * skyLevel);

    // The lower band is sunlight off the road, so it takes the *key's* colour
    // through the ground albedo the sky dome itself uses — warm, not blue.
    const sc = this.activeSun.color;
    const g = this._fillHue2.set(sc.r * 0.33, sc.g * 0.29, sc.b * 0.225);
    g.divideScalar(Math.max(g.x, g.y, g.z, 1e-6));
    const groundLevel = s.groundFill * sunI;
    u.owGroundFill.value.set(g.x * groundLevel, g.y * groundLevel, g.z * groundLevel);

    u.owFillGain.value.set(1, s.bounceFill / Math.max(s.groundFill, 1e-6));
    // The sky publishes an elevation-dependent indirect budget so the key:fill
    // ratio does not invert at golden hour (see SkySystem.indirectScale).
    u.owIndirect.value.x = s.iblDiffuse * (sky?.indirectScale ?? 1);
    u.owIndirect.value.y = s.interiorIndirect;
    this._skyExposureBias = sky?.exposureBias ?? 0;
  }

  /**
   * Publish the coarse interior volumes the indirect gate tests against.
   *
   * The level is authored on one yaw, so a world position reaches level space
   * through a 2D rotation — cheap enough to do per fragment. The volumes are
   * the enterable buildings' own footprints, which the world subsystem already
   * publishes as `world.buildings[].spec`; we do not need per-room geometry
   * because the gate keys off *depth inside the footprint*, and a wall's outer
   * skin is at depth 0 while its inner skin is one thickness in.
   *
   * Runs once, when the world first appears, and then never again.
   */
  _updateRooms() {
    if (this._roomsReady) return;
    const world = this.ctx.peek('world');
    const list = world?.buildings;
    if (!list || !world.levelToWorld) return;
    this._roomsReady = true;

    // Recover the level->world yaw from two transformed level-space points, so
    // this stays correct if the world subsystem re-authors its transform.
    const o = world.levelToWorld(0, 0, 0, this._tmpV3);
    const ox = o.x;
    const oz = o.z;
    const ex = world.levelToWorld(1, 0, 0, this._tmpV3b);
    const c = ex.x - ox;
    const sn = ex.z - oz;
    const inv = 1 / Math.max(1e-6, Math.hypot(c, sn));
    const cs = c * inv;
    const sni = sn * inv;
    // world -> level: p' = R^T (p - o)
    this.patcher.uniforms.owRoomXf.value.set(
      cs,
      sni,
      -(ox * cs + oz * sni),
      -(-ox * sni + oz * cs)
    );

    const rooms = this.patcher.rooms;
    const roomsY = this.patcher.roomsY;
    let n = 0;
    for (const b of list) {
      const sp = b?.spec;
      if (!sp || sp.enterable !== true) continue;
      // A collapsed or ruined shell is open to the sky: it must keep its
      // skylight, or the one room in the level with a hole in its roof is the
      // one that reads as a cave.
      if (sp.collapse === true || sp.ruin === true) continue;
      if (n >= rooms.length) break;
      rooms[n].set(sp.x, sp.z, sp.w * 0.5, sp.d * 0.5);
      // From below the ground slab (so the floor plate counts as interior) up to
      // just under the roof deck — or under a setback, whose terrace is outdoors
      // and sits inside the footprint.
      let top = (b.roofY ?? 12) - 0.06;
      const sb = sp.setback?.from;
      if (sb !== undefined && b.floorY?.[sb] !== undefined) top = b.floorY[sb] - 0.06;
      roomsY[n].set(-0.8, top, 0, 0);
      n++;
    }
    this.patcher.uniforms.owIndirect.value.z = n;
    if (n > 0) console.info(`[render] indirect gate: ${n} interior volumes`);
  }

  _ensureProbe(ctx) {
    // A couple of foreign meshes means another subsystem is still using its
    // own placeholder; the probe only steps aside for a real level.
    const FOREIGN_LIMIT = 6;
    if (this.probeActive) {
      if (this._foreignMeshes >= FOREIGN_LIMIT) {
        ctx.scene.remove(this.probe.group);
        this.probe.dispose();
        this.probeActive = false;
        this.taa?.reset();
      }
      return;
    }
    if (this.frame > 4 || this._foreignMeshes >= FOREIGN_LIMIT) return;
    const g = this.probe.build();
    g.traverse((o) => {
      o.userData.owProbe = true;
    });
    ctx.scene.add(g);
    this.probeActive = true;
  }

  _cullLights(camPos) {
    const s = this.settings;
    for (let i = 0; i < this.lights.length; i++) {
      const e = this.lights[i];
      // If the owner animated the intensity since we last wrote it, adopt the
      // new value as the base rather than fighting them (flickering lamps).
      if (e.applied !== undefined && e.light.intensity !== e.applied) {
        e.baseIntensity = e.light.intensity;
      }
      const d = e.light.position.distanceTo(camPos);
      const fade = 1 - THREE.MathUtils.smoothstep(d, e.range * 0.75, e.range * 1.15);
      // Practicals are held against the sun by the renderer, because the
      // renderer is what owns the key:fill ratio. A "practical" here is a light
      // that asked to be distance-culled inside a room-or-street radius; the FX
      // flash pool deliberately registers at 90 m so the fade never bites it,
      // and a muzzle flash must not be dimmed by a room-lighting control.
      const gain = e.range <= PRACTICAL_RANGE ? s.practicalGain : 1;
      e.applied = e.baseIntensity * fade * gain;
      e.light.intensity = e.applied;
      e.light.visible = fade > 0.002;
    }
  }

  // ==========================================================================
  //  the frame
  // ==========================================================================

  render(ctx) {
    const renderer = this.renderer;
    const { scene, camera, viewScene, viewCamera } = ctx;
    const dt = Math.min(0.1, Math.max(1 / 480, ctx.time.dt || 1 / 60));
    this.frame++;
    // Before anything reads `screenSize` or binds a target: a step reallocates
    // the whole chain, and it must not happen between two passes of one frame.
    this._updateDynRes(ctx);
    renderer.info.reset();

    camera.updateMatrixWorld();
    viewCamera.updateMatrixWorld();

    this._collect(scene);
    this._ensureProbe(ctx);
    this._syncSun(camera);
    this._updateRooms();
    this._updateBounceFill();
    this._updateViewRig(viewCamera);
    this._camPos.setFromMatrixPosition(camera.matrixWorld);
    this._cullLights(this._camPos);
    this._adsT = this._readAds();

    if (ctx.scene.environment !== this.envMap) {
      // somebody installed a better environment — adopt it everywhere
      this.envMap = ctx.scene.environment;
    }
    // Mirror the world environment onto the viewmodel scene so the weapon is
    // lit by the same IBL, but never stomp an environment the weapons
    // subsystem chose for itself.
    if (
      ctx.viewScene.environment !== ctx.scene.environment &&
      (ctx.viewScene.environment === null ||
        ctx.viewScene.environment === this._assignedViewEnv)
    ) {
      ctx.viewScene.environment = ctx.scene.environment;
      this._assignedViewEnv = ctx.scene.environment;
    }

    // ---- unjittered matrices for velocity + reprojection ------------------
    this._currVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._invVP.copy(this._currVP).invert();
    if (this._firstFrame) this._prevVP.copy(this._currVP);

    // ---- 2. cascaded shadow maps -----------------------------------------
    const bg = scene.background;
    if (this.csm.enabled) {
      this.csm.update(camera, this.sunDir, this.settings.sunSoftness);
      this.csm.setJitter(this.taa ? this.frame % 8 : 0);
      scene.background = null;
      this._hideList(this._hide, this._nHide);
      this._hideList(this._noShadow, this._nNoShadow);
      this.csm.render(renderer, scene, this._noCascadeCull ? null : this._draw, this._nDraw);
      this._showList(this._noShadow, this._nNoShadow);
      this._showList(this._hide, this._nHide);
      scene.background = bg;
    }

    // ---- 3. TAA jitter ----------------------------------------------------
    // World camera only. The viewmodel is not temporally resolved any more, so
    // jittering its projection would just make it shimmer with nothing to
    // accumulate the offsets back out.
    if (this.taa) this._applyJitter(camera);

    // ---- 4. prepass -------------------------------------------------------
    const gb = this.gbuffer;
    if (this.needsPrepass) {
      scene.background = null;
      this._hideList(this._hide, this._nHide);
      gb.render(renderer, scene, camera, this._currVP, this._prevVP, true);
      this._showList(this._hide, this._nHide);
      scene.background = bg;
    }

    const feat = this.patcher.uniforms.owFeat.value;
    feat.set(0, 0, 0, 1);

    // ---- 5/6/7. AO, contact shadows, reflections --------------------------
    if (this.gtao && this.needsPrepass) {
      this.patcher.uniforms.owAoTex.value = this.gtao.render(
        renderer,
        gb,
        camera,
        this.frame,
        !!this.taa
      );
      this.aoTexture = this.patcher.uniforms.owAoTex.value;
      feat.x = 1;
    }
    if (this.contact && this.needsPrepass) {
      this.patcher.uniforms.owContactTex.value = this.contact.render(
        renderer,
        gb,
        camera,
        this.sunDirView,
        this.frame
      );
      feat.y = 1;
    }
    if (this.ssr && this.needsPrepass && !this._firstFrame) {
      // Previous frame's resolved colour. Without TAA the HDR target still
      // holds last frame at this point in the schedule, which is exactly what
      // we want to reflect.
      const src = this.taa ? this.taa.previousTexture : this.hdrRt.texture;
      this.patcher.uniforms.owSsrTex.value = this.ssr.render(renderer, gb, src, camera, this.frame);
      feat.z = 1;
    }

    // ---- 8. forward world pass -------------------------------------------
    this.csm.uniforms.owSunDirView.value.copy(this.sunDirView);
    renderer.setRenderTarget(this.hdrRt);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // ---- 9. viewmodel into its OWN colour+depth target --------------------
    // NOT into the world buffer: see the header note. The gbuffer is left
    // describing the world alone, which is what TAA, motion blur, the ADS DOF
    // and the volumetric fog all need it to be.
    this._viewVisible = viewScene.children.length > this._viewRigChildren;
    if (this._viewVisible) {
      // The viewmodel is only in the cascades if its camera shares the world
      // camera's position; otherwise the world-space lookup would be nonsense.
      this._tmpV3.setFromMatrixPosition(viewCamera.matrixWorld);
      const coherent = this._tmpV3.distanceToSquared(this._camPos) < 0.25;
      const prevStrength = this.csm.uniforms.owCsmParams.value.x;
      const prevFeat = feat.y;
      if (!coherent) this.csm.uniforms.owCsmParams.value.x = 0;
      feat.y = 0; // contact shadows are a world-space buffer; not for the gun
      this.csm.uniforms.owSunDirView.value
        .copy(this.sunDir)
        .transformDirection(viewCamera.matrixWorldInverse)
        .normalize();

      // A weapon at the shoulder sees maybe half the sky — the shooter's own
      // head, chest and arms take the rest — so the hemispheric fill is
      // occluded for the viewmodel exactly the way its envMapIntensity is.
      // Without this the gun floats in more indirect light than the street.
      const uSky = this.patcher.uniforms.owSkyFill.value;
      const uGnd = this.patcher.uniforms.owGroundFill.value;
      this._fillSkySave.copy(uSky);
      this._fillGroundSave.copy(uGnd);
      uSky.multiplyScalar(this.settings.viewFillOcclusion);
      uGnd.multiplyScalar(this.settings.viewFillOcclusion);
      // The interior gate is a WORLD-space volume test and the viewmodel's
      // world position is the camera's, so standing in a shop would drop the
      // weapon's whole indirect term at once. The gun has its own rig; skip it.
      const roomN = this.patcher.uniforms.owIndirect.value.z;
      this.patcher.uniforms.owIndirect.value.z = 0;

      // Still walked every frame — that is where new weapon/hand materials get
      // the shadow/AO/fill injection. It just no longer feeds the gbuffer.
      this._collectViewScene(viewScene);

      renderer.setRenderTarget(this._ensureViewRt());
      // Transparent clear: the composite needs coverage, and the MSAA resolve
      // turns partially covered edge pixels into premultiplied fractional alpha.
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(viewScene, viewCamera);
      renderer.setClearColor(0x000000, 1);

      this.csm.uniforms.owCsmParams.value.x = prevStrength;
      feat.y = prevFeat;
      uSky.copy(this._fillSkySave);
      uGnd.copy(this._fillGroundSave);
      this.patcher.uniforms.owIndirect.value.z = roomN;
    }

    if (this.taa) this._removeJitter(camera);

    // ---- 10. TAA ----------------------------------------------------------
    let color = this.hdrRt.texture;
    if (this.taa) {
      color = this.taa.render(renderer, color, gb, this._invVP, this._prevVP);
    }

    // ---- 11. motion blur --------------------------------------------------
    if (this.motionBlur) {
      const shutter = this.settings.shutter * (1 / 60 / dt);
      color = this.motionBlur.render(renderer, color, gb, this.frame, shutter);
    }

    // ---- 12. ADS depth of field ------------------------------------------
    // World only, and only while the sights are actually up. The viewmodel is
    // composited afterwards, so the optic body and the reticle stay sharp by
    // construction rather than by masking.
    if (this.dof && this._adsT > 0.01 && this.needsPrepass) {
      const dofOut = this.pingRt[this._pingIndex];
      color = this.dof.render(
        renderer,
        color,
        gb,
        dofOut,
        this._adsT,
        this.settings,
        this.frame
      );
      this._pingIndex ^= 1;
    }

    // ---- 13. registered passes -------------------------------------------
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p.enabled === false) continue;
      const out = this.pingRt[this._pingIndex];
      p.render(renderer, color, out, this);
      color = out.texture;
      this._pingIndex ^= 1;
    }

    // ---- 14. viewmodel composite -----------------------------------------
    // After the registered passes on purpose: the volumetric fog and haze pass
    // are depth-driven and the gbuffer now holds the WORLD depth at the gun's
    // pixels, so compositing earlier would bury the weapon in 40 m of aerial
    // perspective. Before metering and bloom, so the muzzle flash still meters
    // and still blooms.
    if (this._viewVisible) {
      const vu = this.viewComposite.uniforms;
      const out = this.pingRt[this._pingIndex];
      vu.tColor.value = color;
      vu.tView.value = this.viewRt.texture;
      this.viewComposite.render(renderer, out);
      color = out.texture;
      this._pingIndex ^= 1;
    }

    // ---- 15. metering -----------------------------------------------------
    const s = this.settings;
    const exposureTex = this.exposure.update(
      renderer,
      color,
      this.screenSize.width,
      this.screenSize.height,
      s.autoExposure ? dt : 1e3,
      // The sky publishes a metering compensation for the current sun elevation:
      // a street canyon under a four-degree sun is entirely in shade, and a meter
      // weighted onto that geometry opens up two stops and flattens the sky it is
      // lit by. See SkySystem.exposureBias.
      s.exposureBias + this._skyExposureBias,
      s.exposureKey,
      this.needsPrepass ? this.depthTexture : null
    );
    this.exposureTexture = exposureTex;

    // ---- 16. bloom --------------------------------------------------------
    let bloomTex = null;
    if (this.bloom) {
      bloomTex = this.bloom.render(
        renderer,
        color,
        this.screenSize.width,
        this.screenSize.height,
        exposureTex
      );
    }

    // ---- 17/18. composite -------------------------------------------------
    const cu = this.composite.uniforms;
    cu.tColor.value = color;
    cu.tBloom.value = bloomTex ?? color;
    cu.tExposure.value = exposureTex;
    cu.uGrade.value.x = bloomTex ? s.bloomStrength : 0;
    cu.uGrade.value.z = this.taa ? s.sharpen : 0;
    // Vignette closes in with the sight picture.
    cu.uLens.value.y = s.vignette + (s.adsVignette - s.vignette) * this._adsT;
    cu.uLens.value.w = ctx.time.elapsed;
    cu.uLook.value.w = this.ctx.config.exposure ?? 1;

    if (this.debugView) {
      this._renderDebug(renderer, color);
    } else if (this.fxaa) {
      this.composite.render(renderer, this.ldrRt);
      this.fxaa.uniforms.tColor.value = this.ldrRt.texture;
      this.fxaa.render(renderer, null);
    } else {
      this.composite.render(renderer, null);
    }

    // ---- bookkeeping ------------------------------------------------------
    // Only world objects are in the gbuffer now, so only their transforms need
    // remembering for next frame's velocity.
    gb.beginRecord();
    gb.recordMatrices(this._draw, this._nDraw);
    gb.endRecord();
    this._prevVP.copy(this._currVP);
    this._firstFrame = false;
    renderer.setRenderTarget(null);

    if (this._probeExposure) this._logExposure();
  }

  /**
   * The viewmodel scene walk. Its only job now is material patching — the
   * viewmodel is no longer in the gbuffer, so nothing needs its transform
   * remembered for a velocity difference.
   */
  _visitView(o) {
    if (o.isMesh === true) {
      const m = o.material;
      if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.patcher.patch(m[i]);
      else if (m) this.patcher.patch(m);
    }
  }

  /**
   * Dev aid: show an intermediate buffer full-screen.
   * `ctx.get('render').debugView = 'ao' | 'normal' | 'velocity' | 'depth' |
   *  'ssr' | 'ssrmask' | 'contact' | 'bloom' | null`
   */
  _renderDebug(renderer, color) {
    if (!this._debugPass) this._debugPass = createDebug();
    const u = this._debugPass.uniforms;
    const gb = this.gbuffer;
    const map = {
      ao: [this.aoTexture, 0],
      normal: [gb.normalTexture, 1],
      velocity: [gb.velocityTexture, 2],
      depth: [gb.depthTexture, 3],
      ssr: [this.ssr?.texture, 4],
      ssrmask: [this.ssr?.texture, 5],
      contact: [this.contact?.texture, 0],
      bloom: [this.bloom?.texture, 4],
      view: [this.viewRt?.texture, 4],
      viewalpha: [this.viewRt?.texture, 5],
      color: [color, 4],
    };
    const entry = map[this.debugView] ?? map.color;
    u.tSrc.value = entry[0] ?? color;
    u.uMode.value = entry[1];
    this._debugPass.render(renderer, null);
  }

  /**
   * Dev aid: dump the metering chain. `render.debugExposure()` in console.
   *
   * The metering targets are FloatType only while `EXT_color_buffer_float` is
   * there; without it `AutoExposure` falls back to half float (see its
   * constructor), and reading a HalfFloatType attachment into a Float32Array is
   * a GL type mismatch — the readback either throws or comes back as noise, so
   * the ONE diagnostic that could explain a black frame on the part that needs
   * explaining was the one that broke. Same decode path as `probeHdr`.
   */
  debugExposure() {
    const half = !this.canRenderFloat;
    if (half && !this._readbackH) {
      this._readbackH = new Uint16Array(4);
      this._readbackH2 = new Uint16Array(4);
    }
    const dec = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    const buf = half ? this._readbackH : this._readback;
    this.renderer.readRenderTargetPixels(this.exposure.rt1, 0, 0, 1, 1, buf);
    const avgLog = dec(buf[0]) / Math.max(dec(buf[1]), 1e-4);
    const out = half ? this._readbackH2 : this._readback2;
    this.renderer.readRenderTargetPixels(
      this.exposure.adapt[this.exposure._flip],
      0,
      0,
      1,
      1,
      out
    );
    return { avgLum: Math.pow(2, avgLog), ev100: dec(out[1]), exposure: dec(out[0]) };
  }

  _logExposure() {
    if (this.frame % 90 !== 0) return;
    const d = this.debugExposure();
    const u = this.patcher.uniforms;
    const v3 = (x) => `${x.x.toFixed(3)},${x.y.toFixed(3)},${x.z.toFixed(3)}`;
    console.info(
      `[render] frame ${this.frame} avgLum ${d.avgLum.toFixed(4)} ev100 ${d.ev100.toFixed(2)} exposure ${d.exposure.toFixed(4)} ` +
        `sun=${this.activeSun.intensity.toFixed(3)} skyFill=${v3(u.owSkyFill.value)} gndFill=${v3(u.owGroundFill.value)} ` +
        `ibl=${u.owIndirect.value.x.toFixed(3)} indoor=${u.owIndirect.value.y.toFixed(3)} rooms=${u.owIndirect.value.z}`
    );
  }

  _collectViewScene(viewScene) {
    viewScene.traverseVisible(this._visitView);
  }

  /**
   * Sub-pixel offset for the TAA accumulation. WORLD camera only — the
   * viewmodel has its own MSAA target and no temporal history, so a jitter on
   * `viewCamera` would be a permanent sub-pixel wobble with nothing to resolve
   * it back out.
   */
  _applyJitter(camera) {
    const j = this.taa.nextJitter();
    const jx = (j.x * 2) / this.screenSize.width;
    const jy = (j.y * 2) / this.screenSize.height;
    this._jitterSaved.set(camera.projectionMatrix.elements[8], camera.projectionMatrix.elements[9]);
    camera.projectionMatrix.elements[8] += jx;
    camera.projectionMatrix.elements[9] += jy;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this._jittered = true;
  }

  _removeJitter(camera) {
    if (!this._jittered) return;
    camera.projectionMatrix.elements[8] = this._jitterSaved.x;
    camera.projectionMatrix.elements[9] = this._jitterSaved.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this._jittered = false;
  }

  /**
   * ADS engagement, 0..1. The weapons subsystem owns the transition; we only
   * read it, and never require it to exist.
   */
  _readAds() {
    if (!this._weapons) this._weapons = this.ctx.peek('weapons') || null;
    const w = this._weapons;
    if (!w) return 0;
    const t = w.adsProgress;
    return typeof t === 'number' && t === t ? Math.min(1, Math.max(0, t)) : 0;
  }

  dispose() {
    if (this._onQuality) this.ctx?.events.off('ui:quality', this._onQuality);
    this.csm.dispose();
    this.gbuffer.dispose();
    this.gtao?.dispose();
    this.contact?.dispose();
    this.ssr?.dispose();
    this.taa?.dispose();
    this.motionBlur?.dispose();
    this.dof?.dispose();
    this.bloom?.dispose();
    this.exposure.dispose();
    this.composite.dispose();
    this.viewComposite.dispose();
    this.fxaa?.dispose();
    this.lut.texture.dispose();
    this.envEquirect?.dispose();
    this.hdrRt?.dispose();
    this.viewRt?.dispose();
    this.ldrRt?.dispose();
    this.pingRt[0]?.dispose();
    this.pingRt[1]?.dispose();
    this.envTarget?.dispose();
    if (this.probeActive) {
      this.ctx?.scene.remove(this.probe.group);
      this.probe.dispose();
    }
    this._debugPass?.dispose();
    this.patcher.dispose();
    this.renderer.dispose();
  }
}
