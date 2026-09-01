"use client";

import { ELECTRUM_SERVERS, NETWORK } from "@/lib/config";

import { RadiantChain } from "./chain";
import { ElectrumClient } from "./electrum";

/**
 * The browser's connection to Radiant.
 *
 * The browser talks to a Radiant node **directly**. That is the point: it means
 * verification does not pass through hashmark.rxd.zone, so this site cannot
 * fake a result, and verification keeps working if the site goes away. The
 * server-side API routes exist only as a convenience for clients that cannot
 * open a WebSocket.
 *
 * One shared connection per tab, opened lazily on first use — a page that never
 * verifies anything never touches the network.
 */
let shared: ElectrumClient | undefined;

export function browserElectrum(): ElectrumClient {
  shared ??= new ElectrumClient({
    servers: ELECTRUM_SERVERS,
    genesisHash: NETWORK.genesisHash,
  });
  return shared;
}

export function browserChain(): RadiantChain {
  return new RadiantChain(browserElectrum());
}

/** Which server the tab ended up using, once connected. For the diagnostics line. */
export function connectedServer(): string | undefined {
  return shared?.connectedTo;
}
