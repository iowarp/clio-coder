import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { PermissionResolvedPayload } from "../../src/core/telemetry/live-events.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { CALL_TARGET_MAX_CHARS, describeCallTarget } from "../../src/domains/safety/call-target.js";
import { UNATTENDED_ALLOWED_BY } from "../../src/domains/safety/unattended.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { CARD_CALLOUT_MAX_WIDTH } from "../../src/interactive/card.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { type OverlayState, routeOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import {
	createOverlayPermissionLifecycle,
	type OverlayPermissionLifecycle,
} from "../../src/interactive/overlay-permission-lifecycle.js";
import { permissionHintEntries } from "../../src/interactive/permission-hint.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayHint,
} from "../../src/interactive/permission-overlay.js";
import { renderToolAwaitingApproval } from "../../src/interactive/renderers/tool-execution.js";
import { clioTheme } from "../../src/interactive/theme/index.js";
import { keyCap } from "../../src/interactive/theme/primitives.js";
import type { UnattendedTimers } from "../../src/interactive/unattended-countdown.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";

const DEEP_TARGET =
	"/home/researcher/projects/high-entropy-alloys/sigma-phase-onset/.research/tasks/task-03/task-03-protocol-arc-melting-and-aging.md · content=<string 4173 bytes>";

test("a worker bash target keeps command boundaries without terminal controls", () => {
	const command = "rm -rf scratch-a\r\nrm -rf scratch-b";
	const target = describeCallTarget("bash", { command, output_policy: "bounded" });
	strictEqual(target, "rm -rf scratch-a ⏎ rm -rf scratch-b");
	const hostile = describeCallTarget("bash", {
		command: `rm -rf scratch-a\u001b]0;hidden\ntext\u0007\nrm -rf scratch-b`,
	});
	strictEqual(hostile, "rm -rf scratch-a\\u{1b}]0;hidden ⏎ text\\u{7} ⏎ rm -rf scratch-b");
	const body = createPermissionOverlayBody({
		...WRITE_VIEW,
		tool: "bash",
		actionClass: "execute",
		target,
		origin: { kind: "worker", runId: "worker-1", agentId: "coder" },
	});
	match(plain(body.render(76)).join(" "), /scratch-a ⏎ rm -rf scratch-b/u);
	const bounded = describeCallTarget("bash", { command: `${command}\n`.repeat(30) });
	ok(bounded.length <= CALL_TARGET_MAX_CHARS);
	ok(/ … \+\d+ more characters$/u.test(bounded));
});

const WRITE_VIEW: ApprovalRequestView = {
	requestId: "req-1",
	tool: "write",
	actionClass: "write",
	axis: { kind: "autonomy", level: "default" },
	origin: { kind: "main" },
	reason: "write blocked: write",
	target: DEEP_TARGET,
	mutation: { kind: "write", bytes: 4173, replacements: 1, digest: "6e068cd0028e23c4" },
};

function plain(lines: ReadonlyArray<string>): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

/** The content width a boxed frame hands the card at a terminal width: the box, clamped, minus borders and pads. */
function contentWidth(columns: number): number {
	return Math.min(PERMISSION_OVERLAY_WIDTH, columns) - 4;
}

test("a fresh card shows allow dimmed while Enter cannot answer it yet, in the same words", () => {
	const theme = clioTheme();
	let settling = true;
	const body = createPermissionOverlayBody(
		WRITE_VIEW,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		() => settling,
	);
	const allowRow = (lines: ReadonlyArray<string>): string => {
		const row = lines.find((line) => /\[Enter\] allow/u.test(stripTerminalSequences(line)));
		ok(row !== undefined, "the card shows the allow row");
		return row;
	};
	const denyRow = (lines: ReadonlyArray<string>): string =>
		lines.find((line) => /\[Esc\]\s+deny/u.test(stripTerminalSequences(line))) ?? "";
	for (const rows of [0, 9]) {
		body.setBodyRows(rows);
		settling = true;
		const held = body.render(76);
		ok(allowRow(held).includes(theme.fg("annotation", "[Enter]")), `allow is dimmed (rows ${rows})`);
		ok(!allowRow(held).includes(keyCap(theme, "Enter")), `allow lost its key color (rows ${rows})`);
		ok(denyRow(held).includes(keyCap(theme, "Esc")), `deny keeps its key color (rows ${rows})`);
		settling = false;
		const live = body.render(76);
		ok(allowRow(live).includes(keyCap(theme, "Enter")), `allow returns to the key color (rows ${rows})`);
		deepStrictEqual(plain(held), plain(live));
	}
});

test("a permission card refreshes portable hints when the menu key changes", () => {
	const previous = getKeybindings();
	const terminal = process.env.TERM_PROGRAM;
	process.env.TERM_PROGRAM = "Apple_Terminal";
	const manager = createKeybindingManager(DEFAULT_SETTINGS, {});
	try {
		const body = createPermissionOverlayBody(WRITE_VIEW);
		const text = () => plain(body.render(contentWidth(120))).join(" ");
		match(text(), /\[Ctrl\+G X\] stop/u);
		manager.reload({ "clio-coder.leader": "ctrl+b" });
		match(text(), /\[Ctrl\+B X\] stop/u);
		doesNotMatch(text(), /Ctrl\+G/u);
		manager.reload({ "clio-coder.leader": [] });
		match(text(), /\[Alt\+X\] stop/u);
	} finally {
		setKeybindings(previous);
		if (terminal === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = terminal;
	}
});

for (const columns of [80, 120, 160]) {
	test(`${columns} columns: the folded card leads with the call and keeps the whole target`, () => {
		const width = contentWidth(columns);
		const body = createPermissionOverlayBody(WRITE_VIEW);
		const lines = plain(body.render(width));
		for (const line of lines) ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		strictEqual(lines[0], "± write · default autonomy");
		// The path is folded under its label, never cut: every token survives.
		const joined = lines
			.join(" ")
			.replace(/\s*▌\s*/gu, " ")
			.replace(/\s+/g, " ");
		for (const token of ["task-03-protocol-arc-melting-and-aging.md", "sha256 6e068cd0028e23c4"]) {
			ok(joined.includes(token), `${columns}: lost "${token}"`);
		}
		doesNotMatch(joined, /…/u, "nothing is ellipsized");
		doesNotMatch(joined, /content=</u, "the size placeholder is left to the mutation row");
		ok(lines.length <= 10, `${lines.length} rows: the folded card stays short`);
		ok(!joined.includes("Hard-blocked actions remain blocked"), "standing terms are folded");
		ok(!joined.includes("Consequence:"), "standing terms are folded");
		match(joined, /\[Enter\] allow\s+runs this one call \[Esc\] deny\s+skips it \[Alt\+X\] stop\s+ends the turn/u);
		match(lines[0] ?? "", /default autonomy/u);

		body.toggleTerms();
		const opened = plain(body.render(width)).join(" ");
		ok(opened.includes("Hard-blocked actions remain blocked."));
		ok(opened.includes("Approval allows this one call to write, which writes files."));
		ok(opened.includes("Reversible: yes."));
		body.toggleTerms();
		strictEqual(body.isShowingTerms(), false);
	});
}

test("in a wide dock the card stops at the callout width with every fact, and its inspection keeps the dock's columns", () => {
	const dock = 196;
	const advisory =
		"Clio's safety judge gave no verdict because its answer could not be read, so this call needs your decision.";
	const command = `node scripts/release.mjs --channel nightly --notes ${"x".repeat(150)}`;
	const { mutation: _write, ...call } = WRITE_VIEW;
	const body = createPermissionOverlayBody(
		{ ...call, tool: "bash", actionClass: "execute", target: command },
		undefined,
		() => ({ command }),
		() => advisory,
	);
	const card = plain(body.render(dock));
	for (const line of card) ok(visibleWidth(line) <= CARD_CALLOUT_MAX_WIDTH, `${visibleWidth(line)}: ${line}`);
	const joined = card.join(" ").replace(/\s+/gu, " ");
	ok(joined.includes("so this call needs your decision."), joined);
	ok(
		card
			.join("")
			.replace(/[\s▌│]/gu, "")
			.includes("x".repeat(150)),
		"the whole target survives the narrower card",
	);
	match(joined, /\[Enter\] allow\s+runs this one call/u);
	body.toggleTerms();
	for (const line of plain(body.render(dock))) ok(visibleWidth(line) <= CARD_CALLOUT_MAX_WIDTH, line);
	body.toggleTerms();
	body.toggleInspect();
	ok(
		plain(body.render(dock)).some((line) => visibleWidth(line) > CARD_CALLOUT_MAX_WIDTH),
		"the inspection lays the call out across the dock",
	);
});

test("worker terms say an approval covers one call and a denial holds within the run", () => {
	const body = createPermissionOverlayBody({
		...WRITE_VIEW,
		origin: { kind: "worker", agentId: "coder", runId: "run-1" },
	});
	const folded = plain(body.render(76)).join(" ").replace(/\s+/g, " ");
	match(folded, /allow\s+runs this one call; an identical call asks again/u);
	match(folded, /deny\s+skips it; an identical call in this run is refused without asking/u);
	body.toggleTerms();
	const terms = plain(body.render(76)).join(" ").replace(/\s+/g, " ");
	match(terms, /remembers a denial of exactly this call/u);
	match(terms, /Each call still passes the safety net/u);
	match(terms, /refuses identical calls/u);
	doesNotMatch(terms, /authorizes one|only.*exact request/u);
});

test("the footer names the terms key and drops it before any answer key", () => {
	const wide = permissionOverlayHint(100, false, "closed", "closed");
	match(wide, /\[Alt\+T\] terms/u);
	match(wide, /\[Enter\] allow/u);
	doesNotMatch(wide, /allow once/u);
	match(wide, /\[Alt\+X\] stop turn/u);
	const open = permissionOverlayHint(100, false, "closed", "open");
	match(open, /\[Esc\] hide terms/u);
	doesNotMatch(open, /\[Alt\+T\]/u);
	// The longer modifier labels shorten at the 80-column box.
	strictEqual(
		permissionOverlayHint(80, false, "closed", "closed"),
		"[Enter] allow · [Alt+T] terms · [Alt+V] inspect · [Alt+X] stop · [Esc] deny",
	);
	// Narrower still, both reading keys yield to the decision keys.
	strictEqual(permissionOverlayHint(60, false, "closed", "closed"), "[Enter] allow · [Alt+X] stop · [Esc] deny");
	const narrow = permissionOverlayHint(36, false, "closed", "closed");
	doesNotMatch(narrow, /terms/u);
	match(narrow, /allow/u);
	match(narrow, /stop/u);
	// The composer rail asks without a terms state and stays as it was.
	ok(!permissionHintEntries(false, "closed").some((entry) => entry.key === "alt+t"));
});

test("Alt+T folds the terms while the card owns the keys and yields while the mutation is open", () => {
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
	ok(routeOverlayKey("\x1bt", "permission-confirm", deps as never, matches));
	ok(routeOverlayKey("\r", "permission-confirm", deps as never, matches));
	deps.isInspectingMutation = () => true;
	routeOverlayKey("\x1bt", "permission-confirm", deps as never, matches);
	strictEqual(calls.filter((call) => call === "terms").length, 1, "the key is inert while the mutation is open");
	ok(calls.includes("confirm"));
});

test("local invocation inspection scrolls complete redacted arguments without adding them to the shared approval view", () => {
	const view: ApprovalRequestView = { ...WRITE_VIEW, tool: "bash", actionClass: "unknown", target: "preview" };
	delete view.mutation;
	const before = JSON.stringify(view);
	const body = createPermissionOverlayBody(view, undefined, () => ({
		command: `first\n${"middle\n".repeat(40)}final-command`,
		api_key: "secret-never-shown",
	}));
	ok(body.canInspect());
	body.toggleInspect();
	match(plain(body.render(60)).join("\n"), /bash[^\n]*\nExact invocation/);
	body.scrollInspect(1000);
	const tail = plain(body.render(60)).join("\n");
	match(tail, /final-command/);
	doesNotMatch(tail, /secret-never-shown/);
	strictEqual(JSON.stringify(view), before);
	body.toggleInspect();
	ok(!body.isInspecting());
});

test("a target the safety layer cut at its cap ends in an ellipsis on the card and the transcript row", () => {
	const command = `cd /tmp/work/demo-repo && npm test -- ${"--reporter spec ".repeat(12)}`;
	const cut = describeCallTarget("bash", { command });
	ok(cut.length <= CALL_TARGET_MAX_CHARS, "the safety layer cuts at its cap");
	ok(/ … \+\d+ more characters$/u.test(cut), "the source marks a cut for every consumer");
	const view: ApprovalRequestView = { ...WRITE_VIEW, tool: "bash", actionClass: "execute", target: cut };
	delete view.mutation;
	const card = plain(createPermissionOverlayBody(view).render(76)).join(" ").replace(/\s+/g, " ");
	match(card, /▌ cd \/tmp\/work\/demo-repo && npm test -- .*… \+\d+ more characters/u, card);
	const row = plain(
		renderToolAwaitingApproval({ toolCallId: "b", toolName: "bash", args: { command } }, 100, view),
	).join(" ");
	match(row, /target · cd .*…/u, row);
	// A target under the cap is whole, so it carries no mark.
	const whole = describeCallTarget("bash", { command: "npm test" });
	const short = plain(createPermissionOverlayBody({ ...view, target: whole }).render(76)).join(" ");
	match(short, /▌ npm test/u);
	doesNotMatch(short, /npm test…/u);
	const exact = "x".repeat(CALL_TARGET_MAX_CHARS);
	strictEqual(describeCallTarget("bash", { command: exact }), exact, "an exactly sized target remains whole");
});

/** A monotonic clock the test moves by hand, firing due timers in order. */
function manualTimers() {
	let now = 0;
	let seq = 0;
	const due = new Map<number, { at: number; callback: () => void }>();
	const timers: UnattendedTimers = {
		now: () => now,
		setTimeout: (callback, ms) => {
			seq += 1;
			due.set(seq, { at: now + ms, callback });
			return seq;
		},
		clearTimeout: (handle) => {
			due.delete(handle as number);
		},
	};
	const advance = (ms: number): void => {
		const target = now + ms;
		for (;;) {
			const next = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (next === undefined || next[1].at > target) break;
			due.delete(next[0]);
			now = next[1].at;
			next[1].callback();
		}
		now = target;
	};
	return { timers, advance };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const OUTSIDE_WRITE = { tool: ToolNames.Write, args: { path: "../outside.txt", content: "x" } };

/** The real registry parks an outside-workspace write; the lifecycle stands in for the TUI's card. */
function unattendedFixture(windowMs: number) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-unattended-")));
	const root = join(base, "root");
	mkdirSync(root, { recursive: true });
	const originalCwd = process.cwd();
	process.chdir(root);
	const clock = manualTimers();
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
	registry.register(writeTool);
	const bus = createTelemetryHub();
	const resolved: PermissionResolvedPayload[] = [];
	bus.subscribe("approval.resolved", (payload) => {
		resolved.push(payload);
	});
	const notices: string[] = [];
	const stops: string[] = [];
	const countdowns: Array<() => number | "held" | null> = [];
	let state: OverlayState = "closed";
	const lifecycle: OverlayPermissionLifecycle = createOverlayPermissionLifecycle({
		toolRegistry: registry,
		bus,
		dispatch: {},
		getAutonomy: () => "default",
		getOverlayState: () => state,
		openPermissionOverlay: (_view, _inspect, _invocation, _advisory, countdown) => {
			if (state === "permission-confirm") return false;
			state = "permission-confirm";
			if (countdown !== undefined) countdowns.push(countdown);
			return true;
		},
		closeOverlay: () => {
			if (state !== "permission-confirm") return;
			state = "closed";
			lifecycle.onPermissionOverlayClosed();
		},
		appendNotice: (_level, text) => {
			notices.push(text);
		},
		applyApprovalState: () => {},
		requestRender: () => {},
		stopActiveTurn: (reason) => {
			stops.push(reason);
		},
		getUnattendedWindowMs: () => windowMs,
		unattendedTimers: clock.timers,
	});
	return {
		registry,
		lifecycle,
		clock,
		resolved,
		notices,
		stops,
		countdowns,
		state: () => state,
		cleanup: () => {
			lifecycle.dispose();
			process.chdir(originalCwd);
			rmSync(base, { recursive: true, force: true });
		},
	};
}

test("a card nobody answers denies its call after the window, and the turn continues (#421)", async () => {
	const f = unattendedFixture(5_000);
	try {
		const verdict = f.registry.invoke(OUTSIDE_WRITE, { turnId: "turn-1" });
		await tick();
		strictEqual(f.countdowns[0]?.(), 5_000);
		const card = plain(
			createPermissionOverlayBody(WRITE_VIEW, undefined, undefined, undefined, f.countdowns[0]).render(76),
		);
		match(
			card.join(" "),
			/No answer in 5 s denies this call and Clio continues without it\.\s+Any key\s+holds the card\./u,
		);
		f.clock.advance(5_000);
		const settled = await verdict;
		strictEqual(settled.kind, "blocked");
		if (settled.kind !== "blocked") return;
		strictEqual(settled.deniedPark, true);
		match(settled.reason, /did not answer this write approval within 5 s, so Clio denied it automatically/u);
		strictEqual(settled.denial?.allowedBy, UNATTENDED_ALLOWED_BY);
		deepStrictEqual(f.stops, [], "a timeout never stops the turn");
		strictEqual(f.state(), "closed");
		strictEqual(f.resolved[0]?.decidedBy, "unattended");
		match(f.notices.at(-1) ?? "", /No answer within 5 s: Clio denied write, which did not run/u);
		// Nobody can approve the identical call later in the turn, so it is refused without another wait.
		const repeat = await f.registry.invoke(OUTSIDE_WRITE, { turnId: "turn-1" });
		strictEqual(repeat.kind, "blocked");
		strictEqual(f.countdowns.length, 1, "the repeat never parked");
	} finally {
		f.cleanup();
	}
});

test("a key on the card holds its countdown, and a 0 window waits forever (#421)", async () => {
	for (const windowMs of [5_000, 0]) {
		const f = unattendedFixture(windowMs);
		try {
			let settled = false;
			const verdict = f.registry.invoke(OUTSIDE_WRITE, { turnId: "turn-1" });
			void verdict.then(() => {
				settled = true;
			});
			await tick();
			if (windowMs > 0) f.lifecycle.notePresence();
			strictEqual(f.countdowns[0]?.(), windowMs > 0 ? "held" : null, "no countdown left to run");
			f.clock.advance(600_000);
			await tick();
			strictEqual(settled, false, `${windowMs}: the card still waits for the operator`);
			strictEqual(f.resolved.length, 0);
			f.lifecycle.cancel();
			strictEqual((await verdict).kind, "blocked");
			strictEqual(f.resolved[0]?.decidedBy, "operator");
		} finally {
			f.cleanup();
		}
	}
});
