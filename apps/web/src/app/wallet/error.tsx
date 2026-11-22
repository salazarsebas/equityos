"use client";

import { Container } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/state";

/** Shown when the asset universe behind the balances table cannot be loaded. */
export default function WalletError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Wallet</h1>
      <div className="mt-6">
        <ErrorState title="The asset universe could not be loaded" action={<Button onClick={retry}>Try again</Button>}>
          A data source did not answer: the issuer's asset list or the Base mainnet endpoint. This page only reads, so
          your wallet and its assets are not affected. Try again in a moment.
        </ErrorState>
      </div>
    </Container>
  );
}
