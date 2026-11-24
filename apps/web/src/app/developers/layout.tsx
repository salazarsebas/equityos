import type { ReactNode } from "react";
import { Container } from "@/components/shell/container";
import { SectionNav } from "./section-nav";

/** The developer section: its own navigation under the top bar, then the page. */
export default function DevelopersLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="border-b bg-surface">
        <Container>
          <SectionNav />
        </Container>
      </div>
      {children}
    </>
  );
}
