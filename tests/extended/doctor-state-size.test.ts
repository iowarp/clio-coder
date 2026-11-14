import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stateStorageFinding } from "../../src/cli/doctor-state-size.js";

describe("doctor state storage", () => {
	it("reads a fresh home without a state root as empty, not broken", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-test-state-size-"));
		try {
			const finding = stateStorageFinding(join(root, "state"));
			strictEqual(finding.ok, true);
			strictEqual(finding.level, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
