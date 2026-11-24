# Deployment

How to deploy the contracts to Base Sepolia and Base mainnet, publish the seed indexes and deploy the web app to
Vercel, as a sequence of checked commands. Nothing on this page has been run against a live network yet: the
contracts are not deployed on any live chain, and the deployment map records none.

Every command was checked against Foundry 1.5.1 (`forge --version`: `1.5.1-stable`, commit `b0a9dd9c`) and its
`--help` output. The whole sequence was rehearsed on a local Anvil fork of Base Sepolia, as described in
[Rehearsal on a local fork](#rehearsal-on-a-local-fork).

## What the owner supplies

| Item                                        | Used for                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A funded deployer key                       | The two contract deployments on each chain. The contracts have no owner: the key gets no role |
| A creator key (may be the same)             | The seed indexes. Its address is their creator forever: choose it deliberately                |
| Base Sepolia and Base mainnet JSON-RPC URLs | Deployment, seed and the server side of the web app                                           |
| Two browser JSON-RPC URLs                   | The browser bundle. Use keys restricted to the site's origin: they are public                 |
| An Etherscan API key                        | Source verification on Basescan. One Etherscan API V2 key covers both Base chains             |
| A Vercel account                            | The web app                                                                                   |
| A WalletConnect project id                  | Optional. Without it the WalletConnect option is absent                                       |

No key, URL or token belongs in the repository, in `apps/web/.env.local` or in a shell history. The commands
below read keys from a Foundry keystore or from an environment variable set for one command only.

## Release checklist

In this order. Each step links to its section.

1. [ ] [Preconditions](#1-preconditions) pass on a clean checkout of the release commit.
2. [ ] [Deploy the contracts to Base Sepolia](#2-deploy-the-contracts).
3. [ ] [Post-deployment checks](#3-post-deployment-checks) pass on Base Sepolia.
4. [ ] [Verify the sources](#4-verify-the-sources) on Basescan (Base Sepolia), or on Sourcify.
5. [ ] [Record the deployment](#5-record-the-deployment) of Base Sepolia in the map, merged with CI green.
6. [ ] [Seed dry run](#6-seed-the-indexes) on Base Sepolia, reviewed.
7. [ ] [Seed](#6-seed-the-indexes) on Base Sepolia with the reviewed plan digest.
8. [ ] [Web preview](#7-deploy-the-web-app) on Vercel, reading Base Sepolia (`EQUITYOS_CHAIN_ID=84532`).
9. [ ] [Smoke checks](#8-smoke-checks) against the preview, with real chain data, all passing.
10. [ ] The owner signs off on the preview.
11. [ ] Steps 2 to 5 on Base mainnet, with `DEPLOY_MAINNET=true`.
12. [ ] Seed dry run, then seed, on Base mainnet with `SEED_MAINNET=true`.
13. [ ] Production deployment on Vercel, reading Base mainnet (`EQUITYOS_CHAIN_ID` unset).
14. [ ] Smoke checks against production.

## 1. Preconditions

From the repository root, on the commit to release:

```sh
git status --short                      # must print nothing
git submodule update --init --recursive
bun install --frozen-lockfile
forge --version                         # must print 1.5.1-stable, as CI (foundryup --install v1.5.1)
bun run contracts:fmt:check
bun run contracts:build
bun run contracts:test
```

`contracts:test` runs `test_ExpectedConstantsMatchTheBuild` in `contracts/test/Deploy.t.sol`: it fails unless this
build produces exactly the `EXPECTED_*` addresses and runtime code hashes committed in `script/Deploy.s.sol`. It is
the same check CI runs, so a passing run means the local compiler output equals CI's. The compiler (solc 0.8.39),
EVM version (`prague`), optimizer (200 runs), `via_ir = false` and metadata settings come from
`contracts/foundry.toml`.

Tag the commit so the addresses can be traced to it: `git tag -a v<version> -m v<version> && git push origin v<version>`.

The rest of the contract steps run from `contracts/` with these variables, set in the shell only:

```sh
cd contracts
export BASE_SEPOLIA_RPC_URL='https://base-sepolia.rpc.example/v1/REPLACE_ME'
export DEPLOYER=0xYourDeployerAddress
```

The deterministic deployment proxy must be on the chain with its pinned code hash. The script checks it too, but
checking first costs nothing:

```sh
cast keccak "$(cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url "$BASE_SEPOLIA_RPC_URL")"
# 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989
```

Both Base chains had it on 2026-11-24. Then simulate the deployment. Without `--broadcast` nothing is sent and no
key is needed; the script prints the predicted addresses, which must be the two below, and the estimated cost:

```sh
GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"
#   IndexRegistry: 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c
#   RebalanceLog:  0x593449aeF0Efc05528D3BC7bE9eb8d99e39AA41c
#   Estimated total gas used for script: 1983204
```

### The deployer key

Import it once into an encrypted Foundry keystore, outside the repository (`~/.foundry/keystores`). The key is
typed at a hidden prompt, never on the command line:

```sh
cast wallet import equityos-deployer --interactive
cast wallet address --account equityos-deployer   # equals $DEPLOYER
cast balance "$DEPLOYER" --rpc-url "$BASE_SEPOLIA_RPC_URL" --ether
```

Fund it with a comfortable multiple of the amount the simulation estimates. A raw key in an environment variable
(`--private-key "$DEPLOYER_PRIVATE_KEY"`) also works, but it appears in the process list while forge runs;
prefer the keystore.

## 2. Deploy the contracts

```sh
GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account equityos-deployer \
  --sender "$DEPLOYER" \
  --broadcast \
  --slow
```

forge asks for the keystore password. The script refuses any chain other than 8453, 84532 and 31337, a missing or
different deployment proxy, and a build whose addresses differ from the committed constants. It sends two
transactions, `IndexRegistry` then `RebalanceLog`, and checks the code hashes, the constants and the log's
registry before it prints. A second run sends nothing and prints `already deployed, skipped`.

The receipts are in `broadcast/Deploy.s.sol/84532/run-latest.json` (ignored by git). The deployment block is the
block of the `IndexRegistry` transaction, the first one the script printed:

```sh
cast receipt <IndexRegistry transaction hash> blockNumber --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The block number the script prints is the block of its simulation, not of the deployment.

On Base mainnet the same command needs the opt-in and the mainnet endpoint:

```sh
export BASE_MAINNET_RPC_URL='https://base-mainnet.rpc.example/v1/REPLACE_ME'
DEPLOY_MAINNET=true GIT_COMMIT=$(git rev-parse HEAD) forge script script/Deploy.s.sol \
  --rpc-url "$BASE_MAINNET_RPC_URL" --account equityos-deployer --sender "$DEPLOYER" --broadcast --slow
```

## 3. Post-deployment checks

```sh
DEPLOY_BLOCK=<deployment block> script/check-deployment.sh "$BASE_SEPOLIA_RPC_URL"
```

`script/check-deployment.sh` is read-only. It checks the chain id, that the runtime code at both addresses hashes
to the committed `EXPECTED_*_CODE_HASH`, `BPS` 10000, `MAX_SPEC_BYTES` 8192, `MAX_CONSTITUENTS` 64, that
`RebalanceLog.REGISTRY()` is the registry, and with `DEPLOY_BLOCK` that the registry has no code at the block
before and has it at that block (this needs an endpoint that serves historical state). CI runs it against a local
Anvil deployment in `contracts/test/deploy-local.sh`. The same checks by hand:

```sh
cast keccak "$(cast code 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c --rpc-url "$BASE_SEPOLIA_RPC_URL")"
cast call 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c 'MAX_CONSTITUENTS()(uint16)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call 0x593449aeF0Efc05528D3BC7bE9eb8d99e39AA41c 'REGISTRY()(address)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

## 4. Verify the sources

On Basescan, through the Etherscan API V2, with the compiler settings of `foundry.toml` stated explicitly:

```sh
export ETHERSCAN_API_KEY='REPLACE_ME'
forge verify-contract 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c src/IndexRegistry.sol:IndexRegistry \
  --chain base-sepolia --compiler-version 0.8.39 --num-of-optimizations 200 --evm-version prague --watch
forge verify-contract 0x593449aeF0Efc05528D3BC7bE9eb8d99e39AA41c src/RebalanceLog.sol:RebalanceLog \
  --chain base-sepolia --compiler-version 0.8.39 --num-of-optimizations 200 --evm-version prague \
  --constructor-args "$(cast abi-encode 'constructor(address)' 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c)" \
  --watch
```

`RebalanceLog` has one constructor argument, the registry address; its ABI encoding is
`0x0000000000000000000000004bd4d49a9c88f75fb97674488e23a7fa59f9506c`. `IndexRegistry` has none. The other settings
(`via_ir = false`, `bytecode_hash = "ipfs"`, CBOR metadata, the `forge-std` remapping) are read from
`foundry.toml`. Add `--show-standard-json-input` to print the exact input that is submitted, without submitting it.
For Base mainnet, use `--chain base`. `forge verify-check <GUID> --chain base-sepolia` reports a pending
verification.

Sourcify needs no key:

```sh
forge verify-contract 0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c src/IndexRegistry.sol:IndexRegistry \
  --chain base-sepolia --verifier sourcify --watch
forge verify-contract 0x593449aeF0Efc05528D3BC7bE9eb8d99e39AA41c src/RebalanceLog.sol:RebalanceLog \
  --chain base-sepolia --verifier sourcify --watch
```

Both contracts were created through the deployment proxy, not by a transaction to the zero address. If Sourcify
cannot find the creation, pass `--creation-transaction-hash <hash>`.

## 5. Record the deployment

The deployment map is `packages/contracts-abi/src/deployments.ts`. Recording a chain is a one-line change in its
entry, from `null` to the deployment block as a `bigint`:

```diff
   [BASE_SEPOLIA_CHAIN_ID]: {
     registry: INDEX_REGISTRY_ADDRESS,
     rebalanceLog: REBALANCE_LOG_ADDRESS,
-    deployBlock: null,
+    deployBlock: 12_345_678n,
   },
```

What proves the map right:

- `packages/contracts-abi/test/deployments.test.ts`, in CI: the addresses, the runtime code hashes and the chain ids
  equal the constants of `contracts/script/Deploy.s.sol`; a recorded block is positive; Base mainnet is never
  recorded without Base Sepolia.
- `test_ExpectedConstantsMatchTheBuild`, in CI: those constants are the build of the commit.
- `apps/web/test/registry/live.test.ts`, by hand, because CI does not reach live networks: on each live chain, code
  at both addresses exactly when a block is recorded, with the expected code hashes, and the head at or past the
  block. Run it in the pull request that records the deployment and paste the output:

  ```sh
  cd apps/web
  LIVE_TESTS=1 BASE_RPC_URL="$BASE_MAINNET_RPC_URL" EQUITYOS_RPC_URL="$BASE_SEPOLIA_RPC_URL" \
    bun test test/registry/live.test.ts
  ```

The same pull request updates what states that nothing is deployed, which then becomes false: the status in
`README.md` and `contracts/README.md`, and the tests that assert it. For Base Sepolia these are the "real map" case
of `apps/web/test/studio/publish.test.ts` and the Base Sepolia notice in `apps/web/e2e/studio.e2e.ts`. For Base
mainnet also the not-deployed case of `apps/web/test/registry/config.test.ts`, and the second server of
`apps/web/playwright.config.ts`, which relies on Base mainnet having no registry to stay offline.

## 6. Seed the indexes

`apps/web/scripts/seed-public.ts` publishes three indexes, chosen at run time from the live market data layer by
rules stated in `apps/web/scripts/seed/public-indexes.ts`:

| Index                              | Constituents and weights                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Large Technology Equal Weight      | AAPL, AMZN, GOOGL, META, MSFT, NVDA, equal weights                                                            |
| Large Technology Capped            | The same six, fixed weights in whole percent proportional to minted supply value at reference prices, 20% cap |
| Largest Minted Supply Equal Weight | The five index-eligible tokens with the largest minted supply value at reference prices, equal weights        |

Minted supply value is the token's total supply times its reference price, both read at the Base mainnet block of
the run. It is a reproducible stand-in for depth of liquidity, which cannot be established onchain. The capped
weights are frozen in the spec when it is published. Each spec declares the chain it is published on, and its
constituents and feeds are Base mainnet addresses, as in the local seed.

It sends nothing unless every check passes, in this order: the endpoint is chain 84532, or 8453 with
`SEED_MAINNET=true`; the deployment map records the registry there; the code at the registry address has the
expected hash; the market data is fresh; every constituent is index-eligible with a usable reference price (the
script aborts listing the ones that are not); the registry derives the same index ids; every `createIndex` call
simulates without reverting. An index that already exists is skipped.

| Variable           | Purpose                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `SEED_RPC_URL`     | Endpoint of the chain to seed. Required                                                   |
| `BASE_RPC_URL`     | Base mainnet endpoint for the market data. Without it the rate limited public one is used |
| `SEED_CREATOR`     | Creator address, for a dry run without the key                                            |
| `SEED_PRIVATE_KEY` | Creator key. Required with `--send`. Read from the environment only, never printed        |
| `SEED_PLAN_DIGEST` | The digest the dry run printed. Required with `--send`                                    |
| `SEED_MAINNET`     | Must be `true` to seed Base mainnet                                                       |

The dry run is the default. It prints the supply value ranking, then for each index the rule, the predicted index
id, the salt, the spec hash, the constituents with their weights, the spec text, and the exact transaction with
its calldata, and last the plan digest:

```sh
SEED_RPC_URL="$BASE_SEPOLIA_RPC_URL" BASE_RPC_URL="$BASE_MAINNET_RPC_URL" SEED_CREATOR="$CREATOR" \
  bun run seed:public
```

Review it. Import the creator key into the keystore the same way as the deployer key
(`cast wallet import equityos-creator --interactive`, or reuse `equityos-deployer`), then send exactly that plan,
with the key decrypted into the environment of this one command:

```sh
SEED_RPC_URL="$BASE_SEPOLIA_RPC_URL" BASE_RPC_URL="$BASE_MAINNET_RPC_URL" \
  SEED_PLAN_DIGEST=<digest from the dry run> \
  SEED_PRIVATE_KEY="$(cast wallet private-key --account equityos-creator)" \
  bun run seed:public -- --send
```

The digest covers the chain, the creator, the registry and every transaction byte. If a reference price or a
supply moved enough to change a capped weight or the ranking between the two runs, the send refuses with
`plan_digest_mismatch`: run the dry run again and review the new plan. Each sent transaction is checked by its
receipt, its `IndexCreated` and `VersionPublished` events and a read-back of the stored spec hash. On Base mainnet
add `SEED_MAINNET=true` to both runs.

## 7. Deploy the web app

### Project settings

No `vercel.json` is needed. In the Vercel project:

| Setting           | Value                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Framework Preset  | Next.js                                                                                         |
| Root Directory    | `apps/web`, with "Include source files outside of the Root Directory in the Build Step" enabled |
| Install Command   | `bun install --frozen-lockfile`. Bun finds the workspace root and installs every workspace      |
| Build Command     | `bun run build`, which runs `next build`. The workspace packages are compiled from source       |
| Output Directory  | Default (`.next`)                                                                               |
| Node.js Version   | 22.x, the version of `.nvmrc`                                                                   |
| Production Branch | `main`                                                                                          |

The preview reads Base Sepolia and production reads Base mainnet, so the two Vercel environments get different
values for `EQUITYOS_CHAIN_ID` and `EQUITYOS_RPC_URL`.

### Environment variables

`NEXT_PUBLIC_*` values are compiled into the browser bundle when the app is built: they are public, and changing one
needs a new deployment.

| Variable                               | Required                              | Used by                                                                      | Visibility |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `BASE_RPC_URL`                         | Yes                                   | Server: market data, and the registry on Base mainnet                        | Secret     |
| `EQUITYOS_CHAIN_ID`                    | Preview: `84532`. Production: unset   | Server: the chain the registry is read from (default 8453)                   | Public     |
| `EQUITYOS_RPC_URL`                     | When `EQUITYOS_CHAIN_ID` is `84532`   | Server: the Base Sepolia registry reads                                      | Secret     |
| `EQUITYOS_REQUIRE_REGISTRY`            | `true` once the map records the chain | Server start: refuses to serve when the map records no registry on the chain | Public     |
| `NEXT_PUBLIC_SITE_URL`                 | Yes, an https origin                  | Build: canonical URLs, sitemap, WalletConnect metadata, CSP upgrade          | Public     |
| `NEXT_PUBLIC_BASE_RPC_URL`             | Yes                                   | Browser: Base mainnet reads; CSP `connect-src`                               | Public     |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`     | Yes                                   | Browser: Base Sepolia reads; CSP `connect-src`                               | Public     |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional                              | Browser: enables WalletConnect and its CSP hosts                             | Public     |
| `EQUITYOS_LOG_CHUNK_BLOCKS`            | Optional                              | Server: blocks per `eth_getLogs` request (default 2000)                      | Public     |
| `EQUITYOS_EXCLUDED_ACCOUNTS`           | Optional                              | Server: accounts the network metrics show apart                              | Public     |
| `KYBERSWAP_CLIENT_ID`                  | Optional                              | Server: client id sent to the aggregator (default `equityos`)                | Public     |
| `MARKET_REPLAY_DIR`                    | Never                                 | Browser tests only                                                           | Not set    |
| `REGISTRY_REPLAY_DIR`                  | Never                                 | Browser tests only                                                           | Not set    |
| `EQUITYOS_REPLAY_FOR_TESTS`            | Never                                 | Browser tests only                                                           | Not set    |
| `NEXT_PUBLIC_ANVIL_RPC_URL`            | Never                                 | Development builds only                                                      | Not set    |

Vercel sets `VERCEL_ENV` itself, and adds the `x-vercel-ip-country` header the jurisdiction gate reads.

### Startup check

`apps/web/src/server/deployment-check.ts` runs from the startup hook (`src/instrumentation.ts`) of every production
server, Vercel or `next start`. It refuses to serve when `BASE_RPC_URL`, `NEXT_PUBLIC_SITE_URL`,
`NEXT_PUBLIC_BASE_RPC_URL` or `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` is missing or not a URL, when the site URL is not
an https origin, when a replay variable or the test flag is set, when `EQUITYOS_CHAIN_ID` is unsupported or names
the local chain, when Base Sepolia has no `EQUITYOS_RPC_URL`, and when `EQUITYOS_REQUIRE_REGISTRY=true` while the
deployment map records no registry on the chain. Each problem is logged on one line, by variable name and never
with its value:

```text
deployment configuration: BASE_RPC_URL is not set
deployment configuration: EQUITYOS_CHAIN_ID names the local development chain
```

The hook then fails and every request answers 500, so a misconfigured deployment shows up in the first smoke
check instead of serving wrong data. The only production server it skips is the one the browser smoke tests start
outside Vercel with `EQUITYOS_REPLAY_FOR_TESTS=1`, which the replay rules already govern.

### Security headers

`apps/web/next.config.ts` sets on every route the headers built by `apps/web/src/lib/security-headers.ts`:

| Header                      | Value                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `Content-Security-Policy`   | Below                                                                                |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` (not in development)                           |
| `X-Content-Type-Options`    | `nosniff`                                                                            |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                                                    |
| `Permissions-Policy`        | Camera, microphone, geolocation, payment, USB, sensors, MIDI, autoplay, topics: none |
| `X-Frame-Options`           | `DENY`, for browsers without `frame-ancestors`                                       |

The Content-Security-Policy:

| Directive                   | Allows                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-src`               | `'self'`                                                                                                                                                                                                                                                             |
| `script-src`                | `'self'` and inline: Next.js bootstraps pages with inline scripts and the theme script runs before paint                                                                                                                                                             |
| `style-src`                 | `'self'` and inline                                                                                                                                                                                                                                                  |
| `img-src`                   | `'self'`, `data:`, `blob:`; with WalletConnect also `https://api.web3modal.org`                                                                                                                                                                                      |
| `font-src`                  | `'self'` (fonts are self-hosted); with WalletConnect also `https://fonts.reown.com`                                                                                                                                                                                  |
| `connect-src`               | `'self'`, the origins of the two `NEXT_PUBLIC_*_RPC_URL` values, Base Account (`keys.coinbase.com`, `rpc.wallet.coinbase.com`, `chain-proxy.wallet.coinbase.com`, `cca-lite.coinbase.com`); with WalletConnect also its relay, RPC, event, registry and verify hosts |
| `frame-src`                 | `'none'`; with WalletConnect its verify frames                                                                                                                                                                                                                       |
| `frame-ancestors`           | `'none'`: the app cannot be framed                                                                                                                                                                                                                                   |
| `object-src`                | `'none'`                                                                                                                                                                                                                                                             |
| `base-uri`, `form-action`   | `'self'`                                                                                                                                                                                                                                                             |
| `upgrade-insecure-requests` | When `NEXT_PUBLIC_SITE_URL` is https                                                                                                                                                                                                                                 |

Only the origin of an RPC URL enters the policy, never its path, where providers put keys. `'unsafe-eval'` is
allowed in development only. `Cross-Origin-Opener-Policy` is not set, because Base Account answers from its popup
through `window.opener`. `apps/web/e2e/headers.e2e.ts` checks the headers on the production build and that the
pages and the wallet connection run without a policy violation; the Base Account popup and the WalletConnect modal
were checked by hand in a browser with no violation.

## 8. Smoke checks

`scripts/smoke-deployment.ts` reads a deployment with GET requests only and prints one line per check:

```sh
bun run smoke:deployment https://<preview-url> --chain 84532
bun run smoke:deployment https://<production-url>
```

| Check            | Passes when                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| status           | `GET /api/v1/status`: `meta.mode` is `live`, the registry is deployed on the expected chain, market data is live with a block   |
| assets           | `GET /api/v1/assets?eligible=true`: live, every reference price names its feed and its publication time, at least one is usable |
| indexes          | `GET /api/v1/indexes`: live, read from the expected chain, at least one index                                                   |
| network          | `GET /api/v1/network`: live, on the expected chain, with the published count                                                    |
| pages            | The key pages, the first index page, the OpenAPI document, `robots.txt` and `sitemap.xml` answer 200                            |
| security headers | `/` carries the policy with `frame-ancestors 'none'`, HSTS and `nosniff`                                                        |

It exits with 1 when a check fails. A preview behind Vercel Deployment Protection is reached with the project's
automation bypass secret in `VERCEL_AUTOMATION_BYPASS_SECRET`, sent as the `x-vercel-protection-bypass` header and
never printed.

## Rehearsal on a local fork

The sequence can be rehearsed without any key or live transaction, on an Anvil fork of Base Sepolia, which keeps
chain id 84532 and sends nothing upstream:

```sh
anvil --fork-url https://sepolia.base.org --port 8590 &
cd contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8590 --broadcast --unlocked \
  --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 && cd ..
DEPLOY_BLOCK=<block> contracts/script/check-deployment.sh http://127.0.0.1:8590
```

Then record that block in a local, uncommitted copy of the map and run the seed against the fork with the first
Anvil development key, whose key is public and only meaningful on a local chain. Build the app with
`NEXT_PUBLIC_SITE_URL=http://127.0.0.1:5700` and `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=http://127.0.0.1:8590`, start it
with `EQUITYOS_CHAIN_ID=84532`, `EQUITYOS_RPC_URL=http://127.0.0.1:8590` and `BASE_RPC_URL`, mine a few blocks
(`cast rpc anvil_mine 0x14 --rpc-url http://127.0.0.1:8590`) so the event scan passes its confirmations, and run
`bun run smoke:deployment http://127.0.0.1:5700 --chain 84532`. Restore the map afterwards. This rehearsal passed on
2026-11-24: three seed indexes created and read back, every smoke check passing.

## What cannot be undone

The contracts have no owner, no upgrade path and no self-destruct: a deployment is permanent, and a fix is a new
contract at a new address. A published index stays readable forever; its creator can only deprecate it. A web
deployment can be rolled back in Vercel by promoting the previous deployment.
