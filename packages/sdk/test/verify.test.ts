import { describe, expect, test } from "bun:test";
import { INDEX_REGISTRY_ADDRESS } from "@equityos/contracts-abi";
import { createPublicClient, custom, type Hex } from "viem";
import { bytesToHex, jsonRpcClient, RegistryReadError, specHash, verifyIndexVersion } from "../src/index.ts";
import { example, mockFetch, RECORDED_INDEX_IDS, REGISTRY_RECORDING, recordedClient } from "./support.ts";

const CHAIN_ID = REGISTRY_RECORDING.chainId;
const [MISMATCHED, , , , DIVERSIFIED] = RECORDED_INDEX_IDS;

function target(indexId: Hex | undefined, version = 1) {
  if (indexId === undefined) throw new Error("index missing from the recording");
  return { chainId: CHAIN_ID, registry: INDEX_REGISTRY_ADDRESS, indexId, version };
}

async function readError(promise: Promise<unknown>): Promise<RegistryReadError> {
  const error = await promise.then(
    () => null,
    (rejection: unknown) => rejection,
  );
  if (!(error instanceof RegistryReadError)) throw new Error(`expected a RegistryReadError, got ${String(error)}`);
  return error;
}

describe("verifyIndexVersion on the recorded registry", () => {
  test("the recording holds the five indexes of the seed", () => {
    expect(RECORDED_INDEX_IDS).toHaveLength(5);
  });

  test("a verified version: every check passes and the spec is returned", async () => {
    const result = await verifyIndexVersion({ ...target(DIVERSIFIED, 2), publicClient: recordedClient() });
    expect(result.conformant).toBe(true);
    expect(result.checks.map(({ id, status }) => `${id}:${status}`)).toEqual([
      "C1:pass",
      "C2:pass",
      "C3:pass",
      "C4:pass",
      "C5:pass",
    ]);
    expect(result.spec?.slug).toBe("diversified-equity");
    expect(specHash(result.specBytes)).toBe(result.specHash);
    expect(result).toMatchObject({
      chainId: CHAIN_ID,
      registry: INDEX_REGISTRY_ADDRESS.toLowerCase(),
      version: 2,
      latestVersion: 2,
      blockNumber: 29n,
      composition: "static",
      deprecatedAt: null,
      creator: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    });
  });

  test("the version that publishes other weights than its spec fails C5 and has no spec", async () => {
    const result = await verifyIndexVersion({ ...target(MISMATCHED), publicClient: recordedClient() });
    expect(result.conformant).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.checks.at(-1)).toMatchObject({ id: "C5", status: "fail", code: "weight_mismatch" });
    expect(result.constituents.length).toBeGreaterThan(0);
  });

  test("agrees with the verification the API reports for the same versions", async () => {
    for (const name of ["getIndexVersion", "getIndexVersion.notConformant"]) {
      const { data } = example(name).body as {
        data: { indexId: Hex; version: number; specHash: Hex; specBytes: Hex; verification: unknown };
      };
      const result = await verifyIndexVersion({
        ...target(data.indexId, data.version),
        publicClient: recordedClient(),
      });
      const { conformant, checks, specErrors } = result;
      expect<unknown>({ conformant, checks, specErrors }).toEqual(data.verification);
      expect(result.specHash).toBe(data.specHash);
      expect(bytesToHex(result.specBytes)).toBe(data.specBytes);
    }
  });

  test("every value is read at one block, and only from the registry", async () => {
    const seen: { to: Hex; blockNumber: bigint }[] = [];
    const base = recordedClient();
    const client = recordedClient({
      getCode: async ({ address, blockNumber }) => {
        seen.push({ to: address, blockNumber });
        return "0x6080";
      },
      call: async (args) => {
        seen.push({ to: args.to, blockNumber: args.blockNumber });
        return base.call(args);
      },
    });
    await verifyIndexVersion({ ...target(DIVERSIFIED, 1), publicClient: client });
    expect(seen.length).toBe(6);
    expect(new Set(seen.map(({ to, blockNumber }) => `${to}@${blockNumber}`))).toEqual(
      new Set([`${INDEX_REGISTRY_ADDRESS.toLowerCase()}@29`]),
    );
  });
});

describe("states that are not a version", () => {
  test("an endpoint on another chain", async () => {
    const client = recordedClient({ getChainId: async () => 8453 });
    expect((await readError(verifyIndexVersion({ ...target(DIVERSIFIED), publicClient: client }))).code).toBe(
      "chain_mismatch",
    );
  });

  test("no code at the registry address", async () => {
    for (const code of [undefined, "0x"] as const) {
      const client = recordedClient({ getCode: async () => code });
      expect((await readError(verifyIndexVersion({ ...target(DIVERSIFIED), publicClient: client }))).code).toBe(
        "registry_not_deployed",
      );
    }
  });

  test("an unknown index and an unknown version", async () => {
    const unknown = await readError(
      verifyIndexVersion({ ...target(`0x${"1".repeat(64)}`), publicClient: recordedClient() }),
    );
    expect(unknown.code).toBe("index_not_found");
    const version = await readError(verifyIndexVersion({ ...target(DIVERSIFIED, 3), publicClient: recordedClient() }));
    expect(version.code).toBe("version_not_found");
  });

  test("a failing endpoint and an answer the registry cannot have produced", async () => {
    const failing = recordedClient({
      call: async () => {
        throw new Error("timeout");
      },
    });
    expect((await readError(verifyIndexVersion({ ...target(DIVERSIFIED), publicClient: failing }))).code).toBe(
      "rpc_failure",
    );
    const malformed = recordedClient({ call: async () => ({ data: "0x01" }) });
    expect((await readError(verifyIndexVersion({ ...target(DIVERSIFIED), publicClient: malformed }))).code).toBe(
      "malformed_response",
    );
    const empty = recordedClient({ call: async () => ({}) });
    expect((await readError(verifyIndexVersion({ ...target(DIVERSIFIED), publicClient: empty }))).code).toBe(
      "malformed_response",
    );
  });

  test("a stored spec whose length differs from the size the version records", async () => {
    const base = recordedClient();
    const client = recordedClient({
      call: async (args) =>
        args.data.startsWith("0x4cebcdb1") ? { data: `0x${"0".repeat(62)}20${"0".repeat(64)}` } : base.call(args),
    });
    expect((await readError(verifyIndexVersion({ ...target(DIVERSIFIED), publicClient: client }))).code).toBe(
      "malformed_response",
    );
  });

  test("invalid arguments are a TypeError before any request", async () => {
    const client = recordedClient({
      getChainId: async () => {
        throw new Error("no request expected");
      },
    });
    const valid = target(DIVERSIFIED);
    for (const invalid of [
      { ...valid, chainId: 0 },
      { ...valid, registry: "0x1234" },
      { ...valid, indexId: "0xd622e2a5" },
      { ...valid, version: 0 },
      { ...valid, version: 2 ** 32 },
    ]) {
      await expect(verifyIndexVersion({ ...invalid, publicClient: client })).rejects.toThrow(TypeError);
    }
  });
});

describe("the JSON-RPC path", () => {
  /** A JSON-RPC endpoint over the recording, answering the four methods the verification needs. */
  function rpcFetch(override: (method: string) => unknown = () => undefined) {
    const chain = recordedClient();
    return mockFetch(async (_url, init) => {
      const { id, method, params } = JSON.parse(init.body ?? "{}") as { id: number; method: string; params: unknown[] };
      const replaced = override(method);
      if (replaced !== undefined) return Response.json({ jsonrpc: "2.0", id, ...(replaced as object) });
      const result =
        method === "eth_chainId"
          ? `0x${CHAIN_ID.toString(16)}`
          : method === "eth_blockNumber"
            ? `0x${BigInt(REGISTRY_RECORDING.blockNumber).toString(16)}`
            : method === "eth_getCode"
              ? "0x6080"
              : (await chain.call({ ...(params[0] as { to: Hex; data: Hex }), blockNumber: 29n })).data;
      return Response.json({ jsonrpc: "2.0", id, result });
    });
  }

  test("verifies through rpcUrl with eth_chainId, eth_blockNumber, eth_getCode and eth_call at one block", async () => {
    const mock = rpcFetch();
    const result = await verifyIndexVersion({
      ...target(DIVERSIFIED, 2),
      rpcUrl: "http://rpc.test",
      fetch: mock.fetch,
    });
    expect(result.conformant).toBe(true);
    const requests = mock.calls.map(({ url, init }) => ({ url, ...JSON.parse(init.body ?? "{}") }));
    expect(requests.every(({ url }) => url === "http://rpc.test")).toBe(true);
    expect(requests.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_blockNumber",
      "eth_getCode",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
    ]);
    expect(requests.slice(2).every(({ params }) => params.at(-1) === "0x1d")).toBe(true);
    expect(mock.calls.every(({ init }) => init.method === "POST")).toBe(true);
  });

  test("a JSON-RPC error and an HTTP error are rpc failures", async () => {
    const rpcError = rpcFetch((method) =>
      method === "eth_call" ? { error: { code: -32000, message: "execution reverted" } } : undefined,
    );
    const error = await readError(
      verifyIndexVersion({ ...target(DIVERSIFIED), rpcUrl: "http://rpc.test", fetch: rpcError.fetch }),
    );
    expect(error.code).toBe("rpc_failure");
    expect(String((error.cause as Error).message)).toContain("execution reverted");

    const down = mockFetch(() => new Response("bad gateway", { status: 502 }));
    expect(
      (await readError(verifyIndexVersion({ ...target(DIVERSIFIED), rpcUrl: "http://rpc.test", fetch: down.fetch })))
        .code,
    ).toBe("rpc_failure");
  });

  test("a result that is not hex is a malformed response", async () => {
    const mock = rpcFetch((method) => (method === "eth_blockNumber" ? { result: 9 } : undefined));
    const error = await readError(
      verifyIndexVersion({ ...target(DIVERSIFIED), rpcUrl: "http://rpc.test", fetch: mock.fetch }),
    );
    expect(error.code).toBe("malformed_response");
  });

  test("jsonRpcClient numbers each request", async () => {
    const mock = rpcFetch();
    const client = jsonRpcClient("http://rpc.test", mock.fetch);
    expect(await client.getChainId()).toBe(CHAIN_ID);
    expect(await client.getBlockNumber()).toBe(29n);
    expect(mock.calls.map(({ init }) => JSON.parse(init.body ?? "{}").id)).toEqual([1, 2]);
  });
});

test("a viem PublicClient is accepted as the chain client", async () => {
  const chain = recordedClient();
  const publicClient = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === "eth_chainId") return `0x${CHAIN_ID.toString(16)}`;
        if (method === "eth_blockNumber") return `0x${BigInt(REGISTRY_RECORDING.blockNumber).toString(16)}`;
        if (method === "eth_getCode") return "0x6080";
        if (method === "eth_call")
          return (await chain.call({ ...(params[0] as { to: Hex; data: Hex }), blockNumber: 29n })).data;
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  const result = await verifyIndexVersion({ ...target(DIVERSIFIED, 2), publicClient });
  expect(result.conformant).toBe(true);
});
