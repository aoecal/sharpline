/**
 * Run the sharp-money detector on a REAL World Cup fixture's de-margined 1X2
 * implied-probability series (data pulled via fetch-data.ts).
 *
 * Run: npx ts-node src/run-real.ts data/odds-17588245.json
 */
import * as fs from "fs";
import * as path from "path";
import { SharpDetector, DEFAULT_CFG } from "./signal";
import { OddsPayload, pctToProb } from "./txline";

const file = process.argv[2] || "data/odds-17588245.json";
const rows: OddsPayload[] = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

// Keep the 1X2 result market; build the home-win (part1) implied-prob series.
// full-match 1X2 only (exclude half-time 1X2, a separate series)
const ONEX2 = rows.filter((r) => (r.SuperOddsType || "").includes("1X2") && !r.MarketPeriod && r.Pct && r.Pct.length >= 3);
console.log(`file=${file}  total rows=${rows.length}  1X2 rows=${ONEX2.length}`);
if (!ONEX2.length) { console.log("no 1X2 rows"); process.exit(0); }

// order by timestamp, extract P(home) = part1
type Pt = { ts: number; pHome: number; inRun: boolean };
const series: Pt[] = ONEX2
  .map((r) => ({ ts: Number(r.Ts), pHome: pctToProb(r.Pct![0]) ?? NaN, inRun: !!r.InRunning }))
  .filter((p) => Number.isFinite(p.pHome))
  .sort((a, b) => a.ts - b.ts);

// collapse consecutive identical prices (no information in a repeat)
const clean: Pt[] = [];
for (const p of series) if (!clean.length || Math.abs(clean[clean.length - 1].pHome - p.pHome) > 1e-9) clean.push(p);

const t0 = clean[0].ts, t1 = clean[clean.length - 1].ts;
console.log(`P(home) series: ${clean.length} distinct points over ${((t1 - t0) / 3600000).toFixed(1)}h`);
console.log(`  open ${(100 * clean[0].pHome).toFixed(1)}%  ->  close ${(100 * clean[clean.length - 1].pHome).toFixed(1)}%`);

const det = new SharpDetector(DEFAULT_CFG);
let n = 0;
let i = 0;
for (const p of clean) {
  const s = det.update(p.pHome, p.ts);
  if (s) {
    n++;
    const when = new Date(p.ts).toISOString().slice(11, 19);
    console.log(
      `  SHARP @${when} ${s.direction === 1 ? "home↑" : "home↓"} ` +
        `z=${s.z.toFixed(1)} ph=${s.ph.toFixed(2)} conf=${(100 * s.confidence).toFixed(0)}% ` +
        `| P(home)=${(100 * p.pHome).toFixed(1)}% ${p.inRun ? "(in-play)" : "(pre-match)"}`
    );
  }
  i++;
}
console.log(`\n${n} sharp-money signal(s) detected on this real World Cup fixture.`);
