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
import { ClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { EXTENSIONS_EMPTY } from "../../src/interactive/overlays/extensions.js";
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
