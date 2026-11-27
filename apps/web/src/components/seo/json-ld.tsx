import { serializeJsonLd } from "@/lib/structured-data";

/** Structured data for search engines. Rendered on the server; it is not shown and carries no script to run. */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: serializeJsonLd escapes every character that could end the element
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
