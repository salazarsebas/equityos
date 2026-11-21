/** Semantic version string, for example `1.2.3` or `1.2.3-beta.1`. */
export type SemverString = `${number}.${number}.${number}` | `${number}.${number}.${number}-${string}`;

/** Version of `@equityos/sdk`. Kept equal to the `version` field of its package.json by a test. */
export const SDK_VERSION: SemverString = "0.0.0";
