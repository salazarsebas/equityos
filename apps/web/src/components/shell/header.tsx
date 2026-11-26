import NextLink from "next/link";
import { AccountSlot } from "@/components/wallet/account-slot";
import { site } from "@/lib/site";
import { Container } from "./container";
import { PrimaryNav } from "./primary-nav";
import { ThemeToggle } from "./theme-toggle";

/**
 * Top bar: 56 px, one row. Wordmark, primary navigation, theme toggle, account control. Under 1024 px the
 * navigation moves to a second row of 40 px, because the four groups do not fit in one, and that row scrolls
 * sideways on its own when the links are wider than the screen, so the page itself never does.
 */
export function Header() {
  return (
    <header className="border-b bg-surface">
      <Container className="flex min-h-14 flex-wrap items-center gap-x-3 sm:gap-x-6 lg:flex-nowrap lg:gap-x-8">
        <NextLink
          href="/"
          className="inline-flex items-center rounded-sm text-md font-semibold text-primary pointer-coarse:min-h-11"
        >
          {site.name}
        </NextLink>
        <div className="order-last h-10 w-full overflow-x-auto pointer-coarse:h-11 lg:order-none lg:h-14 lg:w-auto lg:overflow-visible">
          <PrimaryNav />
        </div>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <AccountSlot />
        </div>
      </Container>
    </header>
  );
}
