import * as THREE from 'three';
import { FS_VERT } from './glsl.js';

/**
 * Full-screen triangle infrastructure. One shared geometry, one shared scene,
 * one shared camera — a pass is just a material we swap in. No allocation per
 * frame, no examples/jsm EffectComposer.
 */

const _geometry = new THREE.BufferGeometry();
_geometry.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
);
_geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
_geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8);

const _scene = new THREE.Scene();
_scene.matrixAutoUpdate = false;
const _camera = new THREE.Camera();
const _mesh = new THREE.Mesh(_geometry, null);
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
_scene.add(_mesh);

/**
 * Draw `material` over `target` (null = canvas).
 *
 * `clear` is not cosmetic. A full-screen pass overwrites every pixel it is given,
 * but a tile-based GPU cannot know that: binding a target without clearing it
 * makes the driver LOAD the previous contents of every tile out of memory before
 * the first fragment runs, and store them back afterwards. At 1080p HalfFloat
 * RGBA that is 16 MB of pointless traffic per bind, and the post chain binds a
 * dozen targets a frame. `glClear` on the whole attachment is instead a "fast
 * clear" flag on every tile — no load at all. On an immediate-mode desktop GPU
 * the clear is close to free, so this is a strict win.
 *
 * It is only correct for a pass that (a) covers the whole target and (b) does not
 * blend against what is already there; `Pass.render` derives it from the
 * material's own blending mode, which is exactly that test.
 */
export function blit(renderer, material, target, clear = false, layer = 0) {
  _mesh.material = material;
  renderer.setRenderTarget(target, layer);
  if (clear) renderer.clear(true, false, false);
  renderer.render(_scene, _camera);
}

export function disposeFullScreen() {
  _geometry.dispose();
}

/** A post-processing pass: a ShaderMaterial plus the uniforms it owns. */
export class Pass {
  /**
   * `opts.precision` (only 'mediump' is meaningful) rewrites the pass's own
   * `precision highp float;` header. On a phone that is a real saving — half the
   * register file per invocation and, on most mobile architectures, double-rate
   * ALU — and it is safe for exactly the passes whose arithmetic is COLOUR:
   * values in a bounded range that are about to be quantised to 8 bits anyway.
   * It is NOT safe for anything that reconstructs a world-space position from
   * depth (gtao, ssr, contact, the volumetric composite), where mediump's 10-bit
   * mantissa on a 900 m view ray is metres of error, so those passes never ask
   * for it. Every one of them is off at the phone tier regardless.
   */
  constructor(name, fragmentShader, uniforms, opts = {}) {
    this.name = name;
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader:
        opts.precision === 'mediump'
          ? fragmentShader.replace('precision highp float;', 'precision mediump float;')
          : fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      defines: opts.defines ?? {},
      glslVersion: opts.glslVersion ?? null,
      transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    });
  }
  /**
   * `clear` defaults to "yes, unless this pass blends against the destination"
   * — see the note on `blit`. Bloom's up-chain is the one pass that does blend,
   * and its `blending` is assigned after construction, so the test is made here
   * rather than cached.
   */
  render(renderer, target, clear) {
    blit(
      renderer,
      this.material,
      target,
      clear === undefined ? this.material.blending === THREE.NoBlending : clear
    );
  }
  dispose() {
    this.material.dispose();
  }
}

/** Half-float colour target with sane defaults for HDR post. */
export function hdrTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  });
  rt.texture.name = opts.name ?? 'hdr';
  return rt;
}
