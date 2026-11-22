import { describe, expect, test } from "bun:test";
import { listWalletOptions } from "../../src/lib/wallet/options";

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const generic = { id: "injected", name: "Injected", type: "injected" };
const baseAccount = { id: "baseAccount", name: "Base Account", type: "baseAccount" };
const walletConnect = { id: "walletConnect", name: "WalletConnect", type: "walletConnect" };
const rabby = { id: "io.rabby", name: "Rabby Wallet", type: "injected", icon: ICON };
const metaMask = { id: "io.metamask", name: "MetaMask", type: "injected", icon: "data:image/png;base64,AAAA" };

describe("listWalletOptions", () => {
  test("lists each discovered wallet by its own name and icon, before the others", () => {
    const options = listWalletOptions([generic, baseAccount, rabby, metaMask], true);
    expect(options.map(({ name }) => name)).toEqual(["Rabby Wallet", "MetaMask", "Base Account"]);
    expect(options.map(({ icon }) => icon)).toEqual([ICON, "data:image/png;base64,AAAA", null]);
    expect(options[0]?.connector).toBe(rabby);
    expect(options[0]?.detail).toBe("Detected in this browser");
  });

  test("offers the legacy provider only when no wallet announced itself and one exists", () => {
    expect(listWalletOptions([generic, baseAccount], true).map(({ name }) => name)).toEqual([
      "Browser wallet",
      "Base Account",
    ]);
    expect(listWalletOptions([generic, baseAccount], false).map(({ name }) => name)).toEqual(["Base Account"]);
  });

  test("WalletConnect appears exactly when its connector is configured", () => {
    expect(listWalletOptions([generic, baseAccount], false).some(({ name }) => name === "WalletConnect")).toBe(false);
    const options = listWalletOptions([generic, baseAccount, walletConnect], false);
    expect(options.map(({ name }) => name)).toEqual(["Base Account", "WalletConnect"]);
    expect(options.every(({ detail }) => detail !== "")).toBe(true);
  });

  test("drops an icon that is not an image data URI", () => {
    for (const icon of ["https://example.org/icon.png", "javascript:alert(1)", "data:text/html,<p>", ""]) {
      expect(listWalletOptions([{ ...rabby, icon }], false)[0]?.icon).toBeNull();
    }
  });
});
