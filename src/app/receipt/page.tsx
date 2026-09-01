import type { Metadata } from "next";

import { ReceiptFlow } from "@/components/receipt-flow";

export const metadata: Metadata = {
  title: "Verify a receipt",
  description:
    "Import a HashMark JSON receipt and check every claim in it against the Radiant blockchain.",
};

export default function ReceiptPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text sm:text-3xl">
        Verify a receipt
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        A receipt is a small JSON file that says where on the chain a mark lives.
        It is a convenience, not evidence — anyone can write one. Everything it
        claims is checked against Radiant before anything is shown as verified.
      </p>

      <div className="mt-10">
        <ReceiptFlow />
      </div>
    </div>
  );
}
