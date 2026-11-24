import type { Metadata } from "next";
import { Container } from "@/components/shell/container";
import { Link } from "@/components/ui/link";
import { EmptyState } from "@/components/ui/state";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

/** Any path the site does not serve. Index paths have their own page, which explains index identifiers. */
export default function NotFound() {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Page not found</h1>
      <div className="mt-6">
        <EmptyState title="Nothing is served at this address" action={<Link href="/">Go to the overview</Link>}>
          The link may be mistyped, or the page may have moved. Published indexes are listed on the{" "}
          <Link href="/indexes">indexes page</Link>, and every response of the API is described in the{" "}
          <Link href="/developers/api">API reference</Link>.
        </EmptyState>
      </div>
    </Container>
  );
}
