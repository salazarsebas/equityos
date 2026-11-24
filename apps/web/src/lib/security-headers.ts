/**
 * HTTP security headers of every response, set by `next.config.ts`. Pure: computed from the build environment,
 * so the policy allows exactly the endpoints the browser bundle was built with. It has no imports because
 * `next.config.ts` loads it before any path alias exists.
 */

/** The build-time variables the policy depends on. All are public. */
export interface SecurityHeaderEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly NEXT_PUBLIC_SITE_URL?: string | undefined;
  readonly NEXT_PUBLIC_BASE_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_ANVIL_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?: string | undefined;
}

/** Public endpoints the wallet layer falls back to when no endpoint is configured (`lib/wallet/chains.ts`). */
const FALLBACK_RPC = {
  NEXT_PUBLIC_BASE_RPC_URL: "https://mainnet.base.org",
  NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
  NEXT_PUBLIC_ANVIL_RPC_URL: "http://127.0.0.1:8545",
} as const;

/**
 * Hosts the Base Account SDK (`@base-org/account`) talks to from the page: the key service that opens its popup,
 * its RPC and chain proxy, and its event endpoint. The popup itself is a window on its own origin, which a
 * content security policy does not restrict.
 */
export const BASE_ACCOUNT_CONNECT = [
  "https://keys.coinbase.com",
  "https://rpc.wallet.coinbase.com",
  "https://chain-proxy.wallet.coinbase.com",
  "https://cca-lite.coinbase.com",
] as const;

/**
 * Hosts of the WalletConnect provider and its modal, allowed only when a project id is configured: the relay
 * (WebSocket), its RPC, its event endpoint, the wallet registry and its images, the verification frame and the
 * modal's fonts.
 */
export const WALLETCONNECT = {
  connect: [
    "wss://relay.walletconnect.org",
    "wss://relay.walletconnect.com",
    "https://rpc.walletconnect.org",
    "https://rpc.walletconnect.com",
    "https://pulse.walletconnect.org",
    "https://api.web3modal.org",
    "https://verify.walletconnect.org",
    "https://verify.walletconnect.com",
  ],
  frame: ["https://verify.walletconnect.org", "https://verify.walletconnect.com", "https://secure.walletconnect.org"],
  img: ["https://api.web3modal.org"],
  font: ["https://fonts.reown.com"],
} as const;

/** The origin of an http(s) URL, or `null` when the value is not one. Paths and keys in the path are dropped. */
function originOf(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
}

function rpcOrigin(env: SecurityHeaderEnvironment, variable: keyof typeof FALLBACK_RPC): string {
  const configured = env[variable]?.trim() ?? "";
  return originOf(configured === "" ? FALLBACK_RPC[variable] : configured) ?? originOf(FALLBACK_RPC[variable]) ?? "";
}

/**
 * The Content-Security-Policy of the app.
 *
 * - Scripts and styles: this origin, plus inline. Next.js bootstraps every page with inline scripts and the theme
 *   is set by an inline script before the first paint; a nonce would make every page dynamic, so inline is allowed
 *   and everything else is not. No `eval` outside development, where React needs it.
 * - Connections: this origin, the JSON-RPC endpoints of the bundle (origins only), Base Account, and
 *   WalletConnect when it is configured. In development also the local Anvil node and the reload socket.
 * - Frames: none, except the WalletConnect verification frame when it is configured. The app cannot be framed.
 * - No plugins, no `<base>` change, forms post to this origin only, and plain HTTP subresources are upgraded when
 *   the site is served over HTTPS.
 */
export function contentSecurityPolicy(env: SecurityHeaderEnvironment): string {
  const development = env.NODE_ENV === "development";
  const walletConnect = (env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "") !== "";
  const unique = (values: readonly string[]) => [...new Set(values.filter((value) => value !== ""))];

  const connect = unique([
    "'self'",
    rpcOrigin(env, "NEXT_PUBLIC_BASE_RPC_URL"),
    rpcOrigin(env, "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL"),
    ...(development ? [rpcOrigin(env, "NEXT_PUBLIC_ANVIL_RPC_URL"), "ws:"] : []),
    ...BASE_ACCOUNT_CONNECT,
    ...(walletConnect ? WALLETCONNECT.connect : []),
  ]);
  const siteUrl = env.NEXT_PUBLIC_SITE_URL?.trim() ?? "";
  const https = URL.canParse(siteUrl) && new URL(siteUrl).protocol === "https:";

  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", "'unsafe-inline'", ...(development ? ["'unsafe-eval'"] : [])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", ...(walletConnect ? WALLETCONNECT.img : [])],
    ["font-src", "'self'", ...(walletConnect ? WALLETCONNECT.font : [])],
    ["connect-src", ...connect],
    ["frame-src", ...(walletConnect ? WALLETCONNECT.frame : ["'none'"])],
    ["worker-src", "'self'", "blob:"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  if (https) directives.push(["upgrade-insecure-requests"]);
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/**
 * Features the app never uses, disabled for the page and every frame. Clipboard access stays at the browser
 * default because the copy buttons write to it.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
].join(", ");

/**
 * Every security header. `Cross-Origin-Opener-Policy` is deliberately absent: Base Account answers through
 * `window.opener` from its popup, which `same-origin` would cut.
 */
export function securityHeaders(env: SecurityHeaderEnvironment): { key: string; value: string }[] {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "X-Frame-Options", value: "DENY" },
  ];
  // Two years, subdomains included. Browsers ignore it over plain HTTP, and development never sends it.
  if (env.NODE_ENV !== "development") {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" });
  }
  return headers;
}
