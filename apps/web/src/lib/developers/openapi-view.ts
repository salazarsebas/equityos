import type { OpenApiDocument, Schema } from "@/server/api/openapi";

/** The type of a value, as the API reference shows it. */
export type TypeNode =
  /** A named schema of `components.schemas`, linked to its description. */
  | { readonly kind: "ref"; readonly name: string }
  /** A non-negative integer in a decimal string: an amount, a price, a block number. */
  | { readonly kind: "uint" }
  | { readonly kind: "scalar"; readonly name: string; readonly detail: string | null }
  | { readonly kind: "const"; readonly value: string }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "array"; readonly items: TypeNode }
  | { readonly kind: "nullable"; readonly inner: TypeNode }
  | { readonly kind: "oneOf"; readonly options: readonly TypeNode[] }
  /** An object written in place. Its fields are listed under it. */
  | { readonly kind: "object" };

/** One field of an object, with the fields of an object written in place under it. */
export interface FieldRow {
  /** Dotted path from the object being described: `totals.investedValueUsdE8`, `legs[].side`. */
  readonly path: string;
  readonly depth: number;
  readonly type: TypeNode;
  readonly required: boolean;
  readonly description: string | null;
}

/** The schema name of a `$ref`, such as `Asset` for `#/components/schemas/Asset`. */
export function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function range(schema: Schema): string | null {
  const { minimum, maximum } = schema;
  if (minimum !== undefined && maximum !== undefined) return `${minimum} to ${maximum}`;
  if (minimum !== undefined) return `${minimum} or more`;
  if (maximum !== undefined) return `at most ${maximum}`;
  return null;
}

export function describeType(schema: Schema): TypeNode {
  if (schema.$ref !== undefined) {
    const name = refName(schema.$ref);
    return name === "UintString" ? { kind: "uint" } : { kind: "ref", name };
  }
  if (schema.anyOf !== undefined) {
    const nonNull = schema.anyOf.filter((member) => member.type !== "null");
    const inner: TypeNode =
      nonNull.length === 1 && nonNull[0] !== undefined
        ? describeType(nonNull[0])
        : { kind: "oneOf", options: nonNull.map(describeType) };
    return nonNull.length < schema.anyOf.length ? { kind: "nullable", inner } : inner;
  }
  if (schema.const !== undefined) return { kind: "const", value: JSON.stringify(schema.const) };
  if (schema.enum !== undefined) return { kind: "enum", values: schema.enum.map((value) => String(value)) };
  switch (schema.type) {
    case "array":
      return { kind: "array", items: schema.items === undefined ? { kind: "object" } : describeType(schema.items) };
    case "object":
      return schema.properties === undefined ? { kind: "scalar", name: "object", detail: null } : { kind: "object" };
    case "string":
      return { kind: "scalar", name: "string", detail: schema.pattern === undefined ? null : schema.pattern };
    case "integer":
      return { kind: "scalar", name: "integer", detail: range(schema) };
    default:
      return { kind: "scalar", name: schema.type ?? "any", detail: null };
  }
}

/** The object schema written in place inside `schema`, through arrays and nullability, if there is one. */
function inlineObject(schema: Schema): Schema | null {
  if (schema.$ref !== undefined) return null;
  if (schema.properties !== undefined) return schema;
  if (schema.items !== undefined) return inlineObject(schema.items);
  for (const member of schema.anyOf ?? []) {
    const found = inlineObject(member);
    if (found !== null) return found;
  }
  return null;
}

function arraySuffix(schema: Schema): string {
  if (schema.type === "array") return "[]";
  for (const member of schema.anyOf ?? []) if (member.type === "array") return "[]";
  return "";
}

/** The fields of an object schema in document order, with objects written in place expanded under their field. */
export function fieldRows(schema: Schema, prefix = "", depth = 0): FieldRow[] {
  const required = new Set(schema.required ?? []);
  const rows: FieldRow[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    rows.push({
      path,
      depth,
      type: describeType(property),
      required: required.has(name),
      description: property.description ?? null,
    });
    const nested = inlineObject(property);
    if (nested !== null) rows.push(...fieldRows(nested, `${path}${arraySuffix(property)}.`, depth + 1));
  }
  return rows;
}

type PathItem = OpenApiDocument["paths"][string];
export type ApiOperation = PathItem[keyof PathItem];

export interface OperationEntry {
  readonly method: string;
  readonly path: string;
  readonly operation: ApiOperation;
}

/** Every operation of the document, whatever its method, grouped by its first tag in the order of `tags`. */
export function operationsByTag(
  document: OpenApiDocument,
): readonly { readonly tag: string; readonly description: string; readonly operations: OperationEntry[] }[] {
  const entries: OperationEntry[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      entries.push({ method: method.toUpperCase(), path, operation });
    }
  }
  return document.tags
    .map(({ name, description }) => ({
      tag: name,
      description,
      operations: entries.filter(({ operation }) => operation.tags[0] === name),
    }))
    .filter(({ operations }) => operations.length > 0);
}
