"use client";

import { useEffect, useRef } from "react";

import { bytesToHex } from "@hashmark/protocol";

import { decodeRadiantAddress } from "@/lib/radiant/address";
import { interpretCallback, parseFragment } from "@/lib/wallet/callback";
import { clearPending, loadPending } from "@/lib/wallet/photonic";
import { saveAttestation, saveIdentity } from "@/lib/wallet/session";

/**
 * Where the wallet returns.
 *
 * This route exists to do four things and then get out of the way:
 *
 *   1. Read the result out of the URL **fragment** — never the query, so it was
 *      never sent to a server.
 *   2. Scrub the fragment from history immediately, so a signature does not sit
 *      in the address bar or the back stack.
 *   3. Check the result against the request we stored before navigating away.
 *   4. Hand the outcome to /create and leave.
 *
 * It is a client component with no server rendering: the fragment is not
 * available to a server, by design.
 */
export default function WalletCallbackPage() {
  const handled = useRef(false);

  useEffect(() => {
    // React 18+ mounts effects twice in development; this must run once.
    if (handled.current) return;
    handled.current = true;

    const fragment = window.location.hash;
    const params = parseFragment(fragment);
    const pending = loadPending();

    // Scrub before anything else can read it — including any later error path.
    window.history.replaceState(null, "", window.location.pathname);

    const outcome = interpretCallback(params, pending);
    clearPending();

    /** base64 signature -> the lowercase hex a record carries. */
    const signatureHex = (base64: string): string | undefined => {
      try {
        const binary = atob(base64);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return bytes.length === 65 ? bytesToHex(bytes) : undefined;
      } catch {
        return undefined;
      }
    };

    const search = new URLSearchParams();

    switch (outcome.kind) {
      case "connected":
        saveIdentity({ address: outcome.address, connectedAt: Date.now() });
        search.set("wallet", "connected");
        break;
      case "attested": {
        // The signature is already verified to recover to this address
        // (interpretCallback), which is step 6 of the creation procedure: the
        // wallet signed with the key we are about to commit to, not another.
        const hash160 = decodeRadiantAddress(outcome.address);
        const signature = signatureHex(outcome.signatureBase64);
        if (!hash160 || !signature || pending?.digest === undefined) {
          search.set("wallet", "error");
          search.set(
            "detail",
            "The wallet returned a signature that could not be used.",
          );
          break;
        }
        saveAttestation({
          digest: pending.digest,
          label: pending.label,
          address: outcome.address,
          signerHash160: bytesToHex(hash160),
          signature,
        });
        search.set("wallet", "attested");
        break;
      }
      case "broadcast":
        search.set("txid", outcome.txid);
        break;
      case "rejected":
        search.set("wallet", "rejected");
        if (outcome.message) search.set("detail", outcome.message);
        break;
      case "error":
        search.set("wallet", "error");
        search.set("detail", outcome.message);
        break;
    }

    // `replace`, not `push`: the callback must not sit in the back stack.
    window.location.replace(`/create?${search.toString()}`);
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-5 py-24">
      <p className="eyebrow">Wallet</p>
      <p className="mt-3 text-base text-muted" aria-live="polite">
        Reading the result from your wallet, then returning you to HashMark…
      </p>
      <noscript>
        <p className="mt-4 text-sm text-alert">
          This page needs JavaScript, because a wallet returns its result in the
          part of the address that browsers never send to a server.
        </p>
      </noscript>
    </div>
  );
}
