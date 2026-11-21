import NextLink from "next/link";
import { site } from "@/lib/site";
import { Container } from "./container";
import { PrimaryNav } from "./primary-nav";
import { ThemeToggle } from "./theme-toggle";

/** Top bar: 56 px, one row. Wordmark, primary navigation, theme toggle. */
export function Header() {
  return (
    <header className="border-b bg-surface">
      <Container className="flex h-14 items-center gap-6 md:gap-8">
        <NextLink href="/" className="rounded-sm text-md font-semibold text-primary">
          {site.name}
        </NextLink>
        <PrimaryNav />
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </Container>
    </header>
  );
}
