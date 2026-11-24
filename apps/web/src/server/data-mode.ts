import "server-only";

/**
 * Where the data of a response comes from.
 *
 * - `live`: the sources are read as they are now.
 * - `replay`: a recording of one past block is served, for the browser tests. It is never current data.
 */
export type DataMode = "live" | "replay";

/**
 * The variable that lets a production build replay a recording: `1` allows it. Only the Playwright
 * configuration of the browser smoke tests sets it, because those tests run `next start` on a production build
 * with no network access. It has no effect on a Vercel deployment, where replay is always refused.
 */
export const REPLAY_TEST_FLAG = "EQUITYOS_REPLAY_FOR_TESTS";

export interface ReplayEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly VERCEL_ENV?: string | undefined;
  readonly EQUITYOS_REPLAY_FOR_TESTS?: string | undefined;
}

/**
 * Why a replay variable may not be honoured in this environment, or `null` when it may.
 *
 * - On a Vercel deployment (`VERCEL_ENV` is set, whatever its value) replay is refused, with or without the
 *   test flag: a deployment serves people.
 * - In a production build (`NODE_ENV` is `production`) replay is refused unless `EQUITYOS_REPLAY_FOR_TESTS` is
 *   exactly `1`.
 * - Anywhere else (development, unit tests) replay is allowed.
 */
export function replayRefusal(env: ReplayEnvironment): string | null {
  if ((env.VERCEL_ENV?.trim() ?? "") !== "") return "is set on a deployment, which never serves a recording";
  if (env.NODE_ENV === "production" && env.EQUITYOS_REPLAY_FOR_TESTS !== "1") {
    return `is set in a production build without ${REPLAY_TEST_FLAG}=1, which only the browser tests set`;
  }
  return null;
}

/** The mode of a response built from several sources: `replay` as soon as one of them is a replay. */
export function combinedMode(...modes: readonly DataMode[]): DataMode {
  return modes.includes("replay") ? "replay" : "live";
}
