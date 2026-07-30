#!/usr/bin/env node
/**
 * Per-pixel comparison of two shot directories.
 *
 * This is the gate that enforces "no visual change" during optimisation work:
 * an optimisation is only allowed to land if every shot is pixel-identical (or
 * within an explicitly justified epsilon) to the pre-optimisation baseline.
 *
 *   node tools/imagediff.mjs --a=shots/base --b=shots/opt [--tol=1] [--write-diff]
 *
 * tol is the per-channel 0-255 delta below which a pixel counts as unchanged.
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const A = resolve(args.a), B = resolve(args.b);
const TOL = Number(args.tol ?? 0);

/**
 * `*.diff.png` is this tool's OWN output, written into B by `--write-diff`.
 * Left in the listing it compares a diff overlay against a missing file on the
 * next run, which reports a failure that is not a regression.
 */
const shotsIn = (dir) =>
  readdirSync(dir).filter((f) => f.endsWith('.png') && !f.endsWith('.diff.png')).sort();

const names = shotsIn(A);
const inB = new Set(shotsIn(B));
const rows = [];
let worst = null;

/**
 * A comparison of NOTHING is not a pass.
 *
 * `rows.every()` is vacuously true on an empty list, so with no PNGs in A this
 * printed `identical: true` and exited 0 — certifying any change at all. It is
 * reachable rather than theoretical: `tools/baseline.mjs` creates its output
 * directory before the capture loop and catches each shot's failure
 * individually, so a run where every shot throws leaves an existing-but-empty
 * directory, and the next gate blesses whatever comes after it.
 */
if (names.length === 0) {
  console.log(JSON.stringify({
    a: A, b: B, tol: TOL, identical: false, withinEpsilon: false,
    fatal: `no .png shots in --a=${A}; a comparison of nothing is not a pass`,
    worst: null, rows: [],
  }, null, 2));
  process.exit(1);
}

// A shot that exists only in B was never compared by anything: the loop below
// is driven by A's listing. Silently ignoring it means a capture that GAINED a
// shot reports a clean gate on a set it never looked at.
for (const n of inB) {
  if (!names.includes(n)) rows.push({ shot: n, status: 'MISSING_IN_A' });
}

for (const n of names) {
  const pb = join(B, n);
  if (!existsSync(pb)) { rows.push({ shot: n, status: 'MISSING_IN_B' }); continue; }
  const a = PNG.sync.read(readFileSync(join(A, n)));
  const b = PNG.sync.read(readFileSync(pb));
  if (a.width !== b.width || a.height !== b.height) {
    rows.push({ shot: n, status: 'SIZE_MISMATCH', a: `${a.width}x${a.height}`, b: `${b.width}x${b.height}` });
    continue;
  }
  let diffPx = 0, sum = 0, maxD = 0;
  const total = a.width * a.height;
  const diff = args['write-diff'] ? new PNG({ width: a.width, height: a.height }) : null;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i+1] - b.data[i+1]);
    const db = Math.abs(a.data[i+2] - b.data[i+2]);
    const d = Math.max(dr, dg, db);
    sum += d;
    if (d > maxD) maxD = d;
    const changed = d > TOL;
    if (changed) diffPx++;
    if (diff) {
      // Changed pixels in hot magenta over a dimmed original for eyeballing.
      diff.data[i]   = changed ? 255 : a.data[i] >> 2;
      diff.data[i+1] = changed ? 0   : a.data[i+1] >> 2;
      diff.data[i+2] = changed ? 255 : a.data[i+2] >> 2;
      diff.data[i+3] = 255;
    }
  }
  if (diff) writeFileSync(join(B, n.replace('.png', '.diff.png')), PNG.sync.write(diff));
  const pct = (diffPx / total) * 100;
  const row = { shot: n, changedPct: +pct.toFixed(4), maxDelta: maxD, meanDelta: +(sum / total).toFixed(3) };
  rows.push(row);
  if (!worst || pct > worst.changedPct) worst = row;
}

// `compared` is reported so a reader can tell "all five shots matched" from
// "nothing was looked at" without counting rows by eye — the distinction this
// tool used to collapse.
const compared = rows.filter((r) => r.changedPct !== undefined).length;
const identical = compared > 0 && rows.every((r) => r.changedPct === 0);
const clean =
  compared > 0 &&
  rows.every((r) => (r.changedPct ?? 100) < 0.05 && (r.maxDelta ?? 255) <= Math.max(2, TOL));
console.log(JSON.stringify({ a: A, b: B, tol: TOL, compared, identical, withinEpsilon: clean, worst, rows }, null, 2));
process.exit(clean ? 0 : 1);
