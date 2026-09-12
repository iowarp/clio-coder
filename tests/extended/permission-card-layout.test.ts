import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { routeOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import { permissionHintEntries } from "../../src/interactive/permission-hint.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayHint,
} from "../../src/interactive/permission-overlay.js";

const DEEP_TARGET =
	"/home/researcher/projects/high-entropy-alloys/sigma-phase-onset/.research/tasks/task-03/task-03-protocol-arc-melting-and-aging.md · content=<string 4173 bytes>";

const WRITE_VIEW: ApprovalRequestView = {
	requestId: "req-1",
	tool: "write",
	actionClass: "write",
	axis: { kind: "autonomy", level: "suggest" },
	origin: { kind: "main" },
	reason: "write blocked: write",
	target: DEEP_TARGET,
	mutation: { kind: "write", bytes: 4173, replacements: 1, digest: "6e068cd0028e23c4" },
};

function plain(lines: ReadonlyArray<string>): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

/** The content width the frame hands the card at a terminal width: the fixed box, clamped, minus borders and pads. */
function contentWidth(columns: number): number {
	return Math.min(PERMISSION_OVERLAY_WIDTH, columns) - 4;
}

for (const columns of [80, 120, 160]) {
	test(`${columns} columns: the folded card leads with the call and keeps the whole target`, () => {
		const width = contentWidth(columns);
		const body = createPermissionOverlayBody(WRITE_VIEW);
		const lines = plain(body.render(width));
		for (const line of lines) ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		strictEqual(lines[0], "Tool: write · Action: write");
		// The path is folded under its label, never cut: every token survives.
		const joined = lines.join(" ").replace(/\s+/g, " ");
		for (const token of [
			"task-03-protocol-arc-melting-and-aging.md",
			"content=<string 4173 bytes>",
			"sha256 6e068cd0028e23c4",
		]) {
			ok(joined.includes(token), `${columns}: lost "${token}"`);
		}
		doesNotMatch(joined, /…/u, "nothing is ellipsized");
		ok(lines.length <= 10, `${lines.length} rows: the folded card stays short`);
		ok(!joined.includes("Hard-blocked actions remain blocked"), "standing terms are folded");
		ok(!joined.includes("Consequence:"), "standing terms are folded");
		match(joined, /Allow runs this one write call/u);
		match(joined, /Press \? for the full terms/u);
		match(joined, /Requested by: main agent through autonomy level \(suggest\)/u);

		body.toggleTerms();
		const opened = plain(body.render(width)).join(" ");
		ok(opened.includes("Hard-blocked actions remain blocked."));
		ok(opened.includes("Approval: Approval authorizes one write call to write."));
		ok(opened.includes("Reversible: yes."));
		body.toggleTerms();
		strictEqual(body.isShowingTerms(), false);
	});
}

test("the footer names the terms key and drops it before any answer key", () => {
	const wide = permissionOverlayHint(100, false, "closed", "closed");
	match(wide, /\[\?\] terms/u);
	match(wide, /\[Enter\] allow once/u);
	match(wide, /\[s\] stop turn/u);
	const open = permissionOverlayHint(100, false, "closed", "open");
	match(open, /\[\?\] hide terms/u);
	// At the 80-column box the labels shorten before anything drops.
	strictEqual(
		permissionOverlayHint(80, false, "closed", "closed"),
		"[Enter] allow · [?] terms · [v] inspect · [s] stop · [Esc] deny",
	);
	// Narrower still, the terms key is the first to go and the inspect key stays.
	strictEqual(
		permissionOverlayHint(60, false, "closed", "closed"),
		"[Enter] allow · [v] inspect · [s] stop · [Esc] deny",
	);
	const narrow = permissionOverlayHint(36, false, "closed", "closed");
	doesNotMatch(narrow, /terms/u);
	match(narrow, /allow/u);
	match(narrow, /stop/u);
	// The composer rail asks without a terms state and stays as it was.
	ok(!permissionHintEntries(false, "closed").some((entry) => entry.key === "?"));
});

test("? folds the terms while the card owns the keys and yields while the mutation is open", () => {
	const calls: string[] = [];
	const deps = {
		cancelPermission: () => calls.push("cancel"),
		confirmPermission: () => calls.push("confirm"),
		stopTurnFromPermission: () => calls.push("stop"),
		togglePermissionTerms: () => calls.push("terms"),
		isInspectingMutation: () => false,
		closeOverlay: () => calls.push("close"),
	};
	const matches = () => false;
	ok(routeOverlayKey("?", "permission-confirm", deps as never, matches));
	ok(routeOverlayKey("\r", "permission-confirm", deps as never, matches));
	deps.isInspectingMutation = () => true;
	routeOverlayKey("?", "permission-confirm", deps as never, matches);
	strictEqual(calls.filter((call) => call === "terms").length, 1, "the key is inert while the mutation is open");
	ok(calls.includes("confirm"));
});
