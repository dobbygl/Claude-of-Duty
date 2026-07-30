#!/usr/bin/env node
/**
 * Capture many named shots in a single browser session, then report render
 * stats and any console errors. This is what the visual critics review.
 *
 *   node tools/shotset.mjs --out=shots/iter-03            # all shots
 *   node tools/shotset.mjs --shots=hero,detail --out=tmp  # a subset
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const SETTLE = Number(args.settle ?? 90);
const OUTDIR = resolve(args.out ?? 'shots/latest');
/**
 * `--lockstep` runs the page as `?capture=1&lockstep=1`: the engine schedules no
 * frames of its own and this driver advances exactly SETTLE of them per shot
 * through `window.__PUMP__`. Without it the number of frames that fit inside the
 * driver's round trips is wall-clock dependent, and everything phase-locked to
 * the frame index — TAA jitter, noise rotation, auto-exposure adaptation —
 * lands somewhere slightly different on every run, which shows up as a ~65 %
 * changed-pixel / meanDelta-0.7 haze between two runs of IDENTICAL code. Use it
 * for any before/after pixel gate. See src/dev/shots.js.
 */
const LOCKSTEP = args.lockstep !== undefined && args.lockstep !== 'false' && args.lockstep !== '0';
/** `--q=mobile` selects a quality preset (main.js reads `?q=`). */
const QUALITY = typeof args.q === 'string' ? args.q : null;
const ROOT = resolve(import.meta.dirname, '..');

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    // No hot reload: a file saved mid-run (concurrent agents) would reload the
    // page and every later page.evaluate would fail with a destroyed context.
    env: { ...process.env, OW_NO_HMR: '1' },
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await portOpen(PORT);
  }
  if (!up) {
    server.kill();
    throw new Error('vite failed to start');
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--disable-frame-rate-limit',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => m.type() !== 'debug' && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

mkdirSync(OUTDIR, { recursive: true });

const report = { ok: true, outDir: OUTDIR, size: `${W}x${H}`, shots: [], errors: [] };

try {
  const query =
    `?capture=1${LOCKSTEP ? '&lockstep=1' : ''}${QUALITY ? `&q=${encodeURIComponent(QUALITY)}` : ''}`;
  await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 300000 });

  const all = await page.evaluate('Object.keys(window.__SHOTS__ ?? {})');
  const wanted = args.shots ? String(args.shots).split(',').map((s) => s.trim()) : all;

  for (const name of wanted) {
    if (!all.includes(name)) {
      report.shots.push({ shot: name, ok: false, error: 'unknown shot' });
      continue;
    }
    const before = logs.length;
    const applied = await page.evaluate(
      ({ s, settle }) => window.__APPLY_SHOT__(s, { grabFrame: settle }),
      { s: name, settle: SETTLE }
    );
    // __PUMP__ steps the engine in lockstep mode and is the same rAF wait loop
    // this used to inline when it is free-running, so the non-lockstep path is
    // unchanged.
    await page.evaluate((n) => window.__PUMP__(n), SETTLE);
    if (LOCKSTEP) await page.evaluate(() => window.__PRESENT__(2));
    const file = `${OUTDIR}/${name}.png`;
    await page.screenshot({ path: file, type: 'png' });
    const info = await page.evaluate('window.__RENDER_INFO__ ?? null');
    report.shots.push({
      shot: name,
      ok: !applied?.error,
      file,
      doc: await page.evaluate((s) => window.__SHOTS__[s]?.doc ?? '', name),
      info,
      newLogs: logs.slice(before),
    });
  }
} catch (e) {
  report.ok = false;
  report.fatal = e.message;
} finally {
  report.errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  await browser.close();
  if (server) server.kill();
}

// An unknown shot name, or a shot `__APPLY_SHOT__` refused, was pushed as a row
// with `ok: false` and then never consulted — `report.ok` was only cleared by
// the catch above, so the process exited 0 and the caller saw a successful
// capture of a set that was never taken.
if (report.shots.length === 0) {
  report.ok = false;
  report.fatal = report.fatal ?? 'no shots captured';
} else if (!report.shots.every((s) => s.ok)) {
  report.ok = false;
}

writeFileSync(`${OUTDIR}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
