/**
 * End-to-end check against a local Anvil node: the deployment script, the seed and the reader, with nothing
 * mocked. Skipped unless `INTEGRATION_TESTS=1`, because it needs Foundry (`anvil` and `forge` on the PATH):
 *
 *   bun run test:integration
 *
 * Every transaction goes to the local node, signed by Anvil for its unlocked development account.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { indexRegistryAbi, rebalanceLogAbi } from "@equityos/contracts-abi";
import { createPublicClient, createWalletClient, type Hex, http, stringToHex } from "viem";
import { anvil } from "viem/chains";
import { buildSeedIndexes } from "../../scripts/seed/indexes";
import { SEED_ACCOUNTS, seedUsage } from "../../scripts/seed/usage";
import { type SeededIndex, seedLocal } from "../../scripts/seed-local";
import {
  countPerDay,
  createRegistryClient,
  createRegistryReader,
  distinctCreators,
  HEADS_CACHE,
  LOCAL_CHAIN_ID,
  type RegistryReader,
  resolveRegistryConfig,
} from "../../src/server/registry";
import { createNetworkService } from "../../src/server/network";
import { testClock } from "./support";

const enabled = process.env.INTEGRATION_TESTS === "1";
const port = Number(process.env.ANVIL_PORT ?? 8565);
const rpcUrl = `http://127.0.0.1:${port}`;
const contractsDirectory = fileURLToPath(new URL("../../../../contracts", import.meta.url));
const TIMEOUT_MS = 120_000;

describe.skipIf(!enabled)("integration: deploy, seed and read on Anvil", () => {
  const config = resolveRegistryConfig({ EQUITYOS_CHAIN_ID: String(LOCAL_CHAIN_ID) });
  const { registry, rebalanceLog } = config.deployment;
  const transport = http(rpcUrl);
  const client = createPublicClient({ chain: anvil, transport });
  const wallet = createWalletClient({ chain: anvil, transport });
  const expected = buildSeedIndexes(LOCAL_CHAIN_ID);
  const clock = testClock();
  let node: ReturnType<typeof Bun.spawn> | undefined;
  let reader: RegistryReader;
  let seeded: SeededIndex[] = [];

  async function send(hash: Promise<Hex>): Promise<void> {
    const receipt = await client.waitForTransactionReceipt({ hash: await hash });
    expect(receipt.status).toBe("success");
  }

  beforeAll(async () => {
    node = Bun.spawn(["anvil", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "inherit" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const chainId = await client.getChainId().catch(() => null);
      if (chainId === LOCAL_CHAIN_ID) break;
      await Bun.sleep(100);
    }
    expect(await client.getChainId()).toBe(LOCAL_CHAIN_ID);
    reader = createRegistryReader({ config, client: createRegistryClient(rpcUrl), now: clock.now });
  }, TIMEOUT_MS);

  afterAll(() => {
    node?.kill();
  });

  test("before the deployment the registry is reported as not deployed", async () => {
    expect(await reader.listIndexes()).toEqual({
      status: "registry_not_deployed",
      chainId: LOCAL_CHAIN_ID,
      registry,
      reason: "no_code",
    });
  });

  test(
    "the deployment script deploys an empty registry",
    async () => {
      const [sender] = await wallet.getAddresses();
      const deploy = Bun.spawnSync(
        [
          "forge",
          "script",
          "script/Deploy.s.sol",
          "--rpc-url",
          rpcUrl,
          "--broadcast",
          "--unlocked",
          "--sender",
          sender ?? "",
        ],
        { cwd: contractsDirectory, stdout: "ignore", stderr: "inherit" },
      );
      expect(deploy.exitCode).toBe(0);
      clock.advance(HEADS_CACHE.ttlSeconds);
      expect(await reader.listIndexes()).toEqual({ status: "ok", total: 0, offset: 0, indexes: [] });
      expect(await reader.getEvents()).toMatchObject({ status: "ok", events: [], complete: true });
    },
    TIMEOUT_MS,
  );

  test(
    "the seed publishes five indexes and six versions and deprecates one index, once",
    async () => {
      seeded = await seedLocal(rpcUrl);
      expect(seeded.map(({ published }) => published)).toEqual([[1], [1], [1], [1], [1, 2]]);
      expect(seeded.map(({ deprecated }) => deprecated)).toEqual([false, true, false, false, false]);
      expect(seeded.map(({ specHashes }) => specHashes)).toEqual(
        expected.map(({ versions }) => versions.map(({ specHash }) => specHash)),
      );
      const again = await seedLocal(rpcUrl);
      expect(again.map(({ published }) => published)).toEqual([[], [], [], [], []]);
      expect(again.map(({ indexId }) => indexId)).toEqual(seeded.map(({ indexId }) => indexId));
    },
    TIMEOUT_MS,
  );

  test("the reader returns every seeded index under its canonical identifier, verified unless mismatched", async () => {
    const [creator] = await wallet.getAddresses();
    clock.advance(HEADS_CACHE.ttlSeconds);
    const page = await reader.listIndexes();
    if (page.status !== "ok") throw new Error(page.status);
    expect(page.total).toBe(5);
    const [mismatched, ...conformant] = page.indexes;
    expect(mismatched?.identifier).toBe(seeded[0]?.indexId ?? "");
    expect(mismatched?.latest).toMatchObject({ conformant: false, spec: null, composition: "static" });
    expect(mismatched?.latest.verification.checks.at(-1)).toMatchObject({ status: "fail", code: "weight_mismatch" });
    for (const index of conformant) {
      const { position } = index;
      const seed = expected[position];
      const version = seed?.versions.at(-1);
      const indexId = seeded[position]?.indexId;
      if (seed === undefined || version === undefined || indexId === undefined) throw new Error("missing seed");
      expect(index.position).toBe(position);
      expect(index.identifier).toBe(`${version.spec.slug}-${indexId.slice(2, 10)}`);
      expect(index.identifier).toBe(seeded[position]?.identifier ?? "");
      expect(index.head).toMatchObject({
        indexId,
        creator: creator?.toLowerCase(),
        latestVersion: seed.versions.length,
      });
      expect(index.head.deprecatedAt !== null).toBe(seed.deprecated);
      expect(index.latest).toMatchObject({
        chainId: LOCAL_CHAIN_ID,
        version: seed.versions.length,
        specHash: version.specHash,
        composition: "static",
        conformant: true,
        spec: version.spec,
        constituents: version.tokens.map((token, i) => ({ token, weightBps: version.weightsBps[i] })),
      });
      expect(index.latest.publishedBlock).toBeGreaterThan(0n);
      expect(index.latest.verification.checks.map(({ id, status }) => `${id}:${status}`)).toEqual([
        "C1:pass",
        "C2:pass",
        "C3:pass",
        "C4:pass",
        "C5:pass",
      ]);
      expect(await reader.getIndex(index.identifier)).toEqual({ status: "ok", index });
      expect(await reader.getIndex(indexId)).toEqual({ status: "ok", index });
    }
  });

  test("both versions of the last index are readable and verified", async () => {
    const indexId = seeded[4]?.indexId ?? "0x";
    const versions = await reader.listVersions(indexId);
    if (versions.status !== "ok") throw new Error(versions.status);
    expect(versions.total).toBe(2);
    expect(versions.versions.map(({ version, specHash, conformant }) => ({ version, specHash, conformant }))).toEqual(
      (expected[4]?.versions ?? []).map(({ specHash }, i) => ({ version: i + 1, specHash, conformant: true })),
    );
    expect(versions.versions.map(({ spec }) => spec?.weighting.type)).toEqual(["equal", "fixed"]);
    expect(await reader.getVersion(indexId, 3)).toEqual({ status: "version_not_found" });
  });

  test(
    "an unverifiable index, a deprecation and a rebalance are read back as they are",
    async () => {
      const [creator] = await wallet.getAddresses();
      if (creator === undefined) throw new Error("no unlocked account");
      const first = seeded[0]?.indexId ?? "0x";
      const last = seeded[4]?.indexId ?? "0x";
      const account = { account: creator, abi: indexRegistryAbi, address: registry } as const;
      const salt = stringToHex("integration.not-a-spec", { size: 32 });
      await send(
        wallet.writeContract({
          ...account,
          functionName: "createIndex",
          args: [salt, stringToHex("not a spec"), [], []],
        }),
      );
      await send(wallet.writeContract({ ...account, functionName: "deprecate", args: [first] }));
      await send(
        wallet.writeContract({
          account: creator,
          abi: rebalanceLogAbi,
          address: rebalanceLog,
          functionName: "recordRebalance",
          args: [last, 2],
        }),
      );

      clock.advance(HEADS_CACHE.ttlSeconds);
      const page = await reader.listIndexes();
      if (page.status !== "ok") throw new Error(page.status);
      expect(page.total).toBe(6);
      const unverifiable = page.indexes[5];
      expect(unverifiable?.identifier).toBe(unverifiable?.head.indexId ?? "");
      expect(unverifiable?.latest).toMatchObject({ conformant: false, spec: null, composition: "rule_based" });
      expect(unverifiable?.latest.verification.checks.map(({ status }) => status)).toEqual([
        "pass",
        "fail",
        "skipped",
        "skipped",
        "skipped",
      ]);
      expect(page.indexes[0]?.head.deprecatedAt).toBeGreaterThan(0n);

      const scan = await reader.getEvents();
      if (scan.status !== "ok") throw new Error(scan.status);
      expect(scan.complete).toBe(true);
      expect(scan.events.map(({ type }) => type)).toEqual([
        "index_created",
        "version_published",
        "index_created",
        "version_published",
        "index_deprecated",
        "index_created",
        "version_published",
        "index_created",
        "version_published",
        "index_created",
        "version_published",
        "version_published",
        "index_created",
        "version_published",
        "index_deprecated",
        "rebalance_recorded",
      ]);
      expect(scan.events.at(-1)).toMatchObject({ account: creator.toLowerCase(), indexId: last, version: 2 });
      const block = await client.getBlock({ blockNumber: scan.events.at(-1)?.blockNumber ?? 0n });
      expect(scan.events.at(-1)?.blockTimestamp).toBe(block.timestamp);
      expect(distinctCreators(scan.events)).toEqual([creator.toLowerCase() as Hex]);
      expect(countPerDay(scan.events, "index_created").reduce((sum, { count }) => sum + count, 0)).toBe(6);
    },
    TIMEOUT_MS,
  );

  test(
    "the usage seed gives one attestation of each tier, classified from the chain alone",
    async () => {
      const [creator, linkedSender, idleSender] = (await wallet.getAddresses()).map(
        (address): Hex => `0x${address.slice(2).toLowerCase()}`,
      );
      if (creator === undefined || linkedSender === undefined || idleSender === undefined) {
        throw new Error("the node exposes fewer than three unlocked accounts");
      }
      expect((await seedUsage(rpcUrl)).sent).toBe(true);
      expect((await seedUsage(rpcUrl)).sent).toBe(false);
      const service = createNetworkService({
        reader,
        config,
        client: () => createRegistryClient(rpcUrl),
        exclusions: [{ address: SEED_ACCOUNTS.excluded, label: "Local seed test account" }],
        now: clock.now,
      });
      clock.advance(HEADS_CACHE.ttlSeconds);
      const read = await service.read();
      if (read.status !== "ok") throw new Error(read.status);
      expect(read.usageComplete).toBe(true);
      expect(read.classified.map(({ event, tier, reason }) => [event.account, tier, reason])).toEqual([
        // The rebalance recorded by the test above, with no token moved.
        [creator, "unmatched", "no_constituent_flows"],
        [SEED_ACCOUNTS.matched, "a", null],
        [SEED_ACCOUNTS.partial, "a", null],
        [linkedSender, "b", "no_constituent_flows"],
        [SEED_ACCOUNTS.dust, "unmatched", "below_minimum_notional"],
        [idleSender, "unmatched", "no_constituent_flows"],
        [SEED_ACCOUNTS.excluded, "a", null],
      ]);
      expect(read.classified.map(({ tracking }) => tracking?.status ?? null)).toEqual([
        null,
        "within",
        "outside",
        null,
        null,
        null,
        "within",
      ]);
      const { metrics } = read;
      expect(metrics.attestationsTierA.value).toBe(2);
      expect(metrics.accountsTierA.value).toBe(2);
      expect(metrics.tierAReferenceValueUsdE8.value).toBe(130_000_000_000n);
      expect(metrics.excludedActivity.value.attestations).toEqual({ tierA: 1, tierB: 0, unmatched: 0 });
    },
    TIMEOUT_MS,
  );
});
