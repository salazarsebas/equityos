import { Container } from "@/components/shell/container";
import { Callout } from "@/components/ui/callout";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = Array.from({ length: 12 }, (_, index) => index);
const COLUMNS = ["w-12", "w-40", "w-24", "w-8", "w-20", "w-16", "w-16", "w-32"] as const;

/**
 * Shape of the assets page while the market data loads: title, lead, view switch and a table frame.
 *
 * The table is streamed after this shell and put in place by a script. A reader without JavaScript therefore
 * keeps seeing this shell, so it tells them where the same data can be read.
 */
export default function AssetsLoading() {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Assets</h1>
      <noscript>
        <div className="mt-4">
          <Callout title="This page needs JavaScript to show the table.">
            The same data is available without it as JSON:{" "}
            <Link href="/api/v1/assets?eligible=true">eligible assets</Link> or{" "}
            <Link href="/api/v1/assets">all listed assets</Link>.
          </Callout>
        </div>
      </noscript>
      <div aria-busy="true" className="mt-2">
        <span className="sr-only">Loading the asset universe</span>
        <Skeleton className="h-6 w-full max-w-measure" />
        <div className="mt-6 grid gap-x-6 gap-y-4 border-t pt-4 md:grid-cols-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="mt-6 h-10 w-64" />
        <div className="mt-6 overflow-hidden rounded-lg border bg-surface">
          <div className="border-b px-4 py-3">
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="h-8 border-b bg-subtle" />
          {ROWS.map((row) => (
            <div key={row} className="flex h-8 items-center gap-6 border-b px-4 last:border-b-0">
              {COLUMNS.map((width) => (
                <Skeleton key={width} className={`${width} shrink-0`} />
              ))}
            </div>
          ))}
        </div>
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      </div>
    </Container>
  );
}
