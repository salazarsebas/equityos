"use client";

import { Container } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/state";

/** Shown when the list of indexes or the market data behind the comparison cannot be loaded. */
export default function PortfolioError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Portfolio</h1>
      <div className="mt-6">
        <ErrorState title="The comparison could not be loaded" action={<Button onClick={retry}>Try again</Button>}>
          A data source did not answer: the index registry or the Base mainnet endpoint. This page only reads, so no
          wallet and no asset is affected, and nothing was stored. Try again in a moment.
        </ErrorState>
      </div>
    </Container>
  );
}
