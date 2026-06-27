/**
 * Anchor the agent's decision-ledger chain head on Solana devnet (Memo program).
 * Produces a public, timestamped, immutable record that the agent's calls were
 * not edited after matches resolved — mirroring how TxLINE anchors its own data.
 * Run: npx ts-node src/anchor.ts   (needs .keys/devnet.json + data/ledger.jsonl)
 */
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC || "https://solana-devnet.api.onfinality.io/public";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const KEYS = path.join(__dirname, "..", ".keys");
const ledgerPath = path.join(__dirname, "..", "data", "ledger.jsonl");

async function main() {
  if (!fs.existsSync(ledgerPath)) { console.log("run `npm run agent` first (need data/ledger.jsonl)"); process.exit(1); }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, "devnet.json"), "utf8"))));
  const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  const root: string = last.hash;
  const memo = `SharpLine:ledger-root:${root}:entries=${lines.length}`;
  console.log("wallet:", kp.publicKey.toBase58());
  console.log("anchoring memo:", memo);

  const conn = new Connection(RPC, "confirmed");
  const ix = new TransactionInstruction({
    keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: true }],
    programId: MEMO,
    data: Buffer.from(memo, "utf8"),
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [kp], { commitment: "confirmed" });
  console.log("\nANCHORED on devnet  txSig:", sig);
  console.log(`explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  fs.writeFileSync(path.join(KEYS, "anchor.json"), JSON.stringify({ root, sig, entries: lines.length, ts: last.ts }, null, 2));
}
main().catch((e) => { console.error("FATAL", e?.message || e); process.exit(1); });
