import type { Metadata } from "next";
import { LiveData, Verify } from "@/components/landing/live";
import { Developers, Hero, Holder, Limitations, RuleSet } from "@/components/landing/sections";
import { buildExampleSpec } from "@/lib/landing/example-spec";
import { site } from "@/lib/site";
import { executionReleased, loadRegistry, loadUniverse } from "@/server/landing";

const TITLE = `${site.name}: open, verifiable indexes for tokenized stocks on Base`;
const DESCRIPTION =
  "An index on EquityOS is a published rule set over tokenized stocks on Base. Its hash is stored onchain, anyone can recompute its weights, and followers hold the tokens in their own wallets. Not a fund.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: site.name, title: TITLE, description: DESCRIPTION, locale: "en_US" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

/**
 * Rendered on request, like the assets and index pages. The figures of the page are counted from the market
 * data layer and the registry reader, which bound their reads with their own caches (15 seconds and 10
 * seconds). A page prerendered at build time would carry the build machine's view of the sources, and serve it
 * to the first visitor after every revalidation window.
 */
export const revalidate = 0;

/** Computed once per server process from a core test vector. It is the same on every request. */
const example = buildExampleSpec();

export default async function HomePage() {
  const [universe, registry] = await Promise.all([loadUniverse(), loadRegistry()]);
  const released = executionReleased();
  return (
    <>
      <Hero />
      <RuleSet example={example} executionReleased={released} />
      <Verify registry={registry} />
      <LiveData universe={universe} registry={registry} />
      <Holder executionReleased={released} />
      <Developers />
      <Limitations />
    </>
  );
}
