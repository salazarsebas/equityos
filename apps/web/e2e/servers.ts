/** Origins of the servers `playwright.config.ts` starts next to the main one, which is the `baseURL`. */
const port = Number(process.env.E2E_PORT ?? 3100);

/** Reads Base mainnet, where the index registry is not deployed. */
export const NOT_DEPLOYED_ORIGIN = `http://127.0.0.1:${port + 1}`;
/** Replays a registry that is deployed and holds no index. */
export const EMPTY_REGISTRY_ORIGIN = `http://127.0.0.1:${port + 2}`;
