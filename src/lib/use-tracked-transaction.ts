"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CONFIRMED_DEPTH } from "@/lib/radiant/chain";
import { browserChain } from "@/lib/radiant/client";
import { verifyTransaction, type TransactionVerification } from "@/lib/verify";

/**
 * Watch a transaction until it settles.
 *
 * Confirmation state is the one thing on screen that changes on its own, and
 * the moment a user cares about it most is right after they have spent money.
 * Fetching once and leaving "Not yet confirmed" on screen forever would make
 * the interface lie, so this re-checks on an interval and stops as soon as the
 * mark is settled.
 *
 * Polling is deliberately slow. Radiant blocks are minutes apart, so a tighter
 * interval would only add load to a public node for no extra information. It
 * also stops entirely once confirmed, when there is nothing left to learn, and
 * while the tab is hidden, since nobody is watching.
 */

/** Radiant targets minutes per block; there is nothing to learn faster. */
const POLL_INTERVAL_MS = 30_000;

/** Give up re-checking after this long, rather than polling a dead tab forever. */
const MAX_POLL_MS = 2 * 60 * 60 * 1000;

export type TrackedState =
  | { kind: "loading" }
  | { kind: "loaded"; verification: TransactionVerification }
  | { kind: "error"; message: string };

export interface TrackedTransaction {
  readonly state: TrackedState;
  /** True while a background re-check is in flight. */
  readonly refreshing: boolean;
  /** True once the transaction is settled and polling has stopped. */
  readonly settled: boolean;
  /** Force an immediate re-check. Safe to call from an event handler. */
  readonly refresh: () => void;
}

export function useTrackedTransaction(
  txid: string | null,
  options: { poll?: boolean } = {},
): TrackedTransaction {
  const poll = options.poll ?? true;

  const [state, setState] = useState<TrackedState>(
    txid === null ? { kind: "error", message: "No transaction id" } : { kind: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  // Counts finished checks. Derived rather than a synchronously-set flag, so
  // nothing has to call setState during render or in an effect body.
  const [completed, setCompleted] = useState(0);
  // Set on first run, not during render: Date.now() is impure.
  const startedAt = useRef<number | null>(null);

  const refreshing = completed <= attempt;

  const settled =
    state.kind === "loaded" &&
    state.verification.transaction.confirmations >= CONFIRMED_DEPTH;

  const refresh = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // State is only ever set from a promise callback, never synchronously here.
  useEffect(() => {
    if (txid === null) return;
    let cancelled = false;

    startedAt.current ??= Date.now();

    verifyTransaction(browserChain(), txid)
      .then((verification) => {
        if (!cancelled) setState({ kind: "loaded", verification });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState((previous) =>
          // A failed re-check must not wipe out a result we already have. The
          // transaction has not stopped existing because one poll timed out.
          previous.kind === "loaded"
            ? previous
            : {
                kind: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Could not reach a Radiant node.",
              },
        );
      })
      .finally(() => {
        if (!cancelled) setCompleted(attempt + 1);
      });

    return () => {
      cancelled = true;
    };
  }, [txid, attempt]);

  // Schedule the next check, unless there is nothing left to learn.
  useEffect(() => {
    if (!poll || txid === null || settled) return;
    if (startedAt.current !== null && Date.now() - startedAt.current > MAX_POLL_MS) {
      return;
    }

    const timer = setTimeout(() => {
      // No point re-checking a tab nobody is looking at; the visibility
      // listener below picks it up again when they come back.
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    }, POLL_INTERVAL_MS);

    return () => clearTimeout(timer);
  }, [poll, txid, settled, attempt, state]);

  // Returning to a backgrounded tab should show current information, not
  // whatever was true when it was hidden.
  useEffect(() => {
    if (!poll || txid === null || settled) return;

    const onVisible = () => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [poll, txid, settled]);

  return { state, refreshing, settled, refresh };
}
