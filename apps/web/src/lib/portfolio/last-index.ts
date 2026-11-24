/**
 * The last index a wallet was compared with, remembered in this browser only. Versioned key; nothing else is
 * stored, and a storage that is unavailable or holds something unexpected is ignored.
 */
const KEY = "equityos-portfolio-last-index-v1";
const MAX_ENTRIES = 20;

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function lastIndexOf(address: string): string | null {
  return readAll()[address.toLowerCase()] ?? null;
}

export function rememberIndex(address: string, identifier: string): void {
  const entries = Object.entries(readAll()).filter(([key]) => key !== address.toLowerCase());
  entries.push([address.toLowerCase(), identifier]);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_ENTRIES))));
  } catch {
    // Storage is a convenience: when it is unavailable nothing is remembered.
  }
}
