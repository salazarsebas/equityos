import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceLine } from "../src/components/ui/source-line";

const AS_OF = 1_795_000_000n;

describe("SourceLine", () => {
  test("names the source and the as-of time in UTC, with separators drawn by CSS only", () => {
    const html = renderToStaticMarkup(
      createElement(SourceLine, { label: "Reference prices", source: "Chainlink feeds", asOfUnixSeconds: AS_OF }),
    );
    expect(html).toContain("Reference prices: Chainlink feeds");
    expect(html).toContain('<time dateTime="2026-11-18T11:06:40.000Z" class="num">2026-11-18 11:06 UTC</time>');
    // The separator is generated content with empty alternative text, so it is never read as text.
    expect(html).not.toContain("·</span>");
    expect(html.match(/before:content-/g)?.length).toBe(2);
  });

  test("adds the note as a third part and turns warning-toned with the delay when stale", () => {
    const html = renderToStaticMarkup(
      createElement(SourceLine, {
        label: "Reference prices",
        source: "Chainlink feeds",
        asOfUnixSeconds: AS_OF,
        stale: "oldest 14 min",
        note: "Market closed",
      }),
    );
    expect(html).toContain("text-warning");
    expect(html).toContain("Reference prices delayed, oldest 14 min: Chainlink feeds");
    expect(html).toContain("Market closed");
    expect(html.match(/before:content-/g)?.length).toBe(3);
  });
});
