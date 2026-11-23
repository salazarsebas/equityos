import { type Address, type Hex, isAddress } from "@equityos/core";
import { type Draft, newDraft } from "./draft";

/**
 * Where the draft lives in the browser. The format version is part of the key: a later format is stored under
 * a new key and reads this one once to carry the draft over. Within a version, a field that is missing or has
 * the wrong type falls back to its default, so a draft saved by an older build still opens.
 */
export const DRAFT_STORAGE_KEY = "equityos.studio.draft.v1";

export interface StoredDraft {
  readonly draft: Draft;
  /** Time of the save, Unix milliseconds. `null` when the stored value did not carry a usable one. */
  readonly savedAt: number | null;
}

/** Upper bounds on what is read back, so that a tampered value cannot make the editor unusable. */
const MAX_TEXT = 4_096;
const MAX_TOKENS = 256;

const SALT_PATTERN = /^0x[0-9a-f]{64}$/;

function text(value: unknown, fallback: string, limit = MAX_TEXT): string {
  return typeof value === "string" && value.length <= limit ? value : fallback;
}

function isSalt(value: unknown): value is Hex {
  return typeof value === "string" && SALT_PATTERN.test(value);
}

export function serializeDraft(draft: Draft, savedAt: number): string {
  return JSON.stringify({ savedAt, draft });
}

/**
 * Reads a stored draft. Returns `null` for anything that is not one: no value, text that is not JSON, or JSON
 * of another shape. Every field is checked on its own, and nothing outside the known fields is kept.
 *
 * @param chainIds chains a draft may name. Another chain falls back to the first one.
 * @param freshSalt source of a salt for a stored draft whose own is unusable
 */
export function parseStoredDraft(
  raw: string | null,
  chainIds: readonly [number, ...number[]],
  freshSalt: () => Hex,
): StoredDraft | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("draft" in parsed)) return null;
  const stored = parsed.draft;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  const fields: Record<string, unknown> = { ...stored };
  const base = newDraft(chainIds[0], isSalt(fields.salt) ? fields.salt : freshSalt());

  const tokens: Address[] = [];
  for (const token of Array.isArray(fields.tokens) ? fields.tokens.slice(0, MAX_TOKENS) : []) {
    if (typeof token === "string" && isAddress(token) && !tokens.includes(token)) tokens.push(token);
  }
  const weights: Record<Address, string> = {};
  const storedWeights: Record<string, unknown> =
    typeof fields.weights === "object" && fields.weights !== null ? { ...fields.weights } : {};
  for (const token of tokens) {
    const weight = text(storedWeights[token], "", 16);
    if (weight !== "") weights[token] = weight;
  }
  const slug = text(fields.slug, base.slug, 64);
  const savedAt = "savedAt" in parsed && typeof parsed.savedAt === "number" ? parsed.savedAt : null;
  return {
    draft: {
      chainId: chainIds.find((chainId) => chainId === fields.chainId) ?? base.chainId,
      name: text(fields.name, base.name, 256),
      slug,
      slugEdited: fields.slugEdited === true && slug !== "",
      description: text(fields.description, base.description, 16_384).normalize("NFC"),
      tokens,
      weighting: fields.weighting === "fixed" ? "fixed" : "equal",
      weights,
      maxWeight: text(fields.maxWeight, base.maxWeight, 16),
      minWeight: text(fields.minWeight, base.minWeight, 16),
      driftThreshold: text(fields.driftThreshold, base.driftThreshold, 16),
      minInterval: text(fields.minInterval, base.minInterval, 16),
      minIntervalUnit: fields.minIntervalUnit === "hours" ? "hours" : "days",
      salt: base.salt,
    },
    savedAt: savedAt !== null && Number.isFinite(savedAt) ? savedAt : null,
  };
}

/** The part of `Storage` the draft needs, so that tests can pass a plain object. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Reads the draft. A browser that refuses access to storage has no draft: the Studio still works. */
export function loadDraft(
  storage: DraftStorage,
  chainIds: readonly [number, ...number[]],
  freshSalt: () => Hex,
): StoredDraft | null {
  try {
    return parseStoredDraft(storage.getItem(DRAFT_STORAGE_KEY), chainIds, freshSalt);
  } catch {
    return null;
  }
}

/** Writes the draft. Returns `false` when the browser refused, so the Studio can say the draft is not saved. */
export function saveDraft(storage: DraftStorage, draft: Draft, savedAt: number): boolean {
  try {
    storage.setItem(DRAFT_STORAGE_KEY, serializeDraft(draft, savedAt));
    return true;
  } catch {
    return false;
  }
}

export function discardDraft(storage: DraftStorage): void {
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing was stored, or storage is not available: there is nothing to remove either way.
  }
}
