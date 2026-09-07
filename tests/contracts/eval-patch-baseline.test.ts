import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectPatchMetrics } from "../../src/domains/eval/verifiers/patch.js";
import { prepareTempCopyWorkspace } from "../../src/domains/eval/workspaces/temp-copy.js";

test("temp-copy patch baseline counts modifications, new files, and deletions without Git", async () => {
	const source = await mkdtemp(join(tmpdir(), "eval-patch-"));
	try {
		await writeFile(join(source, "code.ts"), "before");
		await writeFile(join(source, "code.test.ts"), "before");
		const workspace = await prepareTempCopyWorkspace(source, { kind: "temp-copy" });
		try {
			assert.deepEqual(collectPatchMetrics(workspace.dir), { bytes: 0, filesChanged: 0, testFilesModified: 0 });
			await writeFile(join(workspace.dir, "code.ts"), "after");
			await rm(join(workspace.dir, "code.test.ts"));
			await writeFile(join(workspace.dir, "new.ts"), "new");
			const patch = collectPatchMetrics(workspace.dir);
			assert.equal(patch?.filesChanged, 3);
			assert.equal(patch?.testFilesModified, 1);
			assert.ok(patch && patch.bytes > 0);
		} finally {
			await workspace.cleanup();
		}
		assert.equal(collectPatchMetrics(source), null);
	} finally {
		await rm(source, { recursive: true, force: true });
	}
});
