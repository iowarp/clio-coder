import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type BashCommandResult, runBashCommand } from "../../src/core/bash-exec.js";
import { createEditorSubmitController, type EditorSubmitDeps } from "../../src/interactive/editor-submit.js";

import { makeScratchHome } from "../harness/scratch-env.js";

const noop = () => {};
function controller(runBash: EditorSubmitDeps["runBash"], appendEntry: (entry: unknown) => unknown) {
	return createEditorSubmitController({
		editor: { getText: () => "", getTextForSubmit: () => "", setText: noop, addToHistory: noop },
		ui: { start: noop, stop: noop, requestRender: noop },
		io: { stdout: noop, stderr: noop },
		chat: { isStreaming: () => false },
		dispatch: {},
		session: { current: () => ({}), tree: () => ({ leafId: null }), appendEntry },
		sessionTranscript: {
			ensureSessionForLocalEntry: noop,
			refreshChatContextFromSession: noop,
			recordSubmittedTurn: noop,
		},
		chatPanel: { appendReplayBlock: noop },
		dispatchCommand: noop,
		expandSubmit: async (text: string) => ({ text, images: [] }),
		notify: noop,
		runBash,
	} as unknown as EditorSubmitDeps);
}

describe("editor bash drain", () => {
	it("waits for the canceled result to persist and refuses new or queued shell admission", async () => {
		let finish!: (result: BashCommandResult) => void;
		let signal: AbortSignal | undefined;
		let calls = 0;
		let appended = false;
		const editor = controller(
			(_command, options) => {
				calls++;
				signal = options?.signal;
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
			(entry) => {
				appended = true;
				return entry;
			},
		);
		assert.equal(editor.runEditorBash("!first"), true);
		const queued = editor.admitCapturedText("!queued");
		let settled = false;
		const shutdown = editor.shutdownEditorBash().then(() => {
			settled = true;
		});
		const again = editor.shutdownEditorBash();
		assert.equal(signal?.aborted, true);
		await Promise.resolve();
		assert.equal(settled, false);
		assert.equal(editor.runEditorBash("!too late"), true);
		assert.equal(calls, 1);
		finish({
			error: null,
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: "SIGTERM",
			aborted: true,
			timedOut: false,
			outputCapped: false,
			outputBytes: 0,
		});
		await assert.rejects(queued, /editor is shutting down/);
		await Promise.all([shutdown, again]);
		assert.equal(appended, true);
		assert.equal(editor.hasActiveEditorBash(), false);
		assert.equal(calls, 1);
	});
	it("settles shutdown even if command execution rejects", async () => {
		const editor = controller(
			async () => {
				throw new Error("spawn failed");
			},
			(entry) => entry,
		);
		editor.runEditorBash("!failing");
		await editor.shutdownEditorBash();
		assert.equal(editor.hasActiveEditorBash(), false);
	});
});

describe("bash execution without cancellation", () => {
	it("preserves output and the original successful or failing shell result", { timeout: 15_000 }, async () => {
		for (const exitCode of [0, 7]) {
			const result = await runBashCommand(`printf kept; printf warning >&2; exit ${exitCode}`, { timeoutMs: 2000 });
			assert.equal(result.exitCode, exitCode);
			assert.equal(result.signal, null);
			assert.equal(result.stdout, "kept");
			assert.equal(result.stderr, "warning");
			assert.equal(result.outputBytes, 11);
			assert.equal(result.aborted, false);
			assert.equal(result.timedOut, false);
			assert.equal(result.outputCapped, false);
			if (exitCode === 0) assert.equal(result.error, null);
			else assert.equal(result.error?.message, "command exited with code 7");
		}
	});
	it("preserves the original ENOENT spawn error for a nonexistent cwd", { timeout: 15_000 }, async () => {
		const home = makeScratchHome("clio-coder-bash-spawn-error-");
		try {
			const result = await runBashCommand("printf unreachable", { cwd: join(home.dir, "absent"), timeoutMs: 2000 });
			assert.equal(result.error?.code, "ENOENT");
			assert.equal(result.exitCode, null);
			assert.equal(result.signal, null);
			assert.equal(result.stdout, "");
			assert.equal(result.stderr, "");
			assert.equal(result.aborted, false);
			assert.equal(result.timedOut, false);
			assert.equal(result.outputCapped, false);
		} finally {
			home.cleanup();
		}
	});
});
