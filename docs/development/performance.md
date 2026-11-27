# Performance and SEO budgets

The web app has budgets for speed, page weight and search metadata. Each one is checked in CI against the
production build with the recorded market data and registry of the smoke tests, so the numbers do not depend on
the network or on a live chain. A change that misses a budget fails the `web` job.

## Lighthouse

`bun run test:lighthouse` (after `bun run build`) starts the production server, runs Lighthouse with mobile
emulation and simulated throttling on three routes, and checks the run with the median performance score out of
three:

| Route                                  | Why                                    |
| -------------------------------------- | -------------------------------------- |
| `/`                                    | The landing page                       |
| `/indexes`                             | The index explorer                     |
| `/indexes/diversified-equity-d622e2a5` | An index page of the recorded registry |

| Budget                                       | Value        |
| -------------------------------------------- | ------------ |
| Performance score                            | at least 95  |
| Accessibility, best practices and SEO scores | 100          |
| Largest contentful paint                     | under 2.0 s  |
| Cumulative layout shift                      | under 0.05   |
| Total blocking time                          | under 200 ms |

Total blocking time is the lab stand-in for interaction to next paint, which a page load without interaction
cannot measure. The budgets live in `apps/web/scripts/lighthouse-budgets.ts`. Chrome comes from `CHROME_PATH`, or
from the Chrome Headless Shell installed by `bunx playwright install --only-shell chromium`. `LIGHTHOUSE_RUNS`
changes the number of runs per route.

Layout shift is the budget most easily broken. Two patterns keep it at zero today:

- Both font families are preloaded. Numbers, addresses and stats use the mono face, and its proportional fallback
  wraps text differently, so a late mono file moves the page.
- A control that exists only once the page is interactive, such as the copy button, holds its place with an
  invisible box of the same size until then.

## First-load JavaScript

`apps/web/e2e/bundle-budgets.e2e.ts` loads every public page and an index page, adds the compressed size of every
script downloaded until the network is idle, and compares it with the route's budget in
`apps/web/e2e/bundle-budgets.json`, in kilobytes of 1,000 bytes. It runs with the other Playwright tests
(`bun run test:e2e`), and each result is reported as a test annotation.

The budgets sit about 5% above the measured size, so a new dependency on a route fails while small changes do not.
When a change adds JavaScript on purpose, raise the budget of that route in the same pull request and say why in its
description. When a change makes a route smaller, lower the budget.

## Search metadata

`apps/web/e2e/seo.e2e.ts` checks, on every public page and an index page:

- a title of at most 90 characters and a description of 50 to 300 characters, neither shared with another page;
- a canonical URL equal to the page's own path, Open Graph title and description, `lang="en"`, one `h1`, no
  `noindex` and no image without a width and a height;
- schema.org structured data: `WebSite` on the landing page, `Dataset` on an index page, with the values the page
  shows (name, description, version, canonical URL and publication times);
- that every URL of `/sitemap.xml` answers 200 without `noindex`, that the sitemap lists the published indexes,
  and that `robots.txt` excludes `/dev/` and names the sitemap;
- that every font is a self-hosted `woff2` file and is preloaded.

The public pages are listed in `apps/web/src/lib/public-routes.ts`. A unit test fails when a page route exists in
`src/app` without being listed there or excluded with a reason, so a new page is added to the sitemap on purpose.
The sitemap adds one URL per published index, read from the registry on request; when the registry cannot be read
it lists the fixed pages only and logs the failure.

The app serves no raster images. The fonts are IBM Plex Sans (one variable file) and IBM Plex Mono (400 and 500),
Latin subset, self-hosted from pinned Fontsource packages.

## What is not measured

Field data from real visitors (real-user monitoring) needs a live deployment and is not collected.
