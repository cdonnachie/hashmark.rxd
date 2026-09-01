import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers, including a nonce-based Content Security Policy.
 *
 * Next.js 16 renamed this convention: what used to be `middleware.ts` is now
 * `proxy.ts`.
 *
 * A nonce is used rather than `'unsafe-inline'` so that an injected script
 * cannot execute even if something did manage to write markup into the page.
 * The cost is that pages render dynamically, which HashMark can afford: every
 * page here is either interactive or a live chain lookup, and none of it is
 * cacheable static content.
 *
 * `connect-src` is the important one. It is the list of places this application
 * is allowed to talk to, and it is deliberately short: our own origin and the
 * configured Radiant nodes. There is nowhere for a file, a digest or anything
 * else to be sent, even if code tried.
 */

function electrumOrigins(): string[] {
  const configured =
    process.env.NEXT_PUBLIC_ELECTRUM_SERVERS ??
    // Must stay in step with ELECTRUM_SERVERS in lib/config.ts: a server the
    // app dials but the CSP omits fails with a console error and no result.
    [
      "wss://electrumx.rxd-radiant.com:50011",
      "wss://electrumx-eu.rxd-radiant.com:50011",
    ].join(",");

  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";

  const csp = [
    `default-src 'self'`,
    // 'strict-dynamic' lets Next's own bootstrap load its chunks; nothing else
    // can introduce a script. Turbopack's dev runtime needs eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // next/font inlines its @font-face rules, which requires inline styles.
    // Style injection is a defacement risk, not an execution one.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${electrumOrigins().join(" ")}${isDev ? " ws: http://localhost:*" : ""}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // Next reads the nonce back out of the CSP on the REQUEST headers in order to
  // stamp it onto its own script tags. Setting only `x-nonce` leaves its
  // bootstrap scripts unnonced, and 'strict-dynamic' then blocks every one of
  // them — the page renders but never hydrates.
  headers.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers } });

  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("x-permitted-cross-domain-policies", "none");

  if (!isDev) {
    response.headers.set(
      "strict-transport-security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next's own static assets, which need no CSP and would
    // only lose their long cache lifetime by being made dynamic.
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
