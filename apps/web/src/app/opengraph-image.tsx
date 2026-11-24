import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { site } from "@/lib/site";

export const alt = `${site.name}: open, verifiable indexes for tokenized stocks on Base`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The static weights of IBM Plex Mono, from the exact-pinned Fontsource package. The renderer reads WOFF. */
function plexMono(weight: 400 | 500): Promise<Buffer> {
  return readFile(
    join(process.cwd(), `node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${weight}-normal.woff`),
  );
}

/** Light theme tokens of `src/styles/tokens.css`. */
const PAGE = "#fafaf7";
const INK = "#171714";
const SECONDARY = "#55554d";
const RULE = "#d9d9d2";

/** Typographic card for link previews. It states what the product is and carries no figure. */
export default async function OpenGraphImage() {
  const [regular, medium] = await Promise.all([plexMono(400), plexMono(500)]);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        background: PAGE,
        color: INK,
        fontFamily: "IBM Plex Mono",
      }}
    >
      <div style={{ display: "flex", fontSize: 32, fontWeight: 500 }}>{site.name}</div>
      <div style={{ display: "flex", fontSize: 60, fontWeight: 500, lineHeight: 1.15, letterSpacing: "-0.02em" }}>
        Open, verifiable indexes for tokenized stocks on Base
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          borderTop: `2px solid ${RULE}`,
          paddingTop: 28,
          fontSize: 24,
          color: SECONDARY,
        }}
      >
        <span>Rule sets, not funds</span>
        <span>Hash stored onchain</span>
        <span>Weights anyone can recompute</span>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "IBM Plex Mono", data: regular, weight: 400, style: "normal" },
        { name: "IBM Plex Mono", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
