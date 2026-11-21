"use client";

import { Container } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/state";

/** Shown when the asset universe cannot be loaded: a source is down and nothing recent enough is cached. */
export default function AssetsError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Assets</h1>
      <div className="mt-6">
        <ErrorState title="The asset universe could not be loaded" action={<Button onClick={retry}>Try again</Button>}>
          A data source did not answer: the issuer's asset list or the Base mainnet endpoint. This page only reads
          public data, so nothing of yours is affected. Try again in a moment.
        </ErrorState>
      </div>
    </Container>
  );
}
