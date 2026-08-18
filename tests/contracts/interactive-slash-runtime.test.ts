import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SafeEventBus } from "../../src/core/event-bus.js";
import { getAtPath } from "../../src/core/session-routing.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionEntry } from "../../src/domains/session/index.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { withTimeZone } from "../harness/clock.js";

const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function createHarness() {
	const events: string[] = [];
	const stderr: string[] = [];
	let resolveSubmit: (() => void) | undefined;
	const submitFinished = new Promise<void>((resolve) => {
		resolveSubmit = resolve;
	});
	const deps: InteractiveSlashRuntimeDeps = {
		io: {
			stdout: (text) => events.push(`stdout:${text}`),
			stderr: (text) => stderr.push(text),
		},
		bus: {} as SafeEventBus,
		dispatch: {} as DispatchContract,
		providers: {} as ProvidersContract,
		chat: {
			getSessionId: () => null,
			isStreaming: () => false,
			submit: async (text) => {
				events.push(`submit:${text}`);
				await submitFinished;
			},
		},
		chatPanel: {
			appendReplayBlock: () => events.push("notice"),
			appendUser: (text) => events.push(`user:${text}`),
		},
		stateDir: "/tmp/clio-slash-runtime-test-state",
		shutdown: () => {
			events.push("shutdown");
		},
		requestRender: () => events.push("render"),
		refreshFooter: () => events.push("footer"),
		dismissContextBootstrapNotices: () => events.push("dismiss-bootstrap"),
		recordSubmittedTurn: () => events.push("record-turn"),
		readStructuredEntries: () => [],
		expandSubmit: async (text) => ({
			text: `expanded:${text}`,
			images: [],
			workingContextPaths: [],
			pendingSkillRequests: [],
		}),
		openAskUser: async () => ({ answers: [], cancelled: true }),
		openSkillsHub: () => events.push("skills"),
		openCost: () => events.push("cost"),
		openContextView: () => events.push("context"),
		openTasks: () => events.push("tasks"),
		openMemory: () => events.push("memory"),
		openView: () => events.push("view"),
		openModel: () => events.push("model"),
		openSettings: () => events.push("settings"),
		openResume: () => events.push("resume"),
		startNewSession: () => events.push("new"),
		openTree: () => events.push("tree"),
		openMessagePicker: () => events.push("message-picker"),
		openHelp: (query) => events.push(`help:${query ?? ""}`),
		openAgents: () => events.push("agents"),
		openPrompts: () => events.push("prompts"),
		openExtensions: () => events.push("extensions"),
		openContextReset: () => events.push("context-reset"),
		setEditorText: (text) => events.push(`editor:${text}`),
	};
	return {
		deps,
		events,
		stderr,
		finishSubmit: () => resolveSubmit?.(),
	};
}

describe("contracts/interactive slash runtime", () => {
	// Issue #109: current.jsonl is append-only, so a session pinned by /tree and
	// not yet extended still holds the abandoned turns after the pin. /export
	// rehydrated the file unscoped and reproduced them, the same root cause as
	// #107 on a different surface. It now follows the leaf the session is on.
	it("exports only the pinned branch, leaving the abandoned turns out of the file", () => {
		const messageEntry = (
			turnId: string,
			parentTurnId: string | null,
			role: "user" | "assistant",
			text: string,
		): SessionEntry =>
			({
				kind: "message",
				turnId,
				parentTurnId,
				timestamp: "2026-08-09T00:00:00.000Z",
				role,
				payload: { text },
			}) as SessionEntry;
		const harness = createHarness();
		harness.deps.chat.getSessionId = () => "session-pinned";
		harness.deps.readStructuredEntries = () => [
			messageEntry("turn-u1", null, "user", "PROMPT-ONE"),
			messageEntry("turn-a1", "turn-u1", "assistant", "ANSWER-ONE"),
			messageEntry("turn-u2", "turn-a1", "user", "PROMPT-TWO"),
			messageEntry("turn-a2", "turn-u2", "assistant", "ANSWER-TWO"),
		];
		harness.deps.session = { tree: () => ({ leafId: "turn-a1" }) } as never;
		harness.deps.now = () => new Date("2026-08-15T12:00:00.000Z");
		const runtime = createInteractiveSlashRuntime(harness.deps);
		const scratch = mkdtempSync(join(tmpdir(), "clio-export-pin-"));
		const target = join(scratch, "pinned.md");
		try {
			runtime.dispatchCommand(`/export ${target}`);
			const body = readFileSync(target, "utf8");
			ok(body.includes("PROMPT-ONE"), body);
			ok(body.includes("ANSWER-ONE"), body);
			ok(!body.includes("PROMPT-TWO"), `u2 is past the pin, got:\n${body}`);
			ok(!body.includes("ANSWER-TWO"), `a2 is past the pin, got:\n${body}`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	// The export is named for the day the operator ran it. At 21:30 in Chicago
	// the UTC date is already tomorrow, so the old naming sent an operator
	// looking for a file dated today that was never written.
	it("names an export file by the operator's calendar date, not UTC's", () => {
		const harness = createHarness();
		harness.deps.chat.getSessionId = () => "session-1";
		harness.deps.now = () => new Date("2026-08-15T02:30:00.000Z");
		const runtime = createInteractiveSlashRuntime(harness.deps);
		const scratch = mkdtempSync(join(tmpdir(), "clio-export-"));
		const previousCwd = process.cwd();
		try {
			process.chdir(scratch);
			const exported = (zone: string): string[] =>
				withTimeZone(zone, () => {
					runtime.dispatchCommand("/export");
					return readdirSync(join(scratch, ".clio-coder", "exports"));
				});

			ok(exported("America/Chicago").includes("session-1-2026-08-14.md"), exported("America/Chicago").join(", "));
			ok(exported("Asia/Kolkata").includes("session-1-2026-08-15.md"), exported("Asia/Kolkata").join(", "));
			ok(exported("UTC").includes("session-1-2026-08-15.md"), exported("UTC").join(", "));
			// The header inside the file stays UTC: it is the machine-readable half.
			ok(
				readFileSync(join(scratch, ".clio-coder", "exports", "session-1-2026-08-15.md"), "utf8").includes(
					"Exported 2026-08-15T02:30:00.000Z",
				),
			);
		} finally {
			process.chdir(previousCwd);
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("constructs and dispatches overlay commands without a terminal or live provider", () => {
		const harness = createHarness();
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.dispatchCommand("/help model");
		runtime.dispatchCommand("/tasks");

		deepStrictEqual(harness.events, ["help:model", "tasks"]);
	});

	it("derives interactive /run roles from the named agent recipe", async () => {
		const harness = createHarness();
		const requests: DispatchRequest[] = [];
		const specs = new Map<string, Pick<AgentSpec, "capabilityClass" | "resultContract">>([
			["scout", { capabilityClass: "read-only", resultContract: { kind: "scout-report" } }],
			["verifier", { capabilityClass: "verification", resultContract: { kind: "verifier-report" } }],
		]);
		harness.deps.agents = {
			listSpecs: () => [],
			getSpec: (agentId) => (specs.get(agentId) as AgentSpec | undefined) ?? null,
		};
		harness.deps.dispatch = {
			dispatch: async (request: DispatchRequest) => {
				requests.push(request);
				return {
					runId: `run-${requests.length}`,
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ exitCode: 0 } as RunReceipt),
				};
			},
		} as unknown as DispatchContract;
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.dispatchCommand("/run scout inspect the repository");
		runtime.dispatchCommand("/run verifier validate the change");
		await flushAsync();

		deepStrictEqual(
			requests.map(({ agentId, executionRole }) => ({ agentId, executionRole })),
			[
				{ agentId: "scout", executionRole: "researcher" },
				{ agentId: "verifier", executionRole: "verifier" },
			],
		);
	});

	it("routes only grammar-valid share imports and keeps dry-run on the planning path", () => {
		const harness = createHarness();
		const planned: Array<{ path: string; options: unknown }> = [];
		const imported: Array<{ path: string; options: unknown }> = [];
		const result = { archive: null, actions: [], diagnostics: [] };
		harness.deps.share = {
			writeArchive: () => ({ files: [] }) as never,
			planImport: (path, options) => {
				planned.push({ path, options });
				return result;
			},
			importArchive: (path, options) => {
				imported.push({ path, options });
				return result;
			},
		};
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.dispatchCommand("/share import --dry-run /tmp/preview.clio-coder-share.json");
		runtime.dispatchCommand("/share import --dry-rnu /tmp/typo.clio-coder-share.json");
		runtime.dispatchCommand("/share import /tmp/extra.clio-coder-share.json unexpected");
		runtime.dispatchCommand("/share import --force /tmp/apply.clio-coder-share.json");

		deepStrictEqual(planned, [
			{
				path: "/tmp/preview.clio-coder-share.json",
				options: { dryRun: true },
			},
		]);
		deepStrictEqual(imported, [
			{
				path: "/tmp/apply.clio-coder-share.json",
				options: { force: true },
			},
		]);
	});

	it("rejects a second context bootstrap until the first one settles", async () => {
		const harness = createHarness();
		let resolveInit: (() => void) | undefined;
		const initFinished = new Promise<void>((resolve) => {
			resolveInit = resolve;
		});
		let calls = 0;
		harness.deps.onInit = async () => {
			calls += 1;
			await initFinished;
		};
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.context.runInit({});
		runtime.context.runInit({});
		await flushAsync();

		strictEqual(calls, 1);
		deepStrictEqual(harness.stderr, ["[/context init] bootstrap already running\n"]);
		resolveInit?.();
		await flushAsync();
		deepStrictEqual(harness.events, ["dismiss-bootstrap", "footer", "render"]);
	});

	// A slash command changes the running session. Making a value the saved
	// default is the Settings overlay's explicit Apply-and-save-globally choice,
	// so /output and /thinking must never reach settings.yaml on their own.
	it("applies /output and /thinking to the session, never to saved settings", () => {
		const harness = createHarness();
		const commits: Array<{ id: string; scope: string; value: unknown }> = [];
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		harness.deps.getSettings = () => settings;
		harness.deps.writeSettings = () => harness.events.push("write-settings");
		harness.deps.onSetThinkingLevel = () => harness.events.push("write-thinking");
		harness.deps.commitSetting = (id, next, scope) => {
			commits.push({ id, scope, value: getAtPath(next, id) });
		};
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.dispatchCommand("/output verbose");
		runtime.dispatchCommand("/thinking off");

		deepStrictEqual(commits, [
			{ id: "terminal.outputVerbosity", scope: "session", value: "verbose" },
			{ id: "orchestrator.thinkingLevel", scope: "session", value: "off" },
		]);
		ok(!harness.events.includes("write-settings"), "/output wrote saved settings");
		ok(!harness.events.includes("write-thinking"), "/thinking wrote saved settings");
	});

	it("submits a shared worker result as a user turn, and never expands it", async () => {
		const harness = createHarness();
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.context.submitOperatorNote?.(
			"[worker result] coder · run r1 · ok · shared by the operator\nsee @plan.md and /skill:writer",
		);
		await flushAsync();

		// The same path typed text takes, minus expansion: a worker's answer is
		// literal, so an @path or a /skill: inside it must reach the model as the
		// characters the worker wrote.
		deepStrictEqual(harness.events, [
			"record-turn",
			"footer",
			"user:[worker result] coder · run r1 · ok · shared by the operator\nsee @plan.md and /skill:writer",
			"render",
			"submit:[worker result] coder · run r1 · ok · shared by the operator\nsee @plan.md and /skill:writer",
		]);
		harness.finishSubmit();
	});

	it("records and paints an expanded chat submission before awaiting the chat loop", async () => {
		const harness = createHarness();
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.context.submitChat("hello");
		await flushAsync();

		deepStrictEqual(harness.events, ["record-turn", "footer", "user:expanded:hello", "render", "submit:expanded:hello"]);
		harness.finishSubmit();
		await flushAsync();
		deepStrictEqual(harness.events, [
			"record-turn",
			"footer",
			"user:expanded:hello",
			"render",
			"submit:expanded:hello",
			"render",
		]);
	});
});
