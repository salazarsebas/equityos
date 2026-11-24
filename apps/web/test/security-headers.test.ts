import { describe, expect, test } from "bun:test";
import {
  BASE_ACCOUNT_CONNECT,
  contentSecurityPolicy,
  PERMISSIONS_POLICY,
  securityHeaders,
  WALLETCONNECT,
} from "../src/lib/security-headers";

/** The directives of a policy, by name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

const PRODUCTION = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SITE_URL: "https://equityos.example",
  NEXT_PUBLIC_BASE_RPC_URL: "https://base-rpc.example/v1/public-key-placeholder",
  NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://sepolia-rpc.example:8443/v1/public-key-placeholder",
};

describe("contentSecurityPolicy", () => {
  test("production: only this origin, inline bootstrap, the configured RPC origins and Base Account", () => {
    const policy = directives(contentSecurityPolicy(PRODUCTION));
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(policy.get("font-src")).toEqual(["'self'"]);
    expect(policy.get("connect-src")).toEqual([
      "'self'",
      "https://base-rpc.example",
      "https://sepolia-rpc.example:8443",
      ...BASE_ACCOUNT_CONNECT,
    ]);
    expect(policy.get("frame-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.has("upgrade-insecure-requests")).toBe(true);
  });

  test("never contains the path of an RPC URL, where a provider key usually is", () => {
    expect(contentSecurityPolicy(PRODUCTION)).not.toContain("public-key-placeholder");
  });

  test("falls back to the public Base endpoints the wallet layer uses when none is configured", () => {
    const policy = directives(contentSecurityPolicy({ NODE_ENV: "production" }));
    expect(policy.get("connect-src")).toEqual([
      "'self'",
      "https://mainnet.base.org",
      "https://sepolia.base.org",
      ...BASE_ACCOUNT_CONNECT,
    ]);
    // A site served over plain HTTP, such as the browser tests, gets no upgrade.
    expect(policy.has("upgrade-insecure-requests")).toBe(false);
  });

  test("allows the WalletConnect hosts only when a project id is configured", () => {
    const without = contentSecurityPolicy(PRODUCTION);
    for (const host of [...WALLETCONNECT.connect, ...WALLETCONNECT.frame, ...WALLETCONNECT.font]) {
      expect(without).not.toContain(host);
    }
    const policy = directives(contentSecurityPolicy({ ...PRODUCTION, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "p" }));
    for (const host of WALLETCONNECT.connect) expect(policy.get("connect-src")).toContain(host);
    expect(policy.get("frame-src")).toEqual([...WALLETCONNECT.frame]);
    expect(policy.get("img-src")).toContain("https://api.web3modal.org");
    expect(policy.get("font-src")).toContain("https://fonts.reown.com");
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  test("development adds eval for React, the local node and the reload socket", () => {
    const policy = directives(contentSecurityPolicy({ NODE_ENV: "development" }));
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).toContain("http://127.0.0.1:8545");
    expect(policy.get("connect-src")).toContain("ws:");
    const custom = directives(
      contentSecurityPolicy({ NODE_ENV: "development", NEXT_PUBLIC_ANVIL_RPC_URL: "http://127.0.0.1:8576" }),
    );
    expect(custom.get("connect-src")).toContain("http://127.0.0.1:8576");
    expect(directives(contentSecurityPolicy(PRODUCTION)).get("script-src")).not.toContain("'unsafe-eval'");
  });
});

describe("securityHeaders", () => {
  test("sets every header, with HSTS outside development", () => {
    const headers = new Map(securityHeaders(PRODUCTION).map(({ key, value }) => [key, value]));
    expect([...headers.keys()].sort()).toEqual([
      "Content-Security-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Permissions-Policy")).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toContain("camera=()");
    expect(PERMISSIONS_POLICY).not.toContain("clipboard");
    const development = securityHeaders({ NODE_ENV: "development" }).map(({ key }) => key);
    expect(development).not.toContain("Strict-Transport-Security");
    // Base Account answers through window.opener, which a strict opener policy would cut.
    expect(headers.has("Cross-Origin-Opener-Policy")).toBe(false);
  });
});
