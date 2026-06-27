/**
 * Minimal TxLINE (TxODDS Oracle) client.
 *
 * Two data tiers matter for us:
 *  1. GUEST free tier  — `/api/guest/odds/*` needs ONLY a guest JWT (no wallet,
 *     no on-chain subscribe). De-margined ("Stable Price") odds, 60s delay,
 *     for the 9 European competitions below. We use this to prove the pipeline
 *     and to develop/backtest the signal engine on real data immediately.
 *  2. WORLD CUP free tier — service level 1 (60s delay) / 12 (real-time) needs a
 *     free on-chain `subscribe` tx (devnet, throwaway keypair) + activation.
 *     Wired separately in subscribe-wc.ts.
 *
 * Hosts: oracle.txodds.com (mainnet/prod), oracle-dev.txodds.com (devnet).
 */
import axios, { AxiosInstance } from "axios";

// NOTE: the official examples use oracle(-dev).txodds.com, but those hosts fail
// the TLS handshake from our network. txline(-dev).txodds.com are the equivalent,
// reachable API hosts (verified: guest auth returns a valid JWT). Override via TXLINE_HOST.
export const HOSTS = {
  mainnet: "https://txline.txodds.com",
  devnet: "https://txline-dev.txodds.com",
} as const;

/** Guest free-tier de-margined odds coverage (JWT-only, 60s delay). */
export const GUEST_COMPETITIONS: Record<number, string> = {
  7: "La Liga (Spain)",
  8: "Premier League (England)",
  9: "Bundesliga (Germany)",
  10: "UEFA Champions League",
  13: "Serie A (Italy)",
  16: "Ligue 1 (France)",
  18: "UEFA Europa League",
  26: "Serie A (Brazil)",
  87: "Liga Profesional (Argentina)",
};

/** One odds offer for a fixture/market from a bookmaker at time Ts. */
export interface OddsPayload {
  FixtureId: number;
  MessageId: string;
  Ts: number; // epoch (ms or s — detect at runtime)
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string; // e.g. "Match Odds", "Over/Under", "Asian Handicap"
  GameState?: string;
  InRunning: boolean; // true = in-play (live), false = pre-match
  MarketParameters?: string; // e.g. handicap/total line value
  MarketPeriod?: string;
  PriceNames?: string[]; // e.g. ["1","X","2"] or ["Over","Under"]
  Prices?: number[]; // raw decimal odds * 1000 (3dp fixed point)
  /** De-margined implied probability %, 3dp string, or "NA" for quarter lines. */
  Pct?: string[];
}

export class TxlineClient {
  http: AxiosInstance;
  jwt?: string;
  apiToken?: string;

  constructor(public host: string = HOSTS.mainnet) {
    this.http = axios.create({
      baseURL: host,
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** POST /auth/guest/start -> anonymous JWT (30-day expiry). */
  async startGuest(): Promise<string> {
    const r = await this.http.post("/auth/guest/start");
    this.jwt = (r.data && (r.data.token ?? r.data)) as string;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.jwt}`;
    return this.jwt;
  }

  setApiToken(t: string) {
    this.apiToken = t;
    this.http.defaults.headers.common["X-Api-Token"] = t;
  }

  /** Guest free-tier odds snapshot (JWT only). */
  async guestOddsSnapshot(params?: Record<string, any>): Promise<OddsPayload[]> {
    const r = await this.http.get("/api/guest/odds/snapshot", { params });
    return r.data as OddsPayload[];
  }

  /** Paid/subscribed: live odds for one fixture (needs JWT + X-Api-Token). */
  async oddsUpdates(fixtureId: number): Promise<OddsPayload[]> {
    const r = await this.http.get(`/api/odds/updates/${fixtureId}`);
    return r.data as OddsPayload[];
  }
}

/** Parse a Pct string ("52.632" or "NA") to a probability in [0,1], or null. */
export function pctToProb(pct: string | undefined): number | null {
  if (!pct || pct === "NA") return null;
  const v = Number(pct);
  return Number.isFinite(v) ? v / 100 : null;
}
