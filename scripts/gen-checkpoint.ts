/**
 * Generate the shipped header-tree checkpoint, and the fixture that pins it.
 *
 * The constant this prints is the anchor for every inclusion proof, so HOW it
 * is made is the trust decision. The procedure: take the root from the
 * primary server, then demand byte-identical agreement from every other
 * reachable server — including vanilla community ElectrumX servers that are
 * useless for HashMark search but run by other operators, which is exactly
 * what a corroborator should be. Any disagreement aborts with no output.
 *
 * Run: npx tsx scripts/gen-checkpoint.ts
 * Then paste the printed block into src/lib/radiant/checkpoint.ts, and the
 * fixture JSON into src/lib/radiant/__fixtures__/inclusion-proof.json.
 */
import WebSocketImpl from "ws";

import { RADIANT_MAINNET, bytesToHex, hexToBytes } from "../packages/protocol/src/index";
import { ElectrumClient } from "../src/lib/radiant/electrum";
import { parseHeader } from "../src/lib/radiant/header";
import { merkleRootFromBranch, bytesEqual, reverseBytes } from "../src/lib/radiant/merkle";

const PRIMARY = "wss://electrumx.rxd-radiant.com:50011";
const CORROBORATORS = [
  "wss://electrumx-eu.rxd-radiant.com:50011",   // same operator — availability only
  "wss://electrumx.radiantcore.org",            // independent operator
  "wss://electrumx.radiant4people.com:50022",   // independent operator
];

/** The mark the fixture pins: the first signed HashMark. */
const FIXTURE_TXID = "a1a86ab4503901af4df3d092fcf668b07c03c5cd89240fe918ae70e02e045916";
const FIXTURE_HEIGHT = 460572;

/** Deep enough that the checkpoint block itself will not reorg away. */
const SAFETY_MARGIN = 20;

async function connect(server: string): Promise<ElectrumClient> {
  const client = new ElectrumClient({
    servers: [server],
    genesisHash: RADIANT_MAINNET.genesisHash,
    webSocket: (url) => new WebSocketImpl(url) as unknown as WebSocket,
  });
  await client.connect();
  return client;
}

async function rootAt(client: ElectrumClient, cp: number): Promise<string> {
  // Any height works for fetching the root; 0 is always present.
  const raw = (await client.call("blockchain.block.header", [0, cp])) as {
    root?: string;
  };
  if (typeof raw?.root !== "string" || !/^[0-9a-f]{64}$/.test(raw.root)) {
    throw new Error("malformed root");
  }
  return raw.root;
}

async function main(): Promise<void> {
  const primary = await connect(PRIMARY);
  const tip = (await primary.call("blockchain.headers.subscribe")) as { height: number };
  const cpHeight = tip.height - SAFETY_MARGIN;
  console.log(`tip ${tip.height}, checkpoint height ${cpHeight}`);

  const root = await rootAt(primary, cpHeight);
  console.log(`${PRIMARY}\n  root ${root}`);

  let independentAgreements = 0;
  for (const server of CORROBORATORS) {
    try {
      const client = await connect(server);
      const theirs = await rootAt(client, cpHeight);
      client.close();
      const agrees = theirs === root;
      console.log(`${server}\n  root ${theirs} ${agrees ? "AGREES" : "DISAGREES"}`);
      if (!agrees) {
        console.error("\nDisagreement on the root. NOT printing a checkpoint.");
        process.exit(1);
      }
      if (!server.includes("rxd-radiant.com")) independentAgreements += 1;
    } catch (error) {
      console.log(`${server}\n  unreachable (${String(error).slice(0, 60)})`);
    }
  }
  if (independentAgreements === 0) {
    console.error(
      "\nNo INDEPENDENT operator corroborated the root. NOT printing a checkpoint.",
    );
    process.exit(1);
  }

  // Self-check: prove the fixture mark against the root we are about to ship,
  // with the same code the application will run. A checkpoint this script
  // cannot itself use is not printed.
  const merkle = await primary.call("blockchain.transaction.get_merkle", [
    FIXTURE_TXID,
    FIXTURE_HEIGHT,
  ]) as { merkle: string[]; pos: number };
  const headerProof = await primary.call("blockchain.block.header", [
    FIXTURE_HEIGHT,
    cpHeight,
  ]) as { header: string; branch: string[]; root: string };

  const header = parseHeader(hexToBytes(headerProof.header)!)!;
  const txRoot = merkleRootFromBranch(
    reverseBytes(hexToBytes(FIXTURE_TXID)!),
    merkle.merkle.map((h) => reverseBytes(hexToBytes(h)!)),
    merkle.pos,
  );
  if (!bytesEqual(txRoot, header.merkleRoot)) {
    console.error("self-check FAILED: tx branch does not land on the header root");
    process.exit(1);
  }
  const headerRoot = merkleRootFromBranch(
    header.hash,
    headerProof.branch.map((h) => reverseBytes(hexToBytes(h)!)),
    FIXTURE_HEIGHT,
  );
  if (bytesToHex(reverseBytes(headerRoot)) !== root) {
    console.error("self-check FAILED: header branch does not land on the checkpoint root");
    process.exit(1);
  }
  console.log(`\nself-check passed: ${FIXTURE_TXID.slice(0, 12)}… proves against this root`);
  console.log(`header time ${header.time}`);

  console.log(`\n--- checkpoint constant ---`);
  console.log(JSON.stringify({ height: cpHeight, root }, null, 2));
  console.log(`\n--- fixture json ---`);
  console.log(JSON.stringify({
    txid: FIXTURE_TXID,
    height: FIXTURE_HEIGHT,
    position: merkle.pos,
    txBranch: merkle.merkle,
    headerHex: headerProof.header,
    headerBranch: headerProof.branch,
    checkpoint: { height: cpHeight, root },
    expectedHeaderTime: header.time,
  }, null, 2));

  primary.close();
}

main().catch((error) => {
  console.error("ERR", String(error));
  process.exit(1);
});
