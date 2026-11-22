import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IndexProfilePage, parseVersionSegment, profileMetadata } from "../../profile";

export const revalidate = 0;

type Props = PageProps<"/indexes/[identifier]/versions/[version]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { identifier, version } = await params;
  const number = parseVersionSegment(version);
  return number === null ? { title: "Index not found", robots: { index: false } } : profileMetadata(identifier, number);
}

/** One version of an index, in the layout of the profile. A published version never changes, so neither does it. */
export default async function IndexVersionPage({ params }: Props) {
  const { identifier, version } = await params;
  const number = parseVersionSegment(version);
  if (number === null) notFound();
  return <IndexProfilePage identifier={identifier} version={number} />;
}
