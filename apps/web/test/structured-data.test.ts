import { describe, expect, test } from "bun:test";
import { indexStructuredData, serializeJsonLd, webSiteStructuredData } from "../src/lib/structured-data";

describe("structured data", () => {
  test("describes the site with the values given", () => {
    expect(webSiteStructuredData({ name: "EquityOS", url: "https://e.example/", description: "Indexes." })).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "EquityOS",
      url: "https://e.example/",
      description: "Indexes.",
    });
  });

  test("describes an index as a dataset with its version and UTC times", () => {
    expect(
      indexStructuredData({
        name: "Diversified equity",
        description: "Fixed weights, 5 constituents.",
        url: "https://e.example/indexes/diversified-equity-d622e2a5",
        version: 2,
        indexId: "0xd622e2a5",
        firstPublishedAt: 1_700_000_000n,
        publishedAt: 1_700_086_400n,
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: "Diversified equity",
      description: "Fixed weights, 5 constituents.",
      url: "https://e.example/indexes/diversified-equity-d622e2a5",
      identifier: "0xd622e2a5",
      version: "2",
      datePublished: "2023-11-14T22:13:20.000Z",
      dateModified: "2023-11-15T22:13:20.000Z",
      isAccessibleForFree: true,
    });
  });

  test("serializes to JSON that cannot close its script element and parses back to the same value", () => {
    const hostile = { name: `</script><script>alert(1)</script> & ${String.fromCharCode(0x2028, 0x2029)}` };
    const text = serializeJsonLd(hostile);
    for (const character of ["<", ">", "&", String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
      expect(text).not.toContain(character);
    }
    expect(JSON.parse(text)).toEqual(hostile);
  });
});
