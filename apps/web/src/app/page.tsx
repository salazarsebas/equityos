import { Container, Grid } from "@/components/shell/container";
import { Link } from "@/components/ui/link";
import { site } from "@/lib/site";

export default function HomePage() {
  return (
    <Container className="py-12 md:py-16">
      <Grid>
        <div className="col-span-12 lg:col-span-8">
          <h1 className="text-2xl font-medium md:text-3xl">{site.name}</h1>
          <p className="mt-4 max-w-measure text-lg text-primary">{site.tagline}</p>
          <p className="mt-4 max-w-measure text-md text-secondary">
            {site.description} An index is a published rule set, not a pool of funds.
          </p>

          <section aria-labelledby="status-heading" className="mt-12 border-t pt-6">
            <h2 id="status-heading" className="text-lg font-medium">
              Status: early development
            </h2>
            <p className="mt-3 max-w-measure text-md text-secondary">
              Two things can be read today, on pages and through a public read API. The asset universe: the tokenized
              stocks listed on Base, with their onchain state, reference prices and index eligibility. And published
              indexes: each one can be browsed and its methodology verified against what the registry stores onchain. On
              a network where the index registry is not deployed, the explorer says so instead of showing an empty list.
              No index can be created, published or replicated from this site yet.
            </p>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-md">
              <li>
                <Link href="/indexes">Indexes</Link>
              </li>
              <li>
                <Link href="/assets">Assets</Link>
              </li>
              <li>
                <Link href="/api/v1/openapi.json">API description (OpenAPI)</Link>
              </li>
              <li>
                <Link href="/dev/components">Component reference</Link>
              </li>
            </ul>
          </section>
        </div>
      </Grid>
    </Container>
  );
}
