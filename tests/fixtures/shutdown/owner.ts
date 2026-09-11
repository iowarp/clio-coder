import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withWikiDispatchLifecycle } from "../../../src/cli/wiki-generate.js";
import { runBashCommand } from "../../../src/core/bash-exec.js";
import { loadDomains } from "../../../src/core/domain-loader.js";
import { getTerminationCoordinator } from "../../../src/core/termination.js";
import { spawnWorkerProcess, type WorkerSpec } from "../../../src/domains/dispatch/worker-spawn.js";
import {
	createEditorSubmitController,
	EDITOR_BASH_SHUTDOWN_MS,
	type EditorSubmitDeps,
} from "../../../src/interactive/editor-submit.js";

const [mode, root, command] = process.argv.slice(2);
if (!root || !command) throw new Error("missing shutdown fixture arguments");
const noop = () => {};

if (mode === "editor") {
	const controller = createEditorSubmitController({
		editor: { getText: () => "", getTextForSubmit: () => "", setText: noop, addToHistory: noop },
		ui: { start: noop, stop: noop, requestRender: noop },
		io: { stdout: noop, stderr: (text: string) => process.stderr.write(text) },
		chat: { isStreaming: () => false },
		dispatch: {},
		session: {
			current: () => ({}),
			tree: () => ({ leafId: null }),
			appendEntry: (entry: unknown) => {
				writeFileSync(join(root, "entry.json"), JSON.stringify(entry));
				return entry;
			},
		},
		sessionTranscript: {
			ensureSessionForLocalEntry: noop,
			refreshChatContextFromSession: noop,
			recordSubmittedTurn: noop,
		},
		chatPanel: { appendReplayBlock: noop },
		dispatchCommand: noop,
		expandSubmit: async (text: string) => ({ text, images: [] }),
		notify: noop,
		getCwd: () => root,
		runBash: async (...args: Parameters<typeof runBashCommand>) => {
			const result = await runBashCommand(...args);
			writeFileSync(join(root, "bash-result.json"), JSON.stringify({ ...result, settledAt: Date.now() }));
			return result;
		},
	} as unknown as EditorSubmitDeps);
	const termination = getTerminationCoordinator();
	termination.installSignalHandlers();
	termination.onDrain(() => controller.shutdownEditorBash(), { timeoutMs: EDITOR_BASH_SHUTDOWN_MS });
	termination.onPersist(() => writeFileSync(join(root, "persisted"), "yes"));
	controller.runEditorBash(`!${command}`);
} else if (mode === "wiki") {
	let forcedKills = 0;
	const worker = spawnWorkerProcess(
		"/bin/bash",
		["-c", command],
		{
			specVersion: 3,
			settingsFingerprint: "fixture",
			runtimeId: "fixture",
			target: { id: "fixture", url: "http://127.0.0.1:1" },
			wireModelId: "fixture",
			allowedTools: [],
		} as unknown as WorkerSpec,
		{
			cwd: root,
			attestationGraceMs: 30_000,
			onForcedKill: () => {
				forcedKills++;
			},
		},
	);
	await withWikiDispatchLifecycle(
		{
			dispatch: {
				async drain() {
					worker.abort();
					worker.abort();
					await worker.promise;
				},
			},
			async stop() {
				writeFileSync(join(root, "worker-result.json"), JSON.stringify({ ...(await worker.promise), forcedKills }));
				writeFileSync(join(root, "persisted"), "yes");
			},
		},
		async () => {
			await worker.promise;
		},
	);
} else if (mode === "domains") {
	const loaded = await loadDomains(
		["persist", "slow"].map((name) => ({
			manifest: { name, dependsOn: name === "slow" ? ["persist"] : [] },
			createExtension: () => ({
				contract: {},
				extension: {
					start() {},
					stop() {
						if (name === "slow") return new Promise<void>(() => {});
						writeFileSync(join(root, "persisted"), "yes");
					},
				},
			}),
		})),
	);
	const termination = getTerminationCoordinator();
	termination.onPersist(() => loaded.stop(), { timeoutMs: 300 });
	await termination.shutdown(0);
} else if (mode === "budget") {
	const termination = getTerminationCoordinator();
	termination.onDrain(() => new Promise((resolve) => setTimeout(resolve, 200)), { timeoutMs: 300 });
	termination.onDrain(() => new Promise(() => {}));
	termination.onPersist(() => writeFileSync(join(root, "persisted"), "yes"));
	await termination.shutdown(0);
} else {
	throw new Error(`unknown shutdown fixture mode ${mode}`);
}
