/**
 * TxLINE-faithful odds-path SIMULATOR (for detector validation while the live
 * feed is being wired). Emits the same shape the detector consumes: a sequence
 * of implied-probability observations for one fixture's match-odds market, plus
 * ground truth (the realised outcome and any injected informed move).
 *
 * Two regimes:
 *  - NULL fixtures: efficient market, constant fair prob, only microstructure
 *    noise. Used to measure the detector's false-positive rate.
 *  - SIGNAL fixtures: at a random tick, "informed money" arrives — the fair prob
 *    jumps (news) and the market reprices toward it over a few ticks. Used to
 *    measure detection power, direction accuracy, and downstream edge.
 *
 * Deterministic (seeded PRNG) so backtest numbers are reproducible for the demo.
 */
import { logit, invlogit } from "./signal";

// mulberry32 — small deterministic PRNG
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimFixture {
  probs: number[]; // observed market implied-prob series for the tracked outcome
  hasInformed: boolean; // did this fixture contain an injected informed move?
  informedTick: number; // tick the informed move started (-1 if none)
  informedDir: 1 | -1; // direction of the informed move (toward outcome / away)
  outcome: 0 | 1; // realised outcome of the tracked binary (1 = it happened)
  finalFair: number; // latent fair prob at settlement
}

export interface SimConfig {
  ticks: number; // observations per fixture (e.g. 80)
  noiseSd: number; // microstructure noise sd in logit space per tick
  driftSd: number; // slow fair-value random walk sd per tick
  informedJump: number; // mean size of an informed fair-value jump (logit units)
  repriceTicks: number; // how many ticks the market takes to absorb the jump
}

export const DEFAULT_SIM: SimConfig = {
  ticks: 80,
  noiseSd: 0.05,
  driftSd: 0.01,
  informedJump: 0.9,
  repriceTicks: 5,
};

/** Generate one fixture. `informed=false` -> null regime. */
export function simulateFixture(seed: number, informed: boolean, cfg: SimConfig = DEFAULT_SIM): SimFixture {
  const r = rng(seed);
  const probs: number[] = [];
  let fair = logit(0.2 + 0.6 * r()); // starting fair prob in [0.2,0.8] (logit)
  const informedTick = informed ? Math.floor(cfg.ticks * (0.3 + 0.4 * r())) : -1;
  const jumpDir: 1 | -1 = r() < 0.5 ? 1 : -1;
  const jump = informed ? jumpDir * cfg.informedJump * (0.7 + 0.6 * r()) : 0;
  let absorbed = 0;

  for (let t = 0; t < cfg.ticks; t++) {
    // slow efficient-market drift of fair value
    fair += cfg.driftSd * gauss(r);
    // informed repricing: spread the jump over repriceTicks starting at informedTick
    if (informed && t >= informedTick && absorbed < cfg.repriceTicks) {
      fair += jump / cfg.repriceTicks;
      absorbed++;
    }
    const observed = fair + cfg.noiseSd * gauss(r); // market = fair + microstructure noise
    probs.push(invlogit(observed));
  }

  const finalFair = invlogit(fair);
  const outcome: 0 | 1 = r() < finalFair ? 1 : 0; // realised from the (informed-nudged) fair prob
  return { probs, hasInformed: informed, informedTick, informedDir: jumpDir, outcome, finalFair };
}
