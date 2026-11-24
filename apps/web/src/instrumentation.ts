/**
 * Runs once when a server instance starts. It resolves where the market data and the index registry are read
 * from, so that a replay variable set where a replay is refused (a deployment, or a production build without
 * the test flag) stops the server at startup instead of at the first request.
 *
 * @throws {MissingConfigurationError} if `MARKET_REPLAY_DIR` is set where a replay is refused.
 * @throws {RegistryConfigurationError} if `REGISTRY_REPLAY_DIR` is set where a replay is refused.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { marketDataMode } = await import("@/server/market");
  const { registryMode } = await import("@/server/registry");
  marketDataMode();
  registryMode();
}
