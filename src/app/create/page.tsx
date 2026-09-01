import type { Metadata } from "next";
import { Suspense } from "react";

import { CreateFlow } from "@/components/create-flow";

export const metadata: Metadata = {
  title: "Create a HashMark",
  description:
    "Record a file's fingerprint on the Radiant blockchain. The file is hashed in your browser and never uploaded.",
};

export default function CreatePage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text sm:text-3xl">
        Create a HashMark
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        Record a file&rsquo;s fingerprint on Radiant, so you can later prove the
        file existed by that date and has not changed since. The file itself is
        never uploaded.
      </p>

      {/* useSearchParams needs a Suspense boundary during prerender. */}
      <div className="mt-10">
        <Suspense
          fallback={<p className="text-sm text-muted">Loading…</p>}
        >
          <CreateFlow />
        </Suspense>
      </div>
    </div>
  );
}
