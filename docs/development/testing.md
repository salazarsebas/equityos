# Browser tests

The Playwright tests in `apps/web/e2e` run against the production build with recorded data: the main server replays
the market data of `test/fixtures/market` with its clock fixed at the recorded block, and the registry of
`test/fixtures/registry`. No request leaves the machine, so every run sees the same pages. Run them after a build:

```sh
bun run build
bun run test:e2e
```

Transactions sent for real, to a local Anvil node, are in `apps/web/e2e-chain` and run with `bun run test:integration`
(see [Local chain](local-chain.md)).

## What the suite covers

| File              | What it checks                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journeys.e2e.ts` | Journeys that start on the landing page and move only by links and controls: verify an index, read the drift of a wallet and a buy-only plan, publish up to the review, publish a new version as the creator, execute with a mocked wallet (review, acknowledge, sign, decline), a blocked plan, and the jurisdiction gate |
| `keyboard.e2e.ts` | The publish and execute journeys with the keyboard only. At every Tab stop the focused element must show the 2 px focus outline, and focus that stops moving fails the test as a trap                                                                                                                                      |
| `visual.e2e.ts`   | Screenshot baselines of six pages at 375, 768 and 1440 px in both themes (below)                                                                                                                                                                                                                                           |
| The other files   | Each page and API in depth: states, errors, layout at narrow widths, accessibility (axe), headers, SEO and the first-load JavaScript budgets ([Performance and SEO budgets](performance.md))                                                                                                                               |

The execution tests answer `POST /api/v1/portfolio/execution-plan` themselves with the plans of `execution-support.ts`
and `execution-plans.ts`, and mock the Base RPC in the page: the replay server builds no executable plan.

## Screenshot baselines

`visual.e2e.ts` compares full-page screenshots of the landing page, the explorer, an index page, the Studio, a
portfolio comparison and the network page with the PNG files in `apps/web/e2e/__screenshots__/visual.e2e.ts`. A page
is captured once its client parts have mounted: the wallet control is resolved and no element is `aria-busy`.

Text rasterizes differently on each operating system, so the baselines are rendered on Linux, like the CI runner, and
the test is skipped on other systems. To render them on any machine with Docker:

```sh
bun run test:visual:update            # writes the baselines
apps/web/scripts/update-visual-baselines.sh --check   # compares without writing
```

Both run the Playwright image of the pinned version (amd64, the runner's architecture) on a copy of the repository,
so the host's `node_modules` and build are left alone. A failed check leaves the expected, actual and diff images in
`apps/web/test-results`.

When a change alters a page on purpose, update the baselines in the same pull request, look at every changed image
in the diff, and say in the description which pages changed and why. A baseline that changes without a reason is a
regression.

## Stability

A test that fails once without a code change is fixed or removed within a day. To check a new test, repeat it:

```sh
cd apps/web
bunx playwright test e2e/journeys.e2e.ts e2e/keyboard.e2e.ts --repeat-each=20
scripts/update-visual-baselines.sh --check --repeat-each=20
```
