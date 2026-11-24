"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

/** Shape of the Studio while its code loads: the editor column and the preview column. */
function StudioLoading() {
  return (
    <div aria-busy="true" className="grid gap-x-12 gap-y-8 lg:grid-cols-12">
      <span className="sr-only">Loading the Studio</span>
      <div className="flex flex-col gap-4 lg:col-span-7">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
      <div className="flex flex-col gap-4 lg:col-span-5">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

const Studio = dynamic(() => import("@/components/studio/studio").then((module) => module.Studio), {
  ssr: false,
  loading: StudioLoading,
});

/**
 * The Studio region of the page. The draft lives in browser storage and publishing uses the wallet libraries,
 * so the region is loaded in the browser only and the page around it stays static.
 */
export function StudioSlot() {
  return <Studio />;
}
