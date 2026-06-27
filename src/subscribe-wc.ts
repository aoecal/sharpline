/**
 * Devnet World Cup free-tier subscription + API-token activation.
 * Self-serve: generates a throwaway devnet keypair, airdrops SOL, runs the free
 * on-chain `subscribe` (service level 1 = World Cup & Int Friendlies, 0 TxL),
 * then activates an API token. Saves creds to .keys/creds.json.
 *
 * The hackathon explicitly allows "live or on devnet". Zero cost, no real wallet.
 * Run: npm run subscribe
 */
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idlJson from "./idl/txoracle.json";
import { HOSTS } from "./txline";

const DEVNET_PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
// Two conflicting devnet mints are documented; try both.
const DEVNET_MINT_CANDIDATES = [
  "GYdhNurtx2EgiTPRHVGuFWKHPycdpUqgedVkwEVUWVTC", // README.md (newer)
  "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG", // addresses.md
];
// api.devnet.solana.com is TLS-blocked from our network; onfinality public devnet is reachable.
const RPC = process.env.SOLANA_RPC || "https://solana-devnet.api.onfinality.io/public";
const API_HOST = process.env.TXLINE_HOST || HOSTS.devnet;
const SERVICE_LEVEL_ID = Number(process.env.SERVICE_LEVEL || 1); // 1=WC 60s delay, 12=WC realtime
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES: number[] = [];
const KEYS_DIR = path.join(__dirname, "..", ".keys");

function loadOrCreateKeypair(): Keypair {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const f = path.join(KEYS_DIR, "devnet.json");
  if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)));
  console.log("generated devnet keypair:", kp.publicKey.toBase58());
  return kp;
}

async function ensureSol(conn: Connection, kp: Keypair, min = 0.3) {
  let bal = await conn.getBalance(kp.publicKey);
  console.log(`balance: ${bal / LAMPORTS_PER_SOL} SOL`);
  for (let i = 0; bal < min * LAMPORTS_PER_SOL && i < 3; i++) {
    try {
      console.log("requesting airdrop 1 SOL…");
      const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    } catch (e: any) {
      console.log("airdrop failed:", e.message?.slice(0, 160));
    }
    bal = await conn.getBalance(kp.publicKey);
    console.log(`balance: ${bal / LAMPORTS_PER_SOL} SOL`);
  }
  return bal;
}

async function main() {
  const kp = loadOrCreateKeypair();
  console.log("wallet:", kp.publicKey.toBase58(), "| host:", API_HOST, "| SL:", SERVICE_LEVEL_ID);
  const conn = new Connection(RPC, "confirmed");
  const bal = await ensureSol(conn, kp);
  if (bal === 0) {
    console.log("NO SOL — fund this devnet addr via https://faucet.solana.com :", kp.publicKey.toBase58());
    process.exit(2);
  }

  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl: any = JSON.parse(JSON.stringify(idlJson));
  idl.address = DEVNET_PROGRAM_ID;
  const program = new Program(idl, provider);

  console.log("\nguest JWT…");
  const jwt = (await axios.post(`${API_HOST}/auth/guest/start`)).data.token;
  console.log("jwt len:", jwt.length);

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], program.programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], program.programId);

  let txSig: string | null = null;
  let usedMint = "";
  for (const mintStr of DEVNET_MINT_CANDIDATES) {
    const mint = new PublicKey(mintStr);
    try {
      console.log(`\ntrying mint ${mintStr}…`);
      const userTokenAccount = await getOrCreateAssociatedTokenAccount(
        conn, kp, mint, kp.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID
      );
      const tokenTreasuryVault = getAssociatedTokenAddressSync(mint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);
      txSig = await (program.methods as any)
        .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
        .accounts({
          user: kp.publicKey,
          pricingMatrix: pricingMatrixPda,
          tokenMint: mint,
          userTokenAccount: userTokenAccount.address,
          tokenTreasuryVault,
          tokenTreasuryPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      usedMint = mintStr;
      console.log("SUBSCRIBED  txSig:", txSig);
      console.log(`explorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
      break;
    } catch (e: any) {
      console.log("  subscribe failed:", (e.message || String(e)).slice(0, 300));
    }
  }
  if (!txSig) { console.log("\nALL MINT CANDIDATES FAILED"); process.exit(3); }

  console.log("\nactivating API token…");
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const sigBytes = nacl.sign.detached(new TextEncoder().encode(messageString), kp.secretKey);
  const walletSignature = Buffer.from(sigBytes).toString("base64");
  const act = await axios.post(
    `${API_HOST}/api/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = act.data.token || act.data;
  console.log("API token:", String(apiToken).slice(0, 48), "…");

  const creds = { host: API_HOST, jwt, apiToken, txSig, mint: usedMint, serviceLevel: SERVICE_LEVEL_ID, wallet: kp.publicKey.toBase58() };
  fs.writeFileSync(path.join(KEYS_DIR, "creds.json"), JSON.stringify(creds, null, 2));
  console.log("\nsaved .keys/creds.json — ready to pull data.");
}

main().catch((e) => {
  console.error("FATAL", e?.response?.status, e?.response?.data || e?.message || e);
  process.exit(1);
});
