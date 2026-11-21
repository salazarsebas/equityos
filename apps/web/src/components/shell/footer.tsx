import { Link } from "@/components/ui/link";
import { site } from "@/lib/site";
import { Container } from "./container";

export function Footer() {
  return (
    <footer className="mt-16 border-t">
      <Container className="flex flex-col gap-3 py-8 text-sm text-secondary md:flex-row md:items-baseline md:justify-between md:gap-8">
        <p className="max-w-measure">
          {site.name} publishes index methodologies and calculation tools. It does not custody assets, pool funds or
          give investment advice.
        </p>
        <p className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span>Open source under the MIT license</span>
          <Link href={site.repositoryUrl} variant="quiet" className="text-primary">
            Source code on GitHub
          </Link>
        </p>
      </Container>
    </footer>
  );
}
