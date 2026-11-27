import { BASE_MAINNET_CHAIN_ID, DEPLOYMENTS, INDEX_REGISTRY_ADDRESS } from "@equityos/contracts-abi";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { Link } from "@/components/ui/link";
import { formatCount, formatPercent } from "@/lib/format";
import type { ExampleSpec } from "@/lib/landing/example-spec";
import { site } from "@/lib/site";
import { Code, Section, Step } from "./parts";

const docs = (path: string) => `${site.repositoryUrl}/blob/main/docs/${path}`;

export const METHODOLOGY_SPEC_URL = docs("architecture/methodology-spec.md");

export function Hero() {
  return (
    <div className="mx-auto w-full max-w-content px-4 pt-12 pb-12 md:px-8 md:pt-20 md:pb-16">
      <h1 className="max-w-[18em] text-2xl font-medium text-balance md:text-3xl">
        Open, verifiable indexes for tokenized stocks on Base
      </h1>
      <p className="mt-6 max-w-measure text-md text-secondary">
        An index on {site.name} is a published rule set: which tokens, at what weights, and when to rebalance. Its hash
        is stored onchain, anyone can recompute its weights, and whoever follows it holds the tokens in their own
        wallet. It is not a fund.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <NextLink
          href="/indexes"
          className="inline-flex h-10 items-center rounded-md bg-accent px-4 font-medium text-accent-fg transition-colors duration-[120ms] hover:bg-accent-hover pointer-coarse:h-11"
        >
          Explore indexes
        </NextLink>
        <NextLink
          href="/developers"
          className="inline-flex h-10 items-center rounded-md border border-strong bg-surface px-4 font-medium text-primary transition-colors duration-[120ms] hover:bg-subtle pointer-coarse:h-11"
        >
          Read the API docs
        </NextLink>
      </div>
    </div>
  );
}

function Distinction({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="border-t pt-3">
      <dt className="font-medium text-primary">{term}</dt>
      <dd className="mt-1 text-secondary">{children}</dd>
    </div>
  );
}

export function RuleSet({ example, executionReleased }: { example: ExampleSpec; executionReleased: boolean }) {
  return (
    <Section
      id="rule-set"
      title="An index is a rule set, not a fund"
      lead="Four things are easy to confuse. EquityOS keeps them apart, and only the first one is the index."
    >
      <dl className="grid gap-x-6 gap-y-4 text-base sm:grid-cols-2">
        <Distinction term="Index">
          A document that names the tokens, their target weights and the rebalance rule. Each version is stored onchain
          with its hash and never changes.
        </Distinction>
        <Distinction term="Portfolio">
          What a wallet actually holds. Following an index means holding its tokens yourself. {site.name} never holds
          them.
        </Distinction>
        <Distinction term="Execution">
          Trading toward the target weights. That is each holder's decision.{" "}
          {executionReleased ? "This site can prepare the trades." : "This site does not execute trades yet."}
        </Distinction>
        <Distinction term="Infrastructure">
          The registry contract, the open calculator and the public API. Any app can read and check the same data.
        </Distinction>
      </dl>

      <figure className="mt-10">
        <div className="overflow-hidden rounded-lg border bg-surface">
          <p className="border-b px-4 py-3 text-sm font-medium">Example document</p>
          <pre className="px-4 py-3 font-mono text-sm break-all whitespace-pre-wrap text-primary">
            <code>{example.canonicalText}</code>
          </pre>
          <dl className="grid border-t text-sm sm:grid-cols-[13rem_minmax(0,1fr)]">
            <dt className="px-4 pt-3 text-secondary sm:py-3">Spec hash (keccak256)</dt>
            <dd className="px-4 pb-3 font-mono break-all sm:py-3">{example.specHash}</dd>
            <dt className="border-t px-4 pt-3 text-secondary sm:py-3">Weights (equityos.calc/1)</dt>
            <dd className="num px-4 pb-3 sm:border-t sm:py-3">
              {example.weightsBps.map((weight) => formatPercent(weight)).join(", ")}
              <span className="text-secondary"> · the 1 bp left over goes to the lowest address</span>
            </dd>
          </dl>
        </div>
        <figcaption className="mt-2 max-w-measure text-xs text-secondary">
          Test vector <span className="font-mono">{example.vectorName}</span> of @equityos/core,{" "}
          {formatCount(BigInt(example.byteLength))} bytes. Its token and feed addresses are placeholders. The hash and
          the weights are computed from the document by the open calculator, not copied.
        </figcaption>
      </figure>
    </Section>
  );
}

export function Holder({ executionReleased }: { executionReleased: boolean }) {
  return (
    <Section
      id="holder"
      title="Compare a wallet with an index"
      lead="Following an index is a comparison anyone can repeat, not an account. Nothing is stored."
    >
      <ol className="flex flex-col gap-6">
        <Step number={1} title="Pick an index and an address">
          <p className="max-w-measure">
            Any address on Base. Connecting a wallet is optional and only fills in its public address.
          </p>
        </Step>
        <Step number={2} title="See the drift">
          <p className="max-w-measure">
            For each token, the weight the wallet holds minus the target weight, in percentage points, against the drift
            threshold the index publishes.
          </p>
        </Step>
        <Step number={3} title="Preview a plan at reference prices">
          <p className="max-w-measure">
            The trades that would bring the wallet back to its targets. Reference prices come from oracle feeds and are
            not executable prices, so real trades will differ.
          </p>
        </Step>
      </ol>
      <p className="mt-6 max-w-measure text-base">
        {executionReleased
          ? "Trades are prepared from the plan and signed in your wallet."
          : "Executing trades is not available on this site yet. The plan is arithmetic, not an instruction to trade."}{" "}
        <Link href="/portfolio">Compare a wallet</Link>
      </p>
    </Section>
  );
}

export function Developers() {
  const command = `curl -s "${site.url.replace(/\/+$/, "")}/api/v1/assets?eligible=true"`;
  return (
    <Section id="developers" title="Build on it" lead="The same data as JSON. Public reads need no key and no account.">
      <div className="flex flex-col gap-8">
        <div className="min-w-0 border-t pt-4">
          <h3 className="text-md font-medium">Through the API</h3>
          <p className="mt-1 text-base text-secondary">The index-eligible assets with their reference prices:</p>
          <div className="mt-3">
            <Code>{command}</Code>
          </div>
          <p className="mt-3 text-base text-secondary">
            Assets, indexes, single versions with their checks, and portfolio comparisons follow the same shape.
          </p>
          <p className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-base">
            <Link href="/developers/api">API reference</Link>
            <Link href="/api/v1/openapi.json">OpenAPI description</Link>
          </p>
        </div>
        <div className="min-w-0 border-t pt-4">
          <h3 className="text-md font-medium">Without this site</h3>
          <p className="mt-1 max-w-measure text-base text-secondary">
            Read <span className="font-mono text-sm break-all text-primary">IndexRegistry</span> with any Ethereum
            client and check what you read with @equityos/core. The registry address is the same on every chain:
          </p>
          <p className="mt-3 font-mono text-sm break-all">{INDEX_REGISTRY_ADDRESS}</p>
          <p className="mt-3 text-base">
            <Link href={METHODOLOGY_SPEC_URL}>Methodology specification</Link>
          </p>
        </div>
      </div>
    </Section>
  );
}

function Limit({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="border-t pt-3">
      <dt className="font-medium text-primary">{term}</dt>
      <dd className="mt-1 max-w-measure text-secondary">{children}</dd>
    </div>
  );
}

export function Limitations() {
  const mainnetBlock = DEPLOYMENTS[BASE_MAINNET_CHAIN_ID].deployBlock;
  return (
    <Section id="limitations" title="What it is not" lead="Read this before relying on anything here.">
      <dl className="grid gap-x-6 gap-y-4 text-base sm:grid-cols-2">
        <Limit term="Not a fund">
          {site.name} holds no assets and pools no money. The registry contracts cannot hold or move tokens.
        </Limit>
        <Limit term="Not advice">
          An index says what its rules imply, not whether to follow them. Nothing on this site is a recommendation.
        </Limit>
        <Limit term="Not audited">
          No external party has reviewed the contracts.{" "}
          <Link href={docs("security/index-registry.md")}>Security notes</Link>
        </Limit>
        {mainnetBlock === null ? (
          <Limit term="Not on Base mainnet yet">
            The registry is not deployed on Base mainnet, so no index can be published or followed there yet.
          </Limit>
        ) : (
          <Limit term="Deployed on Base mainnet">
            The registry was deployed on Base mainnet at block {formatCount(mainnetBlock)}.
          </Limit>
        )}
        <Limit term="Not an executable price">
          Reference prices come from oracle feeds and value a holding. No trade is guaranteed at them.
        </Limit>
        <Limit term="No automated execution">
          Every trade is signed in your own wallet. Automated rebalancing is a design and a test simulation only, not
          shipped. <Link href={docs("architecture/bounded-executor.md")}>Design</Link>
        </Limit>
        <Limit term="Not for trading by US persons">
          Execution is withheld from requests located in the United States and its territories. Reading works
          everywhere.
        </Limit>
      </dl>
    </Section>
  );
}
