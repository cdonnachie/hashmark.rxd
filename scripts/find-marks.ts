/**
 * Find real HashMark records on mainnet and verify them.
 *
 * Written to cross-check HashMark against an independent implementation: pyrxd
 * was built from HASHMARK_PROTOCOL.md alone and found the same marks. Two tools
 * from one document, agreeing on live chain data, is the interop evidence that
 * a shared test vector cannot give you — so this prints enough detail
 * (transaction id, digest, signer, message) for the two to be compared field by
 * field rather than just "both said valid".
 *
 * Run: npx tsx scripts/find-marks.ts [address]
 */
import { RADIANT_MAINNET, canonicalAttestationMessage } from "../packages/protocol/src/index";
import { electrumScriptHash } from "../src/lib/radiant/address";
import { ElectrumClient } from "../src/lib/radiant/electrum";
import { RadiantChain } from "../src/lib/radiant/chain";
import { verifyTransaction } from "../src/lib/verify";
import { verifyAttestation } from "../src/lib/radiant/attestation";
import { waveNamesForAddress } from "../src/lib/radiant/wave";

const SERVERS = [
  "wss://electrumx.rxd-radiant.com:50011",
  "wss://electrumx-eu.rxd-radiant.com:50011",
];

const ADDRESS = process.argv[2] ?? "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i";

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WebSocketImpl = require("ws");

  const client = new ElectrumClient({
    servers: SERVERS,
    genesisHash: RADIANT_MAINNET.genesisHash,
    webSocket: (url) => new WebSocketImpl(url) as unknown as WebSocket,
  });
  const chain = new RadiantChain(client);

  await client.connect();
  console.log(`node        : ${client.connectedTo}`);
  console.log(`tip         : ${await chain.tipHeight()}`);
  console.log(`scanning    : ${ADDRESS}\n`);

  const scriptHash = electrumScriptHash(ADDRESS);
  if (!scriptHash) throw new Error("invalid address");

  const history = await client.call<{ tx_hash: string; height: number }[]>(
    "blockchain.scripthash.get_history",
    [scriptHash],
  );
  console.log(`history     : ${history.length} transactions\n`);

  // Newest first: the test marks are recent.
  const ordered = [...history].sort((a, b) => b.height - a.height);

  let found = 0;

  for (const entry of ordered) {
    let verification;
    try {
      verification = await verifyTransaction(chain, entry.tx_hash);
    } catch {
      continue;
    }
    if (verification.marks.length === 0) continue;

    for (const mark of verification.marks) {
      found += 1;
      const r = mark.record;
      console.log("─".repeat(72));
      console.log(`MARK ${found}`);
      console.log(`  txid        : ${mark.txid}`);
      console.log(`  vout        : ${mark.outputIndex}`);
      console.log(`  height      : ${entry.height}`);
      console.log(`  confs       : ${mark.confirmations}  (${mark.state})`);
      console.log(`  blockTime   : ${mark.blockTime ?? "unconfirmed"}`);
      console.log(`  version     : ${r.version}`);
      console.log(`  algorithm   : ${r.algorithm}`);
      console.log(`  digest      : ${r.digest}`);
      console.log(`  label       : ${r.label ?? "(none)"}`);

      const signerHash160 = (r as { signerHash160?: string }).signerHash160;
      if (signerHash160 === undefined) {
        console.log(`  attestation : none (v${r.version} record)`);
        continue;
      }

      console.log(`  signer      : ${signerHash160}`);

      // The exact bytes an independent verifier must rebuild to check this.
      const message = canonicalAttestationMessage({
        genesisHash: RADIANT_MAINNET.genesisHash,
        signerHash160,
        algorithmId: r.algorithmId,
        digest: r.digest,
        ...(r.label === undefined ? {} : { label: r.label }),
      });
      console.log(`  message     : ${message}`);

      const result = verifyAttestation(r, RADIANT_MAINNET.genesisHash);
      console.log(
        `  ATTESTATION : ${result.ok ? `VALID — signed by ${result.signer}` : `INVALID (${result.reason})`}`,
      );

      if (result.ok) {
        // The signer address is derived from the record's own committed bytes,
        // so a name held by it is a name that vouched for this file.
        const names = await waveNamesForAddress(client, result.signer);
        console.log(
          `  WAVE names  : ${names.length > 0 ? names.join(", ") : "(none held by this address)"}`,
        );
      }
    }
  }

  console.log("─".repeat(72));
  console.log(`\n${found} HashMark record(s) found on mainnet.`);
  if (found === 0) {
    console.log("None on this address — pass a different one as an argument.");
  }

  client.close();
}

main().catch((error) => {
  console.error("failed:", error);
  process.exitCode = 1;
});
