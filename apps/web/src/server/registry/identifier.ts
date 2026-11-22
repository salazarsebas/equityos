import "server-only";
import type { Hex } from "viem";

/**
 * Canonical identifier of an index in a URL: `<slug>-<prefix>`.
 *
 * - `slug` is the slug of the latest version of the index, taken from its spec, and only when that version
 *   passes verification. A slug is chosen by the creator and is not unique.
 * - `prefix` is the shortest run of leading hexadecimal digits of the index id, at least
 *   `MIN_PREFIX_DIGITS` long, that no index created earlier shares.
 *
 * The prefix alone selects the index, and the slug must then match: a wrong slug is a miss, never a
 * redirect, so a link cannot show one name and open another index. Indexes are append-only and an id never
 * changes, so the prefix of an index depends only on the indexes created before it and is fixed forever. An
 * index created later with an id that starts with the same digits gets a longer prefix: it can neither take
 * over the existing identifier nor make it ambiguous.
 *
 * The full index id is always accepted as an identifier. It is the canonical one while the latest version
 * does not pass verification, because an unverified spec provides no slug to trust.
 */
export const MIN_PREFIX_DIGITS = 8;

const INDEX_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** The slug pattern of `equityos.index/1`, a hyphen, and 8 to 64 lowercase hexadecimal digits. */
const SLUG_IDENTIFIER_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)-([0-9a-f]{8,64})$/;

export type ParsedIdentifier =
  | { readonly kind: "index_id"; readonly indexId: Hex }
  | { readonly kind: "slug"; readonly slug: string; readonly prefix: string };

/** Parses a URL identifier. `null` if it is neither an index id nor `<slug>-<prefix>`. */
export function parseIdentifier(identifier: string): ParsedIdentifier | null {
  if (INDEX_ID_PATTERN.test(identifier)) return { kind: "index_id", indexId: `0x${identifier.slice(2).toLowerCase()}` };
  // The prefix holds no hyphen, so the last hyphen is the separator even when the slug contains hyphens.
  const match = SLUG_IDENTIFIER_PATTERN.exec(identifier);
  const [, slug, prefix] = match ?? [];
  return slug === undefined || prefix === undefined ? null : { kind: "slug", slug, prefix };
}

/** Number of leading hexadecimal digits two ids have in common. */
function commonDigits(a: string, b: string): number {
  let count = 0;
  while (count < a.length && a[count] === b[count]) count += 1;
  return count;
}

/** The ids of a registry in creation order, with the identifier prefix of each. */
export interface IndexDirectory {
  readonly size: number;
  /** Appends ids at the next positions. Ids are lowercase and distinct, as the registry guarantees. */
  append(ids: readonly Hex[]): void;
  idAt(position: number): Hex | undefined;
  positionOf(indexId: Hex): number | undefined;
  /** The identifier prefix of the index at `position`: hexadecimal digits without `0x`. */
  prefixAt(position: number): string | undefined;
  /** Position of the index whose identifier prefix is exactly `prefix`. A longer or shorter one is a miss. */
  positionOfPrefix(prefix: string): number | undefined;
}

export function createIndexDirectory(): IndexDirectory {
  const ids: Hex[] = [];
  const prefixes: string[] = [];
  const positionById = new Map<Hex, number>();
  const positionByPrefix = new Map<string, number>();
  /** Digits of the ids that share their first `MIN_PREFIX_DIGITS` digits, to compare only likely collisions. */
  const digitsByHead = new Map<string, string[]>();

  return {
    get size(): number {
      return ids.length;
    },
    append(added: readonly Hex[]): void {
      for (const indexId of added) {
        const digits = indexId.slice(2);
        const head = digits.slice(0, MIN_PREFIX_DIGITS);
        const earlier = digitsByHead.get(head) ?? [];
        // One digit more than the longest run shared with an earlier id is enough to tell them apart.
        const shared = Math.max(0, ...earlier.map((other) => commonDigits(digits, other)));
        const prefix = digits.slice(0, Math.max(MIN_PREFIX_DIGITS, shared + 1));
        digitsByHead.set(head, [...earlier, digits]);
        positionById.set(indexId, ids.length);
        positionByPrefix.set(prefix, ids.length);
        ids.push(indexId);
        prefixes.push(prefix);
      }
    },
    idAt: (position) => ids[position],
    positionOf: (indexId) => positionById.get(indexId),
    prefixAt: (position) => prefixes[position],
    positionOfPrefix: (prefix) => positionByPrefix.get(prefix),
  };
}

/** `<slug>-<prefix>`. */
export function formatIdentifier(slug: string, prefix: string): string {
  return `${slug}-${prefix}`;
}
