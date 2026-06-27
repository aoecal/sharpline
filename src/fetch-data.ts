/**
 * Pull REAL TxLINE data using the activated API token (.keys/creds.json).
 * Discovers available fixtures + odds and dumps a sample for the signal engine.
 * Run: npx ts-node src/fetch-data.ts
 */
import * as fs from "fs";
import * as path from "path";
import axios from "axios";

const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".keys", "creds.json"), "utf8"));
const http = axios.create({
  baseURL: creds.host,
  timeout: 30000,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.jwt}`, "X-Api-Token": creds.apiToken },
});

async function tryGet(p: string, params?: any): Promise<any> {
  try {
    const r = await http.get(p, { params });
    const n = Array.isArray(r.data) ? `${r.data.length} rows` : typeof r.data;
    console.log(`OK  GET ${p} ${params ? JSON.stringify(params) : ""} -> ${n}`);
    return r.data;
  } catch (e: any) {
    const b = e.response?.data ? JSON.stringify(e.response.data).slice(0, 160) : e.message;
    console.log(`ERR GET ${p} ${params ? JSON.stringify(params) : ""} -> ${e.response?.status ?? ""} ${b}`);
    return null;
  }
}

async function main() {
  console.log("host", creds.host, "| SL", creds.serviceLevel, "| token", String(creds.apiToken).slice(0, 24), "…\n");

  const fx = await tryGet("/api/fixtures/snapshot");
  if (Array.isArray(fx) && fx.length) {
    const comps: Record<string, number> = {};
    for (const f of fx) {
      const k = `${f.Competition ?? "?"} (${f.CompetitionId})`;
      comps[k] = (comps[k] || 0) + 1;
    }
    console.log("\ncompetitions:");
    Object.entries(comps).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`  ${k}: ${n}`));
    console.log("\nsample fixtures:");
    fx.slice(0, 6).forEach((f: any) =>
      console.log(`  ${f.FixtureId} | ${f.Participant1} vs ${f.Participant2} | start ${f.StartTime}`)
    );

    // try odds for the first few fixtures via the documented endpoints
    for (const f of fx.slice(0, 4)) {
      const fid = f.FixtureId;
      console.log(`\n-- odds for fixture ${fid} (${f.Participant1} v ${f.Participant2}) --`);
      let data = await tryGet(`/api/odds/updates/${fid}`);
      if (!Array.isArray(data) || !data.length) data = await tryGet(`/api/odds/snapshot`, { fixtureId: fid });
      if (Array.isArray(data) && data.length) {
        console.log(`  got ${data.length} odds rows; sample:`);
        for (const o of data.slice(0, 3)) {
          console.log(`   ${o.Bookmaker} | ${o.SuperOddsType} ${o.MarketParameters ?? ""} | inRun=${o.InRunning} | ${(o.PriceNames || []).map((nm: string, i: number) => `${nm}=${o.Pct?.[i]}%`).join(" ")}`);
        }
        fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
        fs.writeFileSync(path.join(__dirname, "..", "data", `odds-${fid}.json`), JSON.stringify(data, null, 1));
        console.log(`  saved data/odds-${fid}.json`);
        break;
      }
    }
  }
  console.log("\ndone.");
}

main().catch((e) => console.error("FATAL", e?.response?.status, e?.response?.data || e.message));
