"use client";

import { Container } from "@/components/shell/container";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/state";

/** Shown when the registry cannot be read: its endpoint is down, misconfigured or answered something unusable. */
export default function IndexesError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Indexes</h1>
      <div className="mt-6">
        <ErrorState title="The index registry could not be read" action={<Button onClick={retry}>Try again</Button>}>
          The chain endpoint this page reads the registry from did not answer. Nothing is shown in place of the data,
          and no index is affected: published versions are stored onchain and do not change. Try again in a moment.
        </ErrorState>
      </div>
    </Container>
  );
}
