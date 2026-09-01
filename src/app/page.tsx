import Link from "next/link";

import { HomeDemo } from "@/components/home-demo";
import { APP_TAGLINE } from "@/lib/config";

/**
 * The three steps are a genuine sequence, and the thing they encode is a
 * boundary: step 1 happens on your device, step 3 happens on a public chain,
 * and step 2 is the crossing. Only the fingerprint crosses. The rule and the
 * colour shift carry that; the numbers would not.
 */
const STEPS = [
  {
    side: "local" as const,
    where: "On your device",
    title: "Your browser calculates a private fingerprint of the file.",
    body: "SHA-256, computed in this tab. The file is read in chunks and discarded. It is never uploaded, copied or stored.",
  },
  {
    side: "crossing" as const,
    where: "The crossing",
    title: "The fingerprint is recorded on Radiant.",
    body: "A single transaction carries the fingerprint and nothing else. You approve it in your own wallet, and the block that confirms it fixes the time.",
  },
  {
    side: "chain" as const,
    where: "Public, permanently",
    title: "Anyone can later verify the original file against the chain.",
    body: "No account, no wallet, no permission from us. The record can be read straight from any Radiant node, including without this website.",
  },
];

export default function HomePage() {
  return (
    <>
      <div className="relative">
        <div className="lattice pointer-events-none absolute inset-0 -z-10" />

        <section className="mx-auto max-w-5xl px-5 pb-14 pt-14 sm:pt-20">
          <div className="grid gap-12 lg:grid-cols-[1fr_minmax(0,26rem)] lg:items-start lg:gap-16">
            <div>
              <h1 className="font-display text-[2rem] font-semibold leading-[1.15] tracking-[-0.02em] text-text sm:text-[2.75rem]">
                {APP_TAGLINE}
              </h1>

              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                Create permanent proof that a file existed at a specific time,
                without uploading the file or revealing its contents.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/create"
                  className="rounded bg-chain px-5 py-2.5 text-sm font-medium text-ink transition-opacity hover:opacity-90"
                >
                  Create a HashMark
                </Link>
                <Link
                  href="/verify"
                  className="rounded border border-line-bright px-5 py-2.5 text-sm font-medium text-text transition-colors hover:border-chain-dim hover:text-chain"
                >
                  Verify a file
                </Link>
              </div>

              <p className="mt-8 flex items-center gap-2 text-sm text-local">
                <span aria-hidden="true">&#9679;</span>
                HashMark never uploads or stores your file.
              </p>
            </div>

            <HomeDemo />
          </div>
        </section>
      </div>

      {/* How it works — structured around the privacy boundary. */}
      <section className="mx-auto max-w-5xl px-5 py-16" aria-labelledby="how">
        <h2
          id="how"
          className="font-display text-xl font-semibold tracking-tight text-text"
        >
          How it works
        </h2>

        <ol className="mt-10 space-y-0">
          {STEPS.map((step, index) => (
            <li key={step.title} className="relative grid gap-4 sm:grid-cols-[10rem_1fr]">
              <div className="sm:text-right">
                <p
                  className={[
                    "eyebrow",
                    step.side === "local" && "!text-local",
                    step.side === "chain" && "!text-chain",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {step.where}
                </p>
              </div>

              <div className="relative border-l pb-10 pl-6 sm:pl-8"
                style={{
                  borderColor:
                    step.side === "local"
                      ? "var(--color-local-dim)"
                      : step.side === "chain"
                        ? "var(--color-chain-dim)"
                        : "var(--color-line-bright)",
                  borderLeftStyle: step.side === "crossing" ? "dashed" : "solid",
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute -left-[4.5px] top-1 size-2 rounded-full"
                  style={{
                    background:
                      step.side === "local"
                        ? "var(--color-local)"
                        : step.side === "chain"
                          ? "var(--color-chain)"
                          : "var(--color-line-bright)",
                  }}
                />
                <h3 className="text-base font-medium leading-snug text-text">
                  {step.title}
                </h3>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
                  {step.body}
                </p>
                {index === 1 && (
                  <p className="mt-3 max-w-xl text-sm leading-relaxed text-faint">
                    This is the only moment anything becomes public, and all that
                    crosses is the fingerprint.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* What it does and does not show. Stated plainly, not buried. */}
      <section
        className="mx-auto max-w-5xl px-5 py-16"
        aria-labelledby="claims"
      >
        <h2
          id="claims"
          className="font-display text-xl font-semibold tracking-tight text-text"
        >
          What a HashMark proves
        </h2>

        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
          <div className="bg-surface p-6">
            <p className="eyebrow !text-chain mb-4">It does show</p>
            <ul className="space-y-3 text-sm leading-relaxed text-muted">
              <li>
                That this exact file existed no later than the block that
                recorded its fingerprint.
              </li>
              <li>
                That the file has not changed since. A single altered byte
                produces a different fingerprint.
              </li>
              <li>
                That the record is public and permanent, readable by anyone from
                the Radiant chain.
              </li>
            </ul>
          </div>

          <div className="bg-surface p-6">
            <p className="eyebrow mb-4">It does not show</p>
            <ul className="space-y-3 text-sm leading-relaxed text-muted">
              <li>Who wrote the file. Anyone can mark a file they did not create.</li>
              <li>Who owns it, or who has any right to it.</li>
              <li>That anything the file says is true.</li>
              <li>
                That the file is new. A mark sets the latest possible date, not
                the earliest.
              </li>
            </ul>
          </div>
        </div>

        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-faint">
          The record is a timestamp and nothing more. That is a narrow claim, and
          keeping it narrow is what makes it dependable.{" "}
          <Link
            href="/protocol"
            className="text-muted underline underline-offset-4 hover:text-text"
          >
            Read the protocol
          </Link>
          .
        </p>
      </section>
    </>
  );
}
