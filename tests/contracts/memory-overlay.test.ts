import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryRecord, TaskMemoryOperatorStatus } from "../../src/domains/memory/index.js";
import { TaskMemoryBank, taskMemoryBankSize } from "../../src/domains/memory/index.js";
import { type Component, type OverlayHandle, type TUI, visibleWidth } from "../../src/engine/tui.js";
import { formatMemoryOverlayBodyLines, openMemoryOverlay } from "../../src/interactive/memory-overlay.js";

const ESC = "\x1b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(SGR, "");

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

describe("contracts/memory overlay", () => {
	it("lists approved lessons and every task-bank class with attribution", () => {
		const lines = formatMemoryOverlayBodyLines(operatorStatus(), [durableRecord(true), durableRecord(false)], 84);
		const body = stripAnsi(lines.join("\n"));

		ok(body.includes("memory on · tier LLM · bank 3 · last injected"), body);
		ok(body.includes("Approved lessons (1)"), body);
		ok(body.includes("mem-approved"), body);
		ok(!body.includes("mem-proposed"), body);
		ok(body.includes("status (private) (1)"), body);
		ok(body.includes("knowledge (1)"), body);
		ok(body.includes("procedural (1)"), body);
		ok(body.includes("injected 1"), body);
		ok(body.includes("injected 0"), body);
	});

	it("fits all rendered rows to the real overlay width", () => {
		for (const width of [84, 48, 30]) {
			const lines = formatMemoryOverlayBodyLines(operatorStatus(), [durableRecord(true)], width);
			for (const line of lines) ok(visibleWidth(line) <= width, `width ${width}: ${stripAnsi(line)}`);
		}
	});

	it("keeps the overlay read-only and closes on Escape", () => {
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
		deepStrictEqual(operatorStatus().bank.version, 1);
	});

	it("fully wraps long procedural entries and preserves tail sentinel", () => {
		// Build a long procedural entry with a unique tail sentinel.
		const bank = new TaskMemoryBank({ now: () => new Date("2026-07-13T00:00:00.000Z") });
		bank.updateStatus("Inspect operator visibility.");
		// Create a very long procedural content that will wrap across multiple lines.
		const longContent =
			"Do not retry a failed command without changing its inputs. This is a very long procedural memory entry " +
			"that contains detailed instructions and warnings for the operator. It also includes a unique tail " +
			"sentinel: TAIL_SENTINEL to verify that the entire content is preserved and nothing is truncated or " +
			"replaced by an ellipsis.";
		const procedural = bank.saveProcedural(longContent);
		bank.recordInjection([procedural.id]);
		const knowledge = bank.saveKnowledge("The active branch is feat/fleet-dispatch.");
		bank.recordInjection([knowledge.id]);
		const snapshot = bank.snapshot();

		const status: TaskMemoryOperatorStatus = {
			enabled: true,
			tier: "llm",
			size: taskMemoryBankSize(snapshot),
			lastDecision: "injected",
			activity: [],
			stepInFlight: false,
			bank: snapshot,
		};

		// Test at multiple widths.
		for (const width of [84, 60, 40]) {
			const lines = formatMemoryOverlayBodyLines(status, [durableRecord(true)], width);
			const body = stripAnsi(lines.join("\n"));

			// Verify metadata line is present.
			ok(body.includes("memory on · tier LLM · bank"), `width ${width}: status line missing`);

			// Verify procedural section exists and has multiple lines.
			const procSectionIndex = body.indexOf("procedural");
			ok(procSectionIndex >= 0, `width ${width}: procedural heading missing`);
			const procStart = body.indexOf("injected", procSectionIndex);
			ok(procStart >= 0, `width ${width}: procedural entry missing`);

			// Verify the tail sentinel appears somewhere in the output.
			ok(body.includes("TAIL_SENTINEL"), `width ${width}: TAIL_SENTINEL not found`);
			ok(
				body.replace(/\s/gu, "").includes(longContent.replace(/\s/gu, "")),
				`width ${width}: procedural content was not preserved`,
			);

			// Verify no rendered line exceeds the requested visible width.
			for (const line of lines) {
				ok(visibleWidth(line) <= width, `width ${width}: line exceeds: ${stripAnsi(line)}`);
			}

			// Verify that the content is not truncated with ellipsis in the middle.
			// The tail sentinel should appear intact, not as "TAIL_SENTIN...".
			ok(/TAIL_SENTINEL/.test(body), `width ${width}: sentinel appears intact`);
		}

		// Verify that existing sections (approved lessons, knowledge) still render correctly.
		const lines = formatMemoryOverlayBodyLines(status, [durableRecord(true)], 84);
		const body = stripAnsi(lines.join("\n"));
		ok(body.includes("Approved lessons (1)"), "approved lessons section present");
		ok(body.includes("knowledge (1)"), "knowledge section present");
		ok(body.includes("status (private)"), "status section present");
	});

	it("reports memory steps that leave no other trace", () => {
		const status: TaskMemoryOperatorStatus = {
			...operatorStatus(),
			stepInFlight: true,
			activity: [
				{
					at: "2026-07-13T09:41:07.000Z",
					triggerReasons: ["interval"],
					tier: "llm",
					decision: "gated",
					citedEntries: 0,
					bankWrites: 2,
					latencyMs: 41_200,
				},
				{
					at: "2026-07-13T09:39:55.000Z",
					triggerReasons: ["tool_error_streak", "loop_signal"],
					tier: "rules",
					decision: "injected",
					citedEntries: 1,
					bankWrites: 1,
					latencyMs: 3,
				},
			],
		};
		const body = stripAnsi(formatMemoryOverlayBodyLines(status, [], 84).join("\n"));

		ok(body.includes("Recent steps (2)"), body);
		ok(body.includes("a background step is running"), body);
		// A gated step wrote to the bank and said nothing; without this row the
		// operator would see an unchanged transcript and assume memory was idle.
		ok(body.includes("09:41:07"), body);
		ok(body.includes("interval gated 2w"), body);
		ok(body.includes("llm 41200ms"), body);
		ok(body.includes("tool_error_streak+loop_signal injected 1w 1 cited"), body);
	});

	it("distinguishes a bank with no steps yet from a step that has not finished", () => {
		const idle = stripAnsi(formatMemoryOverlayBodyLines(operatorStatus(), [], 84).join("\n"));
		ok(idle.includes("Recent steps (0)"), idle);
		ok(idle.includes("none"), idle);

		const working = stripAnsi(
			formatMemoryOverlayBodyLines({ ...operatorStatus(), stepInFlight: true }, [], 84).join("\n"),
		);
		ok(working.includes("no completed step yet"), working);
	});
});
