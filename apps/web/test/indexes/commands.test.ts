import { describe, expect, test } from "bun:test";
import { chainName, explorerAddressUrl, publicRpcUrl } from "../../src/lib/indexes/chains";
import { CHECK_MEANINGS, CHECK_STATUS_LABELS } from "../../src/lib/indexes/checks";
import { verificationCommands } from "../../src/lib/indexes/commands";

const REGISTRY = "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c";
const INDEX_ID = "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610";

describe("verificationCommands", () => {
  test("builds the three commands from the real address, index id, version and origin", () => {
    const commands = verificationCommands({
      chainId: 31_337,
      registry: REGISTRY,
      indexId: INDEX_ID,
      version: 2,
      siteUrl: "http://localhost:3000",
    });
    const read = `cast call ${REGISTRY} "specOf(bytes32,uint32)(bytes)" ${INDEX_ID} 2 --rpc-url http://127.0.0.1:8545`;
    expect(commands.map(({ id, command }) => [id, command])).toEqual([
      ["read", read],
      ["hash", `${read} | cast keccak`],
      ["api", `curl -s http://localhost:3000/api/v1/indexes/${INDEX_ID}/versions/2`],
    ]);
    for (const { title, expect: expected } of commands) {
      expect(title.length).toBeGreaterThan(0);
      expect(expected.endsWith(".")).toBe(true);
    }
  });

  test("uses the public endpoint of the chain and never a configured one", () => {
    const target = { registry: REGISTRY, indexId: INDEX_ID, version: 1, siteUrl: "https://example.org/" };
    const base = verificationCommands({ ...target, chainId: 8453 });
    expect(base[0]?.command).toEndWith("--rpc-url https://mainnet.base.org");
    expect(base[2]?.command).toBe(`curl -s https://example.org/api/v1/indexes/${INDEX_ID}/versions/1`);
    expect(verificationCommands({ ...target, chainId: 84_532 })[0]?.command).toEndWith("https://sepolia.base.org");
    expect(verificationCommands({ ...target, chainId: 1 })[0]?.command).toEndWith("--rpc-url <RPC_URL>");
  });
});

describe("chains", () => {
  test("names the supported chains and links addresses only where a public explorer exists", () => {
    expect([chainName(8453), chainName(84_532), chainName(31_337), chainName(1)]).toEqual([
      "Base",
      "Base Sepolia",
      "Local development chain",
      "Chain 1",
    ]);
    expect(explorerAddressUrl(8453, REGISTRY)).toBe(`https://basescan.org/address/${REGISTRY}`);
    expect(explorerAddressUrl(84_532, REGISTRY)).toBe(`https://sepolia.basescan.org/address/${REGISTRY}`);
    expect(explorerAddressUrl(31_337, REGISTRY)).toBeNull();
    expect(publicRpcUrl(1)).toBeNull();
  });
});

describe("check wording", () => {
  test("every check has a name and a one-sentence meaning, and every status a label", () => {
    expect(Object.keys(CHECK_MEANINGS)).toEqual(["C1", "C2", "C3", "C4", "C5"]);
    for (const { name, meaning } of Object.values(CHECK_MEANINGS)) {
      expect(name.length).toBeGreaterThan(0);
      expect(meaning).toMatch(/^[A-Z](?:(?!\. ).)*\.$/);
    }
    expect(CHECK_STATUS_LABELS).toEqual({ pass: "Pass", fail: "Fail", skipped: "Not evaluated" });
  });
});
