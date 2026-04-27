/**
 * Integration coverage for the interop-aware context-file loader. Drives a
 * real cwd tree with all five candidate filenames at multiple depths and
 * verifies the merged output respects the conflict policy.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadProjectContextFiles, renderProjectContextFiles } from "../../src/domains/prompts/context-files.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-context-int-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("prompts/context-files integration", () => {
	it("merges all five candidate files at one depth, with CLIO.md winning on conflicts", () => {
		writeFileSync(join(scratch, "CLIO.md"), "## Setup\n\nclio setup\n\n## Build\n\nclio build\n");
		writeFileSync(join(scratch, "CLAUDE.md"), "## Setup\n\nclaude setup\n\n## Notes\n\nclaude notes\n");
		writeFileSync(join(scratch, "AGENTS.md"), "## Setup\n\nagents setup\n\n## Lint\n\nagents lint\n");
		writeFileSync(join(scratch, "CODEX.md"), "## Setup\n\ncodex setup\n\n## Test\n\ncodex test\n");
		writeFileSync(join(scratch, "GEMINI.md"), "## Setup\n\ngemini setup\n");

		const files = loadProjectContextFiles({ cwd: scratch });
		strictEqual(files.length, 5);

		const rendered = renderProjectContextFiles(files, scratch);
		// CLIO.md wins on Setup; other Setups dropped.
		ok(rendered.includes("clio setup"), rendered);
		ok(!rendered.includes("claude setup"), rendered);
		ok(!rendered.includes("agents setup"), rendered);
		ok(!rendered.includes("codex setup"), rendered);
		ok(!rendered.includes("gemini setup"), rendered);
		// Non-CLIO sections survive.
		ok(rendered.includes("clio build"), rendered);
		ok(rendered.includes("claude notes"), rendered);
		ok(rendered.includes("agents lint"), rendered);
		ok(rendered.includes("codex test"), rendered);
		// Provenance footer mentions every contributor.
		ok(rendered.includes("CLIO.md"), rendered);
		ok(rendered.includes("CLAUDE.md"), rendered);
		ok(rendered.includes("AGENTS.md"), rendered);
		ok(rendered.includes("CODEX.md"), rendered);
		// GEMINI.md only had a Setup block (which CLIO won), so it should not
		// show up as a contributor.
		ok(!rendered.includes("GEMINI.md"), rendered);
	});

	it("walks parent-to-child and lets the child override the parent for non-CLIO files", () => {
		const child = join(scratch, "pkg", "app");
		mkdirSync(child, { recursive: true });
		writeFileSync(join(scratch, "CLAUDE.md"), "## Notes\n\nparent notes\n");
		writeFileSync(join(child, "CLAUDE.md"), "## Notes\n\nchild notes\n");

		const files = loadProjectContextFiles({ cwd: child });
		strictEqual(files.length, 2);
		const rendered = renderProjectContextFiles(files, child);
		ok(rendered.includes("child notes"), rendered);
		ok(!rendered.includes("parent notes"), rendered);
	});

	it("returns an empty string when nothing matches", () => {
		const files = loadProjectContextFiles({ cwd: scratch });
		strictEqual(files.length, 0);
		strictEqual(renderProjectContextFiles(files, scratch), "");
	});

	it("includes unstructured (preamble-only) bodies under per-source headers", () => {
		writeFileSync(join(scratch, "AGENTS.md"), "no h2 headers, just notes\n");
		const files = loadProjectContextFiles({ cwd: scratch });
		const rendered = renderProjectContextFiles(files, scratch);
		ok(rendered.includes("Notes from AGENTS.md"), rendered);
		ok(rendered.includes("no h2 headers, just notes"), rendered);
	});
});
