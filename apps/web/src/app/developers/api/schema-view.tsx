import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import type { FieldRow, TypeNode } from "@/lib/developers/openapi-view";

/** Anchor of a schema in the reference. */
export function schemaAnchor(name: string): string {
  return `schema-${name}`;
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-sm text-primary">{children}</code>;
}

/** A type as text, with named schemas linked to their description. */
export function TypeLabel({ type }: { type: TypeNode }): ReactNode {
  switch (type.kind) {
    case "ref":
      return (
        <a
          href={`#${schemaAnchor(type.name)}`}
          className="rounded-sm font-mono text-sm text-accent underline decoration-1 underline-offset-[3px] hover:decoration-2"
        >
          {type.name}
        </a>
      );
    case "uint":
      return <span>integer in a decimal string</span>;
    case "scalar":
      return (
        <span>
          {type.name}
          {type.detail === null ? null : (
            <>, {type.name === "string" ? <Mono>{type.detail}</Mono> : <span className="num">{type.detail}</span>}</>
          )}
        </span>
      );
    case "const":
      return <Mono>{type.value}</Mono>;
    case "enum":
      return (
        <span>
          one of{" "}
          {type.values.map((value, i) => (
            <span key={value}>
              {i > 0 ? ", " : null}
              <Mono>{value}</Mono>
            </span>
          ))}
        </span>
      );
    case "array":
      return (
        <span>
          array of <TypeLabel type={type.items} />
        </span>
      );
    case "nullable":
      return (
        <span>
          <TypeLabel type={type.inner} /> or <Mono>null</Mono>
        </span>
      );
    case "oneOf":
      return (
        <span>
          {type.options.map((option, i) => (
            <span key={JSON.stringify(option)}>
              {i > 0 ? " or " : null}
              <TypeLabel type={option} />
            </span>
          ))}
        </span>
      );
    case "object":
      return <span>object</span>;
  }
}

/** Indentation of a field per level of nesting: 16 px a level. */
const INDENT = ["", "pl-4", "pl-8", "pl-12", "pl-16"] as const;

/**
 * The fields of an object, one per row: the name in mono, the type and whether it is optional, and the
 * description. Fields of an object written in place are indented under it.
 */
export function FieldList({ rows, label }: { rows: readonly FieldRow[]; label: string }) {
  return (
    <ul aria-label={label} className="border-b">
      {rows.map((row) => (
        <li key={row.path} className={cx("border-t py-2", INDENT[Math.min(row.depth, INDENT.length - 1)])}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <code className="font-mono text-sm font-medium break-all text-primary">{row.path}</code>
            <span className="text-sm text-secondary">
              <TypeLabel type={row.type} />
              {row.required ? null : <span>, optional</span>}
            </span>
          </div>
          {row.description === null ? null : (
            <p className="mt-0.5 max-w-measure text-sm text-secondary">{row.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
