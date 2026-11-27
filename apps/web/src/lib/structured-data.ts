/**
 * schema.org structured data for search engines, as JSON-LD. Every value comes from data the page itself shows:
 * nothing here adds a claim the reader cannot see.
 */

const CONTEXT = "https://schema.org";

export interface WebSiteData {
  readonly name: string;
  readonly url: string;
  readonly description: string;
}

export function webSiteStructuredData({ name, url, description }: WebSiteData) {
  return { "@context": CONTEXT, "@type": "WebSite", name, url, description } as const;
}

export interface IndexData {
  readonly name: string;
  readonly description: string;
  /** Absolute canonical URL of the page. */
  readonly url: string;
  readonly version: number;
  /** The onchain index id. */
  readonly indexId: string;
  /** Unix seconds of the first version of the index. */
  readonly firstPublishedAt: bigint;
  /** Unix seconds of the version shown. */
  readonly publishedAt: bigint;
}

/** An index is a published, versioned methodology: a dataset, not a product for sale. */
export function indexStructuredData(data: IndexData) {
  return {
    "@context": CONTEXT,
    "@type": "Dataset",
    name: data.name,
    description: data.description,
    url: data.url,
    identifier: data.indexId,
    version: String(data.version),
    datePublished: isoInstant(data.firstPublishedAt),
    dateModified: isoInstant(data.publishedAt),
    isAccessibleForFree: true,
  } as const;
}

function isoInstant(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/**
 * JSON for a `<script type="application/ld+json">` element. `<`, `>` and `&` are escaped so that no value, such
 * as an index name chosen by its creator, can close the element or start markup; the line and paragraph separators
 * are escaped because some parsers treat them as line ends.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}
