import { type Browser, expect, type Page, test } from "@playwright/test";
import { EMPTY_REGISTRY_ORIGIN, NOT_DEPLOYED_ORIGIN } from "./servers";

/**
 * Responsive layout check: on every public route, at phone, tablet and desktop widths and in both themes, the
 * page does not scroll sideways and no element reaches past the viewport, except inside a region that scrolls on
 * its own (a table or a code block). On phone widths the primary controls are at least 44 px by 44 px.
 */
const DIVERSIFIED = "diversified-equity-d622e2a5";
const MISMATCHED_ID = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
const HOLDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const routes: readonly string[] = [
  "/",
  "/indexes",
  "/indexes?sort=oldest",
  `/indexes/${DIVERSIFIED}`,
  `/indexes/${DIVERSIFIED}/versions/1`,
  `/indexes/${MISMATCHED_ID}`,
  "/indexes/single-asset-fdc98c0f",
  "/assets",
  "/assets?view=all",
  "/studio",
  `/studio?index=${DIVERSIFIED}`,
  "/portfolio",
  `/portfolio?address=${HOLDER}&index=${DIVERSIFIED}`,
  `/portfolio?address=${HOLDER}&index=${DIVERSIFIED}&plan=buy_only&deposit=50`,
  "/wallet",
  "/network",
  "/developers",
  "/developers/api",
  "/developers/spec",
  "/this-page-does-not-exist",
  `${NOT_DEPLOYED_ORIGIN}/indexes`,
  `${NOT_DEPLOYED_ORIGIN}/portfolio`,
  `${EMPTY_REGISTRY_ORIGIN}/indexes`,
];

const widths = [320, 375, 768, 1280] as const;
const touchWidths = [320, 375] as const;
const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];

/** Opens the route at a width in a theme. Phone widths are touch devices, so that coarse-pointer sizes apply. */
async function openPage(browser: Browser, route: string, width: number, theme: Theme): Promise<Page> {
  const touch = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    colorScheme: theme,
    hasTouch: touch,
    isMobile: touch,
  });
  await context.addInitScript((stored) => {
    try {
      localStorage.setItem("equityos-theme", stored);
    } catch {
      // Storage can be unavailable; the color scheme set above gives the same theme.
    }
  }, theme);
  const page = await context.newPage();
  await page.goto(route, { waitUntil: "networkidle" });
  return page;
}

for (const route of routes) {
  for (const width of widths) {
    for (const theme of themes) {
      test(`${route} fits a ${width} px viewport in the ${theme} theme`, async ({ browser }) => {
        const page = await openPage(browser, route, width, theme);
        const findings = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth;
          const out: string[] = [];
          if (document.documentElement.scrollWidth > viewport) {
            out.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${viewport} px`);
          }
          const scrolls = (element: Element): boolean => {
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const { overflowX } = getComputedStyle(parent);
              if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
            }
            return false;
          };
          for (const element of document.querySelectorAll("body *")) {
            const box = element.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            if (box.right <= viewport + 1 && box.left >= -1) continue;
            if (scrolls(element)) continue;
            out.push(
              `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 30)}" spans ${Math.round(box.left)} to ${Math.round(box.right)} px`,
            );
          }
          return out.slice(0, 10);
        });
        expect(findings, `${route} at ${width} px`).toEqual([]);
        await page.context().close();
      });
    }
  }
}

const CONTROLS = [
  "button",
  "select",
  "textarea",
  "summary",
  "[role=tab]",
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio])",
  "label:has(input[type=checkbox])",
  "label:has(input[type=radio])",
  "body > header a",
  "main nav a",
].join(", ");

for (const route of routes) {
  for (const width of touchWidths) {
    test(`${route} keeps its controls at least 44 px on a ${width} px phone`, async ({ browser }) => {
      const page = await openPage(browser, route, width, "light");
      const small = await page.evaluate((selector) => {
        const out: string[] = [];
        for (const element of document.querySelectorAll(selector)) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (box.width < 44 || box.height < 44) {
            out.push(
              `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 30)}" is ${Math.round(box.width)} by ${Math.round(box.height)} px`,
            );
          }
        }
        return out.slice(0, 10);
      }, CONTROLS);
      expect(small, `${route} at ${width} px`).toEqual([]);
      await page.context().close();
    });
  }
}
