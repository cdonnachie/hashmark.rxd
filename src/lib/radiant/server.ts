/**
 * Server-side Radiant access.
 *
 * Node has no global `WebSocket` across all supported versions, so this module
 * supplies one from the `ws` package. It is deliberately the ONLY place `ws` is
 * referenced: importing it here rather than inside `electrum.ts` keeps the
 * package, and the node builtins it pulls in, out of the browser bundle
 * entirely.
 *
 * Server-side use is limited to the optional read-only API routes. The browser
 * talks to Radiant directly, which is what keeps this site from being a
 * required intermediary for verification.
 */
import "server-only";

import WebSocketImpl from "ws";

import { ELECTRUM_SERVERS, NETWORK } from "@/lib/config";

import { RadiantChain } from "./chain";
import { ElectrumClient } from "./electrum";

export function serverElectrumClient(): ElectrumClient {
  return new ElectrumClient({
    servers: ELECTRUM_SERVERS,
    genesisHash: NETWORK.genesisHash,
    webSocket: (url) => new WebSocketImpl(url) as unknown as WebSocket,
  });
}

/**
 * Run `fn` against a freshly connected chain adapter, always closing the socket
 * afterwards. Route handlers are short-lived, so a connection per request is
 * the right trade: no pooling to leak, and no shared mutable state between
 * requests.
 */
export async function withChain<T>(
  fn: (chain: RadiantChain) => Promise<T>,
): Promise<T> {
  const client = serverElectrumClient();
  try {
    return await fn(new RadiantChain(client));
  } finally {
    client.close();
  }
}
