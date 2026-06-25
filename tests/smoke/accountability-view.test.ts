import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { EvidenceIndexRow } from "../../src/domains/observability/evidence-index.js";
import { AccountabilityArtifactProvider } from "../../src/interactive/view/artifacts.js";

/**
 * Seed a sidecar evidence index on disk (mirroring the EvidenceIndexRow shape
 * Slice 2 writes), build the AccountabilityArtifactProvider, and assert that the
 * single synthetic artifact renders the first-pass rate and the top
 * failure-cause tag. No CLI call, no buildEvidence: this is pure presentation.
 */

function seedIndex(stateDir: string, rows: EvidenceIndexRow[]): void {
	writeFileSync(join(stateDir, "evidence-index.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

function row(partial: Partial<EvidenceIndexRow> & Pick<EvidenceIndexRow, "runId">): EvidenceIndexRow {
	return {
		evidenceId: `run-${partial.runId}`,
		tags: [],
		firstPassSuccess: false,
		findingCount: 0,
		generatedAt: "2026-06-25T00:00:00.000Z",
		...partial,
	};
}

describe("accountability /view surface", { concurrency: false }, () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "clio-accountability-"));
	});

	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("renders the first-pass rate and top failure causes from the seeded index", async () => {
		seedIndex(stateDir, [
			row({ runId: "1", firstPassSuccess: true, tags: ["audit-linked"] }),
			row({ runId: "2", firstPassSuccess: false, tags: ["test-failure", "no-validation"] }),
			row({ runId: "3", firstPassSuccess: false, tags: ["test-failure"] }),
			row({ runId: "4", firstPassSuccess: true, tags: ["build-failure"] }),
		]);

		const provider = new AccountabilityArtifactProvider({ stateDir });
		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		strictEqual(artifacts[0]?.category, "accountability");
		strictEqual(artifacts[0]?.id, "session");

		const loaded = await artifacts[0]?.load();
		strictEqual(loaded?.format, "markdown");
		const text = loaded?.lines.join("\n") ?? "";
		// 2 of 4 first-pass: 50%.
		ok(text.includes("first-pass success: 2/4 (50%)"), text);
		// test-failure is the most common cause (count 2).
		ok(text.includes("test-failure: 2"), text);
		ok(!text.includes("audit-linked:"), text);
		ok(!text.includes("no-validation:"), text);
		ok(text.includes("Top failure causes"), text);
	});

	it("renders the empty summary when no index exists", async () => {
		const provider = new AccountabilityArtifactProvider({ stateDir });
		const artifacts = await provider.list();
		strictEqual(artifacts.length, 1);
		const loaded = await artifacts[0]?.load();
		const text = loaded?.lines.join("\n") ?? "";
		ok(text.includes("first-pass success: 0/0 (0%)"), text);
		ok(text.includes("none"), text);
	});
});
