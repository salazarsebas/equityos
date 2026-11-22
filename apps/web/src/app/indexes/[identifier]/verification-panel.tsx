import type { CheckResult } from "@equityos/core";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { cx } from "@/components/ui/cx";
import { CheckIcon, CrossIcon, WarningIcon } from "@/components/ui/icons";
import { Link } from "@/components/ui/link";
import { formatCount, formatUtcDateTime, toIsoInstant } from "@/lib/format";
import { chainName, explorerAddressUrl } from "@/lib/indexes/chains";
import { CHECK_MEANINGS, CHECK_STATUS_LABELS } from "@/lib/indexes/checks";
import { verificationCommands } from "@/lib/indexes/commands";
import { site } from "@/lib/site";
import type { IndexVersionView } from "@/server/registry";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t px-4 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-32 shrink-0 text-xs text-secondary">{term}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{children}</dd>
    </div>
  );
}

/** A hash, id or address in full: monospace, wrapping anywhere, with a copy control. */
function Identifier({ value, label }: { value: string; label: string }) {
  return (
    <>
      <span className="font-mono text-sm break-all">{value}</span>
      <CopyButton value={value} label={`Copy ${label}`} />
    </>
  );
}

function CheckStatus({ status }: Pick<CheckResult, "status">) {
  const Icon = status === "pass" ? CheckIcon : status === "fail" ? CrossIcon : null;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 font-medium whitespace-nowrap",
        status === "fail" && "text-negative",
        status === "skipped" && "text-secondary",
      )}
    >
      {Icon ? <Icon className="shrink-0" /> : null}
      {CHECK_STATUS_LABELS[status]}
    </span>
  );
}

/** One check: its id, what it means in one sentence, its result and the reason the verifier gave. */
function CheckRow({ check }: { check: CheckResult }) {
  const { name, meaning } = CHECK_MEANINGS[check.id];
  return (
    <li
      data-check={check.id}
      data-status={check.status}
      className={cx(
        "grid grid-cols-[2.5rem_1fr_auto] gap-x-2 border-t px-4 py-3",
        check.status === "fail" && "bg-negative-subtle",
      )}
    >
      <span className="font-mono text-sm text-secondary">{check.id}</span>
      <p className="font-medium">{name}</p>
      <CheckStatus status={check.status} />
      <div className="col-span-2 col-start-2 min-w-0">
        <p className="max-w-measure text-secondary">{meaning}</p>
        <p className="mt-1 text-xs break-words text-secondary">
          <span className="sr-only">Result: </span>
          {check.reason}
        </p>
      </div>
    </li>
  );
}

/** A short piece of monospace text, such as a command, that wraps anywhere, with a copy control. */
function CodeBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-subtle px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
      <pre className="min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap">{value}</pre>
      <CopyButton value={value} label={`Copy ${label}`} className="self-end sm:self-start" />
    </div>
  );
}

/**
 * The exact stored spec in a read-only text field: it wraps anywhere, scrolls inside its frame, is reachable
 * by keyboard and can be selected in full without JavaScript. It takes the height of its content up to a
 * limit where the browser supports that, and six rows elsewhere.
 */
function SpecField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-end gap-2">
      <textarea
        readOnly
        aria-label={label}
        rows={6}
        value={value}
        spellCheck={false}
        className="block field-sizing-content max-h-64 w-full resize-y rounded-md border bg-subtle px-3 py-2 font-mono text-sm break-all"
      />
      <CopyButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

type VerificationPanelProps = {
  view: IndexVersionView;
  /** The spec bytes as text. `null` when they are not UTF-8, or when the version is not conformant. */
  specText: string | null;
  /** The current status of the constituents: time-dependent, so it is not one of the checks above it. */
  currentStatus: ReactNode;
};

/**
 * What the chain stores for a version, the result of checks C1 to C5 on it, and how to repeat the
 * verification without trusting this page.
 */
export function VerificationPanel({ view, specText, currentStatus }: VerificationPanelProps) {
  const { checks } = view.verification;
  const failed = checks.find(({ status }) => status === "fail");
  const registryUrl = explorerAddressUrl(view.chainId, view.registry);
  const commands = verificationCommands({
    chainId: view.chainId,
    registry: view.registry,
    indexId: view.indexId,
    version: view.version,
    siteUrl: site.url,
  });
  const specSize = (view.specBytes.length - 2) / 2;

  return (
    <section aria-labelledby="verification-heading" className="rounded-lg border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3">
        <h2 id="verification-heading" className="text-lg font-medium">
          Verification
        </h2>
        <p
          data-testid="verification-result"
          className={cx("inline-flex items-center gap-2 font-medium", failed && "text-negative")}
        >
          {failed ? <WarningIcon className="shrink-0" /> : <CheckIcon className="shrink-0" />}
          {failed
            ? `Fails check ${failed.id}: ${CHECK_MEANINGS[failed.id].name.toLowerCase()}`
            : `All ${checks.length} checks pass`}
        </p>
      </header>

      <h3 className="border-t bg-subtle px-4 py-2 text-xs font-medium text-secondary">Stored onchain</h3>
      <dl className="-mt-px">
        <Fact term="Spec hash">
          <Identifier value={view.specHash} label="spec hash" />
        </Fact>
        <Fact term="Index id">
          <Identifier value={view.indexId} label="index id" />
        </Fact>
        <Fact term="Registry">
          {registryUrl ? (
            <Link href={registryUrl} variant="quiet" className="font-mono text-sm break-all">
              {view.registry}
            </Link>
          ) : (
            <span className="font-mono text-sm break-all">{view.registry}</span>
          )}
        </Fact>
        <Fact term="Chain">
          <span className="num">
            {chainName(view.chainId)}, chain id {view.chainId}
          </span>
        </Fact>
        <Fact term="Published">
          <span className="num">
            Block {formatCount(view.publishedBlock)},{" "}
            <time dateTime={toIsoInstant(view.publishedAt)}>{formatUtcDateTime(view.publishedAt)}</time>
          </span>
        </Fact>
        <Fact term="Spec size">
          <span className="num">{formatCount(BigInt(specSize))} bytes</span>
        </Fact>
      </dl>

      <h3 className="border-t bg-subtle px-4 py-2 text-xs font-medium text-secondary">
        Checks on the stored version. Their result never changes
      </h3>
      <ol className="-mt-px">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ol>

      <h3 className="border-t bg-subtle px-4 py-2 text-xs font-medium text-secondary">
        Status of the assets now. It can change at any block
      </h3>
      <div className="border-t px-4 py-3">{currentStatus}</div>

      <details className="group border-t">
        <summary className="flex h-10 cursor-pointer items-center gap-2 px-4 font-medium text-accent -outline-offset-2 pointer-coarse:h-11">
          Verify it yourself
          <span className="text-sm font-normal text-secondary group-open:hidden">Spec, hash and three commands</span>
        </summary>
        <div className="flex flex-col gap-4 border-t px-4 py-4">
          <div>
            <h4 className="font-medium">{specText === null ? "Stored spec bytes" : "Canonical spec"}</h4>
            <p className="mt-1 mb-2 max-w-measure text-secondary">
              {specText === null
                ? "The bytes the registry stores, in hexadecimal. They did not pass verification, so they are not shown as a methodology."
                : "The exact bytes the registry stores, as UTF-8 text: one line, no whitespace, properties in sorted order. Hashing these bytes with keccak256 gives the spec hash."}
            </p>
            <SpecField value={specText ?? view.specBytes} label={specText === null ? "spec bytes" : "canonical spec"} />
          </div>
          <div>
            <h4 className="font-medium">Spec hash</h4>
            <p className="mt-1 font-mono text-sm break-all">{view.specHash}</p>
          </div>
          <ol className="flex flex-col gap-4">
            {commands.map(({ id, title, expect, command }, index) => (
              <li key={id}>
                <h4 className="font-medium">
                  <span className="num">{index + 1}.</span> {title}
                </h4>
                <p className="mt-1 mb-2 max-w-measure text-secondary">{expect}</p>
                <CodeBlock value={command} label={`command ${index + 1}`} />
              </li>
            ))}
          </ol>
          <p className="max-w-measure text-xs text-secondary">
            <span className="font-mono">cast</span> is the command line client of Foundry. The first two commands read
            the chain directly and do not depend on this site.
          </p>
        </div>
      </details>
    </section>
  );
}
