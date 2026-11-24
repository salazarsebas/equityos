import type { Hex } from "@equityos/core";
import type { StudioAsset } from "./assets";
import type { Draft } from "./draft";
import { evaluateDraft, type ValidDraft } from "./evaluate";

/**
 * What the review shows and sends, taken once when it opens: the draft, the asset list it was validated
 * against, and the resulting spec. Nothing that changes later, a refetch of the asset list included, reaches
 * it. The salt is the only part that can change, and only through `withSalt`, on an explicit click.
 */
export interface ReviewSnapshot {
  readonly draft: Draft;
  readonly assets: readonly StudioAsset[];
  readonly valid: ValidDraft;
}

/** The snapshot of a draft, or `null` when the draft is not a valid spec against these assets. */
export function takeReviewSnapshot(draft: Draft, assets: readonly StudioAsset[]): ReviewSnapshot | null {
  const { valid } = evaluateDraft(draft, assets);
  return valid === null ? null : { draft, assets: [...assets], valid };
}

/** The same snapshot with another salt. The salt is not part of the spec, so the bytes and the hash stay. */
export function withSalt(snapshot: ReviewSnapshot, salt: Hex): ReviewSnapshot {
  return { ...snapshot, draft: { ...snapshot.draft, salt } };
}
