import type { Metadata } from "next";
import { IndexProfilePage, profileMetadata } from "./profile";

/** Rendered on every request: a new version or a deprecation shows within the ten second cache of the reader. */
export const revalidate = 0;

export async function generateMetadata({ params }: PageProps<"/indexes/[identifier]">): Promise<Metadata> {
  return profileMetadata((await params).identifier, null);
}

/** The latest version of an index, at its canonical URL. */
export default async function IndexPage({ params }: PageProps<"/indexes/[identifier]">) {
  return <IndexProfilePage identifier={(await params).identifier} version={null} />;
}
