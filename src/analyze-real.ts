/**
 * Aggregate the detector over MANY real World Cup fixtures (data/odds-*.json).
 * Real-data evidence for the demo:
 *  - signals split pre-match vs in-play
 *  - line-continuation hit rate: after we flag a sharp move, does the line keep
 *    going that way? (>50% => the signal leads the market — sharp money first)
 *  - pre-match directional accuracy vs the final 1X2 result (small-sample edge)
 * Run: npx ts-node src/analyze-real.ts
 */
import * as fs from "fs";
import * as path from "path";
import { SharpDetector, DEFAULT_CFG } from "./signal";
import { OddsPayload, pctToProb } from "./txline";

const cfg = { ...DEFAULT_CFG, cooldown: 120000, warmup: 12 }; // real timestamps are ms
const dir = path.join(__dirname, "..", "data");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^odds-\d+\.json$/.test(f)) : [];

function analyze(file: string) {
  const rows: OddsPayload[] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  // full-match 1X2 only (exclude half-time 1X2, which is a separate series)
  const x2 = rows.filter((r) => (r.SuperOddsType || "").includes("1X2") && !r.MarketPeriod && r.Pct && r.Pct.length >= 3);
  if (!x2.length) return null;
  const pts = x2
    .map((r) => ({ ts: Number(r.Ts), inRun: !!r.InRunning, p: [pctToProb(r.Pct![0]), pctToProb(r.Pct![1]), pctToProb(r.Pct![2])] }))
    .filter((o) => o.p.every((v) => v !== null && Number.isFinite(v))) as { ts: number; inRun: boolean; p: number[] }[];
  pts.sort((a, b) => a.ts - b.ts);
  if (pts.length < 20) return null;

  const home: { ts: number; p: number; inRun: boolean }[] = [];
  for (const o of pts) if (!home.length || Math.abs(home[home.length - 1].p - o.p[0]) > 1e-9) home.push({ ts: o.ts, p: o.p[0], inRun: o.inRun });

  const det = new SharpDetector(cfg);
  const sigs: { i: number; dir: 1 | -1; conf: number }[] = [];
  for (let i = 0; i < home.length; i++) {
    const s = det.update(home[i].p, home[i].ts);
    if (s) sigs.push({ i, dir: s.direction, conf: s.confidence });
  }
  const preSig = sigs.filter((s) => !home[s.i].inRun).length;
  const inSig = sigs.filter((s) => home[s.i].inRun).length;
  const topConf = sigs.reduce((m, s) => Math.max(m, s.conf), 0);

  let contHit = 0, contN = 0;
  const K = 10;
  for (const s of sigs) {
    const j = Math.min(home.length - 1, s.i + K);
    if (j > s.i) { contN++; if (Math.sign(home[j].p - home[s.i].p) === s.dir) contHit++; }
  }
  const last = pts[pts.length - 1].p;
  const oi = last.indexOf(Math.max(...last));
  const outcome = ["HOME", "DRAW", "AWAY"][oi];
  let preAcc = 0, preN = 0;
  for (const s of sigs) {
    if (home[s.i].inRun) continue;
    preN++;
    if ((s.dir === 1) === (oi === 0)) preAcc++;
  }
  return { id: file.replace("odds-", "").replace(".json", ""), n: home.length, preSig, inSig, topConf, contHit, contN, outcome, preAcc, preN };
}

const tot = { preSig: 0, inSig: 0, contHit: 0, contN: 0, preAcc: 0, preN: 0 };
console.log(`\nfixtures analyzed: ${files.length}  (real World Cup, devnet feed)\n`);
console.log("fixture       pts   pre  in  topConf  lineCont  result");
for (const f of files) {
  const s = analyze(f);
  if (!s) continue;
  tot.preSig += s.preSig; tot.inSig += s.inSig; tot.contHit += s.contHit; tot.contN += s.contN; tot.preAcc += s.preAcc; tot.preN += s.preN;
  const cont = s.contN ? `${(100 * s.contHit / s.contN).toFixed(0)}%` : "-";
  console.log(`${s.id.padEnd(12)} ${String(s.n).padStart(4)}  ${String(s.preSig).padStart(3)} ${String(s.inSig).padStart(3)}   ${(100 * s.topConf).toFixed(0).padStart(3)}%   ${cont.padStart(5)}   ${s.outcome}`);
}
console.log("\n=== aggregate (real World Cup data) ===");
console.log(`pre-match signals : ${tot.preSig}    in-play signals : ${tot.inSig}`);
console.log(`line-continuation hit rate : ${tot.contN ? (100 * tot.contHit / tot.contN).toFixed(1) : "-"}%  (n=${tot.contN})  — does the line keep moving our way after we fire?`);
console.log(`pre-match direction vs final 1X2 result : ${tot.preN ? (100 * tot.preAcc / tot.preN).toFixed(1) : "-"}%  (n=${tot.preN})`);
console.log("");
