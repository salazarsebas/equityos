import {
  canonicalize,
  computeConstituents,
  MAX_CONSTITUENTS,
  MAX_DEPTH,
  MAX_SPEC_BYTES,
  MIN_CONSTITUENTS,
  specHash,
  validateSpec,
} from "@equityos/core";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Container } from "@/components/shell/container";
import { CodeBlock } from "@/components/ui/code-block";
import { cx } from "@/components/ui/cx";
import { Link } from "@/components/ui/link";
import { formatCount, formatPercent } from "@/lib/format";
import { apiExample, prettyJson } from "@/lib/developers/examples";
import { REPOSITORY_DOCS } from "@/lib/developers/links";
import { rulesBeyondSchema, specFields } from "@/lib/developers/spec-fields";
import { CHECK_MEANINGS } from "@/lib/indexes/checks";
import { Section } from "../parts";

export const metadata: Metadata = {
  title: "Methodology spec",
  description:
    "The equityos.index/1 methodology spec: every field with its type and constraints, the rules beyond the JSON Schema, the canonical form, the hash and an example computed at build time.",
  alternates: { canonical: "/developers/spec" },
};

/**
 * The example: version 2 of the index Diversified Equity, as the recorded registry of the test fixtures stores it.
 * Its canonical bytes, hash and weights are computed here, at build time, by `@equityos/core`.
 */
function buildExample() {
  const recorded = apiExample("getIndexVersion");
  const { data } = recorded.body as { data: { spec: unknown; specHash: string; identifier: string; version: number } };
  const validation = validateSpec(data.spec);
  if (!validation.ok) throw new Error("the recorded example spec is not valid");
  const bytes = canonicalize(validation.spec);
  const hash = specHash(bytes);
  if (hash !== data.specHash) throw new Error("the example spec does not hash to its recorded spec hash");
  return {
    spec: validation.spec,
    identifier: data.identifier,
    version: data.version,
    canonical: new TextDecoder().decode(bytes),
    size: bytes.length,
    hash,
    constituents: computeConstituents(validation.spec),
  };
}

const CONTENTS = [
  { id: "fields", label: "Fields" },
  { id: "rules", label: "Rules beyond the JSON Schema" },
  { id: "canonical", label: "Canonical form and hash" },
  { id: "example", label: "Example" },
  { id: "checks", label: "Verification" },
] as const;

/** Rule text with the property paths it names set in mono. */
function RuleText({ text }: { text: string }) {
  const parts: { readonly at: number; readonly text: string; readonly path: boolean }[] = [];
  let at = 0;
  for (const [i, part] of text.split(/([a-z]+\.[a-zA-Z]+(?:\.[a-zA-Z]+)*)/).entries()) {
    parts.push({ at, text: part, path: i % 2 === 1 });
    at += part.length;
  }
  return (
    <>
      {parts.map((part) =>
        part.path ? (
          <code key={part.at} className="font-mono text-sm">
            {part.text}
          </code>
        ) : (
          <span key={part.at}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-sm text-secondary">{term}</dt>
      <dd className="min-w-0 text-base">{children}</dd>
    </div>
  );
}

export default function SpecReferencePage() {
  const fields = specFields();
  const rules = rulesBeyondSchema();
  const example = buildExample();
  return (
    <Container className="pt-8 pb-16 md:pt-12">
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-12">
        <div className="hidden lg:col-span-3 lg:block">
          <nav aria-label="On this page" className="sticky top-6">
            <p className="mb-1 text-xs text-secondary">On this page</p>
            <ul>
              {CONTENTS.map(({ id, label }) => (
                <li key={id}>
                  <a href={`#${id}-heading`} className="block rounded-sm py-1 text-sm hover:text-accent">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="min-w-0 lg:col-span-9">
          <h1 className="text-xl font-medium md:text-2xl">
            Methodology spec <code className="font-mono">equityos.index/1</code>
          </h1>
          <p className="mt-3 max-w-measure text-md text-secondary">
            An index is one JSON document. Its canonical bytes are hashed with keccak256, and the hash identifies the
            methodology: given the document, anyone recomputes the same bytes, the same hash and the same weights. This
            reference is generated from the published JSON Schema of{" "}
            <code className="font-mono text-sm">@equityos/core</code>.
          </p>
          <CodeBlock
            title="Definition"
            code={"specBytes = UTF8(JCS(spec))        RFC 8785\nspecHash  = keccak256(specBytes)   32 bytes"}
            copyLabel="definition"
            overflow="scroll"
            className="mt-6"
          />

          <Section
            id="fields"
            title="Fields"
            lead="Every property is required unless marked otherwise. No other property is allowed at any level, null is never a valid value, and every number is an integer."
          >
            <ul aria-label="Fields of equityos.index/1" className="border-b">
              {fields.map((field) => (
                <li key={field.path} className={cx("border-t py-2", field.depth > 0 && "pl-4")}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <code className="font-mono text-sm font-medium break-all">{field.path}</code>
                    <span className="font-mono text-sm break-all text-secondary">{field.type}</span>
                    <span className="text-sm text-secondary">{field.presence}</span>
                  </div>
                  {field.constraints.length === 0 ? null : (
                    <p className="mt-0.5 text-sm break-all text-secondary">
                      {field.constraints.map((constraint, i) => (
                        <span key={constraint}>
                          {i > 0 ? "; " : null}
                          <span className={cx(/^[\^]/.test(constraint) && "font-mono")}>{constraint}</span>
                        </span>
                      ))}
                    </p>
                  )}
                  <p className="mt-0.5 max-w-measure text-sm">{field.meaning}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-secondary">
              An address is lowercase hexadecimal, so it has exactly one spelling. A weight is in basis points: 10000 is
              100%. The schema file is <Link href={REPOSITORY_DOCS.jsonSchema}>equityos.index-1.schema.json</Link>.
            </p>
          </Section>

          <Section
            id="rules"
            title="Rules beyond the JSON Schema"
            lead="A JSON Schema cannot express these. A document is valid only if it satisfies the schema and all of them. validateSpec enforces both and reports every violation with a JSON Pointer and a stable code."
          >
            <ol className="border-b">
              {rules.map((rule, i) => (
                <li key={rule} className="grid grid-cols-[2rem_1fr] gap-x-2 border-t py-2">
                  <span className="num text-secondary">{i + 1}.</span>
                  <p className="max-w-measure">
                    <RuleText text={rule} />
                  </p>
                </li>
              ))}
            </ol>
            <dl className="mt-6 border-b">
              <Fact term="Canonical form">
                <span className="num">at most {formatCount(BigInt(MAX_SPEC_BYTES))} bytes</span>
              </Fact>
              <Fact term="Constituents">
                <span className="num">
                  {MIN_CONSTITUENTS} to {MAX_CONSTITUENTS}
                </span>
              </Fact>
              <Fact term="Nesting on parse">
                <span className="num">at most {MAX_DEPTH} levels</span>
              </Fact>
            </dl>
          </Section>

          <Section
            id="canonical"
            title="Canonical form and hash"
            lead="The canonical form is the JSON Canonicalization Scheme of RFC 8785, encoded as UTF-8. For this document it reduces to the rules below."
          >
            <ul className="flex max-w-measure list-disc flex-col gap-1 pl-6">
              <li>No whitespace between tokens.</li>
              <li>Object properties sorted by name, as sequences of UTF-16 code units. Array order is kept.</li>
              <li>Integers in decimal digits: no fraction, no exponent, no leading zero.</li>
              <li>
                Strings in double quotes, with <code className="font-mono text-sm">&quot;</code> and{" "}
                <code className="font-mono text-sm">\</code> escaped and control characters escaped. Everything else is
                written as UTF-8. Unicode is not normalized, which is why the description must already be NFC.
              </li>
              <li>
                The hash is Keccak-256 as the EVM computes it, not NIST SHA3-256, written as{" "}
                <code className="font-mono text-sm">0x</code> and 64 lowercase hexadecimal digits.
              </li>
            </ul>
          </Section>

          <Section
            id="example"
            title="Example"
            lead={`Version ${example.version} of the example index ${example.identifier}, as the recorded registry of the test fixtures stores it, on a local development chain. The canonical bytes, the hash and the weights below were computed by @equityos/core when this page was built.`}
          >
            <div className="flex flex-col gap-4">
              <CodeBlock
                title="Document"
                code={prettyJson(example.spec)}
                copyLabel="example document"
                overflow="scroll"
                tall
              />
              <CodeBlock
                title={`Canonical bytes, ${formatCount(BigInt(example.size))} bytes as UTF-8`}
                code={example.canonical}
                copyLabel="canonical bytes"
              />
              <CodeBlock title="keccak256 of the canonical bytes" code={example.hash} copyLabel="spec hash" />
            </div>
            <h3 className="mt-6 mb-2 font-medium">Weights computed by equityos.calc/1</h3>
            <ul aria-label="Computed weights" className="border-b">
              {example.constituents.map(({ token, weightBps }) => (
                <li key={token} className="flex flex-wrap items-baseline justify-between gap-x-4 border-t py-2">
                  <code className="min-w-0 font-mono text-sm break-all">{token}</code>
                  <span className="num text-sm">
                    {formatCount(BigInt(weightBps))} bps, {formatPercent(BigInt(weightBps))}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-measure text-sm text-secondary">
              With <code className="font-mono text-sm">fixed</code> weighting each weight is the one written. With{" "}
              <code className="font-mono text-sm">equal</code> weighting every token gets floor(10000 / n) bps and the
              lowest addresses one more until the sum is 10000. Bounds never move a weight. More cases are in the{" "}
              <Link href={REPOSITORY_DOCS.vectors}>test vectors</Link>.
            </p>
          </Section>

          <Section
            id="checks"
            title="Verification of a published version"
            lead="A version is published as three values: the spec bytes, the spec hash and the constituents. Given those and the chain they were read from, five checks decide whether it is conformant. Their result never changes for a version."
          >
            <ol className="border-b">
              {Object.entries(CHECK_MEANINGS).map(([id, { name, meaning }]) => (
                <li key={id} className="grid grid-cols-[2.5rem_1fr] gap-x-2 border-t py-2">
                  <span className="font-mono text-sm text-secondary">{id}</span>
                  <p>
                    <span className="font-medium">{name}.</span> <span className="text-secondary">{meaning}</span>
                  </p>
                </li>
              ))}
            </ol>
            <p className="mt-3 max-w-measure text-sm text-secondary">
              A check whose requirement did not pass is not evaluated, so nothing is computed from a document that is
              not known to be valid. The full specification, with the parsing rules and the error codes, is{" "}
              <Link href={REPOSITORY_DOCS.methodology}>methodology-spec.md</Link>. Run the checks yourself with{" "}
              <Link href="/developers#verify">verifyIndexVersion</Link>.
            </p>
          </Section>
        </div>
      </div>
    </Container>
  );
}
