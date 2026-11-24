import type { Metadata } from "next";
import { Container } from "@/components/shell/container";
import { StudioSlot } from "./studio-slot";

export const metadata: Metadata = {
  title: "Studio",
  description:
    "Build an index of tokenized stocks as a methodology spec: choose constituents and weights, see the composition, the canonical JSON and its hash, and publish it to the index registry.",
  alternates: { canonical: "/studio" },
};

export default function StudioPage() {
  return (
    <Container className="pt-8 md:pt-12">
      <h1 className="text-xl font-medium">Index Studio</h1>
      <p className="mt-2 mb-8 max-w-measure text-md text-secondary">
        Define an index as a rule set and see exactly what it produces: the composition, the canonical spec and its
        hash. The draft stays in this browser. A wallet is needed only to publish.
      </p>
      <StudioSlot />
    </Container>
  );
}
