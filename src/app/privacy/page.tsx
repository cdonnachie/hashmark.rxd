import type { Metadata } from "next";
import Link from "next/link";

import { MAX_LABEL_BYTES } from "@hashmark/protocol";

import { ELECTRUM_SERVERS } from "@/lib/config";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What HashMark records, what it never records, and what becomes permanently public.",
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text sm:text-3xl">
        Privacy
      </h1>
      <p className="mt-4 text-base leading-relaxed text-muted">
        Short version: your file never leaves your browser, and the only thing
        that becomes public is a fingerprint plus any label you choose to write.
      </p>

      <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        <div className="bg-surface p-6">
          <p className="eyebrow !text-local mb-4">Stays on your device</p>
          <ul className="space-y-2.5 text-sm leading-relaxed text-muted">
            <li>The file itself, always</li>
            <li>Its name, size and type</li>
            <li>Where it came from on your computer</li>
          </ul>
        </div>
        <div className="bg-surface p-6">
          <p className="eyebrow !text-chain mb-4">Becomes permanently public</p>
          <ul className="space-y-2.5 text-sm leading-relaxed text-muted">
            <li>The SHA-256 fingerprint of the file</li>
            <li>A label, only if you type one</li>
            <li>The transaction that carries them, and its fee</li>
          </ul>
        </div>
      </div>

      <Section title="The file is never uploaded">
        <p>
          Hashing happens in your browser, in the tab you are looking at. The
          file is read in chunks, each chunk is fed into the hash, and each is
          discarded immediately. Only a 32-byte running state is kept between
          chunks.
        </p>
        <p>
          There is no upload endpoint in this application. Not one that is
          unused or disabled — the route does not exist. You can confirm this
          yourself: open your browser&rsquo;s network panel and drop a file on
          any page here. No request is made.
        </p>
      </Section>

      <Section title="What we store">
        <p>
          Nothing. HashMark has no user accounts, no database and no server-side
          storage of anything you do. The blockchain holds the records, and your
          browser holds everything else.
        </p>
        <p>
          Two things are kept temporarily in your browser&rsquo;s{" "}
          <code className="digest text-xs text-text">sessionStorage</code>, and
          only while a tab is open: the fingerprint of the file you are marking,
          so it survives the trip to your wallet and back, and the address your
          wallet proved control of. Both are cleared when you close the tab.
        </p>
      </Section>

      <Section title="What the label reveals">
        <p>
          A label is optional, at most {MAX_LABEL_BYTES} bytes, and{" "}
          <strong className="text-caution">
            permanently public and permanently unerasable
          </strong>
          . It cannot be edited or deleted after the transaction is broadcast.
        </p>
        <p>
          We never put your filename in it by default, because a filename can
          give away a client, a case number or a person&rsquo;s name. If you
          want a filename recorded, you have to type it yourself.
        </p>
      </Section>

      <Section title="What a fingerprint can give away">
        <p>
          A fingerprint reveals nothing about a file&rsquo;s contents —{" "}
          <em>provided the file is hard to guess</em>. If someone can guess
          candidate versions of your document, they can hash each guess and see
          which one matches. That matters for short, predictable documents: a
          one-line statement from a known template, or a number in a small
          range.
        </p>
        <p>
          If you need a fingerprint to reveal nothing even to someone who can
          guess, mark a file that contains a long random value alongside the
          content.
        </p>
      </Section>

      <Section title="Who you talk to">
        <p>
          To read the chain, your browser connects directly to a Radiant node
          over an encrypted WebSocket. Those node operators see your IP address,
          as any server you connect to does.
        </p>
        <ul className="mt-3 space-y-1.5">
          {ELECTRUM_SERVERS.map((server) => (
            <li key={server} className="digest text-xs text-faint">
              {server}
            </li>
          ))}
        </ul>
        <p className="mt-3">
          Reading a transaction is direct, not through us. That is deliberate:
          it means this site cannot fabricate a verification result, and
          verifying by transaction id or by receipt keeps working even if this
          site disappears.
        </p>
        <p className="mt-3">
          <strong className="text-text">
            Searching by fingerprint is the exception.
          </strong>{" "}
          Radiant nodes do not index file fingerprints, so to find a mark from a
          file your browser sends the fingerprint to this site, which asks a
          digest index for a list of possibly matching transactions. The
          fingerprint is not logged here, not stored, and nothing else about you
          travels with it. Your browser then reads those transactions from a
          Radiant node itself and decides for itself what they say — the index
          can only point, never answer.
        </p>
        <p className="mt-3">
          If you would rather not send a fingerprint anywhere, verify with a
          transaction id or a receipt instead. Neither one goes near the index.
        </p>
      </Section>

      <Section title="No tracking">
        <p>
          There is no analytics, no tracking pixel, no advertising network and no
          third-party script of any kind. No cookies are set. A fingerprint is
          never sent to an analytics service — it would be a permanent,
          linkable identifier for a file.
        </p>
      </Section>

      <Section title="Your keys">
        <p>
          HashMark never asks for a seed phrase or a private key, and there is no
          field anywhere in this application that could accept one. Signing
          happens inside your own wallet, and the wallet&rsquo;s approval screen
          is what authorises anything.
        </p>
        <p>
          If any site claiming to be HashMark ever asks for a seed phrase, it is
          not us. Close it.
        </p>
      </Section>

      <Section title="What is public on the chain regardless">
        <p>
          A Radiant transaction is public. Its inputs, its change address and its
          amounts are all visible, and someone studying the chain may be able to
          connect several of your marks to each other or to your wallet&rsquo;s
          other activity. That is a property of a public blockchain, not
          something HashMark adds — but it is worth knowing before you mark
          something sensitive.
        </p>
      </Section>

      <p className="mt-12 text-sm text-muted">
        The full technical detail is in the{" "}
        <Link
          href="/protocol"
          className="text-chain underline underline-offset-4 hover:opacity-80"
        >
          protocol documentation
        </Link>
        .
      </p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-base font-semibold text-text">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted">
        {children}
      </div>
    </section>
  );
}
