import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import {
	createDispatchSteering,
	type DispatchSteeringDeps,
	type DispatchSteeringNoticeLevel,
} from "../../src/interactive/dispatch-steering.js";

function row(overrides: Partial<DispatchBoardRow> = {}): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "scout",
		runtimeKind: "http",
		runtimeId: "worker",
		targetId: "target",
		wireModelId: "model",
		status: "running",
		elapsedMs: 1_000,
		tokenCount: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		ttftMs: null,
		...overrides,
	};
}

interface Notice {
	level: DispatchSteeringNoticeLevel;
	text: string;
	key: string;
}

function harness(selected: DispatchBoardRow | undefined, draft = "") {
	const calls: string[] = [];
	const notices: Notice[] = [];
	const editor = {
		text: draft,
		focused: false,
		getText() {
			calls.push("editor:get");
			return this.text;
		},
		setText(text: string) {
			calls.push(`editor:set:${text}`);
			this.text = text;
		},
	};
	let abortError: unknown;
	const deps: DispatchSteeringDeps = {
		getSelectedRow: () => {
			calls.push("selected");
			return selected;
		},
		notify: (level, text, key) => {
			calls.push(`notice:${level}`);
			notices.push({ level, text, key });
		},
		abortDispatch: (runId) => {
			calls.push(`abort:${runId}`);
			if (abortError !== undefined) throw abortError;
		},
		editor,
		closeOverlay: () => calls.push("close"),
		requestRender: () => calls.push("render"),
	};
	return {
		controller: createDispatchSteering(deps),
		calls,
		notices,
		editor,
		failAbortWith(error: unknown) {
			abortError = error;
		},
	};
}

describe("interactive dispatch steering", () => {
	it("reports the exact steer notice when no row is selected", () => {
		const test = harness(undefined);
		test.controller.steerSelectedDispatch();
		deepStrictEqual(test.notices, [{ level: "warning", text: "no fleet run is selected", key: "dispatch-board:steer" }]);
		deepStrictEqual(test.calls, ["selected", "notice:warning"]);
	});

	it("rejects runtimes without live input and non-steerable rows without changing the editor", () => {
		const acp = harness(row({ runtimeKind: "acp-delegation" }), "keep me");
		acp.controller.steerSelectedDispatch();
		deepStrictEqual(acp.notices, [
			{
				level: "warning",
				text: "run run-1 uses worker (acp-delegation) and cannot accept live steering",
				key: "dispatch-board:steer:run-1",
			},
		]);
		strictEqual(acp.editor.text, "keep me");

		const subprocess = harness(row({ runtimeKind: "subprocess", runtimeId: "claude-code" }), "keep me");
		subprocess.controller.steerSelectedDispatch();
		deepStrictEqual(subprocess.notices, [
			{
				level: "warning",
				text: "run run-1 uses claude-code (subprocess) and cannot accept live steering",
				key: "dispatch-board:steer:run-1",
			},
		]);
		strictEqual(subprocess.editor.text, "keep me");

		const completed = harness(row({ status: "completed" }), "keep me");
		completed.controller.steerSelectedDispatch();
		deepStrictEqual(completed.notices, [
			{
				level: "warning",
				text: "run run-1 is completed and cannot accept steering",
				key: "dispatch-board:steer:run-1",
			},
		]);
		deepStrictEqual(completed.calls, ["selected", "notice:warning"]);
		strictEqual(completed.editor.text, "keep me");
	});

	it("closes the board before prefixing and focusing the existing draft", () => {
		const test = harness(row(), "inspect the parser");
		test.controller.steerSelectedDispatch();

		deepStrictEqual(test.calls, ["selected", "editor:get", "close", "editor:set:@run-1 inspect the parser", "render"]);
		strictEqual(test.editor.text, "@run-1 inspect the parser");
		strictEqual(test.editor.focused, true);
		deepStrictEqual(test.notices, []);
	});

	it("leaves a trailing space after the run prefix for an empty draft", () => {
		const test = harness(row());
		test.controller.steerSelectedDispatch();
		strictEqual(test.editor.text, "@run-1 ");
	});

	it("reports the exact cancel notice when no row is selected", () => {
		const test = harness(undefined);
		test.controller.cancelSelectedDispatch();
		deepStrictEqual(test.notices, [{ level: "warning", text: "no fleet run is selected", key: "dispatch-board:cancel" }]);
		deepStrictEqual(test.calls, ["selected", "notice:warning"]);
	});

	it("does not abort a cancellation already in progress or a terminal run", () => {
		const cancelling = harness(row({ status: "cancelling" }));
		cancelling.controller.cancelSelectedDispatch();
		deepStrictEqual(cancelling.notices, [
			{
				level: "info",
				text: "cancellation is already in progress for run-1",
				key: "dispatch-board:cancel:run-1",
			},
		]);
		deepStrictEqual(cancelling.calls, ["selected", "notice:info"]);

		const completed = harness(row({ status: "completed" }));
		completed.controller.cancelSelectedDispatch();
		deepStrictEqual(completed.notices, [
			{
				level: "warning",
				text: "run run-1 is completed and cannot be cancelled",
				key: "dispatch-board:cancel:run-1",
			},
		]);
		deepStrictEqual(completed.calls, ["selected", "notice:warning"]);
	});

	it("aborts before announcing the cancellation request", () => {
		const test = harness(row());
		test.controller.cancelSelectedDispatch();
		deepStrictEqual(test.calls, ["selected", "abort:run-1", "notice:info"]);
		deepStrictEqual(test.notices, [
			{
				level: "info",
				text: "cancellation requested for scout (run-1)",
				key: "dispatch-board:cancel:run-1",
			},
		]);
	});

	it("turns an abort failure into the exact keyed error notice", () => {
		const test = harness(row());
		test.failAbortWith(new Error("worker pipe closed"));
		test.controller.cancelSelectedDispatch();
		deepStrictEqual(test.calls, ["selected", "abort:run-1", "notice:error"]);
		deepStrictEqual(test.notices, [
			{
				level: "error",
				text: "could not cancel run-1: worker pipe closed",
				key: "dispatch-board:cancel:run-1",
			},
		]);
	});
});
