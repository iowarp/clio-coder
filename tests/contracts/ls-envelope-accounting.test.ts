import { ok } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { lsTool } from "../../src/tools/ls.js";
import type { ToolResult } from "../../src/tools/registry.js";

const scratchRoots: string[] = [];

// A directory whose entry names are short enough that the default 500-entry
// slice fits under ls's 8KB byte cap, so truncation is driven by the entry
// limit (not the byte cap) and no separate full rendering is offloaded.
function scratchTree(fileCount: number): string {
	const root = mkdtempSync(join(tmpdir(), "clio-ls-envelope-"));
	scratchRoots.push(root);
	for (let i = 0; i < fileCount; i += 1) {
		writeFileSync(join(root, `f-${String(i).padStart(4, "0")}.txt`), "", "utf8");
	}
	return root;
}

function observationOf(result: ToolResult): Record<string, unknown> {
	ok(result.kind === "ok", "ls returns an ok result");
	const observation = result.details?.observation as Record<string, unknown> | undefined;
	ok(observation, "ls attaches an observation envelope");
	return observation;
}

describe("contracts/ls envelope byte accounting", () => {
	afterEach(() => {
		while (scratchRoots.length > 0) {
			const dir = scratchRoots.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	// BUG-012: an entry-limited ls appends a notice line to the returned body, so
	// shownBytes (measured after the notice) crept past totalBytes (measured on
	// the pre-notice rendering). The envelope invariant is totalBytes >= shownBytes
	// always.
	it("keeps totalBytes >= shownBytes for an entry-limited listing", async () => {
		const root = scratchTree(700);
		const result = await lsTool.run({ path: root }, { sessionId: "ls-envelope", turnId: "t1", toolCallId: "ls.tree" });
		const observation = observationOf(result);
		const shownBytes = observation.shownBytes as number;
		const totalBytes = observation.totalBytes as number;

		ok(observation.truncated === true, "the 700-entry listing is truncated at the 500-entry limit");
		ok(totalBytes >= shownBytes, `totalBytes (${totalBytes}) must be >= shownBytes (${shownBytes})`);
	});
});
