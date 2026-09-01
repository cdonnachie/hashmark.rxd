/**
 * Live sanity check of the Electrum client and chain adapter against a real
 * Radiant node. Not part of the test suite — the unit tests must not depend on
 * the network. Run manually with `npx tsx scripts/probe-chain.ts`.
 */
import { RADIANT_MAINNET } from "../packages/protocol/src/index";
import { RadiantChain } from "../src/lib/radiant/chain";
import { electrumScriptHash } from "../src/lib/radiant/address";
import { ElectrumClient } from "../src/lib/radiant/electrum";

const SERVERS = [
  "wss://electrumx.rxd-radiant.com:50011",
  "wss://electrumx-eu.rxd-radiant.com:50011",
];

async function main(): Promise<void> {
  const client = new ElectrumClient({
    servers: SERVERS,
    genesisHash: RADIANT_MAINNET.genesisHash,
  });
  const chain = new RadiantChain(client);

  await client.connect();
  console.log(`connected to      : ${client.connectedTo}`);
  console.log(`tip height        : ${await chain.tipHeight()}`);

  // A real mainnet transaction carrying a (non-HashMark) OP_RETURN output.
  const txid = "c662253d4e85e52ecc78573e88d286d18a197b2471625740ba445c9148e6ad52";
  const { transaction, records } = await chain.decodeTransaction(txid);
  console.log(`\ntransaction       : ${transaction.txid}`);
  console.log(`state             : ${transaction.state} (${transaction.confirmations} confs)`);
  console.log(`block time        : ${transaction.blockTime}`);
  console.log(`outputs           : ${transaction.outputs.length}`);
  for (const { index, result } of records) {
    const script = transaction.outputs.find((o) => o.index === index)!;
    console.log(
      `  vout ${index}: ${result.ok ? "HASHMARK" : result.reason}` +
        `  value=${script.value}  script=${script.scriptHex.slice(0, 32)}…`,
    );
  }

  // UTXO listing, and how many would be filtered as token-bearing.
  const scriptHash = electrumScriptHash("14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i")!;
  const utxos = await chain.listUnspent(scriptHash);
  const spendable = utxos.filter((u) => u.refs.length === 0);
  console.log(`\nUTXOs             : ${utxos.length} total, ${spendable.length} spendable (non-token)`);
  const total = spendable.reduce((sum, u) => sum + u.value, 0);
  console.log(`spendable balance : ${(total / 1e8).toFixed(8)} RXD`);

  // Digest search lives outside the node: RXinDexer's REST index, reached
  // straight from here rather than through src/lib/hashmark-index.ts, which is
  // server-only and cannot be imported by a script.
  const indexUrl = (process.env.HASHMARK_INDEX_URL ?? "").replace(/\/+$/, "");
  if (!indexUrl) {
    console.log(`\ndigest index      : HASHMARK_INDEX_URL not set — skipped`);
  } else {
    try {
      const stats = (await fetch(`${indexUrl}/hashmark/stats`).then((r) =>
        r.json(),
      )) as Record<string, unknown>;
      const hits = await fetch(
        `${indexUrl}/hashmark/${"a".repeat(64)}?algorithm=sha256&limit=20`,
      ).then((r) => r.json());
      console.log(
        `\ndigest index      : enabled=${stats["enabled"]}` +
          ` backfill_complete=${stats["backfill_complete"]}` +
          ` next_height=${stats["backfill_next_height"]}`,
      );
      console.log(
        `lookup            : ${Array.isArray(hits) ? `${hits.length} hit(s)` : "malformed response"}`,
      );
    } catch (error) {
      console.log(`\ndigest index      : unreachable — ${String(error)}`);
    }
  }

  // Rejection paths.
  for (const bad of ["nope", "A".repeat(64), "ab"]) {
    try {
      await chain.getTransaction(bad);
      console.log(`\nBUG: accepted bad txid ${bad}`);
      process.exitCode = 1;
    } catch {
      // expected
    }
  }
  console.log("\nmalformed txids rejected: yes");

  client.close();
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
