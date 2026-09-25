import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { buildSettingsSections, SettingsCenter } from "../../src/interactive/overlays/settings.js";
import { TreeOverlayView } from "../../src/interactive/overlays/tree-selector.js";
import { ViewOverlayView } from "../../src/interactive/view/view-overlay.js";

const WIDTHS = [60, 80, 120, 200] as const;
const plain = (lines: ReadonlyArray<string>) => lines.map(stripTerminalSequences).join("\n");

/**
 * The filter rule: a typed narrowing is the `> text` input row every list
 * overlay draws, it appears with the first character, and the caret is the
 * editor's own. View kept a permanent `filter: (empty)` caption; settings and
 * the tree held an `Input` they never rendered and printed `text_` instead.
 */
function assertFits(lines: ReadonlyArray<string>, width: number): void {
	for (const line of lines) ok(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
}

test("view shows no filter row until the first character, then the shared input row", () => {
	const view = new ViewOverlayView({
		listArtifacts: async () => [],
		readArtifact: async () => ({ content: "", format: "text" as const }),
		onClose: () => {},
		getBodyHeight: () => 20,
	} as unknown as ConstructorParameters<typeof ViewOverlayView>[0]);
	for (const width of WIDTHS) {
		const empty = view.render(width);
		assertFits(empty, width);
		doesNotMatch(plain(empty), /filter:|^> /mu);
	}
	view.handleInput("rep");
	for (const width of WIDTHS) {
		const typed = view.render(width);
		assertFits(typed, width);
		match(plain(typed), /^> rep/mu);
		doesNotMatch(plain(typed), /rep_/u);
	}
});

test("settings renders its filter editor as the shared input row while it owns input", () => {
	const items = buildSettingsSections([]).flatMap((section) => section.items);
	const center = new SettingsCenter(items, {
		getBodyHeight: () => 22,
		prepareChange: () => null,
		onApply: () => {},
		onCancel: () => {},
	});
	center.handleInput("/");
	center.handleInput("smooth");
	for (const width of WIDTHS) {
		const lines = center.render(width);
		assertFits(lines, width);
		match(plain(lines), /^> smooth/mu);
		doesNotMatch(plain(lines), /Filter settings:|smooth_/u);
	}
});

test("the tree label editor is the shared input row in the body, not a fake caret in the footer", () => {
	const snapshot: TreeSnapshot = {
		sessionId: "session",
		meta: { id: "session", cwd: "/w", createdAt: "2026-09-01T00:00:00Z", endedAt: null, model: null, target: null },
		leafId: "only",
		rootIds: ["only"],
		nodesById: {
			only: { id: "only", parentId: null, at: "2026-09-01T00:00:00Z", kind: "user", children: [], preview: "hello" },
		},
	} as TreeSnapshot;
	const view = new TreeOverlayView(
		{ cwd: "/w", session: { tree: () => snapshot, editLabel: () => {} }, onSwitchTurn: () => {}, onClose: () => {} },
		snapshot,
	);
	view.handleInput("e");
	view.handleInput("ps");
	for (const width of WIDTHS) {
		const lines = view.render(width);
		assertFits(lines, width);
		match(plain(lines), /^> ps/mu);
		doesNotMatch(`${plain(lines)}\n${view.getHint()}`, /label: |ps_/u);
		match(view.getHint(), /\[Enter\] commit label/u);
	}
});
