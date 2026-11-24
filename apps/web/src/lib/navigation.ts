export type NavItem = {
  label: string;
  /** Path of a route that exists under `src/app`. test/navigation.test.ts fails on a link to a missing page. */
  href: `/${string}`;
};

/** Primary navigation, in display order. Add an entry in the same change that adds its page. */
export const primaryNavigation: readonly NavItem[] = [
  { label: "Overview", href: "/" },
  { label: "Indexes", href: "/indexes" },
  { label: "Assets", href: "/assets" },
  { label: "Studio", href: "/studio" },
  { label: "Portfolio", href: "/portfolio" },
  { label: "Wallet", href: "/wallet" },
];
