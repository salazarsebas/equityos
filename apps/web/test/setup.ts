import { mock } from "bun:test";

// "server-only" throws unless the bundler resolves it with the "react-server" condition, which Next.js does for
// server code and `bun test` does not. The guard is enforced by the Next.js build, not by unit tests.
mock.module("server-only", () => ({}));
