import * as THREE from 'three';
import { COMMON } from './glsl.js';

/**
 * Depth / normal / velocity prepass.
 *
 * Up to three MRT attachments, in this order:
 *   RGBA16F  octahedral view normal (xy), coverage (z), material id (w)
 *   RG16F    screen-space velocity as a UV delta (current - previous)
 *   R32F     linear view depth in metres (positive)
 *
 * ATTACHMENTS ARE BUILT FROM THE CONSUMER LIST, NOT UNCONDITIONALLY. Normals are
 * read only by GTAO, SSR and the contact-shadow march; velocity only by TAA,
 * motion blur and the volumetric reprojection. At the `low` preset every one of
 * those is disabled, so the pass was writing 16 of its 20 bytes per pixel into
 * buffers that nothing ever sampled — 50 MB/frame of pure write bandwidth at
 * 1080p, which on a mobile part is most of a millisecond. `RenderSystem` decides
 * which channels have a consumer and passes them here; the shader is generated
 * with only those outputs, and the layout locations are packed so depth-only
 * lands at location 0. Depth is never optional: it is public API (soft
 * particles, fog) and the exposure meter's sky test.
 *
 * Coverage is 1.0 for ordinary geometry and OW_COVERAGE_DYNAMIC (0.7) for
 * geometry whose *vertices* move independently of its transform — skinned
 * characters and morphed meshes. Every consumer only ever tests coverage
 * against 0.5, so both still read as "there is a surface here", but TAA uses the
 * distinction to reject history on exactly the pixels whose motion no
 * matrix-difference velocity can describe. Without it a running enemy's arms and
 * legs emit zero motion and the temporal filter drags the background through
 * them — the smear on the character silhouettes.
 *
 * Velocity is computed from *unjittered* view-projection matrices for both
 * frames, so the TAA jitter never leaks into the motion vectors — which is
 * the single most common reason browser TAA implementations smear.
 *
 * Per-object previous world matrices are pushed through
 * `material.onBeforeRender`, which the renderer calls once per draw; setting
 * `uniformsNeedUpdate` forces the re-upload. This is what makes the velocity
 * buffer *per object* rather than camera-only.
 */
/** Coverage written for skinned / morphed geometry. See the class note. */
export const OW_COVERAGE_DYNAMIC = 0.7;

export class GBuffer {
  /**
   * @param {object}  [opts]
   * @param {boolean} [opts.normal=true]    write the oct-encoded view normal
   * @param {boolean} [opts.velocity=true]  write the screen-space velocity
   */
  constructor(opts = {}) {
    this.hasNormal = opts.normal !== false;
    this.hasVelocity = opts.velocity !== false;
    this.rt = null;
    this.width = 1;
    this.height = 1;
    this.prev = new Map();
    this._seen = new Set();

    // Attachment order is fixed; the *locations* close up around whatever is
    // switched off, because GLSL output locations have to be contiguous from 0.
    let loc = 0;
    this._locNormal = this.hasNormal ? loc++ : -1;
    this._locVelocity = this.hasVelocity ? loc++ : -1;
    this._locDepth = loc++;
    this._count = loc;

    const N = this.hasNormal;
    const V = this.hasVelocity;

    this.material = new THREE.ShaderMaterial({
      name: `ow-prepass${N ? '-n' : ''}${V ? '-v' : ''}`,
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
      uniforms: {
        owPrevModelMatrix: { value: new THREE.Matrix4() },
        owCurrVP: { value: new THREE.Matrix4() },
        owPrevVP: { value: new THREE.Matrix4() },
        owMatId: { value: 0 },
        owCoverage: { value: 1 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <batching_pars_vertex>
        #include <skinning_pars_vertex>
        #include <morphtarget_pars_vertex>

        ${V ? 'uniform mat4 owPrevModelMatrix;\nuniform mat4 owCurrVP;\nuniform mat4 owPrevVP;' : ''}

        ${N ? 'varying vec3 vNrm;' : ''}
        ${V ? 'varying vec4 vCurrClip;\nvarying vec4 vPrevClip;' : ''}
        varying float vViewDepth;

        void main() {
          #include <batching_vertex>
          ${N ? '#include <beginnormal_vertex>' : ''}
          #include <morphinstance_vertex>
          ${N ? '#include <morphnormal_vertex>' : ''}
          #include <skinbase_vertex>
          ${N ? '#include <skinnormal_vertex>' : ''}
          ${N ? '#include <defaultnormal_vertex>' : ''}
          #include <begin_vertex>
          #include <morphtarget_vertex>
          #include <skinning_vertex>
          #include <project_vertex>

          ${N ? 'vNrm = transformedNormal;' : ''}
          vViewDepth = -mvPosition.z;

          ${
            V
              ? `vec4 objPos = vec4( transformed, 1.0 );
          #ifdef USE_BATCHING
            objPos = batchingMatrix * objPos;
          #endif
          #ifdef USE_INSTANCING
            objPos = instanceMatrix * objPos;
          #endif
          vCurrClip = owCurrVP * ( modelMatrix * objPos );
          vPrevClip = owPrevVP * ( owPrevModelMatrix * objPos );`
              : ''
          }
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${COMMON}
        ${N ? 'uniform float owMatId;\nuniform float owCoverage;' : ''}

        ${N ? 'varying vec3 vNrm;' : ''}
        ${V ? 'varying vec4 vCurrClip;\nvarying vec4 vPrevClip;' : ''}
        varying float vViewDepth;

        ${N ? `layout(location = ${this._locNormal}) out vec4 gNormal;` : ''}
        ${V ? `layout(location = ${this._locVelocity}) out vec4 gVelocity;` : ''}
        layout(location = ${this._locDepth}) out vec4 gDepth;

        void main() {
          ${
            N
              ? `vec3 n = normalize( vNrm );
          if ( !gl_FrontFacing ) n = -n;
          gNormal = vec4( owEncodeNormal( n ), owCoverage, owMatId );`
              : ''
          }

          ${
            V
              ? `vec2 a = vCurrClip.xy / max( 1e-6, vCurrClip.w );
          vec2 b = vPrevClip.xy / max( 1e-6, vPrevClip.w );
          gVelocity = vec4( ( a - b ) * 0.5, 0.0, 0.0 );`
              : ''
          }

          gDepth = vec4( vViewDepth, 0.0, 0.0, 0.0 );
        }
      `,
    });

    // Nothing to feed per draw when neither the normal nor the velocity output
    // exists: `owMatId`/`owCoverage` are normal-buffer channels and
    // `owPrevModelMatrix` is the velocity difference. Leaving the hook installed
    // would still force a uniform re-upload on every one of ~1300 draws.
    if (this.hasNormal || this.hasVelocity) {
      this.material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
        const u = this.material.uniforms;
        if (this.hasVelocity) {
          const p = this.prev.get(object.id);
          if (p !== undefined) u.owPrevModelMatrix.value.copy(p);
          else u.owPrevModelMatrix.value.copy(object.matrixWorld);
        }
        if (this.hasNormal) {
          u.owMatId.value = object.userData !== undefined ? object.userData.owMatId || 0 : 0;
          // Skinned and morphed geometry deforms *inside* its transform, so the
          // matrix difference above describes none of the motion its pixels
          // actually have. Flag it so TAA can reject history there instead of
          // smearing.
          u.owCoverage.value =
            object.isSkinnedMesh === true ||
            (object.morphTargetInfluences !== undefined && object.morphTargetInfluences !== null)
              ? OW_COVERAGE_DYNAMIC
              : 1;
        }
        this.material.uniformsNeedUpdate = true;
      };
    }
  }

  setSize(w, h) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (this.rt && this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;
    if (this.rt) this.rt.dispose();

    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: this._count,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    if (this.hasNormal) rt.textures[this._locNormal].name = 'gb-normal';
    if (this.hasVelocity) {
      const v = rt.textures[this._locVelocity];
      v.format = THREE.RGFormat;
      v.type = THREE.HalfFloatType;
      v.name = 'gb-velocity';
    }
    const d = rt.textures[this._locDepth];
    d.format = THREE.RedFormat;
    d.type = THREE.FloatType;
    d.name = 'gb-depth';

    for (const t of rt.textures) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    }

    this.rt = rt;
  }

  get normalTexture() {
    return this.hasNormal ? this.rt.textures[this._locNormal] : null;
  }
  get velocityTexture() {
    return this.hasVelocity ? this.rt.textures[this._locVelocity] : null;
  }
  get depthTexture() {
    return this.rt.textures[this._locDepth];
  }

  /**
   * @param {boolean} clear  clear colour+depth (world pass) or depth only
   *                         (viewmodel pass, composited over the same buffer)
   */
  render(renderer, scene, camera, currVP, prevVP, clear) {
    if (this.hasVelocity) {
      const u = this.material.uniforms;
      u.owCurrVP.value.copy(currVP);
      u.owPrevVP.value.copy(prevVP);
    }

    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.material;
    renderer.setRenderTarget(this.rt);
    if (clear) renderer.clear(true, true, false);
    else renderer.clear(false, true, false);
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
  }

  beginRecord() {
    this._seen.clear();
  }

  /**
   * Remember this frame's transforms so next frame can difference them.
   * Pure bookkeeping for the velocity output — a Map probe, a possible
   * allocation and a 16-float copy for each of ~1300 draws — so it is skipped
   * outright when nothing consumes velocity.
   */
  recordMatrices(objects, count) {
    if (!this.hasVelocity) return;
    for (let i = 0; i < count; i++) {
      const o = objects[i];
      this._seen.add(o.id);
      let m = this.prev.get(o.id);
      if (m === undefined) {
        m = new THREE.Matrix4();
        this.prev.set(o.id, m);
      }
      m.copy(o.matrixWorld);
    }
  }

  /** Drop entries for objects that went away, so the map cannot grow forever. */
  endRecord() {
    if (this.prev.size > this._seen.size * 2 + 64) {
      for (const id of this.prev.keys()) if (!this._seen.has(id)) this.prev.delete(id);
    }
  }

  dispose() {
    if (this.rt) this.rt.dispose();
    this.material.dispose();
    this.prev.clear();
  }
}
