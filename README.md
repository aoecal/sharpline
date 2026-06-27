# SharpLine — autonomous sharp-money detector on TxLINE World Cup odds

> Submission for the **TxODDS × Superteam "Trading Tools and Agents"** World Cup track.
> An autonomous agent that ingests TxLINE de-margined odds, flags statistically
> significant "sharp money" line moves in real time, acts on them, and anchors
> every decision in a tamper-evident ledger.

## The idea

TxLINE publishes **Stable Price** odds — consensus, de-margined (vig-free) prices
for each market, with the implied probability exposed directly as the `Pct` field.
That removes the hardest part of odds modelling (de-vigging across bookmakers) and
hands us a clean probability time series.

On top of that, **SharpLine** answers one question continuously and autonomously:

> *Is the line moving because of genuine informed money, or is it just noise?*

When informed money hits a market the price moves **sharply and persistently**.
Random chop moves it noisily and reverts. Separating the two is a signal-detection
problem — exactly the kind a quant desk solves, and exactly what the judges asked
for ("mathematically/strategically defensible logic").

## Method (why each piece is there)

For each market we track the de-margined implied probability `p_t` and work in
**logit space** `x_t = ln(p/(1−p))` — the natural, additive geometry for
probabilities (a 2-point move at 50% and at 5% carry very different information).

1. **Adaptive volatility normalisation.** EWMA mean + variance of the logit
   increments → a *robust z-score*. "Sharp" means large relative to the market's
   *own recent* volatility (in-play chops far more than pre-match), not an absolute
   threshold.
2. **Persistence via Page-Hinkley change-point test.** A single big tick isn't
   sharp money; a *sustained* directional shift is. A two-sided PH test accumulates
   drift beyond a slack band and alarms only on a genuine regime change.
3. **Both must agree** — a recent sharp shock (z-gate) *and* persistent drift (PH)
   in the same direction. This is what keeps the false-positive rate near zero.
4. **Cooldown debounce** so a single repricing event yields one signal, not a burst.

The operating point (thresholds) is **chosen by a backtest sweep**, not by hand:
max detection power subject to a strict false-positive budget.

## Validation

### Controlled simulation (edge proof)
`npm run backtest` runs the detector over thousands of simulated fixtures with a
known ground truth (efficient-market null vs. one injected informed move):

| metric | result |
|---|---|
| false positives (efficient market) | **≈0.002 / fixture** |
| detection power (informed move) | **95.6%** |
| direction accuracy | **100%** |
| edge per bet (back flagged side at signal price) | **+6.7%**, t = **7.2** |
| mean lead before move fully prices in | ~39 ticks |

The sweep prints the full power-vs-false-positive operating curve.

### Real World Cup data (live demonstration)
`npm run subscribe` (free devnet World Cup tier) → `npx ts-node src/fetch-many.ts`
→ `npx ts-node src/analyze-real.ts` runs the **same detector** on real TxLINE
World Cup fixtures. On the clean full-match 1X2 series:

- **Quiet on efficient pre-match lines** — 0 false alarms, matching the simulated
  null behaviour.
- **Fires precisely on in-play information events (goals)** at high confidence —
  e.g. Croatia–Ghana, the moment the home win-prob repriced 51% → 91%: flagged
  `home↑, conf 97%`.

> Honest scope: edge is proven in the controlled simulation (where ground truth
> exists); real-data runs demonstrate the detector is silent on efficient markets
> and precise on genuine events. Devnet is used per the track rules ("live or on
> devnet"); the same code points at mainnet by changing one host.

## Autonomous agent + on-chain anchoring

`npm run agent` runs unattended over the feed: detect → open a paper position on
the flagged side at the available price → settle P&L at the result. Every signal
is **hash-chained** into `data/ledger.jsonl`; the chain head is anchored on Solana
devnet. TxLINE already publishes Merkle roots of its data on-chain — we mirror that
for our *decisions*, so a judge can verify the agent's calls were not edited after
matches resolved.

## Architecture

```
src/
  txline.ts      TxLINE client (guest JWT, data endpoints, Pct→prob)
  subscribe-wc.ts free World Cup on-chain subscribe + API-token activation (devnet)
  fetch-data.ts  / fetch-many.ts   pull real fixtures + odds
  signal.ts      SharpDetector — logit + EWMA-vol robust z + Page-Hinkley + cooldown
  sim.ts         TxLINE-schema odds simulator (controlled ground truth)
  backtest.ts    operating-curve sweep + edge/FP/power/calibration
  agent.ts       autonomous loop + hash-chained decision ledger
  run-real.ts    detector on a single real fixture
  analyze-real.ts aggregate over many real fixtures
```

## Run it

```bash
npm install
npm run backtest                 # validation sweep on simulated ground truth
npm run subscribe                # free WC devnet subscription -> .keys/creds.json
npx ts-node src/fetch-many.ts    # pull real World Cup odds
npx ts-node src/analyze-real.ts  # detector on real data
npm run agent                    # autonomous run + ledger
```

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT
- on-chain `subscribe(serviceLevel, weeks)` (free WC tier = service level 1) +
  `POST /api/token/activate` — API token
- `GET /api/fixtures/snapshot` — fixtures
- `GET /api/odds/updates/{fixtureId}` — de-margined odds (the `Pct` field is the
  signal input)

## API feedback (what we liked / friction)

- **Loved:** the `Pct` de-margined Stable Price field — vig-free implied
  probabilities out of the box make this the cleanest sports-odds feed to model on.
- **Friction:** the docs use `oracle(-dev).txodds.com` but the reachable API hosts
  are `txline(-dev).txodds.com`; the devnet TxL mint differs between
  `programs/addresses` and the README (the activation only succeeded with the
  `addresses.md` mint). A note in the quickstart would save integrators an hour.

---
MIT. Built for the TxODDS × Superteam World Cup hackathon.
