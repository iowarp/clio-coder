#!/usr/bin/env node
/**
 * The checkout's CLI run from source. Tests that compare the server with "the canonical CLI" point both
 * sides here, so they exercise the code under test rather than whatever `dist/` or `clio-coder` on PATH
 * happens to hold, and they need no build.
 */
import { register } from "tsx/esm/api";

register();
await import("../../../../src/cli/index.ts");
