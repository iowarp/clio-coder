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
});
