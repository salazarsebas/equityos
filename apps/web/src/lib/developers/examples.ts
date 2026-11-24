import recorded from "@/server/api/examples.json";

/** A response of the API recorded from the test fixtures: example data, not current data. */
export interface ApiExample {
  readonly name: string;
  readonly operationId: string;
  readonly title: string;
  /** Path and query from the origin, starting with `/api/v1`. */
  readonly path: string;
  readonly registry: string;
  readonly status: number;
  readonly body: unknown;
}

/** Where the examples were recorded, in one sentence, as the file states it. */
export const EXAMPLES_SOURCE: string = recorded.description;

const EXAMPLES: readonly ApiExample[] = recorded.examples;

/** The recorded examples of one operation, in the order they were recorded. */
export function examplesOf(operationId: string): readonly ApiExample[] {
  return EXAMPLES.filter((example) => example.operationId === operationId);
}

/** One recorded example by name. Throws if it does not exist, which fails the build. */
export function apiExample(name: string): ApiExample {
  const found = EXAMPLES.find((example) => example.name === name);
  if (found === undefined) throw new Error(`no recorded API example named ${name}`);
  return found;
}

/** The body as the API sends it, indented by two spaces. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A curl command for a path of this deployment. */
export function curlCommand(origin: string, path: string): string {
  return `curl "${origin}${path}"`;
}
