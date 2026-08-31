/**
 * Clio's on-screen chrome is a machine-readable interface, not only a human one.
 *
 * herdr, the terminal multiplexer, decides whether a Clio pane is idle, working,
 * or blocked on a human by matching literal strings and regular expressions
 * against the last few non-empty rows of the pane. It has no IPC channel into
 * Clio and no structured status feed. The screen IS the protocol, so a reskin of
 * the composer rail, a footer pill, or an overlay title silently breaks herdr's
 * lifecycle detection: a pane parked on a permission prompt reads as idle, and a
 * controller waiting for a turn to finish wakes into the middle of one.
 *
 * This file is Clio's half of that cross-product contract. It pins every string
 * and shape the herdr detection manifest matches, driven through the narrowest
 * render helper each string actually flows out of, so a rename fails here rather
 * than in herdr's runtime. The manifest is the other half:
 *
 *   repo:  ~/tools/herdr (branch clio-coder-agent)
 *   path:  src/detect/manifests/clio-coder.toml
 *   id:    clio-coder
 *   ver:   2026.08.30.1
 *
 * Changing any pinned string here is allowed. It is not allowed unilaterally:
 * bump the manifest in the same change set, raise its `version`, and land both
 * sides together. History for the pairing lives in
 * `.superpowers/reports/herdr-pr-upgrade.md`.
 *
 * Where a manifest expectation could not be grounded in current Clio source, the
 * test pins what Clio actually renders and says so in the assertion message.
 * Those cases are latent detection bugs on the herdr side and are catalogued in
 * `.superpowers/reports/tuipin.md`.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyDecisionPresentation,
	decisionFactsForAnswer,
} from "../../src/domains/safety/decision-presentation.js";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "../../src/engine/tui.js";
import { ClioEditor, type EditorChrome } from "../../src/interactive/clio-editor.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { buildHarnessStatePill } from "../../src/interactive/footer/widgets.js";
import {
	ASK_USER_DECISION_TITLE,
	ASK_USER_WAITING_TITLE,
	openAskUserOverlay,
} from "../../src/interactive/overlays/ask-user.js";
import { permissionOverlayHint, permissionOverlayTitle } from "../../src/interactive/permission-overlay.js";
import type { AgentStatus } from "../../src/interactive/status/types.js";
import { resolveFooterVerb, resolveInlineVerb } from "../../src/interactive/status/verbs.js";
import { clioTheme, SPINNER_FRAMES, spinnerFrame } from "../../src/interactive/theme/index.js";

const HERDR_MANIFEST = "~/tools/herdr/src/detect/manifests/clio-coder.toml";
const HERDR_MANIFEST_VERSION = "2026.08.30.1";

/**
 * Every assertion in this file fails through here, so no failure can reach a
 * reader without the manifest path, its version, and the coordination rule.
 */
function contract(ruleId: string, detail: string): string {
	return [
		`herdr detection-manifest contract broken: rule \`${ruleId}\``,
		detail,
		`manifest: ${HERDR_MANIFEST} (id clio-coder, version ${HERDR_MANIFEST_VERSION})`,
		"herdr matches these strings on screen; it has no other channel into Clio.",
		"Changing this string requires a coordinated herdr manifest update in the same change set: edit the rule, bump the manifest version, and land both repos together.",
	].join("\n  ");
}

function matches(ruleId: string, pattern: RegExp, actual: string, what: string): void {
	ok(
		pattern.test(actual),
		contract(ruleId, `${what} no longer matches ${String(pattern)}; Clio rendered ${JSON.stringify(actual)}`),
	);
}

function pinned(ruleId: string, expected: string, actual: string, what: string): void {
	strictEqual(
		actual,
		expected,
		contract(ruleId, `${what} moved from ${JSON.stringify(expected)} to ${JSON.stringify(actual)}`),
	);
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu");
const CURSOR_MARKER = "\x1b_pi:c\x07";
const plain = (line: string): string => line.replace(ANSI, "").replaceAll(CURSOR_MARKER, "");

const BRAILLE = "[\\u2800-\\u28FF]";

const IDLE_STATUS: AgentStatus = {
	phase: "idle",
	since: 1_000,
	lastMeaningfulAt: 1_000,
	watchdogTier: 0,
	watchdogPeak: 0,
	localRuntime: false,
};

function statusFor(phase: AgentStatus["phase"], overrides: Partial<AgentStatus> = {}): AgentStatus {
	return {
		...IDLE_STATUS,
		phase,
		tool: { toolName: "bash", toolPreview: "" },
		retry: { attempt: 1, maxAttempts: 3, waitMs: 0 },
		dispatch: { agentName: "scout" },
		...overrides,
	};
}

const NO_TOOLS = { tools: {}, errors: 0, active: 0 };
const NO_WORKERS: ReadonlyArray<DispatchBoardRow> = [];

function pill(status: AgentStatus, width = 100, tick = 0, now = 2_000): string {
	return plain(buildHarnessStatePill(clioTheme(), status, NO_TOOLS, NO_WORKERS, tick, now, width, false));
}

function inlineVerb(status: AgentStatus, cols = 120): string {
	return resolveInlineVerb(status, 2_000, cols, 2)?.text ?? "";
}

const EDITOR_CHROME: EditorChrome = {
	getModelLabel: () => "mini",
	getThinkingLabel: () => "off",
	isStreaming: () => false,
	willEnterSteer: (text) => text.trim().length > 0,
	getSubmitKeyLabel: () => "Enter",
	getNewlineKeyLabel: () => "Shift+Enter",
};

function composerLines(text = "", width = 80): string[] {
	const tui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as TUI;
	const editor = new ClioEditor(tui, EDITOR_CHROME);
	editor.onSubmit = () => {};
	editor.onChange = () => {};
	if (text.length > 0) editor.setText(text);
	return editor.render(width).map(plain);
}

/** The ask_user overlay mounted against a stub TUI, so its real frame renders without a PTY. */
function askUserOverlay(rows = 30, columns = 120) {
	let mounted: Component | null = null;
	let mountedOptions: OverlayOptions | undefined;
	const handle: OverlayHandle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	};
	const terminal = { rows, columns };
	const tui = {
		terminal,
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
			mounted = component;
			mountedOptions = options;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	const session = openAskUserOverlay(tui, { onCancel: () => {} });
	const frame = (): Component => {
		if (!mounted) throw new Error("ask-user overlay was not mounted");
		return mounted;
	};
	return {
		session,
		child: (): Component => (frame() as unknown as { child: Component }).child,
		// The engine evaluates `visible` in the pass that composites the overlay,
		// and that call is where the frame learns its row budget.
		renderFrame: (width = columns): string[] => {
			const component = frame();
			component.invalidate?.();
			mountedOptions?.visible?.(columns, terminal.rows);
			return component.render(width);
		},
	};
}

describe("contracts/herdr TUI detection strings", () => {
	// ── rule composer_message_mode_idle ────────────────────────────────────────
	// The composer's top rail is herdr's primary idle signal: `MESSAGE` exactly
	// when the chat loop is not streaming, relabelled FOLLOW-UP or STEER while it
	// is. The rule needs the rail AND one corroborating line from the same box.

	it("keeps the composer rail herdr reads as idle", () => {
		const lines = composerLines();
		const rail = lines[0] ?? "";

		matches("composer_message_mode_idle", /^MESSAGE ─/u, rail, "the idle composer rail");
		matches(
			"composer_message_mode_idle",
			/^MESSAGE ─+ .+ · \S+ ─*\s*$/u,
			rail,
			"the composer rail's `<model> · <thinking>` right label",
		);
	});

	it("keeps the composer placeholder and send hint herdr corroborates the rail with", () => {
		const lines = composerLines();

		// The manifest's `contains` terms are lowercased before matching.
		ok(
			lines.some((line) => line.toLowerCase().includes("ask clio")),
			contract(
				"composer_message_mode_idle",
				`no rendered composer row contains "ask clio"; Clio rendered ${JSON.stringify(lines)}`,
			),
		);
		ok(
			lines.some((line) => /\bsend\b.*\bnewline\b/u.test(line)),
			contract(
				"composer_message_mode_idle",
				`no rendered composer row matches /\\bsend\\b.*\\bnewline\\b/; Clio rendered ${JSON.stringify(lines)}`,
			),
		);
	});

	it("keeps the MESSAGE prefix on the scroll-indicator rail a tall draft produces", () => {
		const rail = composerLines(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"))[0] ?? "";

		matches("composer_message_mode_idle", /^MESSAGE ─/u, rail, "the scroll-indicator composer rail");
		// The manifest's second arm is `^MESSAGE [↑↓]`, which this rail has never
		// matched: `rule()` fills between the mode label and the indicator. The
		// first arm carries the rule, so detection holds; the dead arm is
		// catalogued in .superpowers/reports/tuipin.md.
		ok(
			/^MESSAGE ─+ [↑↓] \d+ more/u.test(rail),
			contract(
				"composer_message_mode_idle",
				`the scroll-indicator rail changed shape; Clio rendered ${JSON.stringify(rail)}`,
			),
		);
	});

	// ── rule footer_done_phase_idle ────────────────────────────────────────────

	it("keeps the ✓ done footer pill and verb herdr reads as idle", () => {
		pinned("footer_done_phase_idle", "✓ done", pill(statusFor("ended")), "the ended footer phase pill");

		const verb = resolveFooterVerb(
			statusFor("ended", { summary: { elapsedMs: 4_200 } as AgentStatus["summary"] }),
			2_000,
			100,
		);
		matches("footer_done_phase_idle", /✓ done(?:\s+·\s+\S.*)?\s*$/u, verb?.text ?? "", "the ended footer verb");
	});

	// ── rule footer_confirm_pill_blocked ───────────────────────────────────────

	it("keeps the ⏸ confirm footer pill herdr reads as blocked", () => {
		const confirm = pill(statusFor("tool_blocked"));

		pinned("footer_confirm_pill_blocked", "⏸ confirm", confirm, "the tool_blocked footer phase pill");
		matches("footer_confirm_pill_blocked", /⏸ confirm\s*$/u, confirm, "the tool_blocked footer phase pill");
	});

	// ── rule footer_phase_pill_working ─────────────────────────────────────────
	// Live phases lead with a braille spinner frame; the label set is closed and
	// the manifest enumerates it.

	it("keeps every live footer phase pill inside the spinner-plus-label form", () => {
		const expected: ReadonlyArray<[AgentStatus["phase"], string]> = [
			["preparing", "prep"],
			["waiting_model", "waiting"],
			["thinking", "thinking"],
			["writing", "writing"],
			["compacting", "compacting"],
			["dispatching", "dispatch"],
			["tool_running", "tool bash"],
		];
		const pattern = new RegExp(
			`${BRAILLE} (prep|waiting|thinking|writing|compacting|dispatch|tool( .+)?)(\\s+·\\s+\\S.*)?\\s*$`,
			"u",
		);

		for (const [phase, label] of expected) {
			const rendered = pill(statusFor(phase));
			pinned("footer_phase_pill_working", `${spinnerFrame(0)} ${label}`, rendered, `the ${phase} footer phase pill`);
			matches("footer_phase_pill_working", pattern, rendered, `the ${phase} footer phase pill`);
		}
	});

	it("keeps every spinner frame inside the braille block herdr matches", () => {
		for (const frame of SPINNER_FRAMES) {
			matches("footer_phase_pill_working", new RegExp(`^${BRAILLE}$`, "u"), frame, `spinner frame ${frame}`);
		}
	});

	// ── rule footer_static_phase_pill_working ──────────────────────────────────
	// Retry and watchdog-stuck stay live turns but hold a static glyph, so a
	// controller waiting for idle must not be woken by them.

	it("keeps the ↻ retry and ⚠ stuck pills herdr still reads as working", () => {
		const retry = pill(statusFor("retrying"));
		pinned("footer_static_phase_pill_working", "↻ retry 1/3", retry, "the retrying footer phase pill");
		matches("footer_static_phase_pill_working", /↻ retry \d+\/\d+(\s+·\s+\S.*)?\s*$/u, retry, "the retrying pill");

		const stuck = pill(statusFor("stuck"));
		pinned("footer_static_phase_pill_working", "⚠ stuck 1s", stuck, "the stuck footer phase pill");
		matches("footer_static_phase_pill_working", /⚠ stuck( \d+s)?(\s+·\s+\S.*)?\s*$/u, stuck, "the stuck pill");
	});

	it("keeps the inline `Stuck for …` sentence herdr still reads as working", () => {
		matches(
			"footer_static_phase_pill_working",
			/^\s*Stuck for \S+\./u,
			inlineVerb(statusFor("stuck")),
			"the stuck inline status sentence",
		);
	});

	// ── rule inline_status_working ─────────────────────────────────────────────
	// The transcript's inline status line is `<braille spinner> <Verb> · <elapsed>`.
	// resolveInlineVerb returns the verb; interactive-event-projection.ts prefixes
	// the spinner frame, which is why the pinned forms below start at the verb.

	it("keeps the inline working verbs herdr reads as a live turn", () => {
		const cases: ReadonlyArray<[string, AgentStatus, string]> = [
			["preparing", statusFor("preparing"), "Preparing harness"],
			["waiting_model", statusFor("waiting_model"), "Waiting on model"],
			["waiting_model (local)", statusFor("waiting_model", { localRuntime: true }), "Waiting on local model"],
			["thinking", statusFor("thinking"), "Receiving thinking"],
			["writing", statusFor("writing"), "Streaming response"],
			["tool_running", statusFor("tool_running"), "Running tool: bash"],
			["retrying", statusFor("retrying"), "Retrying 1/3"],
			["compacting", statusFor("compacting"), "Compacting context"],
			["dispatching", statusFor("dispatching"), "Dispatching agent: scout"],
			["dispatching (tier 2)", statusFor("dispatching", { watchdogTier: 2 }), "Awaiting agent result: scout"],
		];
		const pattern = new RegExp(
			`^\\s*${BRAILLE} (Still )?(Preparing harness|Waiting on (local )?model|Receiving thinking|Streaming response|Running tool: |Retrying |Compacting context|Dispatching agent|Awaiting agent result)`,
			"u",
		);

		for (const [name, status, head] of cases) {
			const verb = inlineVerb(status);
			ok(
				verb.startsWith(head),
				contract(
					"inline_status_working",
					`the ${name} inline verb no longer starts with ${JSON.stringify(head)}; Clio rendered ${JSON.stringify(verb)}`,
				),
			);
			// Reconstruct the whole rendered row, spinner included, and run the
			// manifest's own regex over it.
			matches("inline_status_working", pattern, `  ${spinnerFrame(0)} ${verb}`, `the ${name} inline status row`);
		}
	});

	/**
	 * The manifest spells the watchdog escalation as `(Still )?` in front of a
	 * capitalised verb, but Clio builds the verb lowercase and uppercases only the
	 * first character, so the escalated forms read `Still preparing harness`, not
	 * `Still Preparing harness`. The manifest regex cannot match any of them.
	 *
	 * They are pinned here anyway: they are what a herdr manifest fix will have to
	 * match, and a reskin must not move them out from under that fix. See
	 * .superpowers/reports/tuipin.md.
	 */
	it("pins the escalated `Still …` inline verbs the manifest regex cannot yet match", () => {
		const escalated: ReadonlyArray<[AgentStatus["phase"], Partial<AgentStatus>, string]> = [
			["preparing", {}, "Still preparing harness"],
			["waiting_model", {}, "Still waiting on model"],
			["waiting_model", { localRuntime: true }, "Still waiting on model"],
			["thinking", {}, "Still receiving thinking"],
			["tool_running", {}, "Still running tool: bash"],
		];

		for (const [phase, overrides, head] of escalated) {
			const verb = inlineVerb(statusFor(phase, { watchdogTier: 2, ...overrides }));
			ok(
				verb.startsWith(head),
				contract(
					"inline_status_working",
					`the watchdog-escalated ${phase} inline verb no longer starts with ${JSON.stringify(head)}; Clio rendered ${JSON.stringify(verb)}. The manifest's \`(Still )?\` arm already fails to match this form, so moving it compounds an open detection gap.`,
				),
			);
		}
	});

	// ── rule inline_awaiting_confirmation_blocked ──────────────────────────────

	it("keeps `Awaiting confirmation` as the parked-call inline verb", () => {
		const verb = inlineVerb(statusFor("tool_blocked"));

		pinned("inline_awaiting_confirmation_blocked", "Awaiting confirmation", verb, "the tool_blocked inline verb");
		matches(
			"inline_awaiting_confirmation_blocked",
			new RegExp(`^\\s*${BRAILLE}?\\s*Awaiting confirmation\\b`, "u"),
			`  ${spinnerFrame(0)} ${verb}`,
			"the tool_blocked inline status row",
		);
	});

	// ── rule inline_ask_user_blocked ───────────────────────────────────────────

	it("keeps `Waiting for user input` as the ask_user inline verb", () => {
		const verb = inlineVerb(statusFor("tool_running", { tool: { toolName: "ask_user", toolPreview: "" } }));

		ok(
			verb.startsWith("Waiting for user input"),
			contract(
				"inline_ask_user_blocked",
				`the ask_user inline verb no longer starts with "Waiting for user input"; Clio rendered ${JSON.stringify(verb)}`,
			),
		);
		matches(
			"inline_ask_user_blocked",
			new RegExp(`^\\s*${BRAILLE}?\\s*Waiting for user input\\b`, "u"),
			`  ${spinnerFrame(0)} ${verb}`,
			"the ask_user inline status row",
		);
	});

	it("keeps both widths of the ask_user footer pill label", () => {
		const askStatus = statusFor("tool_running", { tool: { toolName: "ask_user", toolPreview: "" } });
		const wide = pill(askStatus, 100);
		const narrow = pill(askStatus, 64);

		pinned("inline_ask_user_blocked", `${spinnerFrame(0)} waiting for user`, wide, "the wide ask_user footer pill");
		pinned("inline_ask_user_blocked", `${spinnerFrame(0)} ask`, narrow, "the narrow ask_user footer pill");
		matches(
			"inline_ask_user_blocked",
			/[\u2800-\u28FF\u2699] waiting for user\s*$/u,
			wide,
			"the wide ask_user footer pill",
		);
		matches("inline_ask_user_blocked", /[\u2800-\u28FF\u2699] ask\s*$/u, narrow, "the narrow ask_user footer pill");
	});

	// ── rule permission_overlay_blocked ────────────────────────────────────────
	// The keys survive at every width because fitHintEntries shortens labels
	// before it drops entries, and allow and stop are marked critical.

	it("keeps `[Enter] allow` and `[s] stop` on the permission hint at every width", () => {
		for (const width of [78, 60, 48, 44, 40]) {
			const hint = permissionOverlayHint(width);
			matches("permission_overlay_blocked", /\[Enter\] allow/u, hint, `the permission hint at ${width} columns`);
			matches("permission_overlay_blocked", /\[s\] stop/u, hint, `the permission hint at ${width} columns`);
		}
	});

	/**
	 * The manifest gates this rule on `contains = ["allow this action once?"]`,
	 * which was the permission overlay's title before decision classification
	 * landed. No Clio surface renders that phrase now, so the rule cannot fire and
	 * a parked call is detected only through the `⏸ confirm` footer pill.
	 *
	 * The classified titles are pinned instead: they are what a manifest fix must
	 * match, and moving them again would widen the gap.
	 */
	it("pins the classified permission titles the manifest's `allow this action once?` no longer covers", () => {
		const base = { requestId: "r", reason: "r", origin: { kind: "main" as const } };
		const cases: ReadonlyArray<[string, Parameters<typeof permissionOverlayTitle>[0], string]> = [
			[
				"safety net",
				{ ...base, tool: "bash", actionClass: "execute", axis: { kind: "net", ruleId: "x" } },
				"Safety-net confirmation",
			],
			[
				"autonomy",
				{ ...base, tool: "write", actionClass: "write", axis: { kind: "autonomy", level: "standard" } },
				"Approve workspace action",
			],
			[
				"system change",
				{ ...base, tool: "bash", actionClass: "system_modify", axis: { kind: "autonomy", level: "standard" } },
				"Approve system change",
			],
			[
				"worker escalation",
				{
					...base,
					tool: "write",
					actionClass: "write",
					axis: { kind: "autonomy", level: "standard" },
					origin: { kind: "worker", agentId: "a", runId: "r" },
				},
				"Worker needs approval",
			],
		];

		for (const [name, view, expected] of cases) {
			strictEqual(
				permissionOverlayTitle(view),
				expected,
				contract(
					"permission_overlay_blocked",
					`the ${name} permission overlay title moved off ${JSON.stringify(expected)}. The manifest still gates on the retired literal "allow this action once?", so this rule already cannot fire; moving the replacement title compounds an open detection gap.`,
				),
			);
		}
	});

	// ── rule ask_user_overlay_blocked ──────────────────────────────────────────

	it("keeps `Ask User` as a framed overlay header in the shape herdr matches", () => {
		pinned("ask_user_overlay_blocked", "Ask User", ASK_USER_WAITING_TITLE, "the ask_user waiting overlay title");

		const overlay = askUserOverlay();
		const border = plain(overlay.renderFrame()[0] ?? "");
		overlay.session.cancel();

		matches("ask_user_overlay_blocked", /^\s*┌─ Ask User(\s|─)/u, border, "the ask_user overlay top border");
	});

	it("keeps `[Space] toggle` and `[Esc] close` on the ask_user footer herdr corroborates the header with", async () => {
		const overlay = askUserOverlay();
		const pending = overlay.session.ask([
			{
				question: "Which checks should run before commit?",
				multi_select: true,
				options: [{ label: "Targeted contracts" }, { label: "Full suite" }],
			},
		]);
		let hint = "";
		try {
			hint = (overlay.child() as unknown as { footerHint: () => string }).footerHint();
		} finally {
			overlay.session.cancel();
			await pending;
		}

		matches("ask_user_overlay_blocked", /\[Space\] toggle/u, hint, "the multi-select ask_user footer hint");
		matches("ask_user_overlay_blocked", /\[Esc\] (close|back)/u, hint, "the ask_user footer hint");
		// The manifest's third arm, `[Enter] (submit|accept)`, has never matched
		// ask_user: the Enter verb is the classified `record answer` label. The two
		// arms above carry the rule. Pinned so a rename cannot take both at once.
		pinned(
			"ask_user_overlay_blocked",
			"[Space] toggle · [t] add text · [Enter] record answer · [Esc] close",
			hint,
			"the multi-select ask_user footer hint",
		);
	});

	/**
	 * The manifest's other header arm is `Decision required`, which no Clio
	 * surface renders. A pending ask_user decision swaps the frame title for the
	 * classified decision title, so the state herdr most wants to catch is the one
	 * arm that cannot match. `Ask User` shows only while no decision is pending.
	 */
	it("pins the classified ask_user decision title the manifest's `Decision required` no longer covers", () => {
		strictEqual(
			ASK_USER_DECISION_TITLE,
			"Answer a question",
			contract(
				"ask_user_overlay_blocked",
				`the default ask_user decision title moved off "Answer a question". The manifest still matches the retired header "Decision required", so a pending decision is not detected through this rule at all; moving the replacement title compounds an open detection gap.`,
			),
		);
		strictEqual(
			classifyDecisionPresentation(decisionFactsForAnswer("local")).title,
			ASK_USER_DECISION_TITLE,
			contract("ask_user_overlay_blocked", "the ask_user overlay stopped taking its title from the decision classifier"),
		);
	});
});
