import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { ClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { routeOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayHint,
} from "../../src/interactive/permission-overlay.js";

// BT-005: at 60x40 the safety-net card had 17 rows above the composer, and
// `?` opened terms that ended at "… 3 more rows" with no key that reached them.
const NET_VIEW: ApprovalRequestView = {
	requestId: "req-bt005",
	tool: "bash",
	actionClass: "execute",
	axis: { kind: "net", ruleId: "bash-hidden-content" },
	origin: { kind: "main" },
	reason: "bash blocked: execute",
	target: 'node -e "console.log(41+1)"',
};

const COLUMNS = 60;
const ROW_BUDGET = 17;
const CONTENT = Math.min(PERMISSION_OVERLAY_WIDTH, COLUMNS) - 4;

function plain(lines: ReadonlyArray<string>): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

test("open terms that overflow the frame scroll inside it and every row is reachable", () => {
	const body = createPermissionOverlayBody(NET_VIEW);
	body.toggleTerms();
	const frame = new ClioOverlayFrame(body, "Safety-net confirmation", undefined, PERMISSION_OVERLAY_WIDTH);
	frame.setRowBudget(ROW_BUDGET);

	// Body rows sit between `│ ` and ` │`; the borders are the first and last rows.
	const inner = (rows: string[]): string[] => rows.slice(1, -1).map((row) => row.slice(2, -2).trimEnd());
	const seen = new Set<string>();
	let screen = plain(frame.render(COLUMNS));
	strictEqual(screen.length, ROW_BUDGET, "the card fills its rows and no more");
	ok(body.isCardScrollable(), "the open terms do not fit, so the card scrolls");
	doesNotMatch(screen.join("\n"), /more rows/u, "the frame never has to cut the card");
	match(screen[1] ?? "", /Tool: bash · Action: execute/u, "the call's identity stays at the top");
	match(screen.join("\n"), /↑↓ scroll · \? back/u, "the card names its scroll keys");
	for (const row of inner(screen)) seen.add(row);

	for (let step = 0; step < 20; step++) {
		ok(body.scrollCard(1), "a scrollable card consumes the arrow even at its end");
		screen = plain(frame.render(COLUMNS));
		strictEqual(screen.length, ROW_BUDGET);
		match(screen[1] ?? "", /Tool: bash · Action: execute/u);
		for (const row of inner(screen)) seen.add(row);
	}
	const whole = createPermissionOverlayBody(NET_VIEW);
	whole.toggleTerms();
	const rows = plain(whole.render(CONTENT)).map((row) => row.trimEnd());
	match(rows.join("\n"), /Hard-blocked actions remain blocked\./u);
	for (const row of rows) ok(seen.has(row), `unreachable card row: ${row}`);
});

test("a card that fits does not scroll and folding the terms resets the window", () => {
	const body = createPermissionOverlayBody(NET_VIEW);
	body.setBodyRows(ROW_BUDGET - 2);
	body.render(CONTENT);
	strictEqual(body.isCardScrollable(), false, "the folded card fits in 15 rows");
	strictEqual(body.scrollCard(1), false, "an arrow on a card that fits is not consumed");

	body.toggleTerms();
	body.render(CONTENT);
	ok(body.scrollCard(5));
	body.toggleTerms();
	body.toggleTerms();
	const reopened = plain(body.render(CONTENT)).join("\n");
	match(reopened, /Approval: Approval authorizes one execute call/u, "reopened terms start at their top");

	body.setBodyRows(0);
	const unbounded = plain(body.render(CONTENT)).join("\n");
	doesNotMatch(unbounded, /↑↓ scroll/u, "with no known budget the card renders whole");
	match(unbounded, /Hard-blocked actions remain blocked\./u);
});

test("arrows and pages reach the card's scroll while it owns the keys, and the footer names them", () => {
	const deltas: number[] = [];
	let scrollable = true;
	const deps = {
		cancelPermission: () => {},
		confirmPermission: () => {},
		stopTurnFromPermission: () => {},
		isInspectingMutation: () => false,
		scrollPermissionCard: (delta: number) => {
			if (!scrollable) return false;
			deltas.push(delta);
			return true;
		},
		closeOverlay: () => {},
	};
	const matches = () => false;
	ok(routeOverlayKey("\x1b[B", "permission-confirm", deps as never, matches));
	ok(routeOverlayKey("\x1b[A", "permission-confirm", deps as never, matches));
	ok(routeOverlayKey("\x1b[6~", "permission-confirm", deps as never, matches));
	strictEqual(deltas.length, 3);
	ok((deltas[0] ?? 0) > 0 && (deltas[1] ?? 0) < 0 && (deltas[2] ?? 0) > 1);
	// A card that fits leaves the arrow to the modal, which swallows it.
	scrollable = false;
	ok(routeOverlayKey("\x1b[B", "permission-confirm", deps as never, matches));
	strictEqual(deltas.length, 3);

	match(permissionOverlayHint(100, false, "none", "open", true), /\[↑↓\] scroll/u);
	doesNotMatch(permissionOverlayHint(100, false, "none", "open", false), /scroll/u);
});
