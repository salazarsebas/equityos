"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/cx";
import { primaryNavigation } from "@/lib/navigation";

/** Primary navigation. The current section is marked with `aria-current` and a rule under its label. */
export function PrimaryNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex h-full items-stretch gap-2 whitespace-nowrap lg:-mx-2">
      {primaryNavigation.map(({ label, href }) => {
        const current = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <NextLink
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cx(
              "inline-flex shrink-0 items-center border-y-2 px-2 border-t-transparent text-base font-medium -outline-offset-2 transition-colors duration-[120ms]",
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
