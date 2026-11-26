// token-radar-01 v7 — entrypoint.
//
// Reads the sealed snapshot, fits the model at runtime (lib/model.ts),
// writes the ranked board to <out>/board.json, the dashboard's data to
// <out>/data.js, copies dashboard/ and screenshots/ to <out>/, and writes
// <out>/dossier.json with buildDossier from vendor/makefun-board.ts.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot>
//
// Standard library only; runs on Node 22 as-is (type stripping).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildBoard, buildLedger, buildLive } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));

function parseArgs(): { input: string; outDir: string } {
  const args = process.argv.slice(2);
  let input = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && i + 1 < args.length) input = args[i + 1];
  }
  if (!input) throw new Error('usage: node main.ts --input <snapshot.json>');
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';
  return { input, outDir };
}

function copyTree(src: string, dst: string): number {
  let count = 0;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      count++;
    }
  }
  return count;
}

function main(): void {
  const { input, outDir } = parseArgs();
  const snapshot = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;

  const { rows, fit } = buildBoard(snapshot);
  const rankedSlugs = new Set(rows.map((r) => r.slug));
  const ledger = buildLedger(snapshot, rankedSlugs);
  const live = buildLive(snapshot);

  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;

  // Gate sanity: the board must be the v5 board, byte for byte.
  if (rows.length !== 198) throw new Error(`board has ${rows.length} rows, expected 198`);
  if (ledger.total !== 758) throw new Error(`ledger total is ${ledger.total}, expected 758`);

  const boardJson = JSON.stringify({ rows }) + '\n';
  const boardSha = createHash('sha256').update(boardJson).digest('hex');

  // Validation numbers (REPORT.md §3 + PLAN-v7 §3): median absolute log
  // error of ln(market cap). Full model, four held-out ways.
  const data = {
    meta: {
      as_of: snapshot.as_of,
      model: 'grouped comps curve 0.7 + ridge median 0.3, fit at runtime',
      curve: {
        intercept: fit.intercept,
        slope: fit.slope,
        global_median_residual: fit.globalMedianResidual,
      },
      validation: {
        cv_5fold: 1.3038,
        walk_forward: 1.0505,
        blind_30: 1.209,
        blind_a: 1.3189,
        blind_b: 1.405,
        note: 'median absolute log error of ln(market cap); noise floor about 1.25',
      },
      counts: {
        rows: rows.length,
        watchlist: snapshot.watchlist.length,
        comps,
        protocols: snapshot.protocols.length,
      },
    },
    rows,
    live,
    ledger,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), boardJson);
  writeFileSync(join(outDir, 'data.js'), 'window.RADAR_DATA = ' + JSON.stringify(data) + ';\n');

  const dashSrc = join(ROOT, 'dashboard');
  const shotsSrc = join(ROOT, 'screenshots');
  copyTree(dashSrc, join(outDir, 'dashboard'));
  let shots = 0;
  if (existsSync(shotsSrc)) {
    const names = readdirSync(shotsSrc).filter((f) => !f.startsWith('.') && statSync(join(shotsSrc, f)).isFile());
    if (names.length > 0) shots = copyTree(shotsSrc, join(outDir, 'screenshots'));
  }

  if (shots > 0) {
    const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
    writeFileSync(join(outDir, 'dossier.json'), dossier);
    console.log(`dossier.json: ${dossier.length} bytes`);
  } else {
    console.log('no screenshots yet — dossier.json skipped (take screenshots, then re-run)');
  }

  console.log(`rows: ${rows.length}`);
  console.log(`board.json sha256: ${boardSha}`);
  console.log(
    `ledger: ${ledger.token_trades} trades, ${ledger.token_no_cap} no-cap, ` +
      `${ledger.ranked_watchlist} watchlist, ${ledger.ranked_above_floor} above floor, ` +
      `${ledger.ranked_below_floor} below floor, ${ledger.out_bridge} bridge, ` +
      `${ledger.out_liquid_staking} liquid staking, ${ledger.out_exchange} exchange, ` +
      `${ledger.out_versioned} versioned, ${ledger.out_wrapped} wrapped — total ${ledger.total}`,
  );
  console.log(`fit: a=${fit.intercept} s=${fit.slope}`);
  console.log(`rank 1: ${rows[0].name} $${rows[0].implied_value_usd}`);
}

main();
