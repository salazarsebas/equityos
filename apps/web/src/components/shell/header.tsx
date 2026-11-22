import NextLink from "next/link";
import { AccountSlot } from "@/components/wallet/account-slot";
import { site } from "@/lib/site";
import { Container } from "./container";
import { PrimaryNav } from "./primary-nav";
import { ThemeToggle } from "./theme-toggle";

/**
 * Top bar: 56 px, one row. Wordmark, primary navigation, theme toggle, account control. Under 640 px the
 * navigation moves to a second row of 40 px, because the four groups do not fit in one.
 */
export function Header() {
  return (
    <header className="border-b bg-surface">
      <Container className="flex min-h-14 flex-wrap items-center gap-x-6 sm:flex-nowrap md:gap-x-8">
        <NextLink href="/" className="rounded-sm text-md font-semibold text-primary">
          {site.name}
        </NextLink>
        <div className="order-last h-10 w-full sm:order-none sm:h-14 sm:w-auto">
          <PrimaryNav />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <AccountSlot />
        </div>
      </Container>
    </header>
  );
}
