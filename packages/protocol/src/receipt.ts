/**
 * The HashMark receipt: a small, versioned JSON file a user can keep alongside
 * their file.
 *
 * A receipt is **a pointer, not a proof.** Every field in it is attacker-
 * controlled — it is a text file anyone can edit. Nothing here verifies
 * anything; `validateReceipt` only establishes that the shape is well-formed
 * enough to be worth looking up. The claim becomes true or false only once the
 * referenced transaction and output have been fetched from the chain and
 * re-decoded, and that check lives in the application, not here.
 *
 * The most important field is `network`. A receipt is bound to a chain by its
 * **genesis hash**, not by the human-readable network name, so a receipt made
 * on testnet cannot be quietly read as a mainnet proof by an application whose
 * idea of "mainnet" differs.
 */

import { algorithmByName } from "./constants";

export const RECEIPT_FORMAT = "hashmark-receipt";
export const RECEIPT_VERSION = 1;

export interface NetworkInfo {
  readonly id: string;
  readonly label: string;
  /** Block 0 hash, lowercase hex — the identity of the chain itself. */
  readonly genesisHash: string;
}

/** Verified live against four independent Radiant ElectrumX servers. */
export const RADIANT_MAINNET: NetworkInfo = {
  id: "radiant-mainnet",
  label: "Radiant mainnet",
  genesisHash:
    "0000000065d8ed5d8be28d6876b3ffb660ac2a6c0ca59e437e1f7a6f4e003fb4",
};

export const RADIANT_TESTNET: NetworkInfo = {
  id: "radiant-testnet",
  label: "Radiant testnet",
  // Intentionally empty: this project has not connected to a Radiant testnet
  // node, and inventing a genesis hash would defeat the check it exists for.
  // Populate from `server.features.genesis_hash` before enabling testnet.
  genesisHash: "",
};

const NETWORKS: readonly NetworkInfo[] = [RADIANT_MAINNET, RADIANT_TESTNET];

export function networkById(id: string): NetworkInfo | undefined {
  return NETWORKS.find((network) => network.id === id);
}

export interface HashMarkReceipt {
  readonly format: typeof RECEIPT_FORMAT;
  readonly version: number;
  readonly network: string;
  readonly algorithm: string;
  readonly digest: string;
  readonly transactionId: string;
  readonly outputIndex: number;
  readonly label?: string;
  /**
   * Optional but strongly recommended: the chain's genesis hash. When present
   * it must match the named network, which stops a receipt from claiming
   * `radiant-mainnet` while pointing at some other chain's transaction id.
   */
  readonly genesisHash?: string;
  /**
   * Optional: the signer the reader should **expect**.
   *
   * Named for what it is. A receipt states an expectation; the chain decides
   * whether it is met, and the chain wins. A receipt naming a signer the record
   * does not commit to is a disagreement to report, never grounds to reject the
   * record — and never evidence in itself, since anyone can write a receipt.
   *
   * Absent is not a failure: a receipt for a v1 mark has no signer to expect.
   */
  readonly expectedSigner?: string;
}

export type ReceiptValidation =
  | { readonly ok: true; readonly receipt: HashMarkReceipt }
  | { readonly ok: false; readonly errors: readonly string[] };

const TXID_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]+$/;

/** Guard against a hostile "receipt" that is really a 200 MB JSON bomb. */
export const MAX_RECEIPT_BYTES = 8 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Validate the *shape* of a parsed receipt. Collects every problem rather than
 * failing on the first, so importing a hand-edited receipt tells the user
 * everything that is wrong with it at once.
 */
export function validateReceipt(input: unknown): ReceiptValidation {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["receipt must be a JSON object"] };
  }

  if (input["format"] !== RECEIPT_FORMAT) {
    errors.push(`"format" must be "${RECEIPT_FORMAT}"`);
  }

  const version = input["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    errors.push('"version" must be an integer');
  } else if (version !== RECEIPT_VERSION) {
    // Distinct wording: a v2 receipt is not corrupt, it is simply newer than
    // this reader, and the user should be told to update rather than told
    // their file is broken.
    errors.push(
      `receipt version ${version} is newer than this verifier supports (expected ${RECEIPT_VERSION})`,
    );
  }

  const networkId = input["network"];
  let network: NetworkInfo | undefined;
  if (typeof networkId !== "string") {
    errors.push('"network" must be a string');
  } else {
    network = networkById(networkId);
    if (network === undefined) {
      errors.push(`unknown network "${networkId}"`);
    }
  }

  const algorithmName = input["algorithm"];
  const algorithm =
    typeof algorithmName === "string" ? algorithmByName(algorithmName) : undefined;
  if (typeof algorithmName !== "string") {
    errors.push('"algorithm" must be a string');
  } else if (algorithm === undefined) {
    errors.push(`unsupported algorithm "${algorithmName}"`);
  }

  const digest = input["digest"];
  if (typeof digest !== "string") {
    errors.push('"digest" must be a string');
  } else if (!HEX_RE.test(digest)) {
    errors.push('"digest" must be lowercase hexadecimal');
  } else if (algorithm !== undefined && digest.length !== algorithm.digestLength * 2) {
    errors.push(
      `"digest" must be ${algorithm.digestLength * 2} hex characters for ${algorithm.name}`,
    );
  }

  const transactionId = input["transactionId"];
  if (typeof transactionId !== "string" || !TXID_RE.test(transactionId)) {
    errors.push('"transactionId" must be 64 lowercase hexadecimal characters');
  }

  const outputIndex = input["outputIndex"];
  if (
    typeof outputIndex !== "number" ||
    !Number.isInteger(outputIndex) ||
    outputIndex < 0 ||
    outputIndex > 0xffff_ffff
  ) {
    errors.push('"outputIndex" must be a non-negative integer');
  }

  const label = input["label"];
  if (label !== undefined && typeof label !== "string") {
    errors.push('"label", when present, must be a string');
  }

  const genesisHash = input["genesisHash"];
  const expectedSigner = input["expectedSigner"];
  if (expectedSigner !== undefined) {
    // Shape only. A checksum test needs base58 decoding, and this package is
    // deliberately dependency-free; the verifier compares decoded bytes against
    // the record's committed signer anyway, which is the check that matters.
    if (
      typeof expectedSigner !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{26,35}$/.test(expectedSigner)
    ) {
      errors.push(
        '"expectedSigner", when present, must look like a base58 address',
      );
    }
  }

  if (genesisHash !== undefined) {
    if (typeof genesisHash !== "string" || !TXID_RE.test(genesisHash)) {
      errors.push('"genesisHash", when present, must be 64 lowercase hexadecimal characters');
    } else if (
      network !== undefined &&
      network.genesisHash !== "" &&
      genesisHash !== network.genesisHash
    ) {
      errors.push(
        `"genesisHash" does not match network "${network.id}" — the receipt names one chain and points at another`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    receipt: {
      format: RECEIPT_FORMAT,
      version: version as number,
      network: networkId as string,
      algorithm: algorithmName as string,
      digest: digest as string,
      transactionId: transactionId as string,
      outputIndex: outputIndex as number,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof genesisHash === "string" ? { genesisHash } : {}),
    },
  };
}

/** Parse and validate raw receipt text, with a hard size cap. */
export function parseReceipt(text: string): ReceiptValidation {
  if (text.length > MAX_RECEIPT_BYTES) {
    return {
      ok: false,
      errors: [`receipt is larger than ${MAX_RECEIPT_BYTES} bytes`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["receipt is not valid JSON"] };
  }
  return validateReceipt(parsed);
}

/** Build a receipt from a confirmed (or at least broadcast) HashMark. */
export function buildReceipt(input: {
  network: NetworkInfo;
  algorithm: string;
  digest: string;
  transactionId: string;
  outputIndex: number;
  label?: string | undefined;
  expectedSigner?: string | undefined;
}): HashMarkReceipt {
  return {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    network: input.network.id,
    algorithm: input.algorithm,
    digest: input.digest,
    transactionId: input.transactionId,
    outputIndex: input.outputIndex,
    ...(input.label === undefined || input.label === ""
      ? {}
      : { label: input.label }),
    ...(input.network.genesisHash === ""
      ? {}
      : { genesisHash: input.network.genesisHash }),
    ...(input.expectedSigner === undefined || input.expectedSigner === ""
      ? {}
      : { expectedSigner: input.expectedSigner }),
  };
}

/** Canonical serialization: stable key order, trailing newline, 2-space indent. */
export function serializeReceipt(receipt: HashMarkReceipt): string {
  const ordered: Record<string, unknown> = {
    format: receipt.format,
    version: receipt.version,
    network: receipt.network,
    algorithm: receipt.algorithm,
    digest: receipt.digest,
    transactionId: receipt.transactionId,
    outputIndex: receipt.outputIndex,
  };
  if (receipt.label !== undefined) ordered["label"] = receipt.label;
  if (receipt.genesisHash !== undefined) ordered["genesisHash"] = receipt.genesisHash;
  if (receipt.expectedSigner !== undefined) {
    ordered["expectedSigner"] = receipt.expectedSigner;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
