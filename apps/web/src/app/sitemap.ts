import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

/** Public pages only. Routes under /dev are internal references and are excluded. */
export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/assets"].map((path) => ({ url: new URL(path, site.url).toString() }));
}
