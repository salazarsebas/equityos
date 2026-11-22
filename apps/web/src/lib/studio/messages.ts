import { type TxFailure, txFailureMessage } from "@/lib/tx/errors";

export interface FailureText {
  readonly title: string;
  readonly body: string;
  /** The failure is an index that already exists under this draft's salt: a new salt is the way forward. */
  readonly offersNewSalt: boolean;
}

/**
 * What a refused `createIndex` means for the person publishing. A custom error of the registry is named, with
 * its arguments, next to the explanation, so the words can be checked against the contract.
 */
export function publishFailureText(failure: TxFailure): FailureText {
  if (failure.kind !== "contract_error") {
    return { title: txFailureMessage(failure), body: "The draft is unchanged.", offersNewSalt: false };
  }
  const signature = `${failure.name}(${failure.args.map(String).join(", ")})`;
  if (failure.name === "IndexAlreadyExists") {
    return {
      title: "This wallet already created an index with this draft's salt.",
      body: `The index id is derived from the wallet and the salt, so publishing this draft again cannot create a second index: the registry would revert with ${signature}. Nothing was sent. To publish this methodology as a separate index, give the draft a new salt.`,
      offersNewSalt: true,
    };
  }
  return {
    title: `The registry would reject this call with ${failure.name}.`,
    body: `The simulation reverted with ${signature}. Nothing was sent and the draft is unchanged.`,
    offersNewSalt: false,
  };
}
