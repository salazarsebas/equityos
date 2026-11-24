# Design system

The visual language and the component library of the web app. Everything described here is implemented in
`apps/web` and rendered on the component reference page at `/dev/components`.

## Principles

- The interface reads like a published document: paper-toned surfaces, hairline rules, dense tables.
- Hierarchy comes from type size, weight and whitespace. Not from boxes, shadows or color fills.
- One accent color, used only for interaction: links, the primary action, focus and selection.
- Positive and negative colors carry the sign of a return and nothing else. A signed value always shows an
  explicit `+` or minus sign, so it reads the same without color.
- Light and dark themes are equal. Both pass the same contrast targets.

## Tokens

Color tokens are CSS custom properties in `apps/web/src/styles/tokens.css`. Each one is declared once as
`light-dark(<light>, <dark>)`. `apps/web/src/app/globals.css` maps them to Tailwind CSS utilities in `@theme` and
removes the default Tailwind palette, type scale, radii and shadows, so only the scales below exist.

| Role     | Custom properties                                                          | Utilities                                                          |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Surface  | `--bg-page`, `--bg-surface`, `--bg-subtle`                                 | `bg-page`, `bg-surface`, `bg-subtle`                               |
| Border   | `--border`, `--border-strong`                                              | `border` (default color), `border-strong`                          |
| Text     | `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-disabled` | `text-primary`, `text-secondary`, `text-tertiary`, `text-disabled` |
| Accent   | `--accent`, `--accent-hover`, `--accent-fg`, `--accent-subtle`             | `bg-accent`, `text-accent`, `text-accent-fg`, `bg-accent-subtle`   |
| Semantic | `--positive`, `--negative`, `--warning`, `--info`, each with `-subtle`     | `text-positive`, `bg-positive-subtle` and so on                    |
| Overlay  | `--scrim`, `--border-overlay`, `--elevation-overlay`                       | `bg-scrim`, `border-overlay`, `shadow-overlay`                     |

Rules:

- `--text-tertiary` is the lightest color allowed for text that carries information. `--text-disabled` is for
  disabled controls only.
- `--border-strong` outlines controls. `--border` draws hairlines and table rules.
- Drift outside a threshold, stale data and simulated or demo state use warning, not negative.

### Contrast

`apps/web/test/contrast.test.ts` parses `tokens.css` and computes WCAG 2.x contrast ratios for both themes. It
requires 4.5:1 for every text, accent and semantic color on each surface it is used on, and 3:1 for control
outlines. A token change that breaks a target fails `bun run test`.

### Theme

The theme follows the system preference through `color-scheme`. A script in `<head>` resolves the theme before the
first paint, from the stored choice or else from the system preference, and writes it to `<html data-theme>`. The
toggle in the header flips that attribute and stores the choice in `localStorage` under `equityos-theme`. Styles
never branch on the theme: they use tokens. The `theme-dark:` variant exists for the rare exception, such as
swapping an icon.

### Type

IBM Plex Sans (400, 500, 600) for all interface text and IBM Plex Mono (400, 500) for identifiers: addresses,
hashes, symbols, code and API paths. Both are self-hosted with `next/font/local` and served from the app's own
origin; the build makes no network request.

- Files: the latin subset in woff2 from the exact-pinned Fontsource packages `@fontsource-variable/ibm-plex-sans`
  (the variable font, one file for the three weights) and `@fontsource/ibm-plex-mono` (one file per weight). Both
  fonts are under the SIL Open Font License 1.1, which allows redistribution with the software.
- Display: `swap`. IBM Plex Sans is preloaded, IBM Plex Mono is not.
- Fallback: until a web font loads, text renders in Arial with metric overrides that match IBM Plex, declared in
  `globals.css` as `IBM Plex Sans Fallback` and `IBM Plex Mono Fallback`, so the swap does not shift the layout.
- CI fails if the source or the build output references a Google Fonts host.

| Utility     | Size / line height (px) | Use                                         |
| ----------- | ----------------------- | ------------------------------------------- |
| `text-xs`   | 12 / 16                 | Captions, source lines, tags, table headers |
| `text-sm`   | 13 / 20                 | Dense table cells, secondary text           |
| `text-base` | 14 / 20                 | Body, form controls, table cells            |
| `text-md`   | 16 / 24                 | Lead paragraphs                             |
| `text-lg`   | 20 / 28                 | Section headings, stat values               |
| `text-xl`   | 24 / 32                 | Page titles                                 |
| `text-2xl`  | 32 / 40                 | Landing section headings                    |
| `text-3xl`  | 44 / 48                 | Landing headline                            |

- Weights: 400 for text, 500 for headings and emphasis, 600 for the wordmark. No italics for emphasis.
- Sentence case everywhere, including table headers. No uppercase, letter-spaced labels.
- Prose is capped at 68 characters with `max-w-measure`.
- Numbers stay in the sans face. Every numeric cell and stat value uses the `num` utility, which sets
  `font-variant-numeric: tabular-nums lining-nums`.

### Spacing, layout and shape

- Spacing uses a 4 px base. Allowed steps, in Tailwind units: `0`, `0.5`, `1`, `2`, `3`, `4`, `6`, `8`, `12`,
  `16`, `24` (0 to 96 px).
- `Container` caps content at 1280 px with 32 px side margins, 16 px under 768 px. `Grid` is the 12-column grid
  with 24 px gutters. Breakpoints: 640, 768, 1024 and 1280 px.
- Regions are separated by whitespace and 1 px rules. A page has at most one level of bordered container.
- Heights: 32 px controls, 40 px for the single primary action of a page, 36 px table rows (32 px dense), 32 px
  table headers, 56 px top bar. Controls and table rows grow to 44 px on touch devices.
- Radius: `rounded-sm` 2 px for tags, `rounded-md` 4 px for controls, `rounded-lg` 6 px for dialogs and the
  table frame. Nothing larger.
- No shadows on in-flow elements. `shadow-overlay` is the single elevation, for dialogs and popovers. In the
  dark theme it is replaced by a stronger outline.
- Focus is a 2 px accent outline with a 2 px offset on every interactive element. It is set globally and must
  not be removed.
- Motion is limited to 120 ms color transitions. Skeletons are static.

## Components

All components live in `apps/web/src/components/ui`. They have no dependency beyond React and Next.js.

| Component                              | File              | Notes                                                                                     |
| -------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `Button`                               | `button.tsx`      | `primary`, `secondary`, `ghost`, `destructive`. Sizes `md` and `lg`. Loading, disabled.   |
| `Link`                                 | `link.tsx`        | `inline` and `quiet`. Absolute URLs get the external link icon.                           |
| `Field`, `Input`, `Textarea`, `Select` | `field.tsx`       | And `Checkbox`. `Field` wires label, hint and error to the control through a render prop. |
| `Tabs`                                 | `tabs.tsx`        | ARIA tabs pattern, automatic activation, arrow keys, Home and End.                        |
| `Tag`, `StatusTag`                     | `tag.tsx`         | Five tones. `StatusTag` accepts only the fixed status set.                                |
| `Callout`                              | `callout.tsx`     | `neutral`, `info`, `warning`, `negative`.                                                 |
| `Table` and its parts                  | `table.tsx`       | Sticky header, pinned first column, numeric cells, dense variant, caption, totals.        |
| `Stat`, `StatGrid`                     | `stat.tsx`        | Label and value pairs on hairlines. Not cards. Four or six to a row.                      |
| `CopyButton`                           | `copy-button.tsx` | Copies an exact value and confirms in place. Rendered only once the page is interactive.  |
| `CodeBlock`                            | `code-block.tsx`  | Mono text with a title bar and a copy button. Wraps commands, scrolls JSON inside itself. |
| `SourceLine`                           | `source-line.tsx` | Source name and as-of time in UTC for one data region. Warning tone when stale.           |
| `Skeleton`                             | `skeleton.tsx`    | Static placeholder sized like the content it replaces.                                    |
| `EmptyState`, `ErrorState`             | `state.tsx`       | Text and one action. No illustration.                                                     |
| `Dialog`                               | `dialog.tsx`      | Native `<dialog>`: focus trap, Escape, inert background, focus return.                    |

The shell is in `apps/web/src/components/shell`: `Header`, `PrimaryNav`, `ThemeToggle`, `Footer`, `Container` and
`Grid`. The root layout adds a skip link before the header.

The top bar ends with the account control from `apps/web/src/components/wallet`: "Connect wallet", or the
shortened account in mono with a menu. It has a fixed width of 176 px and is a neutral block of that size until
its code has loaded, so the bar never shifts. Under 640 px the primary navigation moves to a second row of 40 px,
because the wordmark, the navigation, the theme toggle and the account control do not fit in one.

### Usage rules

- **Button.** One primary button per screen. The label is a verb that states what will happen. Disabled and
  loading buttons use `aria-disabled` so they stay focusable. Pass `loadingLabel` to say what is in progress.
- **Link.** A path under `/api/` is a response of the API, not a page. `Link` renders it as a plain anchor, so
  the router neither prefetches it nor navigates to it on the client.
- **Tag.** A tag appears once per scope: in the table caption, not on every row. Do not invent status tags. The
  set is `Theoretical`, `Actual`, `Simulated`, `Demo data`, `Back-calculated`, `Reference`, `Quote`,
  `Market closed`, `Delayed`, `Reference index`, `Deprecated`.
- **Table.** Text left, numbers right, identifiers left in mono. Mark every cell of a numeric column, header
  included, as `numeric`. Put the unit in the header when the column shares one. The first column identifies the
  row and is the only one in medium weight. No vertical borders and no zebra striping. On narrow screens the
  table scrolls horizontally: it is never converted into cards. Pass `maxHeight` to scroll the body under the
  sticky header.
- **Stat.** The value is a string from the formatting utilities. A missing value renders as `MISSING`, never as
  zero.
- **SourceLine.** One per data region, directly under it. Timestamps are UTC.
- **ErrorState.** Say what happened, what state the user's data or assets are in, and what to do next, in that
  order. A failed region shows an error state, not an empty table.
- **Dialog.** Never open a dialog from another dialog.
- **Icons.** `icons.tsx` holds the whole set: 16 px, 1.5 px stroke. Use an icon only where it carries meaning.

## Number and time formatting

`apps/web/src/lib/format.ts` formats values for rendered UI. Every function takes `bigint` in an explicit unit and
returns a string. No value passes through a floating-point number. The helpers live in the web app and not in
`@equityos/core` because they are presentation: they insert thousands separators and the true minus sign
(U+2212), which must not appear in CSV or API output.

| Function                 | Input                   | Output                 | Rounding            |
| ------------------------ | ----------------------- | ---------------------- | ------------------- |
| `formatPercent`          | basis points            | `15.00%`               | exact               |
| `formatSignedPercent`    | basis points            | `+3.42%`               | exact               |
| `formatPercentagePoints` | basis points            | `+3.21 pp`             | exact               |
| `formatUsd`              | amount, decimals        | `12,480.33`            | half away from zero |
| `formatPrice`            | price, decimals         | `184.27`               | half away from zero |
| `formatTokenQuantity`    | base units, decimals    | `4.2031`               | toward zero         |
| `formatCompact`          | value, decimals         | `1.2M`                 | half away from zero |
| `formatCount`            | integer                 | `1,204`                | exact               |
| `formatFixed`            | value, decimals, digits | `1,084.27`             | half away from zero |
| `formatUtcDate`          | Unix seconds            | `2026-11-21`           | exact               |
| `formatUtcDateTime`      | Unix seconds            | `2026-11-20 21:00 UTC` | minute, down        |
| `formatUtcMinute`        | Unix seconds            | `2026-11-20 21:00`     | minute, down        |
| `formatRelativeTime`     | Unix seconds, now       | `4 s ago`              | largest unit, down  |
| `shortenAddress`         | 20-byte hex address     | `0x1234...abcd`        | not applicable      |
| `shortenHash`            | 32-byte hex value       | `0x90d5104e`           | not applicable      |

- A non-zero USD amount under one cent renders as `<0.01`.
- Prices under 1.00 use 4 decimals.
- Token quantities show up to 6 significant digits, trim trailing zeros and never shorten the integer part.
- Zero is unsigned.
- `formatCompact` is for stat rows only. Tables show full values.
- `formatUtcMinute` is for a table column whose header states UTC. Everywhere else the zone is written.

## Navigation

`apps/web/src/lib/navigation.ts` holds the primary navigation as typed data. An entry is added in the same change
that adds its page: `apps/web/test/navigation.test.ts` fails when an entry points to a route with no `page.tsx`.

## Verification

- `bun run test` runs the contrast, formatting and navigation tests.
- `bun run test:e2e` runs the Playwright smoke test against the production build: every page renders with no
  console errors, static pages are still prerendered, there is no horizontal overflow at 375 px, the theme
  toggle persists, fonts are served from
  the app's origin, and tabs and the dialog respond to the keyboard. Run `bun run build` first.
