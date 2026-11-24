import type { Metadata } from "next";
import { Container } from "@/components/shell/container";
import { CodeBlock } from "@/components/ui/code-block";
import { Link } from "@/components/ui/link";
import { ERROR_CODES } from "@/lib/developers/error-codes";
import { curlCommand, EXAMPLES_SOURCE, examplesOf, prettyJson } from "@/lib/developers/examples";
import { apiOrigin } from "@/lib/developers/links";
import {
  type ApiOperation,
  describeType,
  fieldRows,
  type OperationEntry,
  operationsByTag,
} from "@/lib/developers/openapi-view";
import { openApiDocument } from "@/server/api/openapi";
import { FieldList, schemaAnchor, TypeLabel } from "./schema-view";

export const metadata: Metadata = {
  title: "API reference",
  description:
    "Every endpoint of the EquityOS public API v1, generated from its OpenAPI document: parameters, response schemas, error codes and recorded example responses.",
  alternates: { canonical: "/developers/api" },
};

const API_BASE = "/api/v1";

/** A path that may break only after a slash, so that a segment is never split. */
function PathText({ path }: { path: string }) {
  const segments = path.split("/");
  return (
    <>
      {segments.map((segment, i) => (
        <span key={segments.slice(0, i + 1).join("/")}>
          {i > 0 ? "/" : null}
          {segment}
          {i < segments.length - 1 && i > 0 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}

function Method({ method }: { method: string }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center rounded-sm border px-1.5 font-mono text-xs font-medium text-secondary">
      {method}
    </span>
  );
}

function Heading({ id, children }: { id: string; children: string }) {
  return (
    <h4 id={id} className="mt-6 mb-2 text-sm font-medium text-secondary">
      {children}
    </h4>
  );
}

function Parameters({ operation, id }: { operation: ApiOperation; id: string }) {
  const parameters = operation.parameters ?? [];
  if (parameters.length === 0) return null;
  return (
    <>
      <Heading id={`${id}-parameters`}>Parameters</Heading>
      <ul aria-labelledby={`${id}-parameters`} className="border-b">
        {parameters.map((parameter) => (
          <li key={`${parameter.in}-${parameter.name}`} className="border-t py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <code className="font-mono text-sm font-medium text-primary">{parameter.name}</code>
              <span className="text-sm text-secondary">
                {parameter.in}, <TypeLabel type={describeType(parameter.schema)} />,{" "}
                {parameter.required ? "required" : "optional"}
              </span>
            </div>
            <p className="mt-0.5 max-w-measure text-sm text-secondary">{parameter.description}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function Responses({ operation, id }: { operation: ApiOperation; id: string }) {
  const entries = Object.entries(operation.responses);
  return (
    <>
      <Heading id={`${id}-responses`}>Responses</Heading>
      <ul aria-labelledby={`${id}-responses`} className="border-b">
        {entries.map(([status, response]) => {
          const schema = response.content["application/json"].schema;
          const rows = status === "200" && schema.properties !== undefined ? fieldRows(schema) : null;
          return (
            <li key={status} className="grid grid-cols-[3rem_1fr] gap-x-3 border-t py-2">
              <span className="num font-mono text-sm font-medium">{status}</span>
              <div className="min-w-0">
                <p className="max-w-measure text-sm text-secondary">{response.description}</p>
                {rows === null ? (
                  <p className="mt-0.5 text-xs text-secondary">
                    Body <TypeLabel type={describeType(schema)} />
                  </p>
                ) : (
                  <div className="mt-1">
                    <FieldList rows={rows} label={`Body of the ${status} response`} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Endpoint({ entry, origin }: { entry: OperationEntry; origin: string }) {
  const { method, path, operation } = entry;
  const id = operation.operationId;
  const examples = examplesOf(id);
  const request = examples.find(({ status }) => status === 200)?.path ?? `${API_BASE}${path}`;
  return (
    <section aria-labelledby={id} className="scroll-mt-6 border-t pt-6 pb-10">
      <h3 id={id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Method method={method} />
        <code className="min-w-0 font-mono text-md font-medium">
          <PathText path={`${API_BASE}${path}`} />
        </code>
      </h3>
      <p className="mt-2 font-medium">{operation.summary}</p>
      <p className="mt-1 max-w-measure text-secondary">{operation.description}</p>

      <Heading id={`${id}-request`}>Request</Heading>
      <CodeBlock title="Shell" code={curlCommand(origin, request)} copyLabel={`${id} request`} />

      <Parameters operation={operation} id={id} />
      <Responses operation={operation} id={id} />

      {examples.length === 0 ? null : (
        <>
          <Heading id={`${id}-examples`}>Recorded examples</Heading>
          <ul aria-labelledby={`${id}-examples`} className="flex flex-col gap-2">
            {examples.map((example) => (
              <li key={example.name}>
                <details className="group rounded-md border">
                  <summary className="flex min-h-10 cursor-pointer flex-wrap items-center gap-x-3 px-3 py-2 text-sm -outline-offset-2 pointer-coarse:min-h-11">
                    <span className="num font-mono font-medium">{example.status}</span>
                    <span className="font-medium text-accent">{example.title}</span>
                    <code className="min-w-0 font-mono text-xs break-all text-secondary">{example.path}</code>
                  </summary>
                  <CodeBlock
                    title={`Response ${example.status}`}
                    code={prettyJson(example.body)}
                    copyLabel={`${example.name} response`}
                    overflow="scroll"
                    tall
                    className="rounded-none border-x-0 border-b-0"
                  />
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The endpoints of the page by tag, then the error codes and the schemas. */
function EndpointIndex({ groups }: { groups: ReturnType<typeof operationsByTag> }) {
  return (
    <nav aria-label="Endpoints">
      {groups.map(({ tag, operations }) => (
        <div key={tag} className="mb-4">
          <p className="mb-1 text-xs text-secondary">{tag}</p>
          <ul className="flex flex-col">
            {operations.map(({ method, path, operation }) => (
              <li key={operation.operationId}>
                <a
                  href={`#${operation.operationId}`}
                  className="flex gap-2 rounded-sm py-1 text-primary hover:text-accent pointer-coarse:py-3"
                >
                  <span className="w-8 shrink-0 font-mono text-xs leading-5 text-secondary">{method}</span>
                  <span className="min-w-0 font-mono text-xs leading-5">
                    <PathText path={path} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="mb-1 text-xs text-secondary">Reference</p>
      <ul>
        <li>
          <a href="#errors" className="block rounded-sm py-1 text-sm hover:text-accent pointer-coarse:py-3">
            Error codes
          </a>
        </li>
        <li>
          <a href="#schemas" className="block rounded-sm py-1 text-sm hover:text-accent pointer-coarse:py-3">
            Schemas
          </a>
        </li>
      </ul>
    </nav>
  );
}

export default function ApiReferencePage() {
  const origin = apiOrigin();
  const groups = operationsByTag(openApiDocument);
  const { info, components } = openApiDocument;
  return (
    <Container className="pt-8 pb-16 md:pt-12">
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-12">
        <div className="hidden lg:col-span-3 lg:block">
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pr-2">
            <EndpointIndex groups={groups} />
          </div>
        </div>

        <div className="min-w-0 lg:col-span-9">
          <h1 className="text-xl font-medium md:text-2xl">API reference</h1>
          <p className="mt-3 max-w-measure text-md text-secondary">{info.description}</p>
          <dl className="mt-6 grid max-w-measure grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-y py-3">
            <dt className="text-sm text-secondary">Base URL</dt>
            <dd className="min-w-0 font-mono text-sm break-all">
              {origin}
              {API_BASE}
            </dd>
            <dt className="text-sm text-secondary">Version</dt>
            <dd className="num font-mono text-sm">{info.version}</dd>
            <dt className="text-sm text-secondary">Source</dt>
            <dd className="text-sm">
              Generated from <Link href={`${API_BASE}/openapi.json`}>the OpenAPI document</Link> this deployment serves.
            </dd>
          </dl>
          <p className="mt-3 max-w-measure text-xs text-secondary">Examples: {EXAMPLES_SOURCE}</p>
          <div className="mt-8 lg:hidden">
            <EndpointIndex groups={groups} />
          </div>

          {groups.map(({ tag, description, operations }) => (
            <section key={tag} aria-labelledby={`tag-${tag}`} className="mt-12">
              <h2 id={`tag-${tag}`} className="text-lg font-medium">
                {tag}
              </h2>
              <p className="mt-1 mb-4 max-w-measure text-secondary">{description}</p>
              {operations.map((entry) => (
                <Endpoint key={entry.operation.operationId} entry={entry} origin={origin} />
              ))}
            </section>
          ))}

          <section aria-labelledby="errors" className="mt-12">
            <h2 id="errors" className="scroll-mt-6 text-lg font-medium">
              Error codes
            </h2>
            <p className="mt-1 mb-4 max-w-measure text-secondary">
              A failed request answers with{" "}
              <code className="font-mono text-sm text-primary">{"{ error: { code, message, details } }"}</code>. The
              code is stable: branch on it, never on the message. A code added later within v1 must be treated as
              unknown, not as a failure of the client.
            </p>
            <ul aria-label="Error codes" className="border-b">
              {Object.entries(ERROR_CODES).map(([code, { status, meaning }]) => (
                <li key={code} className="grid grid-cols-[3rem_1fr] gap-x-3 border-t py-2">
                  <span className="num font-mono text-sm">{status}</span>
                  <div className="min-w-0">
                    <code className="font-mono text-sm font-medium break-all">{code}</code>
                    <p className="mt-0.5 max-w-measure text-sm text-secondary">{meaning}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="schemas" className="mt-12">
            <h2 id="schemas" className="scroll-mt-6 text-lg font-medium">
              Schemas
            </h2>
            <p className="mt-1 mb-4 max-w-measure text-secondary">
              Every object is closed and every key is always present: a value that does not exist is null, next to a
              field that says why. Optional fields appear only in the published spec, which is returned as its author
              wrote it.
            </p>
            {Object.entries(components.schemas).map(([name, schema]) => (
              <section
                key={name}
                id={schemaAnchor(name)}
                aria-labelledby={`${schemaAnchor(name)}-heading`}
                className="scroll-mt-6 border-t pt-4 pb-6"
              >
                <h3 id={`${schemaAnchor(name)}-heading`} className="font-mono text-md font-medium">
                  {name}
                </h3>
                {schema.description === undefined ? null : (
                  <p className="mt-1 max-w-measure text-sm text-secondary">{schema.description}</p>
                )}
                <div className="mt-2">
                  {schema.properties === undefined ? (
                    <p className="text-sm text-secondary">
                      <TypeLabel type={describeType(schema)} />
                    </p>
                  ) : (
                    <FieldList rows={fieldRows(schema)} label={`Fields of ${name}`} />
                  )}
                </div>
              </section>
            ))}
          </section>
        </div>
      </div>
    </Container>
  );
}
