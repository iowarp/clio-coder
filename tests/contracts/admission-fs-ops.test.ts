import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { countFsCalls, installFsCounters } from "../harness/fs-counter.js";

// Operator config and state decide how far the skill-root walks go, so the
// count is pinned against a home this file owns. It is set, and the counters
// installed, before any tool module loads, because both are read on first use.
const home = mkdtempSync(join(tmpdir(), "clio-coder-admission-fs-ops-"));
process.env.CLIO_CODER_HOME = home;
process.env.CLIO_CODER_STATE_DIR = join(home, "state");
await installFsCounters();
const { ToolNames } = await import("../../src/core/tool-names.js");
const { createWorkerSafety, createWorkerToolRegistry } = await import("../../src/engine/worker-tools.js");
const { invokeRegisteredTool } = await import("../../src/tools/agent-tools.js");

/**
 * Counted fs calls for one admitted call, admission through publish, on a
 * worker registry at auto-edit. Every target and root is still resolved at
 * admission, but each component once: a walk repeated inside the same call
 * raises these and fails here. Each call runs on a fresh scratch root after
 * one warmup call, so caches a first call fills are not counted.
 */
const ANCHOR = "<<E0:admission>>";
const LINE = "the quick brown fox jumps over the lazy dog, ";
const KB_TEXT = `${`${LINE}\n`.repeat(Math.ceil(1024 / (LINE.length + 1)))}`;

const CASES = [
	{
		id: "edit of a 1 KB file near its head",
		tool: ToolNames.Edit,
		expected: 40,
		seed: (root: string) => writeFileSync(join(root, "data", "target.txt"), `${ANCHOR}${KB_TEXT}`),
		args: { path: "data/target.txt", edits: [{ oldText: ANCHOR, newText: "<<R0:admission>>" }] },
		check: (root: string) => readFileSync(join(root, "data", "target.txt"), "utf8").startsWith("<<R0:admission>>"),
	},
	{
		id: "write creating a 1 KB file in an existing directory",
		tool: ToolNames.Write,
		expected: 48,
		seed: () => {},
		args: { path: "data/new.txt", content: KB_TEXT },
		check: (root: string) => readFileSync(join(root, "data", "new.txt"), "utf8") === KB_TEXT,
	},
] as const;

async function admittedCall(entry: (typeof CASES)[number]) {
	// The scratch root sits one level inside its own temp directory, the layout
	// the numbers were pinned on.
	const base = mkdtempSync(join(tmpdir(), "clio-coder-admission-fs-ops-call-"));
	const root = join(realpathSync(base), "root");
	const previousCwd = process.cwd();
	const previousUmask = process.umask(0o022);
	try {
		mkdirSync(join(root, "data"), { recursive: true, mode: 0o755 });
		entry.seed(root);
		process.chdir(root);
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: root }),
			{ noSkills: true },
			[],
			"default",
		);
		// Let setup I/O drain so it cannot land inside the counted window.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		const counted = await countFsCalls(() => invokeRegisteredTool(registry, entry.tool, structuredClone(entry.args)));
		strictEqual(entry.check(root), true, `${entry.id}: the call did not produce its post-state`);
		return counted;
	} finally {
		process.chdir(previousCwd);
		process.umask(previousUmask);
		rmSync(base, { recursive: true, force: true });
	}
}

describe("admission fs calls", () => {
	after(() => rmSync(home, { recursive: true, force: true }));

	for (const entry of CASES) {
		it(`${entry.id} resolves each path component once per call`, async () => {
			await admittedCall(entry);
			const measured = await admittedCall(entry);
			strictEqual(measured.total, entry.expected, `${entry.id}: ${JSON.stringify(measured.byName)}`);
		});
	}
});
