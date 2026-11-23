import type { Metadata } from "next";
import NextLink from "next/link";
import { type ReactNode, Suspense } from "react";
import { Container } from "@/components/shell/container";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Link } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import { SourceLine } from "@/components/ui/source-line";
import { EmptyState } from "@/components/ui/state";
import { chainName } from "@/lib/indexes/chains";
import { getRegistryReader, MAX_PAGE_SIZE } from "@/server/registry";
import { ExplorerTable } from "./explorer-table";
import { FixedCaption } from "./fixed-caption";
import { RegistryNotDeployedState, RegistryNotice } from "./registry-states";

export const metadata: Metadata = {
  title: "Indexes",
  description:
    "Index methodologies published to the EquityOS registry: creator, weighting, constituents, latest version and whether the published version passes verification.",
  alternates: { canonical: "/indexes" },
};

/** Rendered on every request: the registry reader already bounds its reads with a ten second cache. */
export const revalidate = 0;

type Sort = "newest" | "oldest";

function listHref(sort: Sort, page: number): string {
  const query = new URLSearchParams();
  if (sort === "oldest") query.set("sort", sort);
  if (page > 1) query.set("page", String(page));
  const text = query.toString();
  return text === "" ? "/indexes" : `/indexes?${text}`;
}

function SortLink({ href, current, children }: { href: string; current: boolean; children: ReactNode }) {
  return (
    <NextLink
      href={href}
      aria-current={current ? "true" : undefined}
      className={cx(
        "inline-flex h-10 items-center border-b-2 px-2 font-medium whitespace-nowrap -outline-offset-2 transition-colors duration-[120ms]",
        current ? "border-accent text-primary" : "border-transparent text-secondary hover:text-primary",
      )}
    >
      {children}
    </NextLink>
  );
}

/**
 * The positions of one page of the list, as an offset and a limit in creation order. `null` for a page past
 * the last index.
 */
function pageWindow(total: number, sort: Sort, page: number): { offset: number; limit: number } | null {
  const skipped = (page - 1) * MAX_PAGE_SIZE;
  if (skipped >= total) return null;
  if (sort === "oldest") return { offset: skipped, limit: Math.min(MAX_PAGE_SIZE, total - skipped) };
  const end = total - skipped;
  const offset = Math.max(0, end - MAX_PAGE_SIZE);
  return { offset, limit: end - offset };
}

async function Explorer({ sort, page }: { sort: Sort; page: number }) {
  const reader = getRegistryReader();
  // The first read gives the number of indexes, which decides where the newest page starts.
  const count = await reader.listIndexes({ limit: 1 });
  if (count.status !== "ok") return <RegistryNotDeployedState {...count} />;
  const chain = chainName(reader.chainId);
  if (count.total === 0) {
    return (
      <div className="flex flex-col gap-3">
        <RegistryNotice chainId={reader.chainId} />
        <EmptyState
          title="No index has been published yet"
          action={<Link href="/api/v1/indexes">See the same answer as JSON</Link>}
        >
          The registry is deployed on {chain} at{" "}
          <span className="font-mono text-sm break-all text-primary">{reader.registry}</span> and holds no index. An
          index appears here as soon as its creator publishes it.
        </EmptyState>
      </div>
    );
  }
  const window = pageWindow(count.total, sort, page);
  const listed = window === null ? { ...count, indexes: [] } : await reader.listIndexes(window);
  if (listed.status !== "ok") return <RegistryNotDeployedState {...listed} />;
  const indexes = sort === "newest" ? [...listed.indexes].reverse() : listed.indexes;
  const pages = Math.ceil(listed.total / MAX_PAGE_SIZE);
  const unverified = indexes.filter(({ latest }) => !latest.conformant).length;
  let newestPublication = 0n;
  for (const { latest } of indexes) {
    if (latest.publishedAt > newestPublication) newestPublication = latest.publishedAt;
  }

  return (
    <div className="flex flex-col gap-3">
      <RegistryNotice chainId={reader.chainId} />
      <nav aria-label="Sort order" className="flex gap-2 shadow-[inset_0_-1px_0_var(--border)]">
        <SortLink href={listHref("newest", 1)} current={sort === "newest"}>
          Newest first
        </SortLink>
        <SortLink href={listHref("oldest", 1)} current={sort === "oldest"}>
          Oldest first
        </SortLink>
      </nav>
      {unverified > 0 ? (
        <Callout
          tone="warning"
          title={
            unverified === 1
              ? "One index on this page fails verification."
              : `${unverified} indexes on this page fail verification.`
          }
        >
          It stays listed with the check it fails. Its name, weighting and weights are not shown, because they would
          come from a document that did not pass every check.
        </Callout>
      ) : null}
      {window === null ? (
        <EmptyState title="This page is past the last index" action={<Link href={listHref(sort, 1)}>First page</Link>}>
          The registry holds {listed.total} {listed.total === 1 ? "index" : "indexes"}, on {pages}{" "}
          {pages === 1 ? "page" : "pages"}.
        </EmptyState>
      ) : (
        <ExplorerTable
          indexes={indexes}
          total={listed.total}
          newestFirst={sort === "newest"}
          apiHref={`/api/v1/indexes?offset=${window.offset}&limit=${window.limit}`}
        />
      )}
      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-4 text-sm">
          {page > 1 ? <Link href={listHref(sort, page - 1)}>Previous page</Link> : null}
          <span className="num text-secondary">
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={listHref(sort, page + 1)}>Next page</Link> : null}
        </nav>
      ) : null}
      {indexes.length > 0 ? (
        <SourceLine
          label="Indexes and verification"
          source={`IndexRegistry on ${chain}, verified by this server on read`}
          asOfUnixSeconds={newestPublication}
          note="latest publication shown"
        />
      ) : null}
      {indexes.length > 0 ? <FixedCaption /> : null}
    </div>
  );
}

const SKELETON_ROWS = Array.from({ length: 5 }, (_, index) => index);
const SKELETON_COLUMNS = ["w-48", "w-24", "w-20", "w-8", "w-12", "w-10", "w-16", "w-28"] as const;

/**
 * Shape of the list while the registry is read. The table is streamed after this shell and put in place by a
 * script, so a reader without JavaScript keeps seeing it: it says where the same data can be read.
 */
function ExplorerSkeleton() {
  return (
    <>
      <noscript>
        <Callout title="This page needs JavaScript to show the table.">
          The same list is available without it as JSON: <Link href="/api/v1/indexes">published indexes</Link>.
        </Callout>
      </noscript>
      <div aria-busy="true" className="mt-3">
        <span className="sr-only">Loading the published indexes</span>
        <Skeleton className="h-10 w-56" />
        <div className="mt-3 overflow-hidden rounded-lg border bg-surface">
          <div className="border-b px-4 py-3">
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="h-8 border-b bg-subtle" />
          {SKELETON_ROWS.map((row) => (
            <div key={row} className="flex h-9 items-center gap-6 border-b px-4 last:border-b-0">
              {SKELETON_COLUMNS.map((width) => (
                <Skeleton key={width} className={`${width} shrink-0`} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export default async function IndexesPage({ searchParams }: PageProps<"/indexes">) {
  const query = await searchParams;
  const sort: Sort = query.sort === "oldest" ? "oldest" : "newest";
  const requested = typeof query.page === "string" && /^[1-9][0-9]{0,6}$/.test(query.page) ? Number(query.page) : 1;

  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Indexes</h1>
      <p className="mt-2 max-w-measure text-md text-secondary">
        An index is a published methodology: a fixed list of tokenized stocks, their target weights and a rebalance
        rule. It is not a fund and holds no assets. Every version listed here is checked against what the registry
        stores onchain.
      </p>
      <div className="mt-6">
        <Suspense key={`${sort}:${requested}`} fallback={<ExplorerSkeleton />}>
          <Explorer sort={sort} page={requested} />
        </Suspense>
      </div>
    </Container>
  );
}
