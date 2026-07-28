import * as THREE from 'three';
import { COMMON, TONEMAP } from './glsl.js';
import { Pass } from './pass.js';

/**
 * Final composite: exposure -> lens (chromatic aberration, additive thresholded
 * bloom, cos^4 lens shading — all in linear light) -> AgX filmic tone map ->
 * procedural LUT grade -> grain -> contrast-adaptive sharpen -> sRGB with an
 * ordered dither.
 *
 * All of it in one pass, one pass over the framebuffer, so the bandwidth cost
 * is a single read/write rather than one per effect.
 */

const COMPOSITE = /* glsl */ `
precision highp float;
${COMMON}
${TONEMAP}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tExposure;
uniform sampler3D tLut;

uniform vec2 uTexel;
uniform vec2 uResolution;
uniform vec4 uLens;      // x chromatic, y vignette, z grainAmount, w time
uniform vec4 uGrade;     // x bloomStrength, y lutStrength, z sharpen, w lutSize
uniform vec4 uLook;      // x agx slope, y agx power, z agx sat, w exposureBias
uniform vec4 uHurt;      // x desaturation, y blood vignette, z hit flash, w heartbeat
varying vec2 vUv;

vec3 sampleLut( vec3 c ) {
  float n = uGrade.w;
  vec3 uvw = clamp( c, 0.0, 1.0 ) * ( ( n - 1.0 ) / n ) + ( 0.5 / n );
  return texture( tLut, uvw ).rgb;
}

// Smoothed value noise. Only used by the hurt block below, where it stands in
// for the feTurbulence the DOM overlay used to displace the vignette edge with.
float owVnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = owHash12( i );
  float b = owHash12( i + vec2( 1.0, 0.0 ) );
  float c = owHash12( i + vec2( 0.0, 1.0 ) );
  float d = owHash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

void main() {
  float exposure = texture2D( tExposure, vec2( 0.5 ) ).r * uLook.w;

  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  // --- chromatic aberration: sample the scene three times with a radial
  //     offset that grows toward the corners, like a real lens
  vec3 hdr;
  float ca = uLens.x * r2;
  if ( ca > 0.00002 ) {
    vec2 o = d * ca;
    hdr.r = texture2D( tColor, vUv + o ).r;
    hdr.g = texture2D( tColor, vUv ).g;
    hdr.b = texture2D( tColor, vUv - o ).b;
  } else {
    hdr = texture2D( tColor, vUv ).rgb;
  }
  vec3 centre = max( texture2D( tColor, vUv ).rgb, vec3( 0.0 ) );
  hdr = max( hdr, vec3( 0.0 ) );

  vec3 n1 = max( texture2D( tColor, vUv + vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 n2 = max( texture2D( tColor, vUv - vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) );
  vec3 n3 = max( texture2D( tColor, vUv + vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );
  vec3 n4 = max( texture2D( tColor, vUv - vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) );

  // --- chroma clean-up in the darks ---------------------------------------
  // A 4-tap CHROMA-only blur, applied only in the bottom three stops and
  // fading out completely by the mid-tones. It keeps each pixel's own
  // luminance exactly — so no detail, edge or texture is softened — and only
  // pulls its hue toward the neighbourhood's.
  //
  // The post chain is no longer the source of the per-pixel chroma speckle
  // over dark surfaces (measured: turning grain, CA and sharpen off together
  // moves the high-frequency chroma metric by under 5%), but the night frame
  // still reads as speckled because a ~14x exposure amplifies whatever chroma
  // variance the shading has. The eye has almost no chroma acuity down there,
  // which is exactly why every codec and every denoiser throws dark chroma
  // away, and why doing it here costs nothing visible but the noise.
  {
    vec3 nb = ( n1 + n2 + n3 + n4 ) * 0.25;
    float lh = owLum( hdr );
    float ln = owLum( nb );
    float w = ( 1.0 - smoothstep( 0.003, 0.030, lh ) ) * 0.60;
    if ( w > 0.005 && ln > 1e-6 ) hdr = mix( hdr, nb * ( lh / ln ), w );
  }

  // --- sharpen (contrast adaptive, only where TAA softened things) ---------
  // LUMINANCE ONLY, and computed from the UNSHIFTED centre tap. The old code
  // sharpened hdr, which is the chromatically-aberrated fetch, against a blur
  // of unshifted neighbours: the difference therefore *contained the CA offset
  // itself* and the sharpen amplified it, which is where the coarse
  // magenta/green fringing on every high-contrast edge came from. A scalar gain
  // around the centre luminance cannot invent chroma at all.
  // OW_SHARPEN is only defined when TAA exists. Without it uGrade.z is pinned
  // to 0 for the life of the process (see RenderSystem._applySettings), so this
  // is dead code the compiler cannot prove dead — it still costs registers, and
  // on a tiler register pressure costs occupancy.
  #ifdef OW_SHARPEN
  if ( uGrade.z > 0.001 ) {
    float l1 = owLum( n1 ), l2 = owLum( n2 ), l3 = owLum( n3 ), l4 = owLum( n4 );
    float lc = owLum( centre );
    float lmn = min( min( l1, l2 ), min( l3, l4 ) );
    float lmx = max( max( l1, l2 ), max( l3, l4 ) );
    float lblur = ( l1 + l2 + l3 + l4 ) * 0.25;
    // contrast adaptive: less sharpening where local contrast is already high
    float contrast = ( lmx - lmn ) / ( lmx + lmn + 0.02 );
    float amount = uGrade.z * ( 1.0 - clamp( contrast * 1.6, 0.0, 1.0 ) );
    // ...and none at all down in the noise floor, where "detail" is grain.
    amount *= smoothstep( 0.004, 0.03, lc );
    float gain = ( lc + ( lc - lblur ) * amount ) / max( lc, 1e-4 );
    hdr *= clamp( gain, 0.0, 4.0 );
  }
  #endif

  hdr *= exposure;

  // --- bloom (already exposure-scaled AND thresholded in the prefilter) ----
  // ADDED, not mixed. mix() with an unthresholded pyramid is veiling glare: it
  // replaces N% of every pixel with a blurred copy of the frame, which is a
  // milky haze you cannot turn up far enough to see a specular event. The
  // pyramid now only carries what is above display white, so adding it puts
  // light around the sun disc, the glints and the muzzle flash and leaves the
  // rest of the frame exactly where the tone curve put it.
  vec3 bloom = max( texture2D( tBloom, vUv ).rgb, vec3( 0.0 ) );
  hdr += bloom * max( uGrade.x, 0.0 );

  // --- vignette: cos^4 natural falloff, in LINEAR LIGHT --------------------
  // Lens shading is a transmission loss, so it belongs in front of the tone
  // curve, not behind it. Applied in display space it was a flat multiply on the
  // code value: at 0.24 it scaled everything outside the middle sixth of the
  // frame by 0.85..0.81, which put a hard ceiling of ~210 code values on the sky
  // and made display white unreachable anywhere but dead centre. In linear light
  // the same 0.24 costs a quarter of a stop, which the filmic shoulder absorbs
  // in the highlights (a few code values) while still visibly weighting the mids
  // and shadows toward the corners — which is the whole point of a vignette.
  float cos4 = pow( 1.0 / ( 1.0 + r2 * 2.4 ), 2.0 );
  hdr *= mix( 1.0, cos4, uLens.y );

  // --- tone map ------------------------------------------------------------
  vec3 col = owAgX( hdr, uLook.x, uLook.y, uLook.z );

  // --- DISPLAY TRANSFORM ---------------------------------------------------
  // Everything below this line is display-referred (code values, 0..1 sRGB).
  // The grade LUT and the grain are authored in that space:
  // the LUT's toe/shadowTint are additive *code value* offsets, so feeding it
  // linear light turned a 0.008 toe into a hard linear floor and painted the
  // whole frame's shadows blue-grey. Encode first, grade second.
  col = clamp( col, 0.0, 1.0 );
  vec3 disp = owLinearToSrgb( col );

  // --- procedural film grade (display-referred) ----------------------------
  vec3 graded = sampleLut( disp );
  disp = mix( disp, graded, uGrade.y );

  // --- hurt state (display-referred) ---------------------------------------
  // These four effects were five stacked full-screen DOM layers over the canvas:
  // a backdrop-filter for the desaturation, two gradients pushed through an
  // feTurbulence/feDisplacementMap SVG filter for the blood vignette, and two
  // mix-blend-mode layers for the heartbeat ring and the hit flash. Every one
  // of them reads the pixels *underneath*, and underneath is a canvas that
  // redraws every frame, so not one of them could ever be cached in a composited
  // layer: the browser read back the whole framebuffer, ran a filter graph over
  // it and recomposited, on every frame, for as long as the player was hurt.
  // Here it is a handful of ALU ops on a value this pass already holds in a
  // register. src/ui/health.js publishes the amounts and src/ui/index.js hands
  // them over through RenderSystem.setHurt.
  //
  // The branch is uniform-coherent — every invocation in the draw takes the same
  // side — so a healthy player pays for a compare. And with uHurt at zero, disp
  // leaves this block bit-identical, which is what keeps the shot gate clean.
  if ( uHurt.x + uHurt.y + uHurt.z + uHurt.w > 0.001 ) {
    // desaturate / contrast / brightness. Exactly the old .ow-desat filter
    // chain, saturate(.6) contrast(1.04) brightness(.97), mixed by its opacity.
    if ( uHurt.x > 0.002 ) {
      float l = owLum( disp );
      vec3 f = ( ( l + ( disp - l ) * 0.6 ) - 0.5 ) * 1.04 + 0.5;
      disp = mix( disp, clamp( f * 0.97, 0.0, 1.0 ), uHurt.x );
    }

    // Organic edge, two octaves. A clean radial ramp is the single most "WebGL
    // demo" thing a hurt overlay can do, which is the whole reason the DOM
    // version was paying for a turbulence filter.
    float warp = ( owVnoise( vUv * vec2( 6.5, 4.2 ) ) - 0.5 ) * 0.085
               + ( owVnoise( vUv * vec2( 17.0, 11.0 ) ) - 0.5 ) * 0.030;

    // Box coordinates of the old .ow-blood wrapper, which was inset -7%, and the
    // heartbeat's slow swell of it.
    vec2 hp = ( vUv - 0.5 ) / ( 1.14 * ( 1.0 + uHurt.w * 0.04 ) );

    if ( uHurt.y > 0.002 ) {
      // .ow-blood-a: ellipse 78% x 74% about the centre, alpha ramping from 62%
      // of the radius out to the corners.
      float t = length( vec2( hp.x / 0.78, hp.y / 0.74 ) ) + warp;
      float e = clamp( ( t - 0.60 ) / 0.30, 0.0, 1.0 );
      vec3 blood = mix( vec3( 0.478, 0.055, 0.039 ), vec3( 0.290, 0.031, 0.020 ), e );
      disp = mix( disp, blood, e * e * 0.62 * uHurt.y );

      // .ow-blood-b: four off-centre smears, multiplied in. Circular in SCREEN
      // space, so the distance is aspect-corrected rather than uv-corrected.
      vec2 ar = vec2( uResolution.x / max( uResolution.y, 1.0 ), 1.0 );
      float sm = smoothstep( 0.30, 0.0, length( ( vUv - vec2( 0.02, 0.22 ) ) * ar ) )
               + smoothstep( 0.27, 0.0, length( ( vUv - vec2( 0.99, 0.58 ) ) * ar ) )
               + smoothstep( 0.33, 0.0, length( ( vUv - vec2( 0.26, 1.01 ) ) * ar ) )
               + smoothstep( 0.31, 0.0, length( ( vUv - vec2( 0.74, -0.02 ) ) * ar ) );
      sm = clamp( sm + warp * 1.6, 0.0, 1.0 ) * 0.38 * uHurt.y;
      disp *= mix( vec3( 1.0 ), vec3( 0.376, 0.039, 0.031 ), sm );
    }

    // .ow-lowbeat: the wider, softer ring that pulses with the heartbeat.
    if ( uHurt.w > 0.002 ) {
      float t = length( vec2( hp.x / 0.76, hp.y / 0.70 ) ) + warp;
      disp = mix( disp, vec3( 0.588, 0.055, 0.039 ),
                  clamp( ( t - 0.62 ) / 0.34, 0.0, 1.0 ) * 0.34 * uHurt.w );
    }

    // .ow-hitflash: a 190 ms screen-blended red bloom on every round that lands.
    if ( uHurt.z > 0.002 ) {
      float t = length( vec2( ( vUv.x - 0.5 ) / 0.90, ( vUv.y - 0.5 ) / 0.86 ) );
      vec3 fl = vec3( 0.627, 0.070, 0.047 )
              * ( mix( 0.22, 0.62, clamp( ( t - 0.40 ) / 0.60, 0.0, 1.0 ) ) * uHurt.z );
      disp = 1.0 - ( 1.0 - disp ) * ( 1.0 - fl );
    }
  }

  // --- grain, in code-value space, LESS of it in the darks -----------------
  // Real sensor noise is loudest in the mid/upper mids once it has been
  // through a display transform; in the darks it is what the eye reads as
  // "dirty image", so the response is deliberately the opposite of the naive
  // "more grain where it is dark".
  if ( uLens.z > 0.0005 ) {
    float g = owHash12( gl_FragCoord.xy + uLens.w * 137.13 ) - 0.5;
    float g2 = owHash12( gl_FragCoord.xy * 1.7 - uLens.w * 71.3 ) - 0.5;
    float noise = ( g * 0.65 + g2 * 0.35 );
    float l = owLum( disp );
    float response = uLens.z * ( 0.35 + 0.65 * smoothstep( 0.0, 0.30, l ) );
    disp += noise * response;
  }

  // ordered dither before the 8-bit write kills gradient banding in the sky
  disp += ( owHash12( gl_FragCoord.xy * 0.5 + uLens.w ) - 0.5 ) * 0.0022;

  gl_FragColor = vec4( disp, 1.0 );
}
`;

const FXAA = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vUv;

// Compact FXAA 3.11-style edge filter, used only when TAA is off so the
// no-temporal path still has clean silhouettes.
void main() {
  vec3 rgbNW = texture2D( tColor, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbNE = texture2D( tColor, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 rgbSW = texture2D( tColor, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 rgbSE = texture2D( tColor, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  vec4 texColor = texture2D( tColor, vUv );
  vec3 rgbM = texColor.rgb;

  float lumaNW = owLum( rgbNW );
  float lumaNE = owLum( rgbNE );
  float lumaSW = owLum( rgbSW );
  float lumaSE = owLum( rgbSE );
  float lumaM  = owLum( rgbM );
  float lumaMin = min( lumaM, min( min( lumaNW, lumaNE ), min( lumaSW, lumaSE ) ) );
  float lumaMax = max( lumaM, max( max( lumaNW, lumaNE ), max( lumaSW, lumaSE ) ) );

  if ( lumaMax - lumaMin < max( 0.0312, lumaMax * 0.125 ) ) {
    gl_FragColor = texColor;
    return;
  }

  vec2 dir = vec2(
    -( ( lumaNW + lumaNE ) - ( lumaSW + lumaSE ) ),
      ( ( lumaNW + lumaSW ) - ( lumaNE + lumaSE ) ) );
  float dirReduce = max( ( lumaNW + lumaNE + lumaSW + lumaSE ) * 0.03125, 0.0078125 );
  float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
  dir = clamp( dir * rcpDirMin, -8.0, 8.0 ) * uTexel;

  vec3 rgbA = 0.5 * (
    texture2D( tColor, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
    texture2D( tColor, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D( tColor, vUv - dir * 0.5 ).rgb +
    texture2D( tColor, vUv + dir * 0.5 ).rgb );

  float lumaB = owLum( rgbB );
  gl_FragColor = vec4( ( lumaB < lumaMin || lumaB > lumaMax ) ? rgbA : rgbB, texColor.a );
}
`;

/**
 * Composite the first-person scene over the finished world image.
 *
 * The viewmodel is rendered into its own MSAA colour+depth target AFTER the TAA
 * resolve, because it is the one thing in the frame whose motion the camera
 * matrices cannot describe. The ADS transition, sway, bob, recoil and the
 * skinned AI meshes all move in VIEW space, so a velocity buffer built from
 * `viewPrevVP`/`viewCurrVP` emits zero motion for them; TAA then reprojected
 * those pixels onto a stale sample containing the static background and blended
 * it in at ~85%, which is why the optic tube, the mount and the glove were
 * semi-transparent with balcony rails and power lines legible straight through.
 * Drawing it after the resolve makes the whole class of bug impossible.
 *
 * The target holds PREMULTIPLIED alpha: opaque geometry lands a = 1, the MSAA
 * resolve produces fractional coverage on the silhouette, additive muzzle flash
 * accumulates a little alpha and a lot of colour. `world * (1 - a) + rgb`
 * handles all three correctly. An FXAA-style edge filter runs on the RGBA so
 * the machining, rail teeth and optic ring get the antialiasing TAA used to
 * provide, without any history to smear.
 */
const VIEW_COMPOSITE = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform sampler2D tView;
uniform vec2 uTexel;
varying vec2 vUv;

vec4 fetchView( vec2 uv ) { return max( texture2D( tView, uv ), vec4( 0.0 ) ); }
// Alpha is part of the edge signal: the silhouette against an empty background
// is a step in coverage, not in luminance.
float edgeLuma( vec4 c ) { return owLum( c.rgb ) + c.a; }

void main() {
  vec3 world = texture2D( tColor, vUv ).rgb;

  vec4 m = fetchView( vUv );
  vec4 nw = fetchView( vUv + vec2( -1.0, -1.0 ) * uTexel );
  vec4 ne = fetchView( vUv + vec2(  1.0, -1.0 ) * uTexel );
  vec4 sw = fetchView( vUv + vec2( -1.0,  1.0 ) * uTexel );
  vec4 se = fetchView( vUv + vec2(  1.0,  1.0 ) * uTexel );

  float lm = edgeLuma( m );
  float lnw = edgeLuma( nw );
  float lne = edgeLuma( ne );
  float lsw = edgeLuma( sw );
  float lse = edgeLuma( se );
  float lmin = min( lm, min( min( lnw, lne ), min( lsw, lse ) ) );
  float lmax = max( lm, max( max( lnw, lne ), max( lsw, lse ) ) );

  vec4 v = m;
  if ( lmax - lmin >= max( 0.045, lmax * 0.11 ) ) {
    vec2 dir = vec2(
      -( ( lnw + lne ) - ( lsw + lse ) ),
        ( ( lnw + lsw ) - ( lne + lse ) ) );
    float dirReduce = max( ( lnw + lne + lsw + lse ) * 0.03125, 0.0078125 );
    float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
    dir = clamp( dir * rcpDirMin, -6.0, 6.0 ) * uTexel;

    vec4 a = 0.5 * (
      fetchView( vUv + dir * ( 1.0 / 3.0 - 0.5 ) ) +
      fetchView( vUv + dir * ( 2.0 / 3.0 - 0.5 ) ) );
    vec4 b = a * 0.5 + 0.25 * (
      fetchView( vUv - dir * 0.5 ) + fetchView( vUv + dir * 0.5 ) );
    float lb = edgeLuma( b );
    v = ( lb < lmin || lb > lmax ) ? a : b;
  }

  float alpha = clamp( v.a, 0.0, 1.0 );
  gl_FragColor = vec4( world * ( 1.0 - alpha ) + v.rgb, 1.0 );
}
`;

export function createViewComposite(precision) {
  return new Pass(
    'ow-view-composite',
    VIEW_COMPOSITE,
    {
      tColor: { value: null },
      tView: { value: null },
      uTexel: { value: new THREE.Vector2() },
    },
    { precision }
  );
}

const DEBUG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform int uMode;
varying vec2 vUv;
void main() {
  vec4 s = texture2D( tSrc, vUv );
  vec3 c;
  if ( uMode == 0 ) c = vec3( s.r );                       // scalar (AO, shadow)
  else if ( uMode == 1 ) c = owDecodeNormal( s.xy ) * 0.5 + 0.5;
  else if ( uMode == 2 ) c = vec3( abs( s.rg ) * 40.0, 0.0 ); // velocity
  else if ( uMode == 3 ) c = vec3( fract( s.r * 0.05 ) );  // linear depth
  else if ( uMode == 4 ) c = s.rgb;                        // raw colour
  else c = vec3( s.a );                                    // confidence
  gl_FragColor = vec4( owLinearToSrgb( clamp( c, 0.0, 1.0 ) ), 1.0 );
}
`;

export function createDebug() {
  return new Pass('ow-debug', DEBUG, {
    tSrc: { value: null },
    uMode: { value: 0 },
  });
}

/**
 * @param {boolean} sharpen compile the CAS block in (only useful with TAA).
 * @param {string} [precision] 'mediump' on the phone tier — see Pass.
 */
export function createComposite(lut, sharpen = true, precision) {
  return new Pass('ow-composite', COMPOSITE, {
    tColor: { value: null },
    tBloom: { value: null },
    tExposure: { value: null },
    tLut: { value: lut.texture },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2() },
    uLens: { value: new THREE.Vector4(0.0016, 0.24, 0.010, 0) },
    uGrade: { value: new THREE.Vector4(0.05, 0.85, 0.22, lut.size) },
    // slope / power / saturation of the AgX look, applied to the LOG-NORMALISED
    // value. minEv..maxEv spans 16.5 stops, so power > 1 costs whole stops in
    // the shadows (1.35 lost ~1.8) — the contrast belongs in the LUT, which
    // works about a pivot instead of about zero.
    //
    // SLOPE IS 1.0 AND MUST STAY THERE. It multiplies the *normalised log*
    // value, so 1.05 is not "5% brighter", it is +0.5 EV applied to the whole
    // image at the point where AgX has already decided where mid-grey goes.
    // Together with a contrast pivot below mid-grey it is what put 18% scene
    // grey on code value 153.
    uLook: { value: new THREE.Vector4(1.0, 1.0, 1.08, 1) },
    // Screen-space hurt state, written by RenderSystem.setHurt. Zero is the
    // exact no-op — the shader branch is not taken and the frame is unchanged.
    uHurt: { value: new THREE.Vector4(0, 0, 0, 0) },
  }, { defines: sharpen ? { OW_SHARPEN: 1 } : {}, precision });
}

export function createFxaa(precision) {
  return new Pass(
    'ow-fxaa',
    FXAA,
    {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2() },
    },
    { precision }
  );
}
