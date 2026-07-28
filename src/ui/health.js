import { el, setText, setStyle, setClass, clamp01, damp, ease, lerp } from './util.js';

/**
 * Health feedback: the screen-space hurt state *and* the vitals widget.
 *
 *   0-25% hurt   nothing but a faint edge darkening
 *   25-60%       blood vignette blooms in, world desaturates
 *   60-100%      heartbeat pulses the vignette, saturation drops hard
 *   on hit       a 180ms directional-agnostic red flash
 *   regen        vignette breathes out over ~2s and saturation returns
 *
 * THE SCREEN-SPACE PART IS NOT DOM ANY MORE. It used to be five stacked
 * full-screen layers: a `backdrop-filter` for the desaturation, two gradients
 * pushed through an feTurbulence/feDisplacementMap SVG filter for the blood
 * vignette, and two `mix-blend-mode` layers for the heartbeat ring and the hit
 * flash. Every one of those reads the pixels *underneath* it, and what is
 * underneath is a canvas that redraws every frame — so none of them could ever
 * be cached in a composited layer. The browser had to read back the whole
 * framebuffer, run a filter graph over it and recomposite, on every frame, for
 * as long as the player was hurt, which is most of a firefight.
 *
 * All four amounts are now published as plain numbers (`desatA`, `bloodA`,
 * `flashA`, `beatA`) and pushed into the render composite by `src/ui/index.js`
 * via `RenderSystem.setHurt`, where they are a handful of ALU ops on a value the
 * pass already has in a register. The organic vignette edge — which is the whole
 * reason the DOM version paid for a turbulence filter, because a clean radial
 * ramp is the single most "WebGL demo" thing a hurt overlay can do — is
 * reproduced there with two octaves of value noise.
 *
 * The vitals widget lives in the bottom-LEFT of the safe area — the mirror of
 * the ammo block — because it holds the most important number on the screen and
 * it has to be findable. It was previously a 90px unlabelled 4-segment bar dead
 * centre bottom, half behind the viewmodel sleeve, with a track so faint it
 * vanished over gravel: it read as leftover debug UI. Now: label, numeric
 * readout, a genuinely dark track behind the empty segments, and a visually
 * distinct armour row underneath.
 *
 * @param {HTMLElement} chrome  layer for the widget (fades with the HUD)
 */
export class HealthFx {
  constructor(chrome) {
    // ---- vitals widget ----------------------------------------------------
    this.vitals = el('div', 'ow-vitals', chrome);
    const head = el('div', 'ow-vt-head', this.vitals);
    el('div', 'ow-vt-lbl', head, 'Health');
    this.hpNum = el('div', 'ow-vt-num', head);
    this.hpVal = el('span', null, this.hpNum, '100');
    this.hpMax = el('i', null, this.hpNum, '/100');
    const track = el('div', 'ow-vt-track', this.vitals);
    this.hpFill = el('i', null, track);
    el('u', null, track); // segment dividers, drawn over the fill

    this.armour = el('div', 'ow-armour', this.vitals);
    el('div', 'ow-vt-lbl', this.armour, 'Armour');
    const plates = el('div', 'ow-arm-plates', this.armour);
    this.plates = new Array(3);
    for (let i = 0; i < 3; i++) {
      const p = el('div', 'ow-plate', plates);
      this.plates[i] = el('i', null, p);
    }

    this.hpShown = 1;
    this._lastHp = -1;
    this.hurt = 0;
    this.flashT = 1;
    this.beatPhase = 0;
    this.beatEnergy = 0;
    this.regenT = 1;
    this.armourShown = 0;
    this._lastBeat = 0;
    this.onBeat = null; // set by index for the audio cue

    /**
     * Screen-space hurt amounts, 0..1, read once a frame by `src/ui/index.js`
     * and handed to `RenderSystem.setHurt`. All four at zero is the exact no-op
     * path in the composite shader.
     */
    this.desatA = 0;
    this.bloodA = 0;
    this.flashA = 0;
    this.beatA = 0;
  }

  onDamage(intensity = 1) {
    this.flashT = 0;
    this.flashPeak = 0.35 + 0.65 * clamp01(intensity);
  }

  onRegenStart() {
    this.regenT = 0;
  }

  /** @param {object} s { health, maxHealth, armour, maxArmour, regen:bool } */
  update(dt, s) {
    const h = clamp01((s.health ?? 100) / (s.maxHealth || 100));
    const targetHurt = clamp01((0.78 - h) / 0.78) ** 1.3;
    this.hurt = damp(this.hurt, targetHurt, 7, dt);
    const hurt = this.hurt;

    // --- heartbeat --------------------------------------------------------
    const beatIntensity = clamp01((0.5 - h) / 0.5);
    if (beatIntensity > 0.02) {
      const hz = lerp(1.15, 2.35, beatIntensity);
      this.beatPhase += dt * hz;
      const p = this.beatPhase % 1;
      // systole + weaker diastole
      const thump =
        Math.exp(-((p / 0.085) ** 2)) + 0.55 * Math.exp(-(((p - 0.235) / 0.1) ** 2));
      this.beatEnergy = thump * beatIntensity;
      const beatIndex = Math.floor(this.beatPhase);
      if (beatIndex !== this._lastBeat) {
        this._lastBeat = beatIndex;
        this.onBeat?.(beatIntensity);
      }
    } else {
      this.beatEnergy = damp(this.beatEnergy, 0, 6, dt);
      this.beatPhase = 0;
    }

    // --- regeneration breath ---------------------------------------------
    if (this.regenT < 1) this.regenT = Math.min(1, this.regenT + dt / 1.8);

    // --- screen-space amounts, published to the render composite ----------
    this.bloodA = clamp01(hurt * 1.05 + this.beatEnergy * 0.16);
    this.beatA = clamp01(this.beatEnergy * 0.55);
    this.desatA = clamp01(hurt * 0.8);
    if (this.flashT < 1) {
      this.flashT = Math.min(1, this.flashT + dt / 0.19);
      this.flashA = clamp01((this.flashPeak ?? 1) * (1 - ease.outQuad(this.flashT)) * 0.8);
    } else {
      this.flashA = 0;
    }

    // --- vitals readout ---------------------------------------------------
    const maxH = s.maxHealth || 100;
    const hp = Math.max(0, Math.min(maxH, s.health ?? maxH));
    // the bar chases the value so a burst reads as a slide, not a jump; the
    // numeral is the truth and updates immediately
    this.hpShown = damp(this.hpShown, h, 16, dt);
    setStyle(this.hpFill, 'transform', `scaleX(${clamp01(this.hpShown).toFixed(4)})`);
    const shownHp = Math.round(hp);
    if (shownHp !== this._lastHp) {
      this._lastHp = shownHp;
      setText(this.hpVal, shownHp);
      setText(this.hpMax, '/' + Math.round(maxH));
    }
    setClass(this.vitals, 'low', h <= 0.55 && h > 0.28);
    setClass(this.vitals, 'crit', h <= 0.28);
    // the numeral pulses on the same heartbeat as the vignette
    setStyle(this.hpNum, 'transform', `scale(${(1 + this.beatEnergy * 0.05).toFixed(3)})`);

    // --- armour plates ----------------------------------------------------
    const maxA = s.maxArmour || 150;
    const armour = Math.max(0, s.armour ?? 0);
    this.armourShown = damp(this.armourShown, armour > 0 ? 1 : 0, 10, dt);
    setStyle(this.armour, 'opacity', this.armourShown.toFixed(3));
    setStyle(this.armour, 'display', this.armourShown < 0.01 ? 'none' : '');
    if (this.armourShown > 0.01) {
      const per = maxA / 3;
      for (let i = 0; i < 3; i++) {
        const f = clamp01((armour - i * per) / per);
        setStyle(this.plates[i], 'transform', `scaleX(${f.toFixed(3)})`);
        setStyle(this.plates[i], 'opacity', f > 0.001 ? '1' : '0');
      }
    }
  }

  dispose() {
    this.vitals.remove();
  }
}
