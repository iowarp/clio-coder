import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { sortViewArtifacts, type ViewArtifact } from "../../src/interactive/view/artifacts.js";
import {
	buildArtifactHeader,
	filterViewArtifacts,
	groupedViewRows,
	initialViewSelection,
	nextContentScrollOffset,
	viewFooterHint,
} from "../../src/interactive/view/view-overlay.js";

function artifact(
	input: Partial<ViewArtifact> & Pick<ViewArtifact, "id" | "category" | "title" | "timestamp">,
): ViewArtifact {
	return {
		sizeBytes: 10,
		load: async () => ({ lines: [input.title], format: "text" }),
		...input,
	};
}

describe("contracts/view-overlay", () => {
	it("sorts newest first and groups by category order", () => {
		const artifacts = sortViewArtifacts([
			artifact({ id: "old", category: "receipt", title: "old receipt", timestamp: 1 }),
			artifact({ id: "new", category: "receipt", title: "new receipt", timestamp: 5 }),
			artifact({ id: "dispatch", category: "dispatch", title: "dispatch", timestamp: 4 }),
			artifact({ id: "compact", category: "compaction", title: "compact", timestamp: 3 }),
		]);

		deepStrictEqual(
			artifacts.map((item) => item.id),
			["new", "dispatch", "compact", "old"],
		);

		const rows = groupedViewRows(artifacts);
		deepStrictEqual(
			rows.filter((row) => row.type === "group").map((row) => row.category),
			["receipt", "dispatch", "tool-output", "compaction"],
		);
		deepStrictEqual(
			rows.filter((row) => row.type === "item" && row.category === "receipt").map((row) => row.item?.id),
			["new", "old"],
		);
		ok(rows.some((row) => row.type === "empty" && row.category === "tool-output"));
	});

	it("filters and auto-selects exact run id matches", () => {
		const artifacts = [
			artifact({ id: "run-111", category: "receipt", title: "coder fix lint", timestamp: 2 }),
			artifact({ id: "run-222", category: "dispatch", title: "scout inspect tests", timestamp: 1 }),
		];

		deepStrictEqual(
			filterViewArtifacts(artifacts, "scout").map((item) => item.id),
			["run-222"],
		);
		strictEqual(initialViewSelection(artifacts, "run-222"), 0);
		strictEqual(initialViewSelection(artifacts, "dispatch:run-222"), 0);
		strictEqual(initialViewSelection(artifacts, "missing"), 0);
	});

	it("clamps scroll windows for top, bottom, pages, and half pages", () => {
		strictEqual(nextContentScrollOffset(20, 100, 10, "top"), 0);
		strictEqual(nextContentScrollOffset(0, 100, 10, "bottom"), 90);
		strictEqual(nextContentScrollOffset(20, 100, 10, "page-up"), 11);
		strictEqual(nextContentScrollOffset(20, 100, 10, "page-down"), 29);
		strictEqual(nextContentScrollOffset(20, 100, 10, "half-up"), 15);
		strictEqual(nextContentScrollOffset(20, 100, 10, "half-down"), 25);
		strictEqual(nextContentScrollOffset(0, 3, 10, "line-down"), 0);
	});

	it("paints verification state into artifact headers", () => {
		const item = artifact({ id: "run-ok", category: "receipt", title: "receipt", timestamp: 1 });

		const okHeader = buildArtifactHeader(item, { status: "ok", detail: "integrity verified" }, 120);
		ok(okHeader.includes("verify ok integrity verified"));

		const failHeader = buildArtifactHeader(item, { status: "fail", detail: "integrity mismatch" }, 120);
		ok(failHeader.includes("verify fail integrity mismatch"));
	});

	it("switches footer hints by pane focus", () => {
		const listHint = viewFooterHint("list", true);
		ok(listHint.includes("[type] filter"));
		ok(listHint.includes("[Tab] content"));
		ok(listHint.includes("[v] verify"));

		const contentHint = viewFooterHint("content", false);
		ok(contentHint.includes("[PgUp/PgDn] page"));
		ok(contentHint.includes("[g/G] top/bottom"));
		ok(contentHint.includes("[Tab] list"));
		ok(!contentHint.includes("[v] verify"));
	});
});
