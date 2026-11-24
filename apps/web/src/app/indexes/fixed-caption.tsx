/** The one caption attached to every region that shows target weights or reference prices. Never reworded. */
export const WEIGHTS_AND_PRICES_CAPTION =
  "Target weights are published rules. Reference prices are indications of value, not executable prices. Nothing here is advice.";

export function FixedCaption() {
  return <p className="max-w-measure text-xs text-secondary">{WEIGHTS_AND_PRICES_CAPTION}</p>;
}
