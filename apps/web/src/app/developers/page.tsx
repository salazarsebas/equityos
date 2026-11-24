import type { Metadata } from "next";
import { Container } from "@/components/shell/container";
import { CodeBlock } from "@/components/ui/code-block";
import { Link } from "@/components/ui/link";
import { apiOrigin, REPOSITORY_DOCS } from "@/lib/developers/links";
import { apiExample, curlCommand, EXAMPLES_SOURCE, prettyJson } from "@/lib/developers/examples";
import { CHECK_MEANINGS } from "@/lib/indexes/checks";
import { API_VERSION } from "@/server/api/http";
import { Section } from "./parts";

export const metadata: Metadata = {
  title: "Developers",
  description:
    "Read and verify EquityOS indexes from your own code: a keyless read API, a typed TypeScript SDK, and verification of any published version from the registry contract.",
  alternates: { canonical: "/developers" },
};

const IDENTIFIER = "diversified-equity-d622e2a5";

const QUICKSTART = [
  {
    example: "listIndexes",
    title: "List the published indexes",
    text: "A page of indexes in creation order, each with its latest version and whether that version passes verification.",
  },
  {
    example: "getIndexComposition",
    title: "Read the composition of an index",
    text: "The constituents of the latest verified version with their target weights in basis points and the reference price of each token now.",
  },
  {
    example: "getPortfolioPlan",
    title: "Compare an address with the index and compute a plan",
    text: "The holdings of any address against the target weights, and the arithmetic toward them at reference prices. It is not a quote and not an instruction to trade.",
  },
] as const;

const BUILD = [
  {
    title: "Index pages in your product",
    text: "Composition, weights, versions and the verification report of any published index.",
  },
  {
    title: "Drift and rebalance views",
    text: "Any address compared with a version, and the plan toward its weights, from the same calculation this site uses.",
  },
  {
    title: "Independent verification",
    text: "Check a published version against the registry contract with your own RPC endpoint, without this site.",
  },
  {
    title: "Offline reproduction",
    text: "Recompute the canonical bytes, the spec hash and the weights of a methodology from its JSON alone.",
  },
] as const;

function sdkExample(origin: string): string {
  return `import { createClient } from "@equityos/sdk";

const client = createClient({ baseUrl: "${origin}" });
const { data } = await client.getIndexComposition("${IDENTIFIER}");
for (const c of data.constituents) console.log(c.symbol, c.targetWeightBps, c.referencePrice.priceE8);`;
}

const VERIFY_EXAMPLE = `import { INDEX_REGISTRY_ADDRESS, verifyIndexVersion } from "@equityos/sdk";

const result = await verifyIndexVersion({
  chainId: 31337,
  registry: INDEX_REGISTRY_ADDRESS,
  indexId: "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
  version: 2,
  rpcUrl: "http://127.0.0.1:8545",
});
console.log(result.conformant, result.checks.map((check) => \`\${check.id} \${check.status}\`));`;

const BUILD_SDK = `git clone https://github.com/salazarsebas/equityos.git && cd equityos
bun install
bun run --filter @equityos/sdk build`;

function Conventions({ origin }: { origin: string }) {
  const rows = [
    ["Base URL", <code key="url" className="font-mono text-sm break-all">{`${origin}/api/v1`}</code>],
    ["Access", "Every endpoint is a GET. No key, no account, open CORS."],
    [
      "Amounts",
      <span key="amounts">
        Integers in decimal strings. The scale is in the field name: <code className="font-mono text-sm">priceE8</code>{" "}
        is USD times 10^8.
      </span>,
    ],
    ["Weights", "Integer basis points. 10000 is 100%, and the weights of a version sum to exactly 10000."],
    ["Time", "ISO 8601 in UTC with second precision."],
    ["Addresses", "Lowercase hex. A path address is accepted in any letter case."],
    ["Missing values", "null next to a field that says why. Never zero."],
    [
      "Errors",
      <span key="errors">
        <code className="font-mono text-sm">{"{ error: { code, message, details } }"}</code>. Branch on code, which is
        stable.
      </span>,
    ],
    [
      "Version",
      <span key="version">
        <code className="font-mono text-sm">/api/v1</code>, contract <span className="num">{API_VERSION}</span>.
        Additive changes only within v1.
      </span>,
    ],
  ] as const;
  return (
    <aside aria-labelledby="conventions-heading" className="rounded-lg border bg-surface">
      <h2 id="conventions-heading" className="px-4 pt-3 pb-2 text-md font-medium">
        Conventions
      </h2>
      <dl>
        {rows.map(([term, value]) => (
          <div key={term} className="border-t px-4 py-2">
            <dt className="text-xs text-secondary">{term}</dt>
            <dd className="mt-0.5 text-base">{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

export default function DevelopersPage() {
  const origin = apiOrigin();
  const notDeployed = apiExample("listIndexes.registryNotDeployed");
  return (
    <Container className="pt-8 pb-16 md:pt-12">
      <h1 className="text-xl font-medium md:text-2xl">Developers</h1>
      <p className="mt-3 max-w-measure text-md text-secondary">
        Indexes are public methodologies stored in a registry contract. Read them through a keyless API, use them from
        TypeScript with the SDK, and verify any published version against the chain yourself, without trusting this
        site.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <Section id="build" title="What you can build" rule={false}>
            <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {BUILD.map(({ title, text }) => (
                <li key={title} className="border-t pt-3">
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 text-secondary">{text}</p>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <div className="lg:col-span-4 lg:row-span-2">
          <div className="lg:sticky lg:top-6">
            <Conventions origin={origin} />
          </div>
        </div>

        <div className="min-w-0 lg:col-span-8">
          <Section
            id="quickstart"
            title="Quickstart: three requests, no key"
            lead="Each command runs against this deployment. The response under it was recorded from the test fixtures, so it shows the shape of the answer, not current data."
          >
            <ol className="flex flex-col gap-8">
              {QUICKSTART.map(({ example: name, title, text }, index) => {
                const example = apiExample(name);
                return (
                  <li key={name} className="flex min-w-0 flex-col gap-3">
                    <div>
                      <h3 className="font-medium">
                        <span className="num text-secondary">{index + 1}.</span> {title}
                      </h3>
                      <p className="mt-1 max-w-measure text-secondary">{text}</p>
                    </div>
                    <CodeBlock
                      title="Shell"
                      code={curlCommand(origin, example.path)}
                      copyLabel={`request ${index + 1}`}
                    />
                    <details open={index === 0} className="group rounded-md border">
                      <summary className="flex h-10 cursor-pointer items-center px-3 text-sm font-medium text-accent -outline-offset-2 pointer-coarse:h-11">
                        Recorded response, status {example.status}
                      </summary>
                      <CodeBlock
                        title="JSON"
                        code={prettyJson(example.body)}
                        copyLabel={`response ${index + 1}`}
                        overflow="scroll"
                        tall
                        className="rounded-none border-x-0 border-b-0"
                      />
                    </details>
                  </li>
                );
              })}
            </ol>
            <div className="mt-8 text-secondary">
              <p className="max-w-measure">
                Where the index registry is not deployed on the chain a deployment reads, the index and portfolio
                endpoints answer <code className="font-mono text-sm text-primary">409 registry_not_deployed</code>{" "}
                instead of an empty list. <code className="font-mono text-sm text-primary">GET /api/v1/status</code>{" "}
                says which applies. The registry is deployed on a local development chain only today.
              </p>
              <CodeBlock
                title={`Recorded response, status ${notDeployed.status}`}
                code={prettyJson(notDeployed.body)}
                copyLabel="registry_not_deployed response"
                overflow="scroll"
                className="mt-3"
              />
              <p className="mt-3 max-w-measure text-xs">{EXAMPLES_SOURCE}</p>
            </div>
          </Section>
        </div>

        <div className="min-w-0 lg:col-span-8">
          <Section
            id="sdk"
            title="TypeScript SDK"
            lead={
              <p>
                <code className="font-mono text-sm text-primary">@equityos/sdk</code> is a typed client of every
                endpoint. Amounts arrive as <code className="font-mono text-sm text-primary">bigint</code>, values that
                do not exist as <code className="font-mono text-sm text-primary">null</code>, and each API error code as
                a typed error. It has no runtime dependency outside EquityOS.
              </p>
            }
          >
            <p className="mb-3 max-w-measure text-secondary">
              It is not published to a package registry yet. Build it from the repository:
            </p>
            <CodeBlock title="Shell" code={BUILD_SDK} copyLabel="build commands" />
            <CodeBlock
              title="TypeScript"
              code={sdkExample(origin)}
              copyLabel="SDK example"
              overflow="scroll"
              className="mt-4"
            />
          </Section>

          <Section
            id="verify"
            title="Verify without trusting this site"
            lead={
              <p>
                <code className="font-mono text-sm text-primary">verifyIndexVersion</code> reads the stored spec bytes,
                the spec hash and the constituents directly from the registry contract, through an RPC endpoint you
                choose, all at one block. It never calls this site.
              </p>
            }
          >
            <CodeBlock title="TypeScript" code={VERIFY_EXAMPLE} copyLabel="verification example" overflow="scroll" />
            <p className="mt-4 max-w-measure text-secondary">
              It refuses an endpoint on another chain, then runs the five checks of the methodology spec. A version is
              conformant only if all five pass, and only then does the result carry its methodology. The example runs
              against a local node after{" "}
              <code className="font-mono text-sm text-primary">bun run contracts:deploy:local</code> and{" "}
              <code className="font-mono text-sm text-primary">bun run seed:local</code>.
            </p>
            <ol className="mt-4 border-b">
              {Object.entries(CHECK_MEANINGS).map(([id, { name, meaning }]) => (
                <li key={id} className="grid grid-cols-[2.5rem_1fr] gap-x-2 border-t py-2">
                  <span className="font-mono text-sm text-secondary">{id}</span>
                  <p>
                    <span className="font-medium">{name}.</span> <span className="text-secondary">{meaning}</span>
                  </p>
                </li>
              ))}
            </ol>
          </Section>

          <Section id="reference" title="Reference">
            <ul className="flex flex-col gap-2">
              <li>
                <Link href="/developers/api">API reference</Link>
                <span className="text-secondary">: every endpoint, its parameters, responses and errors.</span>
              </li>
              <li>
                <Link href="/developers/spec">Methodology spec</Link>
                <span className="text-secondary">: the fields of equityos.index/1, its canonical form and hash.</span>
              </li>
              <li>
                <Link href="/api/v1/openapi.json">OpenAPI document</Link>
                <span className="text-secondary">: the contract the reference is generated from.</span>
              </li>
              <li>
                <Link href={REPOSITORY_DOCS.sdk}>SDK documentation</Link>
                <span className="text-secondary">: design, errors and how the types follow the OpenAPI document.</span>
              </li>
            </ul>
          </Section>
        </div>
      </div>
    </Container>
  );
}
