import { publicRpcUrl } from "./chains";

export interface VerificationTarget {
  readonly chainId: number;
  /** Address of the IndexRegistry on that chain. */
  readonly registry: string;
  /** The index id, or a shell variable such as `$INDEX_ID` where no index is published yet. */
  readonly indexId: string;
  /** The version, or a shell variable such as `$VERSION` where no index is published yet. */
  readonly version: number | string;
  /** Public origin of this deployment, without a trailing slash. */
  readonly siteUrl: string;
}

export interface VerificationCommand {
  readonly id: "read" | "hash" | "api";
  readonly title: string;
  /** What running the command prints, and what to compare it with. */
  readonly expect: string;
  readonly command: string;
}

/**
 * The commands that reproduce what the page shows for one version, from the real address, index id, version
 * and public origin. `cast` is the command line client of Foundry. Nothing here depends on this application:
 * the first two commands talk to the chain only.
 *
 * - `read` prints the spec bytes the registry stores, as hexadecimal.
 * - `hash` reads the same bytes and prints their keccak256, which must equal the published spec hash.
 * - `api` fetches the same version from the public API of this deployment.
 */
export function verificationCommands(target: VerificationTarget): VerificationCommand[] {
  const { chainId, registry, indexId, version, siteUrl } = target;
  const rpcUrl = publicRpcUrl(chainId) ?? "<RPC_URL>";
  const read = `cast call ${registry} "specOf(bytes32,uint32)(bytes)" ${indexId} ${version} --rpc-url ${rpcUrl}`;
  return [
    {
      id: "read",
      title: "Read the spec from the chain",
      expect: "Prints the stored spec as hexadecimal bytes: the same bytes as the JSON above.",
      command: read,
    },
    {
      id: "hash",
      title: "Hash it",
      expect: "Prints the keccak256 of those bytes. It must equal the spec hash above.",
      command: `${read} | cast keccak`,
    },
    {
      id: "api",
      title: "Fetch the same version from the public API",
      expect: "Returns the spec hash, the spec bytes and text, the constituents and the result of every check as JSON.",
      command: `curl -s ${siteUrl.replace(/\/+$/, "")}/api/v1/indexes/${indexId}/versions/${version}`,
    },
  ];
}
