/**
 * ElectrumX / RXinDexer client over WebSocket.
 *
 * SURF.RXD's equivalent (`src/lib/radiant/electrum-client.ts`) opens a raw TCP
 * socket per call, which suits a server-side lookup per request. HashMark needs
 * the same protocol **from the browser**, where TCP is unavailable and where a
 * single verification makes several correlated calls, so this is a persistent
 * WebSocket connection with request multiplexing and server failover.
 *
 * The wire protocol is unchanged: newline-delimited JSON-RPC 2.0, one request
 * per line, one matching response per line.
 *
 * Security notes:
 *  - The chain identity is checked on connect (`server.features.genesis_hash`)
 *    and a server on the wrong chain is rejected outright, so a misconfigured
 *    or hostile endpoint cannot silently serve testnet data as mainnet.
 *  - Responses are size-capped; a hostile server must not be able to grow our
 *    memory without bound.
 *  - Nothing about the user's file is ever sent. Only digests (on the verify
 *    path), addresses and transaction ids leave the browser.
 */

export interface ElectrumConfig {
  /** Tried in order; the first that connects and matches the chain wins. */
  readonly servers: readonly string[];
  /** Expected `server.features.genesis_hash`. Connections that differ are refused. */
  readonly genesisHash: string;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  /** Supply a WebSocket implementation when there is no global one (Node). */
  readonly webSocket?: WebSocketFactory;
}

export class ElectrumError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ElectrumError";
  }
}

/** A hostile server must not be able to exhaust memory with one huge line. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const CLIENT_NAME = "hashmark";
const PROTOCOL_VERSION = "1.4";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * A minimal WebSocket surface, so a caller can supply its own implementation.
 *
 * Browsers provide this globally. Node has no global WebSocket in every
 * supported version, so server-side callers pass one in (see
 * `serverElectrumClient` in server.ts). Injecting rather than dynamically
 * importing `ws` keeps a Node-only package, and the node builtins it depends
 * on, entirely out of the browser bundle.
 */
export type WebSocketFactory = (url: string) => WebSocket;

function defaultFactory(url: string): WebSocket {
  if (typeof globalThis.WebSocket === "undefined") {
    throw new ElectrumError(
      "No WebSocket implementation available. Pass `webSocket` in ElectrumConfig when running outside a browser.",
    );
  }
  return new globalThis.WebSocket(url);
}

export class ElectrumClient {
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private buffer = "";
  private closedByUs = false;

  /** The server URL currently in use, for diagnostics. */
  connectedTo: string | undefined;

  constructor(private readonly config: ElectrumConfig) {
    if (config.servers.length === 0) {
      throw new Error("ElectrumClient: no servers configured");
    }
  }

  /** Connect if needed, trying each server in turn. Safe to call concurrently. */
  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === 1) return;
    this.connecting ??= this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    const failures: string[] = [];

    for (const url of this.config.servers) {
      try {
        await this.openSocket(url);
        await this.handshake(url);
        this.connectedTo = url;
        return;
      } catch (error) {
        failures.push(
          `${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.teardown();
      }
    }

    throw new ElectrumError(
      `Could not reach a Radiant node. Tried ${this.config.servers.length} server(s): ${failures.join("; ")}`,
    );
  }

  private async openSocket(url: string): Promise<void> {
    const socket = (this.config.webSocket ?? defaultFactory)(url);
    this.socket = socket;
    this.closedByUs = false;
    this.buffer = "";

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ElectrumError("connection timed out"));
      }, this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        // The browser deliberately withholds the reason for a failed WebSocket
        // handshake, so there is nothing more specific to report here.
        reject(new ElectrumError("connection failed"));
      };
    });

    socket.onmessage = (event: MessageEvent) => this.onMessage(event);
    socket.onclose = () => this.onClose();
  }

  /**
   * Negotiate the protocol version and — the part that matters — confirm the
   * server is on the chain we expect before any query is made against it.
   */
  private async handshake(url: string): Promise<void> {
    await this.rpc("server.version", [CLIENT_NAME, PROTOCOL_VERSION]);

    const features = (await this.rpc("server.features", [])) as {
      genesis_hash?: unknown;
    };
    const genesis = features?.genesis_hash;

    if (typeof genesis !== "string") {
      throw new ElectrumError(`${url} did not report a genesis hash`);
    }
    if (genesis.toLowerCase() !== this.config.genesisHash.toLowerCase()) {
      throw new ElectrumError(
        `${url} is on the wrong chain (genesis ${genesis}, expected ${this.config.genesisHash})`,
      );
    }
  }

  private onMessage(event: MessageEvent): void {
    const data = event.data;
    this.buffer += typeof data === "string" ? data : String(data);

    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.failAll(new ElectrumError("server sent an oversized response"));
      this.close();
      return;
    }

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      // Some servers send one frame per response without a trailing newline;
      // treat a complete frame as a line when nothing is buffered behind it.
      const line =
        newline === -1
          ? this.buffer.trim().length > 0 && this.looksComplete(this.buffer)
            ? this.buffer
            : undefined
          : this.buffer.slice(0, newline);
      if (line === undefined) return;
      this.buffer = newline === -1 ? "" : this.buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      this.dispatch(line);
    }
  }

  /** Cheap check that a frame is a whole JSON document rather than a fragment. */
  private looksComplete(text: string): boolean {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  private dispatch(line: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed line is not attributable to a request, so it cannot be
      // failed individually. Ignoring it lets the request time out cleanly.
      return;
    }

    if (typeof parsed.id !== "number") return; // server notification
    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);

    if (parsed.error) {
      pending.reject(
        new ElectrumError(parsed.error.message ?? "unknown error", parsed.error.code),
      );
    } else {
      pending.resolve(parsed.result);
    }
  }

  private onClose(): void {
    if (!this.closedByUs) {
      this.failAll(new ElectrumError("connection closed by the server"));
    }
    this.socket = undefined;
    this.connectedTo = undefined;
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private teardown(): void {
    this.failAll(new ElectrumError("connection abandoned"));
    this.closedByUs = true;
    try {
      this.socket?.close();
    } catch {
      // Already closed or never opened; nothing to do.
    }
    this.socket = undefined;
  }

  /** Issue one JSON-RPC call on an already-open socket. */
  private rpc(method: string, params: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new ElectrumError("not connected"));
    }

    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ElectrumError(`"${method}" timed out`));
      }, this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      socket.send(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Connect if needed, then call `method`. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    await this.connect();
    return (await this.rpc(method, params)) as T;
  }

  close(): void {
    this.closedByUs = true;
    this.failAll(new ElectrumError("client closed"));
    try {
      this.socket?.close();
    } catch {
      // Nothing to do.
    }
    this.socket = undefined;
    this.connectedTo = undefined;
  }
}
