import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PortfolioError from "../../src/app/portfolio/error";

describe("PortfolioError", () => {
  test("keeps the page title and says what failed, what is affected and what to do", () => {
    const html = renderToStaticMarkup(createElement(PortfolioError, { error: new Error("x"), retry: () => {} }));
    expect(html).toContain(">Portfolio</h1>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("The comparison could not be loaded");
    expect(html).toContain("no wallet and no asset is affected");
    expect(html).toContain(">Try again</button>");
  });
});
