/**
 * Publishes the public seed indexes of `seed/public-indexes.ts` to the IndexRegistry on Base Sepolia or Base
 * mainnet. A dry run by default: it prints every transaction it would send and sends nothing.
 *
 *   SEED_RPC_URL=<rpc> SEED_CREATOR=<address> bun run seed:public            # dry run, no key needed
 *   SEED_RPC_URL=<rpc> SEED_PRIVATE_KEY=<key> SEED_PLAN_DIGEST=<digest> bun run seed:public -- --send
 *
 * It refuses, before sending anything, unless:
 * - the endpoint reports chain 84532 (Base Sepolia) or 8453 (Base mainnet), and on 8453 `SEED_MAINNET=true`;
 * - the deployment map records the registry on that chain, and the code at its address is the expected build;
 * - every constituent is index-eligible with a usable reference price in the live market data layer;
 * - with `--send`: the key is given in `SEED_PRIVATE_KEY`, and `SEED_PLAN_DIGEST` equals the digest of the plan
 *   computed in this run, which the dry run prints. A plan that changed since the dry run is not sent.
 *
 * The key is read from the environment only, never from a file or an argument, and is never printed. It can be
 * run again: an index that already exists is skipped.
 */
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  DEPLOYMENTS,
  type Deployment,
  INDEX_REGISTRY_CODE_HASH,
  indexRegistryAbi,
  type SupportedChainId,
} from "@equityos/contracts-abi";
import {
  type Address,
  BaseError,
  bytesToHex,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  type Hex,
  http,
  isAddress,
  keccak256,
  type PublicClient,
  parseEventLogs,
  stringToHex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { createMarketData, type MarketSnapshot } from "../src/server/market/index";
import { type PublicSeedIndex, type SupplyValue, selectPublicSeed, tickerOf } from "./seed/public-indexes";

/** Environment variable that must be `true` to seed Base mainnet. */
export const MAINNET_OPT_IN = "SEED_MAINNET";

/** Why the seed refused to go on. Nothing was sent. */
export type SeedRefusalCode =
  | "unsupported_chain"
  | "mainnet_not_confirmed"
  | "not_in_deployment_map"
  | "registry_code_missing"
  | "registry_code_mismatch"
  | "index_id_mismatch"
  | "market_data_stale"
  | "ineligible_constituents"
  | "no_creator"
  | "invalid_key"
  | "creator_mismatch"
  | "send_requires_key"
  | "plan_digest_mismatch"
  | "simulation_failed"
  | "insufficient_balance";

/** The seed refused before sending a transaction. */
export class SeedPublicRefusedError extends Error {
  readonly code: SeedRefusalCode;

  constructor(code: SeedRefusalCode, message: string) {
    super(`refused (${code}): ${message}`);
    this.name = "SeedPublicRefusedError";
    this.code = code;
  }
}

export interface SeedPublicEnvironment {
  readonly SEED_MAINNET?: string | undefined;
  /** Private key of the creator, `0x` and 64 hex digits. Needed to send; optional for a dry run. */
  readonly SEED_PRIVATE_KEY?: string | undefined;
  /** Address of the creator, for a dry run without a key. Checked against the key when both are given. */
  readonly SEED_CREATOR?: string | undefined;
  /** Digest printed by the dry run. Required to send. */
  readonly SEED_PLAN_DIGEST?: string | undefined;
}

export interface SeedPublicOptions {
  /** Transport of the chain to seed. */
  readonly transport: Transport;
  /** The market snapshot the constituents are checked and chosen against. */
  readonly snapshot: () => Promise<MarketSnapshot>;
  readonly env: SeedPublicEnvironment;
  /** Send the transactions. Without it, nothing is sent. */
  readonly send: boolean;
  /** The deployment map. Replaced by tests only. */
  readonly deployments?: Readonly<Record<SupportedChainId, Deployment>>;
  /** keccak256 of the expected registry runtime code. Replaced by tests only, which have no build. */
  readonly expectedCodeHash?: Hex;
}

/** One `createIndex` transaction of the plan, exactly as it is sent. */
export interface PlannedTransaction {
  readonly to: Address;
  /** Always zero: the registry accepts no ETH. */
  readonly value: 0n;
  readonly data: Hex;
  readonly gas: bigint;
}

export interface PlannedIndex {
  readonly index: PublicSeedIndex;
  /** `keccak256(abi.encode(creator, salt))`, as the registry computes it. */
  readonly indexId: Hex;
  /**
   * - `create`: the index does not exist and `transaction` creates it.
   * - `exists`: the index exists with version 1 equal to this spec. Nothing to send.
   * - `exists_different`: the index exists with another spec. Nothing is sent, and it is reported.
   */
  readonly status: "create" | "exists" | "exists_different";
  readonly transaction: PlannedTransaction | null;
}

export interface SeedPlan {
  readonly chainId: SupportedChainId;
  readonly registry: Address;
  readonly creator: Address;
  /** Base mainnet block and time of the market snapshot the plan was built from. */
  readonly marketBlock: bigint;
  readonly marketTimestamp: number;
  readonly ranking: readonly SupplyValue[];
  readonly indexes: readonly PlannedIndex[];
  /** keccak256 of the chain id, creator, registry and every transaction to send, in order. */
  readonly digest: Hex;
  /** Upper bound of the fee of the transactions to send, in wei, at the fees of the plan. */
  readonly maxFeeWei: bigint;
  readonly balanceWei: bigint;
}

export interface SentTransaction {
  readonly indexId: Hex;
  readonly hash: Hex;
  readonly blockNumber: bigint;
}

export interface SeedPublicResult {
  readonly plan: SeedPlan;
  /** Empty on a dry run. */
  readonly sent: readonly SentTransaction[];
}

/** The balance must cover this many times the estimated fee, so a fee movement cannot stop the seed midway. */
const BALANCE_MARGIN = 2n;

/** The creator: the account of the key when one is given, otherwise `SEED_CREATOR`. */
function resolveCreator(env: SeedPublicEnvironment, send: boolean) {
  const key = env.SEED_PRIVATE_KEY?.trim() ?? "";
  const declared = env.SEED_CREATOR?.trim() ?? "";
  if (key === "") {
    if (send) throw new SeedPublicRefusedError("send_requires_key", "set SEED_PRIVATE_KEY to send");
    if (!isAddress(declared, { strict: false })) {
      throw new SeedPublicRefusedError("no_creator", "set SEED_CREATOR to an address, or SEED_PRIVATE_KEY");
    }
    return { creator: declared.toLowerCase() as Address, account: null };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    // The value is never echoed: it may be a key with a typo.
    throw new SeedPublicRefusedError("invalid_key", "SEED_PRIVATE_KEY is not 0x followed by 64 hex digits");
  }
  const account = privateKeyToAccount(key as Hex);
  const creator = account.address.toLowerCase() as Address;
  if (declared !== "" && declared.toLowerCase() !== creator) {
    throw new SeedPublicRefusedError("creator_mismatch", `SEED_CREATOR is not the address of SEED_PRIVATE_KEY`);
  }
  return { creator, account };
}

/** The digest the dry run prints and the send run must be given. */
export function planDigest(chainId: number, creator: Address, registry: Address, txs: readonly PlannedTransaction[]) {
  const text = JSON.stringify({
    chainId,
    creator,
    registry: registry.toLowerCase(),
    transactions: txs.map(({ to, value, data }) => ({ to: to.toLowerCase(), value: value.toString(), data })),
  });
  return keccak256(stringToHex(text));
}

/**
 * Checks every precondition, builds the plan and, with `send`, sends it.
 *
 * @throws {SeedPublicRefusedError} for every refusal, always before the first transaction is sent.
 * @throws {IneligibleConstituentsError} listing the constituents that are not index-eligible.
 */
export async function seedPublic(options: SeedPublicOptions): Promise<SeedPublicResult> {
  const { env, send, transport } = options;
  const deployments = options.deployments ?? DEPLOYMENTS;
  const client: PublicClient = createPublicClient({ transport });

  const chainId = await client.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID && chainId !== BASE_MAINNET_CHAIN_ID) {
    throw new SeedPublicRefusedError("unsupported_chain", `chain ${chainId} is not Base Sepolia or Base mainnet`);
  }
  if (chainId === BASE_MAINNET_CHAIN_ID && env.SEED_MAINNET !== "true") {
    throw new SeedPublicRefusedError("mainnet_not_confirmed", `set ${MAINNET_OPT_IN}=true to seed Base mainnet`);
  }
  const deployment = deployments[chainId];
  if (deployment.deployBlock === null) {
    throw new SeedPublicRefusedError(
      "not_in_deployment_map",
      `the deployment map records no registry on chain ${chainId}: record the deployment first`,
    );
  }
  const registry = deployment.registry;
  const code = (await client.getCode({ address: registry })) ?? "0x";
  if (code === "0x") throw new SeedPublicRefusedError("registry_code_missing", `no code at ${registry}`);
  if (keccak256(code) !== (options.expectedCodeHash ?? INDEX_REGISTRY_CODE_HASH)) {
    throw new SeedPublicRefusedError("registry_code_mismatch", `the code at ${registry} is not the expected build`);
  }

  const { creator, account } = resolveCreator(env, send);

  const snapshot = await options.snapshot();
  if (snapshot.assetList.servedStale || snapshot.onchain.servedStale) {
    throw new SeedPublicRefusedError("market_data_stale", "the market data was served from cache after a failure");
  }
  const selection = selectPublicSeed(snapshot, chainId);

  const fees = await client.estimateFeesPerGas();
  const indexes: PlannedIndex[] = [];
  for (const index of selection.indexes) {
    const indexId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, index.salt]));
    const onchainId = await client.readContract({
      address: registry,
      abi: indexRegistryAbi,
      functionName: "computeIndexId",
      args: [creator, index.salt],
    });
    if (onchainId !== indexId) {
      throw new SeedPublicRefusedError("index_id_mismatch", `the registry derives ${onchainId}, not ${indexId}`);
    }
    const exists = await client.readContract({
      address: registry,
      abi: indexRegistryAbi,
      functionName: "exists",
      args: [indexId],
    });
    if (exists) {
      const first = await client.readContract({
        address: registry,
        abi: indexRegistryAbi,
        functionName: "getVersion",
        args: [indexId, 1],
      });
      const status = first.specHash === index.version.specHash ? "exists" : "exists_different";
      indexes.push({ index, indexId, status, transaction: null });
      continue;
    }
    const { version } = index;
    const data = encodeFunctionData({
      abi: indexRegistryAbi,
      functionName: "createIndex",
      args: [index.salt, bytesToHex(version.specBytes), [...version.tokens], [...version.weightsBps]],
    });
    // A simulation from the creator: a call that would revert is never planned.
    const gas = await client.estimateGas({ account: creator, to: registry, data, value: 0n }).catch((error) => {
      const reason = error instanceof Error ? error.name : "unknown";
      throw new SeedPublicRefusedError("simulation_failed", `createIndex for ${index.key} would fail (${reason})`);
    });
    indexes.push({ index, indexId, status: "create", transaction: { to: registry, value: 0n, data, gas } });
  }

  const transactions = indexes.flatMap(({ transaction }) => (transaction === null ? [] : [transaction]));
  const maxFeeWei = transactions.reduce((sum, { gas }) => sum + gas * fees.maxFeePerGas, 0n);
  const balanceWei = await client.getBalance({ address: creator });
  const plan: SeedPlan = {
    chainId,
    registry,
    creator,
    marketBlock: snapshot.onchain.blockNumber,
    marketTimestamp: snapshot.onchain.blockTimestamp,
    ranking: selection.ranking,
    indexes,
    digest: planDigest(chainId, creator, registry, transactions),
    maxFeeWei,
    balanceWei,
  };
  if (!send) return { plan, sent: [] };

  const confirmed = env.SEED_PLAN_DIGEST?.trim().toLowerCase() ?? "";
  if (confirmed !== plan.digest) {
    throw new SeedPublicRefusedError(
      "plan_digest_mismatch",
      `SEED_PLAN_DIGEST is ${confirmed === "" ? "unset" : confirmed}, this run's plan is ${plan.digest}: run the dry run again and review it`,
    );
  }
  if (balanceWei < maxFeeWei * BALANCE_MARGIN) {
    throw new SeedPublicRefusedError(
      "insufficient_balance",
      `${formatEther(balanceWei)} ETH does not cover twice the estimated fee of ${formatEther(maxFeeWei)} ETH`,
    );
  }
  if (account === null) throw new SeedPublicRefusedError("send_requires_key", "set SEED_PRIVATE_KEY to send");

  const chain: Chain = chainId === BASE_MAINNET_CHAIN_ID ? base : baseSepolia;
  const wallet = createWalletClient({ account, chain, transport });
  const sent: SentTransaction[] = [];
  for (const { index, indexId, transaction } of indexes) {
    if (transaction === null) continue;
    // The calldata sent is the calldata printed and digested, byte for byte.
    const hash = await wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} for ${index.key} reverted`);
    const events = parseEventLogs({ abi: indexRegistryAbi, logs: receipt.logs }).filter(
      (log) => log.address.toLowerCase() === registry.toLowerCase(),
    );
    const created = events.some(
      (log) =>
        log.eventName === "IndexCreated" && log.args.indexId === indexId && log.args.creator.toLowerCase() === creator,
    );
    const published = events.some(
      (log) =>
        log.eventName === "VersionPublished" &&
        log.args.indexId === indexId &&
        log.args.version === 1 &&
        log.args.specHash === index.version.specHash,
    );
    if (!created || !published) throw new Error(`transaction ${hash} did not emit the expected events`);
    const stored = await client.readContract({
      address: registry,
      abi: indexRegistryAbi,
      functionName: "getVersion",
      args: [indexId, 1],
    });
    if (stored.specHash !== index.version.specHash) throw new Error(`index ${indexId} reads back another spec hash`);
    sent.push({ indexId, hash, blockNumber: receipt.blockNumber });
  }
  return { plan, sent };
}

function percent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}

function usd(valueE8: bigint): string {
  const whole = valueE8 / 100_000_000n;
  return `${whole.toLocaleString("en-US")} USD`;
}

/** The report the script prints: the plan, then what was sent. Contains no key. */
export function formatReport({ plan, sent }: SeedPublicResult, send: boolean): string {
  const lines: string[] = [];
  const network = plan.chainId === BASE_MAINNET_CHAIN_ID ? "Base mainnet" : "Base Sepolia";
  lines.push(`${send ? "SEND" : "DRY RUN"}: public seed on ${network} (chain ${plan.chainId})`);
  lines.push(`registry: ${plan.registry}`);
  lines.push(`creator:  ${plan.creator}`);
  lines.push(
    `market data: Base mainnet block ${plan.marketBlock} (${new Date(plan.marketTimestamp * 1000).toISOString()})`,
  );
  lines.push("");
  lines.push("supply value ranking (total supply at reference price, not an executable price):");
  for (const [i, entry] of plan.ranking.entries()) {
    lines.push(`  ${i + 1}. ${entry.ticker.padEnd(6)} ${entry.token}  ${usd(entry.valueUsdE8)}`);
  }
  for (const { index, indexId, status, transaction } of plan.indexes) {
    const { spec, specHash, specBytes, tokens, weightsBps } = index.version;
    lines.push("");
    lines.push(`${spec.name} (${index.key})`);
    lines.push(`  rule:        ${index.rule}`);
    lines.push(`  index id:    ${indexId}`);
    lines.push(`  salt:        ${index.salt}`);
    lines.push(`  spec hash:   ${specHash}`);
    lines.push(`  spec bytes:  ${specBytes.length}`);
    lines.push(
      `  status:      ${status === "create" ? "to create" : status === "exists" ? "exists, skipped" : "exists with another spec, left unchanged"}`,
    );
    tokens.forEach((token, i) => {
      lines.push(`    ${tickerOf(token).padEnd(6)} ${token}  ${percent(weightsBps[i] ?? 0)}`);
    });
    lines.push(`  spec:        ${new TextDecoder().decode(specBytes)}`);
    if (transaction !== null) {
      lines.push(`  transaction: to ${transaction.to}, value 0, gas ${transaction.gas}`);
      lines.push(`  calldata:    ${transaction.data}`);
    }
  }
  lines.push("");
  const toSend = plan.indexes.filter(({ transaction }) => transaction !== null).length;
  lines.push(`transactions to send: ${toSend}`);
  lines.push(
    `estimated maximum fee: ${formatEther(plan.maxFeeWei)} ETH; creator balance: ${formatEther(plan.balanceWei)} ETH`,
  );
  lines.push(`plan digest: ${plan.digest}`);
  if (!send) {
    lines.push("");
    lines.push("Nothing was sent. To send exactly this plan, run again with --send, SEED_PRIVATE_KEY and");
    lines.push(`SEED_PLAN_DIGEST=${plan.digest}`);
  }
  for (const { indexId, hash, blockNumber } of sent) {
    lines.push(`sent: ${hash} (block ${blockNumber}) created ${indexId}`);
  }
  return lines.join("\n");
}

/**
 * A one-line description of a failure. A viem error is reduced to its short message, because its full message
 * contains the request URL, and an RPC URL can carry a provider key.
 */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) return `${error.name}: ${error.shortMessage}`;
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const send = process.argv.slice(2).includes("--send");
  const rpcUrl = process.env.SEED_RPC_URL?.trim() ?? "";
  try {
    if (!/^https?:\/\//.test(rpcUrl)) throw new Error("set SEED_RPC_URL to the http(s) endpoint of the chain to seed");
    const market = createMarketData();
    const result = await seedPublic({
      transport: http(rpcUrl),
      snapshot: () => market.getSnapshot(),
      env: {
        SEED_MAINNET: process.env.SEED_MAINNET,
        SEED_PRIVATE_KEY: process.env.SEED_PRIVATE_KEY,
        SEED_CREATOR: process.env.SEED_CREATOR,
        SEED_PLAN_DIGEST: process.env.SEED_PLAN_DIGEST,
      },
      send,
    });
    console.log(formatReport(result, send));
  } catch (error) {
    console.error(`seed-public: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
