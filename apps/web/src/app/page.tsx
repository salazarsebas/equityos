import { site } from "@/lib/site";

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-6 py-12 sm:px-8 sm:py-20">
      <main className="flex-1">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{site.name}</h1>
        <p className="mt-4 text-lg text-neutral-700 dark:text-neutral-300">{site.tagline}</p>
        <p className="mt-6 leading-7 text-neutral-700 dark:text-neutral-300">
          {site.description} An index is a published rule set, not a pool of funds.
        </p>

        <section
          aria-labelledby="status-heading"
          className="mt-10 border-l-2 border-neutral-300 pl-4 dark:border-neutral-700"
        >
          <h2 id="status-heading" className="text-sm font-semibold uppercase tracking-wide">
            Status: early development
          </h2>
          <p className="mt-2 leading-7 text-neutral-700 dark:text-neutral-300">
            Nothing is deployed yet. This repository currently contains the project scaffold only.
          </p>
        </section>
      </main>

      <footer className="mt-12 border-t border-neutral-200 pt-6 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        <p>
          Open source under the MIT license.{" "}
          <a
            href={site.repositoryUrl}
            className="font-medium text-neutral-900 underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:text-neutral-100"
          >
            Source code on GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
