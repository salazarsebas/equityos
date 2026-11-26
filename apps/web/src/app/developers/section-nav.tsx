"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/cx";

const PAGES = [
  { label: "Overview", href: "/developers" },
  { label: "API reference", href: "/developers/api" },
  { label: "Methodology spec", href: "/developers/spec" },
] as const;

/** The pages of the developer section. The current one is marked with `aria-current` and a rule under it. */
export function SectionNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Developer documentation" className="-mb-px flex gap-4 overflow-x-auto whitespace-nowrap">
      {PAGES.map(({ label, href }) => {
        const current = pathname === href;
        return (
          <NextLink
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cx(
              "inline-flex h-10 shrink-0 items-center border-b-2 pointer-coarse:h-11 text-base font-medium -outline-offset-2 transition-colors duration-[120ms]",
              current ? "border-b-accent text-primary" : "border-b-transparent text-secondary hover:text-primary",
            )}
          >
            {label}
          </NextLink>
        );
      })}
    </nav>
  );
}
