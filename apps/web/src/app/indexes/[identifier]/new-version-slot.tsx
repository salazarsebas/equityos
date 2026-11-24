"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

const NewVersionAction = dynamic(() => import("./new-version-action").then((module) => module.NewVersionAction), {
  ssr: false,
  loading: () => null,
});

/**
 * "Publish a new version", for the creator of the index only. Whether the visitor is the creator is known only
 * in the browser, from the connected wallet, so the action is loaded there and the page stays static.
 */
export function NewVersionSlot(props: ComponentProps<typeof NewVersionAction>) {
  return <NewVersionAction {...props} />;
}
