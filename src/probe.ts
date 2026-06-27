/**
 * Pipeline probe — proves we can pull REAL de-margined odds with just a guest JWT.
 * No wallet, no on-chain subscribe. This is the highest-risk assumption, verified first.
 *
 * Run: npm run probe        (defaults to mainnet/prod)
 *      TXLINE_HOST=https://oracle-dev.txodds.com npm run probe
 */
import { TxlineClient, HOSTS, GUEST_COMPETITIONS, OddsPayload } from "./txline";

const HOST = process.env.TXLINE_HOST || HOSTS.mainnet;

function summarize(rows: OddsPayload[], n = 4) {
  console.log(`    rows=${rows.length}  fixtures=${new Set(rows.map((r) => r.FixtureId)).size}`);
  for (const r of rows.slice(0, n)) {
    console.log(
      `    - fx ${r.FixtureId} | ${r.Bookmaker} | ${r.SuperOddsType} ${r.MarketParameters ?? ""} | inRun=${r.InRunning}`
    );
    if (r.PriceNames && r.Pct) {
      console.log("        " + r.PriceNames.map((nm, i) => `${nm}=${r.Pct?.[i]}%`).join("  "));
    }
  }
}

async function tryGet(c: TxlineClient, path: string, params?: any): Promise<any> {
  try {
    const r = await c.http.get(path, { params });
    const shape = Array.isArray(r.data) ? `${r.data.length} rows` : typeof r.data;
    console.log(`  OK  GET ${path} ${params ? JSON.stringify(params) : ""} -> ${shape}`);
    return r.data;
  } catch (e: any) {
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    console.log(`  ERR GET ${path} ${params ? JSON.stringify(params) : ""} -> ${e.response?.status ?? ""} ${body}`);
    return null;
  }
}

async function main() {
  console.log("TxLINE probe — host:", HOST);
  const c = new TxlineClient(HOST);

  console.log("\n[1] guest JWT  POST /auth/guest/start");
  const jwt = await c.startGuest();
  console.log(`  jwt=${jwt.slice(0, 28)}…  (len ${jwt.length})`);

  console.log("\n[2] guest odds snapshot (no params)");
  const all = await tryGet(c, "/api/guest/odds/snapshot");
  if (Array.isArray(all) && all.length) summarize(all);

  for (const cid of [8, 10, 7, 13]) {
    console.log(`\n[3] guest odds snapshot competitionId=${cid} (${GUEST_COMPETITIONS[cid]})`);
    const rows = await tryGet(c, "/api/guest/odds/snapshot", { competitionId: cid });
    if (Array.isArray(rows) && rows.length) summarize(rows);
  }

  console.log("\ndone.");
}

main().catch((e) => {
  console.error("FATAL", e?.response?.status, e?.response?.data || e?.message || e);
  process.exit(1);
});
