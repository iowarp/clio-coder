import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryRecord, TaskMemoryOperatorStatus } from "../../src/domains/memory/index.js";
import { TaskMemoryBank, taskMemoryBankSize } from "../../src/domains/memory/index.js";
import { type Component, type OverlayHandle, type TUI, visibleWidth } from "../../src/engine/tui.js";
import {
	buildMemoryOverlayItems,
	formatMemoryStatusLine,
	MemoryOverlayView,
	openMemoryOverlay,
} from "../../src/interactive/memory-overlay.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { withTimeZone } from "../harness/clock.js";

const ESC = "\x1b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(SGR, "");
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const TAB = "\t";

function operatorStatus(): TaskMemoryOperatorStatus {
	const bank = new TaskMemoryBank({ now: () => new Date("2026-07-13T00:00:00.000Z") });
	bank.updateStatus("Inspect operator visibility.");
	const knowledge = bank.saveKnowledge("The active branch is feat/fleet-dispatch.");
	bank.saveProcedural("Do not retry a failed command without changing its inputs.");
	bank.recordInjection([knowledge.id]);
	const snapshot = bank.snapshot();
	return {
		enabled: true,
		tier: "llm",
		size: taskMemoryBankSize(snapshot),
		lastDecision: "injected",
		activity: [],
		stepInFlight: false,
		bank: snapshot,
	};
}

/** A bank far taller than any terminal, which is the shape the static dump could not reach. */
function largeBankStatus(entryCount: number): TaskMemoryOperatorStatus {
	const bank = new TaskMemoryBank({
		now: () => new Date("2026-07-13T00:00:00.000Z"),
		knowledgeCap: entryCount,
		proceduralCap: entryCount,
	});
	bank.updateStatus("Inspect operator visibility.");
	for (let index = 0; index < entryCount; index += 1) {
		bank.saveKnowledge(`marker-${index}`);
	}
	const snapshot = bank.snapshot();
	return {
		enabled: true,
		tier: "rules",
		size: taskMemoryBankSize(snapshot),
		lastDecision: "silent",
		activity: [],
		stepInFlight: false,
		bank: snapshot,
	};
}

function durableRecord(approved: boolean): MemoryRecord {
	return {
		id: approved ? "mem-approved" : "mem-proposed",
		scope: "global",
		key: approved ? "verified-build" : "unverified-build",
		lesson: approved ? "Run typecheck before handoff." : "Skip verification.",
		evidenceRefs: ["ev-1"],
		appliesWhen: [],
		avoidWhen: [],
		confidence: 0.9,
		createdAt: "2026-07-13T00:00:00.000Z",
		approved,
	};
}

function overlayHandle(onHide: () => void = () => {}): OverlayHandle {
	let hidden = false;
	return {
		hide(): void {
			hidden = true;
			onHide();
		},
		setHidden(next: boolean): void {
			hidden = next;
		},
		isHidden: () => hidden,
		focus: () => undefined,
		unfocus: () => undefined,
		isFocused: () => true,
	};
}

function view(
	getStatus: () => TaskMemoryOperatorStatus,
	getRecords: () => ReadonlyArray<MemoryRecord> = () => [],
	onClose: () => void = () => {},
): MemoryOverlayView {
	return new MemoryOverlayView(getStatus, getRecords, onClose, () => {});
}

/** The label of the row the cursor is on, without styling, columns, or padding. */
function selectedLabel(lines: ReadonlyArray<string>): string {
	const row = stripAnsi(lines.find((line) => stripAnsi(line).includes(GLYPH.cursor)) ?? "");
	const body = row.slice(row.indexOf(GLYPH.cursor) + GLYPH.cursor.length);
	return (body.split("│")[0] ?? "").trim();
}

describe("contracts/memory overlay", () => {
	it("groups approved lessons, bank entries, and steps into one selectable list", () => {
		const status: TaskMemoryOperatorStatus = {
			...operatorStatus(),
			activity: [
				{
					at: "2026-07-13T09:41:07.000Z",
					triggerReasons: ["interval"],
					tier: "llm",
					decision: "gated",
					reason: "uncited",
					citedEntries: 0,
					bankWrites: 2,
					latencyMs: 41_200,
				},
			],
		};
		const items = withTimeZone("UTC", () => buildMemoryOverlayItems(status, [durableRecord(true), durableRecord(false)]));
		const plain = items.map((item) => ({
			id: item.id,
			group: stripAnsi(item.group ?? ""),
			label: stripAnsi(item.label),
			meta: stripAnsi(item.meta ?? ""),
		}));

		// A rejected or unapproved record is not a lesson Clio holds.
		ok(
			plain.some((item) => item.id === "lesson:mem-approved"),
			JSON.stringify(plain),
		);
		ok(!plain.some((item) => item.id === "lesson:mem-proposed"), JSON.stringify(plain));

		// Group headers carry the counts the static dump printed as section titles.
		const groups = [...new Set(plain.map((item) => item.group))];
		deepStrictEqual(groups, ["approved lessons (1)", "task bank (3)", "recent steps (1)"]);

		const bank = plain.filter((item) => item.group.startsWith("task bank"));
		strictEqual(bank.length, 3);
		ok(
			bank.some((item) => item.meta.includes("status (private)")),
			JSON.stringify(bank),
		);
		ok(
			bank.some((item) => item.meta.includes("knowledge") && item.meta.includes("injected 1")),
			JSON.stringify(bank),
		);
		ok(
			bank.some((item) => item.meta.includes("procedural") && item.meta.includes("injected 0")),
			JSON.stringify(bank),
		);

		// A gated step wrote to the bank and said nothing; without this row the
		// operator would see an unchanged transcript and assume memory was idle.
		const step = plain.find((item) => item.group.startsWith("recent steps"));
		ok(step?.label.includes("09:41:07"), JSON.stringify(step));
		ok(step?.label.includes("interval gated uncited 2w"), JSON.stringify(step));
		ok(step?.meta.includes("llm 41200ms"), JSON.stringify(step));

		// Every row carries a detail pane; a row with no detail is a dead end.
		ok(
			items.every((item) => typeof item.detail === "function"),
			"every row must open a detail pane",
		);
	});

	it("keeps the status line above the list and fits every row to the overlay width", () => {
		for (const width of [96, 84, 48, 30]) {
			const lines = view(operatorStatus, () => [durableRecord(true)]).render(width);
			const header = stripAnsi(lines[0] ?? "");
			ok(header.includes("memory on"), `width ${width}: ${header}`);
			// The header narrows by dropping whole units with an ellipsis marker; it
			// never disappears and never leaves a half-written one behind.
			ok(width < 48 || header.includes("bank 3"), `width ${width}: ${header}`);
			for (const line of lines) ok(visibleWidth(line) <= width, `width ${width}: ${stripAnsi(line)}`);
		}
	});

	it("reaches every bank entry by keyboard once the bank outgrows the terminal", () => {
		const status = largeBankStatus(120);
		const memory = view(() => status);
		const total = buildMemoryOverlayItems(status, []).length;
		strictEqual(total, 121);

		const reached = new Set<string>();
		// The list starts focused on the filter row; the first Down moves into it.
		memory.render(96);
		for (let step = 0; step <= total; step += 1) {
			memory.handleInput(DOWN);
			reached.add(selectedLabel(memory.render(96)));
		}

		// Every row was the selected row at some point, and the last marker is
		// reachable rather than stranded below the fold.
		strictEqual(reached.size, total);
		ok(
			[...reached].some((row) => row.includes("marker-119")),
			"the last bank entry must be reachable",
		);
		ok(
			[...reached].some((row) => row.includes("marker-0")),
			"the first bank entry must be reachable",
		);
	});

	it("renders the selected entry in full in a scrollable detail pane", () => {
		const bank = new TaskMemoryBank({ now: () => new Date("2026-07-13T00:00:00.000Z") });
		const longContent =
			"Do not retry a failed command without changing its inputs. This is a very long procedural memory entry " +
			"that contains detailed instructions and warnings for the operator. It also includes a unique tail " +
			"sentinel: TAIL_SENTINEL to verify that the entire content is preserved and nothing is truncated or " +
			"replaced by an ellipsis.";
		bank.saveProcedural(longContent);
		const snapshot = bank.snapshot();
		const status: TaskMemoryOperatorStatus = {
			...operatorStatus(),
			size: taskMemoryBankSize(snapshot),
			bank: snapshot,
		};
		const memory = view(() => status);

		// The detail pane is the only surface that must show the whole entry; the
		// row itself is a one-line summary and may truncate.
		memory.handleInput(DOWN);
		memory.handleInput(TAB);
		let body = stripAnsi(memory.render(60).join("\n"));
		for (let page = 0; page < 6 && !body.includes("TAIL_SENTINEL"); page += 1) {
			memory.handleInput(PAGE_DOWN);
			body = stripAnsi(memory.render(60).join("\n"));
		}
		ok(body.includes("TAIL_SENTINEL"), `the detail pane must scroll to the end of the entry:\n${body}`);
	});

	it("survives the live refresh without losing the selection or the detail scroll", () => {
		const bank = new TaskMemoryBank({ now: () => new Date("2026-07-13T00:00:00.000Z") });
		bank.updateStatus("Inspect operator visibility.");
		bank.saveKnowledge(`anchor-row ${Array.from({ length: 90 }, (_unused, index) => `word${index}`).join(" ")}`.trim());
		const build = (): TaskMemoryOperatorStatus => {
			const snapshot = bank.snapshot();
			return {
				enabled: true,
				tier: "llm",
				size: taskMemoryBankSize(snapshot),
				lastDecision: "injected",
				activity: [],
				stepInFlight: false,
				bank: snapshot,
			};
		};
		const memory = view(build);

		// A stacked layout puts the detail pane in the last rows, which is what
		// makes a scroll position comparable across a refresh.
		memory.render(60);
		memory.handleInput(DOWN);
		const before = selectedLabel(memory.render(60));
		ok(before.includes("anchor-row"), before);
		memory.handleInput(TAB);
		const unscrolled = memory.render(60).slice(-10).map(stripAnsi);
		memory.handleInput(PAGE_DOWN);
		const scrolled = memory.render(60).slice(-10).map(stripAnsi);
		ok(scrolled.join("\n") !== unscrolled.join("\n"), "PgDn must move the detail pane");

		// The background step writes a new entry, and a refresh lands mid-read.
		bank.saveProcedural("A later capture must not move the cursor.");
		const after = memory.render(60);
		strictEqual(selectedLabel(after), before);
		ok(stripAnsi(after[0] ?? "").includes("bank 3"), stripAnsi(after[0] ?? ""));
		deepStrictEqual(after.slice(-10).map(stripAnsi), scrolled, "the detail pane keeps its scroll across a refresh");
	});

	it("reports memory steps and the in-flight step that leave no other trace", () => {
		const status: TaskMemoryOperatorStatus = {
			...operatorStatus(),
			stepInFlight: true,
			activity: [
				{
					at: "2026-07-13T09:39:55.000Z",
					triggerReasons: ["tool_error_streak", "loop_signal"],
					tier: "rules",
					decision: "injected",
					reason: "intervened",
					citedEntries: 1,
					bankWrites: 1,
					latencyMs: 3,
				},
			],
		};
		const header = stripAnsi(formatMemoryStatusLine(status, 96));
		ok(header.includes("step running"), header);
		strictEqual(stripAnsi(formatMemoryStatusLine(operatorStatus(), 96)).includes("step running"), false);

		const steps = buildMemoryOverlayItems(status, []).filter((item) => (item.group ?? "").includes("recent steps"));
		strictEqual(steps.length, 1);
		ok(stripAnsi(steps[0]?.label ?? "").includes("tool_error_streak+loop_signal injected 1w 1 cited"), "step label");
		const detail = stripAnsi((steps[0]?.detail?.(60) ?? []).join("\n"));
		ok(detail.includes("rules"), detail);
		ok(detail.includes("3ms"), detail);
	});

	it("clocks step rows in the operator's timezone while the detail pane keeps the instant", () => {
		const status: TaskMemoryOperatorStatus = {
			...operatorStatus(),
			activity: [
				{
					at: "2026-08-15T11:18:32.810Z",
					triggerReasons: ["interval"],
					tier: "llm",
					decision: "gated",
					reason: "uncited",
					citedEntries: 0,
					bankWrites: 1,
					latencyMs: 8_405,
				},
			],
		};
		const stepRow = (zone: string): { label: string; detail: string } => {
			const items = withTimeZone(zone, () => buildMemoryOverlayItems(status, []));
			const row = items.find((item) => (item.group ?? "").includes("recent steps"));
			return { label: stripAnsi(row?.label ?? ""), detail: stripAnsi((row?.detail?.(60) ?? []).join("\n")) };
		};

		// America/Chicago is -0500 in August: an operator whose clock reads 06:18
		// must not be shown 11:18 with nothing marking it as UTC.
		const chicago = stepRow("America/Chicago");
		ok(chicago.label.includes("06:18:32"), chicago.label);
		ok(!chicago.label.includes("11:18:32"), chicago.label);
		// The detail pane still carries the instant, which is what lets the two
		// surfaces be reconciled rather than merely agree by coincidence.
		ok(chicago.detail.includes("2026-08-15T11:18:32.810Z"), chicago.detail);

		// A half-hour offset, and the zone where local and UTC coincide.
		ok(stepRow("Asia/Kolkata").label.includes("16:48:32"), stepRow("Asia/Kolkata").label);
		ok(stepRow("UTC").label.includes("11:18:32"), stepRow("UTC").label);
	});

	it("names the real keys in the footer and closes on Escape", () => {
		// The scroll keys sit ahead of the key that opens the pane, so a footer that
		// has to narrow sheds them first and keeps the way in.
		const hint = view(operatorStatus, () => [durableRecord(true)]).getHint();
		strictEqual(hint, "[↑↓] select · [type] filter · [PgUp/PgDn] scroll detail · [Enter/Tab] detail · [Esc] close");

		let mounted: Component | null = null;
		let hidden = 0;
		const tui = {
			showOverlay(component: Component): OverlayHandle {
				mounted = component;
				return overlayHandle(() => {
					hidden += 1;
				});
			},
			requestRender: () => undefined,
		} as unknown as TUI;
		let closed = 0;
		const handle = openMemoryOverlay(tui, operatorStatus, () => [durableRecord(true)], {
			onClose: () => {
				closed += 1;
			},
		});

		if (mounted === null) throw new Error("memory overlay was not mounted");
		(mounted as Component).handleInput?.(ESC);
		strictEqual(closed, 1);
		strictEqual(hidden, 0);
		handle.hide();
		strictEqual(hidden, 1);
		// The overlay reads the bank; it never writes to it.
		deepStrictEqual(operatorStatus().bank.version, 1);
	});
});
