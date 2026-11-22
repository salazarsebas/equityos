import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, type ReactNode, Suspense } from "react";
import { Container } from "@/components/shell/container";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { Link } from "@/components/ui/link";
import { Stat, StatGrid } from "@/components/ui/stat";
import { StatusTag, Tag } from "@/components/ui/tag";
import {
  formatCount,
  formatPercent,
  formatUtcDate,
  formatUtcDateTime,
  shortenAddress,
  shortenHash,
  toIsoInstant,
} from "@/lib/format";
import { chainName, explorerAddressUrl } from "@/lib/indexes/chains";
import { CHECK_MEANINGS } from "@/lib/indexes/checks";
import { formatDuration, formatPoints, largestWeightBps, weightingLabel } from "@/lib/indexes/methodology";
import { site } from "@/lib/site";
import { type IndexProfile, loadIndexProfile } from "@/server/indexes";
import { getMarketData } from "@/server/market";
import { type Composition as CompositionKind, getRegistryReader, type IndexVersionView } from "@/server/registry";
import { RegistryNotDeployedState, RegistryNotice } from "../registry-states";
import { Composition, CompositionSkeleton, CurrentStatus, type SnapshotResult } from "./composition";
import { Methodology, Performance, VersionHistory } from "./sections";
import { VerificationPanel } from "./verification-panel";

/** One lookup per request, shared by the metadata and the page. */
const resolveProfile = cache((identifier: string, version: number | null) =>
  loadIndexProfile(getRegistryReader(), identifier, version ?? undefined),
);

/** A version number from a URL, or `null` when the segment is not one. */
export function parseVersionSegment(segment: string): number | null {
  return /^[1-9][0-9]{0,9}$/.test(segment) ? Number(segment) : null;
}

function profilePath(identifier: string, version: number | null): string {
  return version === null ? `/indexes/${identifier}` : `/indexes/${identifier}/versions/${version}`;
}

/** The name of a version: the one its spec carries when the spec is verified, and the index id otherwise. */
function displayName(view: IndexVersionView): string {
  return view.conformant ? view.spec.name : `Unverified index ${shortenHash(view.indexId)}`;
}

const COMPOSITION_LABELS: Record<CompositionKind, string> = {
  static: "Static: tokens and weights stored onchain",
  dynamic_weights: "Dynamic weights: tokens stored onchain",
  rule_based: "Rule based: nothing mirrored onchain",
};

/**
 * Metadata of a profile. The title and the description come from the spec only when the version passes every
 * check: an unverified document never names the page.
 */
export async function profileMetadata(identifier: string, version: number | null): Promise<Metadata> {
  const profile = await resolveProfile(identifier, version);
  if (profile.status === "registry_not_deployed") return { title: "Indexes", robots: { index: false } };
  if (profile.status !== "ok") return { title: "Index not found", robots: { index: false } };
  const { index, version: view } = profile;
  const name = displayName(view);
  const title = version === null ? name : `${name}, version ${view.version}`;
  const published = formatUtcDate(view.publishedAt);
  const description = view.conformant
    ? `${weightingLabel(view.spec)}, ${view.constituents.length} ${view.constituents.length === 1 ? "constituent" : "constituents"}. Version ${view.version} of a published index methodology, published ${published} and verified against the index registry on ${chainName(view.chainId)}.`
    : `Version ${view.version} of an index published ${published} on ${chainName(view.chainId)}. It fails verification, so its methodology is not shown.`;
  const canonical = profilePath(index.identifier, version);
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", siteName: site.name, title, description, url: canonical, locale: "en_US" },
    twitter: { card: "summary", title, description },
  };
}

function HeaderFact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <dt className="text-secondary">{term}</dt>
      <dd className="flex items-center gap-2">{children}</dd>
    </div>
  );
}

function Header({ profile, name }: { profile: IndexProfile; name: string }) {
  const { index, version: view } = profile;
  const { latestVersion, deprecatedAt, creator } = index.head;
  const superseded = view.version < latestVersion;
  const creatorUrl = explorerAddressUrl(view.chainId, creator);
  return (
    <header>
      <nav aria-label="Breadcrumb" className="text-sm text-secondary">
        <Link href="/indexes" variant="quiet">
          Indexes
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{name}</span>
      </nav>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-medium">{name}</h1>
        <Tag tone={superseded ? "warning" : "neutral"}>
          v{view.version}, {superseded ? `superseded by v${latestVersion}` : "latest"}
        </Tag>
        {deprecatedAt === null ? null : <StatusTag status="Deprecated" />}
      </div>
      <p className="mt-2 text-secondary">
        A published methodology, not a fund. Anyone replicating it holds the assets in their own wallet.
      </p>
      {view.conformant && view.spec.description !== "" ? (
        <p className="mt-3 max-w-measure text-md">{view.spec.description}</p>
      ) : null}
      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <HeaderFact term="Creator">
          {creatorUrl ? (
            <Link href={creatorUrl} variant="quiet" className="font-mono">
              <span title={creator}>{shortenAddress(creator)}</span>
            </Link>
          ) : (
            <span className="font-mono" title={creator}>
              {shortenAddress(creator)}
            </span>
          )}
        </HeaderFact>
        <HeaderFact term="Composition">{COMPOSITION_LABELS[view.composition]}</HeaderFact>
        <HeaderFact term="Published">
          <time dateTime={toIsoInstant(view.publishedAt)} className="num">
            {formatUtcDateTime(view.publishedAt)}
          </time>
        </HeaderFact>
        <HeaderFact term="Spec hash">
          <span className="font-mono" title={view.specHash}>
            {shortenHash(view.specHash)}
          </span>
          <CopyButton value={view.specHash} label="Copy spec hash" />
        </HeaderFact>
      </dl>
    </header>
  );
}

/** Conditions of the index or of the version shown that a reader must know before reading anything else. */
function Notices({ profile }: { profile: IndexProfile }) {
  const { index, version: view } = profile;
  const { latestVersion, deprecatedAt } = index.head;
  const failed = view.verification.checks.find(({ status }) => status === "fail");
  return (
    <>
      <RegistryNotice chainId={view.chainId} />
      {view.version < latestVersion ? (
        <Callout
          tone="warning"
          title={`You are viewing version ${view.version}. Version ${latestVersion} is the latest.`}
        >
          This version stays published and verifiable, and it is no longer the current methodology of the index.{" "}
          <Link href={`/indexes/${index.identifier}`}>View the latest version</Link>
        </Callout>
      ) : null}
      {deprecatedAt === null ? null : (
        <Callout tone="warning" title={`The creator deprecated this index on ${formatUtcDate(deprecatedAt)}.`}>
          No new version can be published. Every published version stays readable and verifiable.
        </Callout>
      )}
      {failed === undefined ? null : (
        <Callout
          tone="negative"
          title={`This version fails verification: check ${failed.id}, ${CHECK_MEANINGS[failed.id].name.toLowerCase()}.`}
        >
          The verifier reports: {failed.reason}. Nothing computed from its methodology is shown: no name, no composition
          and no rules. What the registry stores and the full report are under Verification.
        </Callout>
      )}
    </>
  );
}

/** The stored bytes as text, or `null` when they are not well-formed UTF-8. */
function specTextOf(view: IndexVersionView): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(view.specBytes.slice(2), "hex"),
    );
  } catch {
    return null;
  }
}

const SECTIONS = [
  { href: "#composition-heading", label: "Composition" },
  { href: "#verification-heading", label: "Verification" },
  { href: "#methodology-heading", label: "Methodology" },
  { href: "#versions-heading", label: "Version history" },
  { href: "#performance-heading", label: "Performance" },
] as const;

/**
 * The fact page of one version of an index, in a fixed order: header, key facts, composition, verification,
 * methodology, version history, performance. `version` is `null` for the latest version.
 *
 * The registry is read before anything is sent, so a redirect and a missing index have their real HTTP status.
 * Only the regions that need market data are streamed.
 */
export async function IndexProfilePage({ identifier, version }: { identifier: string; version: number | null }) {
  const profile = await resolveProfile(identifier, version);
  if (profile.status === "registry_not_deployed") {
    return (
      <Container className="py-8 md:py-12">
        <h1 className="text-xl font-medium">Indexes</h1>
        <div className="mt-6">
          <RegistryNotDeployedState {...profile} />
        </div>
      </Container>
    );
  }
  if (profile.status !== "ok") notFound();
  const { index, version: view, history } = profile;
  // An index id, or an identifier in another letter case, resolves: the canonical URL is the only one served.
  if (index.identifier !== identifier) redirect(profilePath(index.identifier, version));

  const snapshot: SnapshotResult = view.conformant
    ? getMarketData()
        .getSnapshot()
        .catch((error: unknown) => {
          console.error(`index profile ${index.identifier}: market data unavailable`, error);
          return null;
        })
    : Promise.resolve(null);
  const firstPublishedAt = index.head.createdAt;

  return (
    <Container className="flex flex-col gap-8 py-8 md:py-12">
      <Header profile={profile} name={displayName(view)} />
      <div className="flex flex-col gap-3 empty:hidden">
        <Notices profile={profile} />
      </div>

      {view.conformant ? (
        <>
          <div>
            <StatGrid columns={4}>
              <Stat label="Constituents" value={formatCount(BigInt(view.constituents.length))} />
              <Stat label="Largest weight" value={formatPercent(BigInt(largestWeightBps(view.constituents)))} />
              <Stat
                label="Rebalance rule"
                value={formatPoints(view.spec.rebalance.driftThresholdBps)}
                unit={
                  view.spec.rebalance.minIntervalSeconds === 0
                    ? "drift"
                    : `drift, ${formatDuration(view.spec.rebalance.minIntervalSeconds)} min`
                }
              />
              <Stat label="Last published" value={formatUtcDate(index.latest.publishedAt)} unit="UTC" />
            </StatGrid>
            <nav aria-label="Sections" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {SECTIONS.map(({ href, label }) => (
                <a key={href} href={href} className="rounded-sm text-accent underline-offset-[3px] hover:underline">
                  {label}
                </a>
              ))}
            </nav>
          </div>

          <section aria-labelledby="composition-heading">
            <h2 id="composition-heading" className="text-lg font-medium">
              Composition
            </h2>
            <p className="mt-1 mb-3 max-w-measure text-secondary">
              {weightingLabel(view.spec)}. The weights are the ones published with this version. Prices and status are
              read now and can differ from the day of publication.
            </p>
            <Suspense fallback={<CompositionSkeleton view={view} />}>
              <Composition view={view} snapshot={snapshot} />
            </Suspense>
          </section>
        </>
      ) : null}

      <VerificationPanel
        view={view}
        specText={specTextOf(view)}
        currentStatus={
          view.conformant ? (
            <Suspense fallback={<p className="text-secondary">Reading the current status of the constituents.</p>}>
              <CurrentStatus view={view} snapshot={snapshot} />
            </Suspense>
          ) : (
            <p className="text-secondary">Not evaluated: this version has no verified composition to check.</p>
          )
        }
      />

      {view.conformant ? <Methodology spec={view.spec} /> : null}
      <VersionHistory
        identifier={index.identifier}
        history={history}
        total={index.head.latestVersion}
        shown={view.version}
      />
      {view.conformant ? <Performance firstPublishedAt={firstPublishedAt} /> : null}
    </Container>
  );
}
