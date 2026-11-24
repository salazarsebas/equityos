"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { PortfolioSkeleton } from "./skeleton";

const PortfolioView = dynamic(() => import("./portfolio-view").then((module) => module.PortfolioView), {
  ssr: false,
  loading: PortfolioSkeleton,
});

/** The comparison region. It uses the wallet libraries for the connected address, so it loads in the browser. */
export function PortfolioSlot(props: ComponentProps<typeof PortfolioView>) {
  return <PortfolioView {...props} />;
}
