import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";
import { sortViewArtifacts, type ViewArtifact } from "../../src/interactive/view/artifacts.js";
import {
	artifactsInCategoryOrder,
	buildArtifactHeader,
	filterViewArtifacts,
	groupedViewRows,
	initialViewSelection,
	nextCategorySelection,
	nextContentScrollOffset,
	openViewOverlay,
	parseViewFilterQuery,
	VIEW_OVERLAY_MARGIN,
	ViewOverlayView,
	viewFooterHint,
} from "../../src/interactive/view/view-overlay.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function artifact(
	input: Partial<ViewArtifact> & Pick<ViewArtifact, "id" | "category" | "title" | "timestamp">,
): ViewArtifact {
	return {
		sizeBytes: 10,
		load: async () => ({ lines: [input.title], format: "text" }),
		...input,
	};
}

function overlayHandle(): OverlayHandle {
	return {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
}

function fakeTui(
	rows = 42,
	columns = 132,
): {
	tui: TUI;
	component: () => Component;
	options: () => OverlayOptions | undefined;
} {
	let mounted: Component | null = null;
	let overlayOptions: OverlayOptions | undefined;
	const tui = {
		terminal: { rows, columns },
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
			mounted = component;
			overlayOptions = options;
			return overlayHandle();
		},
		requestRender() {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay was not mounted");
			return mounted;
		},
		options: () => overlayOptions,
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
			[
				"accountability",
				"evidence",
				"receipt",
				"dispatch",
				"task-ledger",
				"tool-output",
				"protected-artifact",
				"compaction",
				"prompt-manifest",
				"audit",
			],
		);
		deepStrictEqual(
			rows.filter((row) => row.type === "item" && row.category === "receipt").map((row) => row.item?.id),
			["new", "old"],
		);
		ok(rows.some((row) => row.type === "empty" && row.category === "tool-output"));
	});

	it("uses the rendered category order for selection without losing the newest initial artifact", () => {
		const artifacts = [
			artifact({ id: "prompt-newest", category: "prompt-manifest", title: "prompt", timestamp: 3 }),
			artifact({ id: "receipt-middle", category: "receipt", title: "receipt", timestamp: 2 }),
			artifact({ id: "accountability-oldest", category: "accountability", title: "accountability", timestamp: 1 }),
		];
		deepStrictEqual(
			artifactsInCategoryOrder(artifacts).map((item) => item.id),
			["accountability-oldest", "receipt-middle", "prompt-newest"],
		);
		strictEqual(initialViewSelection(artifacts), 2, "newest artifact is mapped into the rendered order");
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

	it("parses category-aware view filter query strings", () => {
		deepStrictEqual(parseViewFilterQuery("audit"), { kind: "category", category: "audit", value: "" });
		deepStrictEqual(parseViewFilterQuery("prompt-manifest"), {
			kind: "category",
			category: "prompt-manifest",
			value: "",
		});
		deepStrictEqual(parseViewFilterQuery("audit:session-1"), {
			kind: "category",
			category: "audit",
			value: "session-1",
		});
		deepStrictEqual(parseViewFilterQuery(" receipt:run-1 "), {
			kind: "category",
			category: "receipt",
			value: "run-1",
		});
		deepStrictEqual(parseViewFilterQuery("receipt:"), { kind: "category", category: "receipt", value: "" });
		deepStrictEqual(parseViewFilterQuery("unknown:run-1"), { kind: "text", text: "unknown:run-1" });
		deepStrictEqual(parseViewFilterQuery("receipt"), { kind: "text", text: "receipt" });
	});

	it("filters category-aware queries against summary metadata", () => {
		const artifacts = [
			artifact({
				id: "run-111",
				category: "receipt",
				title: "coder fix lint",
				timestamp: 8,
				runId: "run-111",
				sessionId: "session-1",
				path: "/state/receipts/run-111.json",
			}),
			artifact({
				id: "evidence-run-111",
				category: "evidence",
				title: "Evidence · run run-111",
				timestamp: 7,
				runId: "run-111",
				sessionId: "session-1",
				searchText: ["blocked-tool"],
			}),
			artifact({
				id: "run-222",
				category: "dispatch",
				title: "scout inspect tests",
				timestamp: 6,
				runId: "run-222",
			}),
			artifact({
				id: "task-ledger:turn-1",
				category: "task-ledger",
				title: "Task ledger · Ship proof catalog",
				timestamp: 5,
				searchText: ["G1", "run-333"],
			}),
			artifact({
				id: "tool:turn-1",
				category: "tool-output",
				title: "Bash · npm test",
				timestamp: 4,
				runId: "run-444",
				toolName: "bash",
				searchText: ["npm test"],
			}),
			artifact({
				id: "protected:turn-1",
				category: "protected-artifact",
				title: "Protected · locked.ts",
				timestamp: 3,
				runId: "run-555",
				correlationId: "corr-protected",
				path: "/workspace/src/locked.ts",
			}),
			artifact({
				id: "compaction:turn-1",
				category: "compaction",
				title: "Compaction · force",
				timestamp: 2,
			}),
			artifact({
				id: "audit:2026-06-11.jsonl:3",
				category: "audit",
				title: "Audit · tool_call · bash · blocked",
				timestamp: 1,
				runId: "run-666",
				sessionId: "session-2",
				correlationId: "corr-audit",
			}),
		];

		deepStrictEqual(
			filterViewArtifacts(artifacts, "receipt:run-111").map((item) => item.id),
			["run-111"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "evidence:blocked-tool").map((item) => item.id),
			["evidence-run-111"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "evidence:run-111").map((item) => item.id),
			["evidence-run-111"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "dispatch:run-222").map((item) => item.id),
			["run-222"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "task-ledger").map((item) => item.id),
			["task-ledger:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "task-ledger:run-333").map((item) => item.id),
			["task-ledger:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "tool-output:bash").map((item) => item.id),
			["tool:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "tool-output:run-444").map((item) => item.id),
			["tool:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "protected-artifact").map((item) => item.id),
			["protected:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "protected-artifact:/workspace/src/locked.ts").map((item) => item.id),
			["protected:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "protected-artifact:run-555").map((item) => item.id),
			["protected:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "compaction").map((item) => item.id),
			["compaction:turn-1"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "audit:corr-audit").map((item) => item.id),
			["audit:2026-06-11.jsonl:3"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "audit:session-2").map((item) => item.id),
			["audit:2026-06-11.jsonl:3"],
		);
		deepStrictEqual(
			filterViewArtifacts(artifacts, "audit").map((item) => item.id),
			["audit:2026-06-11.jsonl:3"],
		);
	});

	it("falls unknown category prefixes back to free-text filtering", () => {
		const artifacts = [
			artifact({ id: "unknown:needle", category: "receipt", title: "prefixed id", timestamp: 1 }),
			artifact({ id: "run-222", category: "audit", title: "audit row", timestamp: 2 }),
		];

		deepStrictEqual(
			filterViewArtifacts(artifacts, "unknown:needle").map((item) => item.id),
			["unknown:needle"],
		);
	});

	it("auto-selects one exact category-aware metadata match among fuzzy matches", () => {
		const artifacts = [
			artifact({
				id: "tool:preview",
				category: "tool-output",
				title: "Bash npm test",
				timestamp: 2,
			}),
			artifact({
				id: "tool:exact",
				category: "tool-output",
				title: "shell output",
				timestamp: 1,
				toolName: "bash",
			}),
		];
		const filtered = filterViewArtifacts(artifacts, "tool-output:bash");
		strictEqual(filtered.length, 2);
		strictEqual(filtered[initialViewSelection(artifacts, "tool-output:bash")]?.id, "tool:exact");
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

	it("jumps across non-empty artifact categories in either direction", () => {
		const artifacts = [
			artifact({ id: "receipt-1", category: "receipt", title: "receipt one", timestamp: 4 }),
			artifact({ id: "receipt-2", category: "receipt", title: "receipt two", timestamp: 3 }),
			artifact({ id: "prompt-1", category: "prompt-manifest", title: "prompt", timestamp: 2 }),
			artifact({ id: "audit-1", category: "audit", title: "audit", timestamp: 1 }),
		];

		strictEqual(nextCategorySelection(artifacts, 0, 1), 2, "next skips empty categories and sibling receipts");
		strictEqual(nextCategorySelection(artifacts, 2, 1), 3);
		strictEqual(nextCategorySelection(artifacts, 3, 1), 0, "next wraps to the first non-empty category");
		strictEqual(nextCategorySelection(artifacts, 0, -1), 3, "previous wraps to the last non-empty category");
		strictEqual(nextCategorySelection(artifacts.slice(0, 2), 1, 1), 1, "one-category filters keep their selection");
	});

	it("paints verification state into artifact headers", () => {
		const item = artifact({
			id: "run-ok",
			category: "receipt",
			title: "receipt",
			timestamp: Date.UTC(2026, 5, 11, 12, 0, 5),
		});

		const okHeader = buildArtifactHeader(item, { status: "ok", detail: "integrity verified" }, 120);
		const plainOkHeader = stripAnsi(okHeader);
		ok(plainOkHeader.includes("verify ok integrity verified"));
		ok(plainOkHeader.includes(GLYPH.ok), "ok verification uses the shared glyph");
		ok(/\b\d{2}:\d{2}:\d{2}\b/.test(plainOkHeader), plainOkHeader);
		ok(!plainOkHeader.includes("2026-06-11T12:00:05.000Z"), "artifact headers should not show raw ISO timestamps");
		ok(okHeader.includes(clioTheme().fgSequence("success")), "ok verification uses the success token");

		const failHeader = buildArtifactHeader(item, { status: "fail", detail: "integrity mismatch" }, 120);
		ok(stripAnsi(failHeader).includes("verify fail integrity mismatch"));
		ok(stripAnsi(failHeader).includes(GLYPH.error), "failed verification uses the shared glyph");
		ok(failHeader.includes(clioTheme().fgSequence("error")), "failed verification uses the error token");

		const narrow = stripAnsi(buildArtifactHeader(item, { status: "ok", detail: "integrity verified" }, 32));
		ok(narrow.includes("…"), `narrow headers should truncate with an ellipsis: ${narrow}`);
		ok(!narrow.includes("..."), "narrow headers should not use three-dot truncation");
	});

	it("renders loading content with an ellipsis", async () => {
		const pending = artifact({
			id: "pending",
			category: "receipt",
			title: "pending receipt",
			timestamp: Date.now(),
			load: async () => new Promise(() => {}),
		});
		const view = new ViewOverlayView({
			providers: [{ category: "receipt", list: async () => [pending] }],
			getBodyHeight: () => 4,
			onClose() {},
			requestRender() {},
		});

		view.refresh();
		await new Promise((resolve) => setImmediate(resolve));
		const body = stripAnsi(view.render(80).join("\n"));

		ok(body.includes("loading artifact…"), body);
		ok(!body.includes("loading artifact..."), "loading text should use an ellipsis glyph");
	});

	it("switches footer hints by pane focus", () => {
		const listHint = viewFooterHint("list", true);
		ok(listHint.includes("[←→] category"));
		ok(listHint.includes("[type] filter"));
		ok(listHint.includes("[Tab] content"));
		ok(listHint.includes("[v] verify"));

		const contentHint = viewFooterHint("content", false);
		ok(contentHint.includes("[←→] category"));
		ok(contentHint.includes("[PgUp/PgDn] page"));
		ok(contentHint.includes("[g/G] top/bottom"));
		ok(contentHint.includes("[Tab] list"));
		ok(!contentHint.includes("[v] verify"));
	});

	it("uses Tab for panes and category arrows from the detail pane", async () => {
		const accountability = artifact({
			id: "accountability-1",
			category: "accountability",
			title: "accountability details",
			timestamp: 3,
		});
		const receipt = artifact({
			id: "receipt-1",
			category: "receipt",
			title: "receipt details",
			timestamp: 1,
		});
		const prompt = artifact({
			id: "prompt-1",
			category: "prompt-manifest",
			title: "prompt details",
			timestamp: 2,
		});
		const view = new ViewOverlayView({
			providers: [
				{ category: "accountability", list: async () => [accountability] },
				{ category: "receipt", list: async () => [receipt] },
				{ category: "prompt-manifest", list: async () => [prompt] },
			],
			getBodyHeight: () => 24,
			onClose() {},
			requestRender() {},
		});

		view.refresh();
		await new Promise((resolve) => setImmediate(resolve));
		view.handleInput("\x1b[B");
		let body = stripAnsi(view.render(100).join("\n"));
		ok(body.includes(`${GLYPH.cursor} receipt details`), body);
		ok(view.getHint().includes("[Tab] content"));
		view.handleInput("\t");
		ok(view.getHint().includes("[Tab] list"));
		view.handleInput("\x1b[C");
		body = stripAnsi(view.render(100).join("\n"));
		ok(body.includes(`${GLYPH.cursor} prompt details`), body);

		view.handleInput("\x1b[Z");
		ok(view.getHint().includes("[Tab] content"), "Shift+Tab returns to the artifact list");
	});

	it("mounts as a full-screen opaque frame so dashboard rows cannot bleed through", () => {
		const harness = fakeTui();
		const handle = openViewOverlay(harness.tui, { providers: [], onClose() {} });

		strictEqual(harness.options()?.width, "100%");
		strictEqual(harness.options()?.maxHeight, "100%");
		deepStrictEqual(harness.options()?.margin, VIEW_OVERLAY_MARGIN);
		deepStrictEqual(VIEW_OVERLAY_MARGIN, { top: 0, right: 0, bottom: 0, left: 0 });

		const lines = harness.component().render(132);
		for (const line of lines) strictEqual(visibleWidth(line), 132);
		handle.hide();
	});
});
