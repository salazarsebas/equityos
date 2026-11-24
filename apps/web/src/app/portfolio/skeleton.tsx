import { Skeleton } from "@/components/ui/skeleton";
import { Stat, StatGrid } from "@/components/ui/stat";
import { MISSING } from "@/lib/format";

const ROWS = Array.from({ length: 5 }, (_, index) => index);

/** Shape of the comparison while it loads: the facts show dashes, never zeros, and the table its frame. */
export function PortfolioSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the comparison</span>
      <Skeleton className="h-12 w-full max-w-xl" />
      <StatGrid columns={4}>
        <Stat label="Portfolio value at reference prices" value={MISSING} />
        <Stat label="Largest drift" value={MISSING} />
        <Stat label="Drift threshold of the index" value={MISSING} />
        <Stat label="USDC not invested" value={MISSING} />
      </StatGrid>
      <div className="overflow-hidden rounded-lg border bg-surface">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="h-8 border-b bg-subtle" />
        {ROWS.map((row) => (
          <div key={row} className="flex h-9 items-center gap-6 border-b px-4 last:border-b-0">
            <Skeleton className="w-14 shrink-0" />
            <Skeleton className="w-16 shrink-0" />
            <Skeleton className="w-16 shrink-0" />
            <Skeleton className="w-40 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
