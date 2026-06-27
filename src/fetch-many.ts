/** Pull odds for several real World Cup fixtures into data/. Run: npx ts-node src/fetch-many.ts */
import * as fs from "fs";
import * as path from "path";
import axios from "axios";

const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".keys", "creds.json"), "utf8"));
const http = axios.create({
  baseURL: creds.host,
  timeout: 90000,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.jwt}`, "X-Api-Token": creds.apiToken },
});
const LIMIT = Number(process.env.LIMIT || 6);

async function main() {
  const fx = (await http.get("/api/fixtures/snapshot")).data;
  fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  let saved = 0;
  for (const f of fx) {
    if (saved >= LIMIT) break;
    try {
      const rows = (await http.get(`/api/odds/updates/${f.FixtureId}`)).data;
      if (Array.isArray(rows) && rows.length) {
        fs.writeFileSync(path.join(__dirname, "..", "data", `odds-${f.FixtureId}.json`), JSON.stringify(rows));
        console.log(`saved ${f.FixtureId}  ${f.Participant1} v ${f.Participant2}: ${rows.length} rows`);
        saved++;
      }
    } catch (e: any) {
      console.log(`skip ${f.FixtureId}: ${e.response?.status || e.message}`);
    }
  }
  console.log(`saved ${saved} fixtures`);
}
main().catch((e) => console.error("FATAL", e?.response?.status || e.message));
