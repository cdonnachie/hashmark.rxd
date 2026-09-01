import type { Metadata } from "next";

import { VerifyFlow } from "@/components/verify-flow";

export const metadata: Metadata = {
  title: "Verify a file",
  description:
    "Check whether a file has a HashMark on the Radiant blockchain. Free, no wallet needed, and the file never leaves your browser.",
};

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text sm:text-3xl">
        Verify a file
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        Choose a file to see whether its fingerprint was recorded on Radiant, and
        when. This is free, needs no wallet and no account, and the file itself
        stays on your device.
      </p>

      <div className="mt-10">
        <VerifyFlow />
      </div>
    </div>
  );
}
