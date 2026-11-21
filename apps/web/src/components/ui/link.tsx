import NextLink from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { ExternalLinkIcon } from "./icons";

type LinkProps = {
  href: string;
  children: ReactNode;
  /** "inline" is an accent, underlined text link. "quiet" takes the surrounding color and underlines on hover. */
  variant?: "inline" | "quiet";
  className?: string;
  "aria-current"?: "page" | undefined;
};

const variants = {
  inline: "text-accent underline decoration-1 underline-offset-[3px] hover:decoration-2",
  quiet: "underline-offset-[3px] hover:underline",
};

/** Text link. Absolute URLs open in the same tab as a plain anchor and are marked with the external link icon. */
export function Link({ href, children, variant = "inline", className, ...rest }: LinkProps) {
  const classes = cx("rounded-sm", variants[variant], className);
  if (/^https?:\/\//.test(href)) {
    return (
      <a {...rest} href={href} rel="noreferrer" className={cx(classes, "inline-flex items-center gap-1")}>
        {children}
        <ExternalLinkIcon className="shrink-0" />
      </a>
    );
  }
  return (
    <NextLink {...rest} href={href} className={classes}>
      {children}
    </NextLink>
  );
}
