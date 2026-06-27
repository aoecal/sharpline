/**
 * Autonomous sharp-money agent.
 *
 * Runs unattended over a TxLINE odds feed: maintains a per-fixture detector,
 * opens a paper position the instant a sharp move is flagged (backing the side
 * the smart money is moving toward, at the price available then), and settles
 * P&L when the match resolves. Every signal is hash-chained into a tamper-evident
 * ledger; the chain head is the value we anchor on Solana devnet once funded
 * (TxLINE publishes Merkle roots of its data on-chain; we mirror that pattern for
 * our decisions, so a judge can verify the agent's calls weren't edited after the
 * fact).
 *
 * Feed is pluggable: today a deterministic REPLAY feed (TxLINE-schema simulator);
 * swap `replayFeed` for the live SSE client once the API token is provisioned.
 *
 * Run: npm run agent           (FIXTURES=400 default)
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { SharpDetector, DEFAULT_CFG } from "./signal";
import { simulateFixture, DEFAULT_SIM } from "./sim";

interface Tick { fixtureId: number; t: number; prob: number; final?: boolean; outcome?: 0 | 1 }
interface Position { fixtureId: number; t: number; side: 1 | -1; entry: number; conf: number }
interface LedgerEntry { seq: number; ts: number; fixtureId: number; kind: "SIGNAL" | "SETTLE"; data: any; prevHash: string; hash: string }

/** Interleaved replay feed standing in for the live TxLINE SSE stream. */
function* replayFeed(M: number, seed = 42): Generator<Tick> {
  const fixtures = [] as { id: number; fx: ReturnType<typeof simulateFixture>; k: number }[];
  for (let i = 0; i < M; i++) {
    const informed = i % 3 !== 0; // ~2/3 of matches see informed flow; 1/3 efficient
    fixtures.push({ id: 7_000_000 + i, fx: simulateFixture(seed + i, informed, DEFAULT_SIM), k: 0 });
  }
  const done = new Set<number>();
  while (done.size < fixtures.length) {
    for (const f of fixtures) {
      if (done.has(f.id)) continue;
      if (f.k < f.fx.probs.length) {
        yield { fixtureId: f.id, t: f.k, prob: f.fx.probs[f.k] };
        f.k++;
      }
      if (f.k >= f.fx.probs.length) {
        done.add(f.id);
        yield { fixtureId: f.id, t: f.k, prob: f.fx.probs[f.fx.probs.length - 1], final: true, outcome: f.fx.outcome };
      }
    }
  }
}

function sha(s: string) { return crypto.createHash("sha256").update(s).digest("hex"); }

function main() {
  const M = Number(process.env.FIXTURES || 400);
  const detectors = new Map<number, SharpDetector>();
  const open = new Map<number, Position[]>();
  const ledger: LedgerEntry[] = [];
  let prevHash = "GENESIS";
  let seq = 0;
  const append = (fixtureId: number, kind: "SIGNAL" | "SETTLE", data: any, ts: number) => {
    const base = { seq: seq++, ts, fixtureId, kind, data, prevHash };
    const hash = sha(JSON.stringify(base));
    ledger.push({ ...base, hash });
    prevHash = hash;
  };

  let nSignals = 0, nPos = 0, wins = 0, pnl = 0, settled = 0;
  const signalLog: string[] = [];

  for (const tick of replayFeed(M)) {
    if (tick.final) {
      const ps = open.get(tick.fixtureId) || [];
      for (const p of ps) {
        const win = p.side === 1 ? tick.outcome! : 1 - tick.outcome!;
        const ret = win - p.entry; // unit stake, net return vs price paid
        pnl += ret; nPos++; if (win) wins++;
        append(tick.fixtureId, "SETTLE", { side: p.side, entry: +p.entry.toFixed(4), win, ret: +ret.toFixed(4) }, tick.t);
      }
      open.delete(tick.fixtureId);
      detectors.delete(tick.fixtureId);
      settled++;
      continue;
    }
    let det = detectors.get(tick.fixtureId);
    if (!det) { det = new SharpDetector(DEFAULT_CFG); detectors.set(tick.fixtureId, det); }
    const s = det.update(tick.prob, tick.t);
    if (s) {
      nSignals++;
      const entry = s.direction === 1 ? tick.prob : 1 - tick.prob; // price paid to back flagged side
      const pos: Position = { fixtureId: tick.fixtureId, t: tick.t, side: s.direction, entry, conf: s.confidence };
      if (!open.has(tick.fixtureId)) open.set(tick.fixtureId, []);
      open.get(tick.fixtureId)!.push(pos);
      append(tick.fixtureId, "SIGNAL", { t: s.t, dir: s.direction, z: +s.z.toFixed(2), ph: +s.ph.toFixed(2), conf: +s.confidence.toFixed(2), entry: +entry.toFixed(4) }, tick.t);
      if (signalLog.length < 12)
        signalLog.push(`  fx${tick.fixtureId} t=${s.t} ${s.direction === 1 ? "BACK↑" : "BACK↓"} z=${s.z.toFixed(1)} ph=${s.ph.toFixed(2)} conf=${(100 * s.confidence).toFixed(0)}% @${(100 * entry).toFixed(1)}%`);
    }
  }

  // persist the ledger
  fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  const ledgerPath = path.join(__dirname, "..", "data", "ledger.jsonl");
  fs.writeFileSync(ledgerPath, ledger.map((e) => JSON.stringify(e)).join("\n") + "\n");

  console.log("\n=== Autonomous sharp-money agent — replay run ===");
  console.log(`fixtures processed : ${settled}`);
  console.log(`sharp signals      : ${nSignals}`);
  console.log("\nfirst signals:");
  signalLog.forEach((l) => console.log(l));
  console.log("\n=== Paper P&L (1-unit stake per signal) ===");
  console.log(`positions taken    : ${nPos}`);
  console.log(`win rate           : ${(100 * wins / Math.max(1, nPos)).toFixed(1)}%`);
  console.log(`total net P&L      : ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} units`);
  console.log(`ROI / position     : ${(100 * pnl / Math.max(1, nPos)).toFixed(1)}%`);
  console.log(`\nledger entries     : ${ledger.length}  -> ${ledgerPath}`);
  console.log(`ledger chain head  : ${prevHash.slice(0, 32)}…  (anchor this on Solana devnet)`);
  console.log("");
}

main();
