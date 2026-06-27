/**
 * Sharp-movement detector for a de-margined implied-probability time series.
 *
 * Design (each choice is deliberate and defensible — see README §Method):
 *  - Work in LOGIT space. Probabilities live in (0,1); their natural geometry is
 *    additive in log-odds. A "10% -> 12%" move near 0.5 and near 0.05 are very
 *    different amounts of information; logit makes increments comparable.
 *  - Normalise by ADAPTIVE volatility. Odds chop more in-play than pre-match and
 *    more near kickoff. We track an EWMA mean+variance of logit increments and
 *    score each tick as a robust z. A "sharp" tick is one large relative to the
 *    market's *own recent* volatility, not an absolute threshold.
 *  - Require PERSISTENCE via a two-sided Page-Hinkley change-point test. A single
 *    noisy tick is not sharp money; a sustained directional shift is. PH tracks
 *    cumulative drift and alarms only when the move accumulates beyond slack.
 *  A signal fires only when BOTH fire (instantaneous shock AND persistent drift),
 *  which controls the false-positive rate (quantified in the backtest under a
 *  pure-noise null).
 */

export function logit(p: number): number {
  const e = 1e-6;
  const q = Math.min(1 - e, Math.max(e, p));
  return Math.log(q / (1 - q));
}
export function invlogit(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export interface DetectorConfig {
  lambda: number; // EWMA decay for increment mean/var and PH baseline (0..1)
  zGate: number; // minimum recent-peak robust z — ensures the move is "sharp" not just slow drift
  zScale: number; // z reference used for confidence scaling
  phDelta: number; // Page-Hinkley slack (logit units) — ignore drift below this
  phThresh: number; // Page-Hinkley alarm threshold (cumulative logit drift) — primary trigger
  zDecay: number; // per-tick decay of the running peak |z| so only recent shocks count
  cooldown: number; // min gap (in the same unit as the t passed to update) between signals — debounces bursts
  warmup: number; // updates to observe before emitting signals
}

// Operating point chosen by the backtest sweep: max detection power subject to a
// strict false-positive budget (≈0.002 false signals/fixture under the null).
export const DEFAULT_CFG: DetectorConfig = {
  lambda: 0.92,
  zGate: 1.5,
  zScale: 3.0,
  phDelta: 0.04,
  phThresh: 0.25,
  zDecay: 0.9,
  cooldown: 3, // tick-units for the simulator; real-time callers override with ms
  warmup: 10,
};

export interface Signal {
  t: number; // timestamp / tick index of the alarm
  direction: 1 | -1; // +1 = probability rising (backing this outcome), -1 = falling
  z: number; // robust z-score of the triggering increment
  dLogit: number; // size of the triggering move in logit space
  ph: number; // Page-Hinkley statistic at the alarm
  confidence: number; // 0..1 combined evidence
  level: number; // logit level at alarm (invlogit -> implied prob)
}

/** Online sharp-move detector for ONE probability series (e.g. P(home win)). */
export class SharpDetector {
  private n = 0;
  private prevX: number | null = null;
  private mInc = 0; // EWMA mean of increments
  private vInc = 1e-4; // EWMA variance of increments
  private phBaseline = 0; // EWMA baseline increment for PH
  private mTup = 0;
  private minUp = 0;
  private mTdn = 0;
  private maxDn = 0;
  private zPeak = 0; // decaying running peak of the signed robust z
  private lastFire: number | null = null;

  constructor(private cfg: DetectorConfig = DEFAULT_CFG) {}

  /** Feed one implied-probability observation. Returns a Signal on alarm. */
  update(p: number, t: number): Signal | null {
    const x = logit(p);
    this.n++;
    if (this.prevX === null) {
      this.prevX = x;
      return null;
    }
    const d = x - this.prevX;
    this.prevX = x;
    const { lambda } = this.cfg;

    // EWMA mean/variance of increments (West's online update)
    const prevM = this.mInc;
    this.mInc = lambda * this.mInc + (1 - lambda) * d;
    this.vInc = lambda * this.vInc + (1 - lambda) * (d - prevM) * (d - prevM);
    const sd = Math.sqrt(this.vInc + 1e-9);
    const z = (d - this.mInc) / sd;

    // decaying running peak of signed z — captures a recent sharp shock without
    // requiring it to land on the exact tick the persistence test alarms
    this.zPeak *= this.cfg.zDecay;
    if (Math.abs(z) > Math.abs(this.zPeak)) this.zPeak = z;

    // Two-sided Page-Hinkley on increments (detects a sustained shift in mean drift)
    this.phBaseline = lambda * this.phBaseline + (1 - lambda) * d;
    this.mTup += d - this.phBaseline - this.cfg.phDelta;
    this.minUp = Math.min(this.minUp, this.mTup);
    this.mTdn += d - this.phBaseline + this.cfg.phDelta;
    this.maxDn = Math.max(this.maxDn, this.mTdn);
    const phUp = this.mTup - this.minUp; // grows on sustained upward drift
    const phDn = this.maxDn - this.mTdn; // grows on sustained downward drift

    if (this.n < this.cfg.warmup) return null;
    if (this.lastFire !== null && t - this.lastFire < this.cfg.cooldown) return null;

    const ph = Math.max(phUp, phDn);
    const dir: 1 | -1 = phUp >= phDn ? 1 : -1;

    // Primary trigger = persistent drift (PH). Gate = a recent sharp shock in the
    // SAME direction. Both must agree -> "sharp money", not slow repricing or a blip.
    if (ph >= this.cfg.phThresh && Math.abs(this.zPeak) >= this.cfg.zGate && Math.sign(this.zPeak) === dir) {
      const zRep = this.zPeak;
      const conf = invlogit(0.5 * (Math.abs(zRep) - this.cfg.zGate) + 1.0 * (ph - this.cfg.phThresh));
      // reset accumulators after an alarm to avoid repeated firing on the same shift
      this.mTup = 0;
      this.minUp = 0;
      this.mTdn = 0;
      this.maxDn = 0;
      this.zPeak = 0;
      this.lastFire = t;
      return { t, direction: dir, z: zRep, dLogit: d, ph, confidence: conf, level: x };
    }
    return null;
  }
}
