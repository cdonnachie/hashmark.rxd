import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Sans, Martian_Mono } from "next/font/google";
import Link from "next/link";

import { Mark, Wordmark } from "@/components/mark";
import { APP_NAME, APP_TAGLINE, APP_URL, APP_WAVE_NAME } from "@/lib/config";

import "./globals.css";

/*
 * Three faces, each doing one job.
 *
 * Martian Mono is the display face — an unusual choice for headlines, and a
 * deliberate one: this product is about fixed-width grids of hexadecimal, so
 * the headline voice being monospaced is the subject speaking rather than a
 * decorative flourish. Used only for headings and labels.
 *
 * IBM Plex Mono carries digests specifically, because its slashed zero and
 * disambiguated 1/l are functional when someone compares two 64-character
 * strings by eye.
 */
const martian = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-martian",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: `${APP_NAME} — ${APP_TAGLINE}`,
    template: `%s — ${APP_NAME}`,
  },
  description:
    "Create permanent, independently verifiable proof that a file existed at a specific time. Files remain private and never leave the browser.",
  applicationName: APP_NAME,
  openGraph: {
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description:
      "Create permanent proof that a file existed at a specific time, without uploading the file or revealing its contents.",
    url: APP_URL,
    siteName: APP_NAME,
    type: "website",
  },
  robots: { index: true, follow: true },
};

/**
 * Every route renders per request.
 *
 * This is what makes the nonce-based CSP in `src/proxy.ts` work. Next stamps
 * its nonce during server rendering, using the CSP on the incoming request — a
 * statically prerendered page is built when no request exists, so it gets no
 * nonce, and `'strict-dynamic'` then blocks its own bootstrap scripts.
 *
 * The alternative is `script-src 'unsafe-inline'`, which would defeat the point
 * of having a policy at all on a site that renders labels written by strangers.
 * These pages are small and every interesting one is a live chain lookup, so
 * there is little static value being given up.
 */
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  themeColor: "#08090c",
};

const NAV = [
  { href: "/create", label: "Create" },
  { href: "/verify", label: "Verify" },
  { href: "/protocol", label: "Protocol" },
  { href: "/privacy", label: "Privacy" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * The font variables go on <html>, not <body>. The theme declares
     * `--font-display: var(--font-martian), …` at :root, and a custom property
     * whose value references an undefined variable is invalid at computed-value
     * time — so defining --font-martian one level lower silently voided every
     * font token. Declaring them at the same level as the theme fixes it.
     */
    <html
      lang="en"
      className={`${martian.variable} ${instrument.variable} ${plexMono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-raised focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3.5">
            <Link href="/" aria-label={`${APP_NAME} home`}>
              <Wordmark />
            </Link>
            <nav aria-label="Main">
              <ul className="flex items-center gap-1 text-sm">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="rounded px-2.5 py-1.5 text-muted transition-colors hover:bg-raised hover:text-text"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="mt-24 border-t border-line">
          <div className="mx-auto max-w-5xl px-5 py-10">
            <div className="flex flex-wrap items-start justify-between gap-8">
              <div className="max-w-xs">
                <Mark size={22} duotone />
                <p className="mt-3 text-sm text-muted">
                  Proof that a file existed at a point in time, recorded on
                  Radiant. Your file never leaves this browser.
                </p>
                <p className="digest mt-3 text-xs text-faint">
                  {APP_WAVE_NAME}
                </p>
              </div>

              <div className="flex gap-12">
                <div>
                  <p className="eyebrow mb-3">Use</p>
                  <ul className="space-y-2 text-sm">
                    {NAV.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className="text-muted transition-colors hover:text-text"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="eyebrow mb-3">Verify</p>
                  <ul className="space-y-2 text-sm">
                    <li>
                      <Link
                        href="/receipt"
                        className="text-muted transition-colors hover:text-text"
                      >
                        Import a receipt
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/protocol"
                        className="text-muted transition-colors hover:text-text"
                      >
                        Build your own verifier
                      </Link>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <p className="mt-10 border-t border-line pt-6 text-xs leading-relaxed text-faint">
              A HashMark shows that someone knew a file&rsquo;s fingerprint no
              later than the block that recorded it. It does not prove who wrote
              the file, who owns it, or that anything in it is true.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
