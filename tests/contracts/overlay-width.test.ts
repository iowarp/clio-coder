/**
 * Overlays at the widths operators actually run.
 *
 * The 40/80/120 sweep found four surfaces that sized their text for one width
 * and let the frame hard-cut the rest: the permission overlay ended its safety
 * sentences mid-word and dropped a working key from its footer, the settings
 * overlay printed setting keys one character short with no marker, `/tasks` cut
 * its only remedy sentence, and `/view` gave its detail pane three columns.
 *
 * A cut with no marker is the defect: it presents a fragment as the whole
 * value. These cases assert that each surface either fits, wraps, or marks.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { formatContextActivityIslandLines } from "../../src/interactive/context-activity.js";
import {
	buildHint,
	ClioOverlayFrame,
	elideHint,
	FILTER_HINT,
	fitHintEntries,
	isCriticalHintKey,
} from "../../src/interactive/overlay-frame.js";
import { EXTENSIONS_EMPTY } from "../../src/interactive/overlays/extensions.js";
import { ModelOverlayView, type ModelRow } from "../../src/interactive/overlays/model-selector.js";
import { PROMPTS_EMPTY } from "../../src/interactive/overlays/prompts.js";
import { buildSettingItems, SETTINGS_SECTIONS, SettingsCenter } from "../../src/interactive/overlays/settings.js";
import {
	type ApprovalRequestView,
	createPermissionOverlayBody,
	PERMISSION_OVERLAY_WIDTH,
	permissionOverlayHint,
	permissionOverlayLines,
	permissionOverlayTitle,
} from "../../src/interactive/permission-overlay.js";
import { formatTasksOverlayBodyLines } from "../../src/interactive/tasks-overlay.js";
import { ViewOverlayView, viewFooterHint } from "../../src/interactive/view/view-overlay.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/** The release width matrix for a full-screen TUI surface. */
const WIDTHS = [40, 80, 120];

const LONG_COMMAND =
	'echo "The cost is context-dependent. In the CLIO ecosystem, operations are priced per token and the answer depends on the target"';

function approvalView(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
	return {
		requestId: "req-1",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "autonomy", level: "auto-edit" },
		origin: { kind: "main" },
		reason: "bash blocked: execute",
		target: LONG_COMMAND,
		...overrides,
	};
}

function permissionFrameLines(view: ApprovalRequestView, width: number): string[] {
	const frame = new ClioOverlayFrame(
		createPermissionOverlayBody(view),
		permissionOverlayTitle(),
		(innerWidth) => permissionOverlayHint(innerWidth),
		PERMISSION_OVERLAY_WIDTH,
		"center",
	);
	return frame.render(width).map(stripAnsi);
}

describe("contracts/overlay width — permission overlay", () => {
	it("keeps every body line inside the width it was given, at every width", () => {
		for (let width = 20; width <= 120; width += 1) {
			for (const line of permissionOverlayLines(approvalView(), width)) {
				ok(
					line.length <= width,
					`permission body line ran past ${width} columns (${line.length}): ${JSON.stringify(line)}`,
				);
			}
		}
	});

	it("wraps the safety sentences instead of cutting them mid-word", () => {
		for (const width of WIDTHS) {
			const body = permissionOverlayLines(approvalView(), width).join(" ").replace(/\s+/gu, " ");
			for (const sentence of [
				"Parked until you decide; allow or deny applies to this call only.",
				"Stopping the turn denies it and ends the run, so nothing asks again.",
				"Hard-blocked actions remain blocked.",
			]) {
				ok(body.includes(sentence), `at ${width} cols the overlay lost "${sentence}"`);
			}
		}
	});

	it("ellipsizes the command being authorized rather than hard-cutting it", () => {
		for (const width of WIDTHS) {
			const target = permissionOverlayLines(approvalView(), width).find((line) => line.startsWith("Target: "));
			ok(target, `no Target line at ${width} cols`);
			ok(
				(target ?? "").endsWith("…"),
				`at ${width} cols the Target line was cut without a marker: ${JSON.stringify(target)}`,
			);
			ok((target ?? "").length <= width);
		}
	});

	it("never hides the stop-turn key, whatever the width", () => {
		for (const width of WIDTHS) {
			const lines = permissionFrameLines(approvalView(), width);
			const footer = lines.at(-1) ?? "";
			ok(/\[s\] stop/u.test(footer), `at ${width} cols the footer hid the stop key: ${footer}`);
			ok(/\[Enter\] allow/u.test(footer), `at ${width} cols the footer hid the allow key: ${footer}`);
			for (const line of lines) {
				ok(visibleWidth(line) <= width, `frame ran past ${width} columns: ${JSON.stringify(line)}`);
			}
		}
	});

	it("shortens its own labels before dropping an action", () => {
		// 82 columns of box: everything fits, nothing is abbreviated.
		strictEqual(permissionOverlayHint(78), "[Enter] allow once · [s] stop turn · [Esc] close");
		// 40 columns of terminal: 38 inside the borders, where the full form does
		// not fit and the elider would have removed the middle entry.
		strictEqual(permissionOverlayHint(38), "[Enter] allow · [s] stop");
	});

	// This surface used to hand-write those three tiers because the generic
	// elider dropped by position. It now declares allow and stop critical and Esc
	// droppable, and the generic fitter reproduces the tiers. If the two ever
	// disagree again, this is the case that says so.
	it("expresses its tiers through the shared hint fitter, not a private ladder", () => {
		strictEqual(permissionOverlayHint(50), "[Enter] allow · [s] stop · [Esc] close");
		// Below every tier, the last thing standing is a safety action, not `close`.
		ok(/\[s\] stop/u.test(permissionOverlayHint(20)), permissionOverlayHint(20));
	});
});

/**
 * A narrow footer exists to answer "how do I commit this" and "how do I leave".
 * The old elider kept the first and last entry and spliced the middle, so it
 * kept `[↑↓] select`, which every terminal user can guess, and dropped
 * `[Enter] use`, which is the only way to act.
 */
describe("contracts/overlay width — hint elision keeps the keys that act", () => {
	const listHint = buildHint([{ key: "↑↓", verb: "select" }, FILTER_HINT, { key: "Enter", verb: "use" }]);

	it("drops guessable navigation before the commit key, at every narrowing step", () => {
		strictEqual(elideHint(listHint, 80), "[↑↓] select · [type] filter · [Enter] use · [Esc] close");
		strictEqual(elideHint(listHint, 45), "[type] filter · [Enter] use · [Esc] close");
		strictEqual(elideHint(listHint, 30), "[Enter] use · [Esc] close");
	});

	it("keeps Enter and Esc while anything is dropped at all", () => {
		for (let width = 26; width <= 60; width += 1) {
			const elided = elideHint(listHint, width);
			ok(elided.includes("[Enter]"), `at ${width} columns the commit key was dropped: ${elided}`);
			ok(elided.includes("[Esc]"), `at ${width} columns the way out was dropped: ${elided}`);
			ok(visibleWidth(elided) <= width || elided === "[Enter] use · [Esc] close", elided);
		}
	});

	it("classifies by key, so a surface may release a key the default protects", () => {
		ok(isCriticalHintKey("Enter"));
		ok(isCriticalHintKey("esc"));
		ok(!isCriticalHintKey("Tab"));
		strictEqual(
			fitHintEntries(
				[
					{ key: "Esc", verb: "close", critical: false },
					{ key: "s", verb: "stop", critical: true },
				],
				12,
			),
			"[s] stop",
		);
	});
});

/**
 * The in-flow context island is 40 columns wide on a narrow terminal, where its
 * phase trail and progress message both outrun the body. `padAnsi` defaults to
 * an empty marker, so both used to stop mid-word: `… › CLIO.md › sta`.
 */
describe("contracts/overlay width — context activity island", () => {
	const activity = {
		kind: "context-init" as const,
		phase: "codewiki" as const,
		status: "running" as const,
		message: "indexed 480 modules and refreshed project state",
		startedAtMs: 1000,
		updatedAtMs: 1500,
		completedAtMs: null,
		current: 240,
		total: 480,
		detail: "src/domains/context/bootstrap.ts",
	};

	/** The body rows, stripped of the `│ ` gutters the frame adds on each side. */
	function islandBody(width: number): string[] {
		return formatContextActivityIslandLines(activity, width, 2000, 1)
			.slice(1, -1)
			.map((line) => stripAnsi(line).slice(2, -2).trimEnd());
	}

	it("marks every row it cuts, and spans exactly the width it was given", () => {
		for (const width of WIDTHS) {
			for (const line of formatContextActivityIslandLines(activity, width, 2000, 1)) {
				strictEqual(visibleWidth(line), width, `island line did not span ${width}: ${JSON.stringify(stripAnsi(line))}`);
			}
			for (const row of islandBody(width)) {
				// A row either fits inside the body or says that it does not.
				ok(
					row.length < width - 4 || row.endsWith("…"),
					`at ${width} cols a row filled the body with no cut marker: ${JSON.stringify(row)}`,
				);
			}
		}
	});

	it("cuts the narrow trail and message with a marker rather than mid-word", () => {
		const body = islandBody(40);
		const trail = body.find((row) => row.startsWith("scan"));
		const message = body.find((row) => row.startsWith("indexed 480"));
		ok(trail?.endsWith("…"), `the phase trail was cut without a marker: ${JSON.stringify(trail)}`);
		ok(message?.endsWith("…"), `the message was cut without a marker: ${JSON.stringify(message)}`);
		// At 80 the same rows fit whole, so the marker is a statement about width.
		ok(
			islandBody(80).some((row) => row.endsWith("state")),
			islandBody(80).join("\n"),
		);
	});
});

/**
 * A dotted lowercase identifier in this overlay is a settings.yaml key. If one
 * is rendered short of its real name with no marker, the panel has published a
 * key that does not exist.
 */
const DOTTED_IDENTIFIER = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u;

function settingsCenter(bodyHeight: number): SettingsCenter {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.autonomy = "auto-edit";
	return new SettingsCenter(buildSettingItems(settings), {
		getBodyHeight: () => bodyHeight,
		onCommit: () => undefined,
		onCancel: () => undefined,
	});
}

describe("contracts/overlay width — settings overlay", () => {
	const configPaths = new Set<string>(
		buildSettingItems(structuredClone(DEFAULT_SETTINGS)).map((item) => item.configPath),
	);

	it("never prints a setting key short of its real name without a marker", () => {
		for (const width of WIDTHS) {
			const center = settingsCenter(24);
			for (const section of SETTINGS_SECTIONS) {
				center.setSelection(section.id, 0);
				const rendered = stripAnsi(center.render(width).join("\n"));
				for (const word of rendered.split(/\s+/u)) {
					if (!DOTTED_IDENTIFIER.test(word)) continue;
					ok(
						configPaths.has(word),
						`at ${width} cols the ${section.id} section printed "${word}", which is no settings key`,
					);
				}
			}
		}
	});

	it("marks a truncated label rather than presenting the fragment as the label", () => {
		// 40 columns drops the key column and squeezes labels; whatever survives
		// must say that it was squeezed.
		const rendered = stripAnsi(settingsCenter(20).render(40).join("\n"));
		ok(rendered.includes("…"), `nothing marked as cut at 40 columns:\n${rendered}`);
	});

	/**
	 * Section 2.6's width ladder for this surface: one column at 40, categories
	 * and settings at 80, and the live description as its own third column at
	 * 120. The description used to be a footer strip at every width, which spent
	 * six rows of height while forty columns sat empty beside the settings rows.
	 */
	it("gives the description its own column at 120 and not below", () => {
		const center = settingsCenter(16);
		center.setSelection("safety", 0, "rows");
		const dividersAt = (width: number): number =>
			Math.max(...center.render(width).map((line) => (stripAnsi(line).match(/│/gu) ?? []).length));
		strictEqual(dividersAt(120), 2, "120 columns lays out three lanes");
		strictEqual(dividersAt(100), 1, "100 columns keeps two lanes and the footer");
		strictEqual(dividersAt(40), 0, "40 columns stays a single stacked column");
	});

	it("keeps the selected setting's meaning and its scope note visible at 120", () => {
		const center = settingsCenter(16);
		center.setSelection("safety", 0, "rows");
		const flat = stripAnsi(center.render(120).join(" ")).replace(/\s+/gu, " ");
		ok(flat.includes("Autonomy level"), flat);
		ok(flat.includes("How freely Clio acts"), `the description column lost the explanation: ${flat}`);
		ok(flat.includes("Enter applies to this session now"), `the description column lost the scope note: ${flat}`);
	});

	it("marks the description column when the explanation outruns the height", () => {
		const center = settingsCenter(12);
		center.setSelection("safety", 0, "rows");
		const rendered = stripAnsi(center.render(120).join("\n"));
		ok(rendered.includes("…"), `nothing marked as cut in a short 3-column pane:\n${rendered}`);
		// The marker belongs on a line that carries text, never alone on a spacer.
		for (const line of rendered.split("\n")) {
			const cell = line.split("│").at(-1)?.trim() ?? "";
			ok(cell !== "…", `the cut marker landed on an empty row: ${JSON.stringify(line)}`);
		}
	});

	it("marks the explanation pane when it does not fit", () => {
		const center = settingsCenter(20);
		center.setSelection("safety", 0);
		const flat = stripAnsi(center.render(40).join(" ")).replace(/\s+/gu, " ");
		const help =
			"read-only observes; suggest parks non-read calls; auto-edit edits, dispatches, and runs recognized commands; full-auto runs except command substitution and system-level changes.";
		if (flat.includes(help)) return;
		const shown = flat.slice(flat.indexOf("read-only observes"));
		ok(shown.includes("…"), `the explanation stopped without a marker: ${JSON.stringify(shown.slice(0, 120))}`);
	});
});

describe("contracts/overlay width — /tasks empty state", () => {
	it("wraps the remedy sentence instead of cutting it, at every width", () => {
		const remedy = 'The agent declares one with the tasks tool (action="plan") before multi-step work.';
		for (const width of WIDTHS) {
			// The overlay is 88 columns wide, so its body gets width - 4 up to 84.
			const bodyWidth = Math.min(84, width - 4);
			const lines = formatTasksOverlayBodyLines(null, bodyWidth).map(stripAnsi);
			for (const line of lines) {
				ok(visibleWidth(line) <= bodyWidth, `at ${width} cols a line ran past the body: ${JSON.stringify(line)}`);
			}
			const flat = lines.join(" ").replace(/\s+/gu, " ").trim();
			ok(flat.includes("No task board declared in this session."), `at ${width} cols the statement was cut: ${flat}`);
			ok(flat.includes(remedy), `at ${width} cols the remedy was cut: ${flat}`);
		}
	});
});

describe("contracts/overlay width — /view panes", () => {
	function view(): ViewOverlayView {
		return new ViewOverlayView({
			providers: [
				{
					category: "accountability",
					list: async () => [
						{
							id: "acc-1",
							category: "accountability" as const,
							title: "Session accountability",
							timestamp: 1,
							sizeBytes: 10,
							load: async () => ({ lines: ["Accountability", "first-pass success: 0/0 (0%)"], format: "text" as const }),
						},
					],
				},
			],
			getBodyHeight: () => 12,
			onClose() {},
			requestRender() {},
		});
	}

	it("keeps two panes at 80 and 120 and drops to one at 40", async () => {
		const overlay = view();
		overlay.refresh();
		await new Promise((resolve) => setImmediate(resolve));

		for (const bodyWidth of [76, 116]) {
			const lines = stripAnsi(overlay.render(bodyWidth).join("\n"));
			ok(lines.includes("│"), `at ${bodyWidth} columns the two-pane divider must stay`);
		}
		const narrow = stripAnsi(overlay.render(36).join("\n"));
		ok(!narrow.includes("│"), `at 36 columns the detail pane had 3 characters:\n${narrow}`);
		ok(narrow.includes("Session accountability"), narrow);
		for (const line of overlay.render(36)) {
			ok(visibleWidth(stripAnsi(line)) <= 36, `single pane ran past 36 columns: ${JSON.stringify(line)}`);
		}
	});

	it("names the key that reaches the other pane while only one is shown", () => {
		// 40 columns of terminal is 38 inside the frame's borders.
		ok(viewFooterHint("list", false, 38).includes("[Tab] detail"));
		ok(viewFooterHint("content", false, 38).includes("[Tab] list"));
		// Wide stays exactly as it was.
		strictEqual(viewFooterHint("list", false, 118), viewFooterHint("list", false));
	});
});

/**
 * Esc unwinds one step per press. Every other list overlay clears a typed
 * filter first and closes on the second press; `/models` closed on the first,
 * so narrowing to one model and reaching for Esc threw away the whole overlay.
 */
describe("contracts/overlay — model selector Esc hierarchy", () => {
	function modelRow(model: string): ModelRow {
		return {
			value: `mini/${model}`,
			target: "mini",
			model,
			runtimeName: "ollama",
			runtimeShortName: "ollama",
			runtimeId: "ollama",
			apiFamily: "openai",
			bucket: "local",
			source: "live",
			authText: "ok",
			available: true,
			reason: "",
			healthGlyph: " ",
			healthText: "healthy",
			caps: {} as ModelRow["caps"],
			badges: "",
			context: "262k",
			maxTokens: "16k",
			active: false,
			scoped: false,
			selectable: true,
			visibleByDefault: true,
		} as ModelRow;
	}

	function view(closes: string[]): ModelOverlayView {
		return new ModelOverlayView(
			[modelRow("qwen3.6-35b"), modelRow("deepseek-r1-14b")],
			{ totalModels: 2, targets: 1, localModels: 2, cloudModels: 0, activeRef: "mini/qwen3.6-35b" },
			() => closes.push("select"),
			undefined,
			() => closes.push("close"),
			{ requestRender: () => {} },
		);
	}

	const ESC_KEY = String.fromCharCode(27);

	it("clears an active filter on the first Esc and closes on the second", () => {
		const closes: string[] = [];
		const overlay = view(closes);
		// The overlay takes one keypress at a time, so a typed filter is four calls.
		for (const character of "qwen") overlay.handleInput(character);
		ok(stripAnsi(overlay.render(82).join("\n")).includes("qwen"), "the filter should be showing");

		overlay.handleInput(ESC_KEY);
		strictEqual(closes.length, 0, "the first Esc cleared the filter and must not close the overlay");
		ok(!stripAnsi(overlay.render(82).join("\n")).includes("> qwen"), "the filter should be gone");

		overlay.handleInput(ESC_KEY);
		strictEqual(closes.at(-1), "close", "the second Esc closes");
	});

	it("closes on the first Esc when no filter was typed", () => {
		const closes: string[] = [];
		view(closes).handleInput(ESC_KEY);
		strictEqual(closes.at(-1), "close");
	});
});

/**
 * The CLI's empty states all name the command that fills them
 * ("no targets configured. run `clio configure` ..."), and so do the TUI's
 * `/tasks` and Fleet Runs overlays. `/prompts` and `/extensions` just said no.
 */
describe("contracts/empty states name the next step", () => {
	for (const [surface, message] of [
		["/prompts", PROMPTS_EMPTY],
		["/extensions", EXTENSIONS_EMPTY],
	] as const) {
		it(`${surface} names how to make one exist`, () => {
			ok(/^[a-z]/.test(message), `${surface} empty state opens in the product's voice: ${message}`);
			ok(message.length > 40, `${surface} empty state says more than "none": ${message}`);
			ok(/\.clio\/|clio [a-z]+ [a-z]+/.test(message), `${surface} empty state names a command or a path: ${message}`);
		});
	}
});
