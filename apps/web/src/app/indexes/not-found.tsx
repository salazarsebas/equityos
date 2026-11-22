import { Container } from "@/components/shell/container";
import { Link } from "@/components/ui/link";
import { EmptyState } from "@/components/ui/state";

export default function IndexNotFound() {
  return (
    <Container className="py-8 md:py-12">
      <h1 className="text-xl font-medium">Index not found</h1>
      <div className="mt-6">
        <EmptyState title="No index or version has this address" action={<Link href="/indexes">See all indexes</Link>}>
          The registry holds no index with this identifier, or the index has no version with this number. An identifier
          is the slug of the index followed by the first digits of its index id, and it changes when the creator
          publishes a version with another slug. The full index id always works.
        </EmptyState>
      </div>
    </Container>
  );
}
