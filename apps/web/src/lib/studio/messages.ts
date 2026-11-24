import { type TxFailure, txFailureMessage } from "@/lib/tx/errors";
import type { PublishRefusal } from "./request";

export interface FailureText {
  readonly title: string;
  readonly body: string;
  /**
   * A reason in the contract's own words, relayed by the wallet or the node, already made safe by
   * `reportedReason`. It is shown apart from the app's sentences, as quoted text, and never interpreted.
   */
  readonly reported: string | null;
  /** The failure is an index that already exists under this draft's salt: a new salt is the way forward. */
  readonly offersNewSalt: boolean;
  /** Another version was published first: loading the latest version, with the draft kept, is the way forward. */
  readonly offersReload: boolean;
}

const RELOAD =
  "Load the latest version: your draft is kept, and its changes are then shown against the version the registry holds now.";

/**
 * What a refused `createIndex` or `publishVersion` means for the person publishing. A custom error of the
 * registry is named, with its arguments, next to the explanation, so the words can be checked against the
 * contract.
 */
export function publishFailureText(failure: TxFailure): FailureText {
  const text = (title: string, body: string, offers: Partial<Pick<FailureText, "offersNewSalt" | "offersReload">>) => ({
    title,
    body,
    reported: null,
    offersNewSalt: offers.offersNewSalt ?? false,
    offersReload: offers.offersReload ?? false,
  });
  if (failure.kind !== "contract_error") {
    const reported = failure.kind === "revert" ? failure.reason : null;
    return { ...text(txFailureMessage(failure), "The draft is unchanged.", {}), reported };
  }
  const signature = `${failure.name}(${failure.args.map(String).join(", ")})`;
  switch (failure.name) {
    case "IndexAlreadyExists":
      return text(
        "This wallet already created an index with this draft's salt.",
        `The index id is derived from the wallet and the salt, so publishing this draft again cannot create a second index: the registry would revert with ${signature}. Nothing was sent. To publish this methodology as a separate index, give the draft a new salt.`,
        { offersNewSalt: true },
      );
    case "NotCreator":
      return text(
        "Only the creator of this index can publish a new version.",
        `The registry would revert with ${signature}: the connected account did not create this index. Nothing was sent. Connect the wallet that created it.`,
        {},
      );
    case "IndexIsDeprecated":
      return text(
        "This index is deprecated.",
        `The registry would revert with ${signature}. Its creator deprecated it, which cannot be undone, so no version can follow. Every published version stays readable. Nothing was sent.`,
        {},
      );
    case "UnexpectedVersion": {
      const [expected, next] = failure.args.map(String);
      return text(
        "Another version was published while this draft was open.",
        `This draft would be version ${expected}, and the registry expects version ${next}: it would revert with ${signature}. Nothing was sent. ${RELOAD}`,
        { offersReload: true },
      );
    }
    default:
      return text(
        `The registry would reject this call with ${failure.name}.`,
        `The simulation reverted with ${signature}. Nothing was sent and the draft is unchanged.`,
        {},
      );
  }
}

/**
 * What a refusal at the click means, for the refusals that only a read made at the click can reveal. The
 * others are already on screen in the checklist, which is why the button was enabled at all.
 */
export function clickRefusalText(refusal: PublishRefusal): FailureText | null {
  const text = (title: string, body: string, offersReload = false) => ({
    title,
    body,
    reported: null,
    offersNewSalt: false,
    offersReload,
  });
  switch (refusal.reason) {
    case "version_moved":
      return text(
        `Version ${refusal.latestVersion} was published while this draft was open.`,
        `The registry was read again at the click, and this draft is no longer based on its latest version. Nothing was sent. ${RELOAD}`,
        true,
      );
    case "not_creator":
      return text(
        "Only the creator of this index can publish a new version.",
        `The registry records ${refusal.creator} as the creator, not the connected account. Nothing was sent.`,
      );
    case "deprecated":
      return text(
        "This index is deprecated.",
        "Its creator deprecated it, which cannot be undone, so no version can follow. Nothing was sent.",
      );
    case "index_unreadable":
      return text(
        "The registry could not be read at the click.",
        "The version to publish is confirmed against the registry at the moment of sending, and that read failed. Nothing was sent. Press the button again.",
      );
    case "unchanged":
      return text(
        "This draft is the latest version, byte for byte.",
        "A new version must change something. Nothing was sent.",
      );
    default:
      return null;
  }
}
