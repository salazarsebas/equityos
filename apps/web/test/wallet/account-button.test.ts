import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountButton } from "../../src/components/wallet/account-button";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("AccountButton", () => {
  test("offers the connection when there is no account", () => {
    const html = renderToStaticMarkup(createElement(AccountButton, { account: null }));
    expect(html).toContain(">Connect wallet</button>");
    expect(html).toContain("w-full");
    expect(html).not.toContain("aria-label");
  });

  test("shows the shortened account in tabular mono and names the full one", () => {
    const html = renderToStaticMarkup(createElement(AccountButton, { account: ACCOUNT }));
    expect(html).toContain('<span class="num font-mono text-sm">0xf39F...2266</span>');
    expect(html).toContain(`aria-label="Account ${ACCOUNT}"`);
  });

  test("marks an unsupported network in the name, not by color alone", () => {
    const html = renderToStaticMarkup(createElement(AccountButton, { account: ACCOUNT, wrongNetwork: true }));
    expect(html).toContain(`aria-label="Account ${ACCOUNT}, unsupported network"`);
    expect(html).toContain("text-warning");
  });
});
