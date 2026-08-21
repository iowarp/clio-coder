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
import { createUserTasksStore } from "../../src/domains/user-tasks/store.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { formatDecisionCorrectionTurn } from "../../src/interactive/overlays/decisions.js";
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
			clearFoldOverrides: () => events.push("clear-folds"),
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
		openDecisions: () => events.push("decisions"),
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
	it("acknowledges captured chat admission before draining the next Stage 0 record", async () => {
		const harness = createHarness();
		const busyError =
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.";
		let phase: "idle" | "admitting" | "streaming" = "idle";
		let releasePreflight = (): void => {};
		const preflight = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let releaseTurn = (): void => {};
		const turn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const submitted: string[] = [];
		const queued: Array<{ text: string; steering: string | undefined }> = [];
		harness.deps.chat.isStreaming = () => phase === "streaming";
		harness.deps.chat.submit = async (text, options) => {
			submitted.push(text);
			if (phase === "admitting") throw new Error(busyError);
			if (phase === "streaming") {
				queued.push({ text, steering: options?.steering });
				return;
			}
			phase = "admitting";
			await preflight;
			phase = "streaming";
			options?.onAdmitted?.();
			await turn;
			phase = "idle";
		};
		const runtime = createInteractiveSlashRuntime(harness.deps);

		const drain = (async () => {
			await runtime.admitCommand("ALPHA");
			await runtime.admitCommand("BRAVO");
		})();
		await flushAsync();
		deepStrictEqual(submitted, ["expanded:ALPHA"], "record two cannot enter while record one is in preflight");

		releasePreflight();
		await flushAsync();
		await drain;
		deepStrictEqual(submitted, ["expanded:ALPHA", "expanded:BRAVO"]);
		deepStrictEqual(
			queued,
			[{ text: "expanded:BRAVO", steering: "end-of-turn" }],
			"record two uses the live turn's FIFO follow-up queue",
		);
		strictEqual(harness.stderr.join("").includes(busyError), false, "the engine invariant cannot leak to the operator");

		releaseTurn();
		await flushAsync();
	});

	it("submits one attributed decision correction through the ordinary user-turn path while idle or streaming", async () => {
		for (const streaming of [false, true]) {
			const harness = createHarness();
			harness.deps.chat.isStreaming = () => streaming;
			const runtime = createInteractiveSlashRuntime(harness.deps);
			const correction = formatDecisionCorrectionTurn(
				{ interviewId: "interview-1", key: "scope", label: "Scope", value: "CLI only" },
				"Include the TUI",
			);

			runtime.context.submitChat(correction);
			await flushAsync();
			deepStrictEqual(
				harness.events.filter((event) => event.startsWith("submit:")),
				[
					'submit:expanded:Decision "Scope" (previously: CLI only) is superseded by the operator. New direction: Include the TUI. Acknowledge and adjust the plan.',
				],
			);
			strictEqual(harness.events.filter((event) => event === "record-turn").length, 1);
			strictEqual(
				harness.events.filter((event) => event.startsWith("user:")).length,
				streaming ? 0 : 1,
				"a streaming correction is queued by chat.submit and is not painted before delivery",
			);
			harness.finishSubmit();
		}
	});

	it("logs without submitting and hands exactly one operator turn while idle or streaming", async () => {
		for (const streaming of [false, true]) {
			const harness = createHarness();
			const cwd = mkdtempSync(join(tmpdir(), `clio-slash-user-tasks-${streaming ? "stream" : "idle"}-`));
			const userTasks = createUserTasksStore({ cwd });
			harness.deps.userTasks = userTasks;
			harness.deps.chat.getSessionId = () => "session-1";
			harness.deps.chat.isStreaming = () => streaming;
			const runtime = createInteractiveSlashRuntime(harness.deps);

			runtime.dispatchCommand("/tasks add write release notes");
			await flushAsync();
			strictEqual(userTasks.get("u1")?.status, "open");
			strictEqual(harness.events.filter((event) => event.startsWith("submit:")).length, 0);

			runtime.dispatchCommand("/tasks hand u1");
			await flushAsync();
			strictEqual(userTasks.get("u1")?.status, "handed");
			strictEqual(userTasks.get("u1")?.handedSessionId, "session-1");
			deepStrictEqual(
				harness.events.filter((event) => event.startsWith("submit:")),
				[
					'submit:expanded:Operator task u1: write release notes. Pick it up with tasks action="pick" id="u1" and work it when appropriate.',
				],
			);
			harness.finishSubmit();
		}
	});

	it("submits nothing when the explicit handoff sidecar mutation fails", async () => {
		const harness = createHarness();
		const cwd = mkdtempSync(join(tmpdir(), "clio-slash-user-tasks-failed-hand-"));
		const durable = createUserTasksStore({ cwd });
		durable.add("keep local");
		harness.deps.userTasks = createUserTasksStore({
			cwd,
			write: () => {
				throw new Error("disk full");
			},
		});
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.dispatchCommand("/tasks hand u1");
		await flushAsync();
		strictEqual(harness.events.filter((event) => event.startsWith("submit:")).length, 0);
		strictEqual(durable.get("u1")?.status, "open");
	});

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
			ok(body.startsWith("# Clio session session-pinned\n\n"), body);
			ok(body.includes("```text\n"), body);
			ok(!body.includes("\x1b"), "Pi terminal control sequences never cross into the transcript export");
			ok(body.includes("PROMPT-ONE"), body);
			ok(body.includes("ANSWER-ONE"), body);
			ok(!body.includes("PROMPT-TWO"), `u2 is past the pin, got:\n${body}`);
			ok(!body.includes("ANSWER-TWO"), `a2 is past the pin, got:\n${body}`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("exports a fixture session as self-contained HTML with semantic tool rows", () => {
		const ts = "2026-08-15T12:00:00.000Z";
		const harness = createHarness();
		harness.deps.chat.getSessionId = () => "session-html";
		harness.deps.now = () => new Date(ts);
		harness.deps.readStructuredEntries = () =>
			[
				{
					kind: "message",
					role: "user",
					turnId: "u1",
					parentTurnId: null,
					timestamp: ts,
					payload: { text: "Run the fixture" },
				},
				{
					kind: "message",
					role: "tool_call",
					turnId: "t1",
					parentTurnId: "u1",
					timestamp: ts,
					payload: { toolCallId: "bash-1", toolName: "bash", args: { command: "printf fixture" } },
				},
				{
					kind: "message",
					role: "tool_result",
					turnId: "t2",
					parentTurnId: "t1",
					timestamp: ts,
					payload: {
						toolCallId: "bash-1",
						toolName: "bash",
						result: { content: [{ type: "text", text: "fixture" }], details: { exitCode: 0 } },
						isError: false,
					},
				},
				{
					kind: "message",
					role: "assistant",
					turnId: "a1",
					parentTurnId: "t2",
					timestamp: ts,
					payload: { text: "Fixture complete" },
				},
			] as SessionEntry[];
		const runtime = createInteractiveSlashRuntime(harness.deps);
		const scratch = mkdtempSync(join(tmpdir(), "clio-export-html-"));
		const previousCwd = process.cwd();
		try {
			process.chdir(scratch);
			runtime.dispatchCommand("/export");
			const target = join(scratch, ".clio-coder", "exports", "session-html-2026-08-15.html");
			const body = readFileSync(target, "utf8");
			ok(body.startsWith("<!doctype html>"), body.slice(0, 80));
			ok(body.includes('class="tool-row" data-tool="ran"'), body);
			ok(body.includes("printf fixture"), body);
			ok(body.includes("Fixture complete"), body);
			ok(!body.includes("\x1b"), "raw terminal control sequences must not cross into HTML");
			ok(!/<(?:link|script)\b[^>]+(?:src|href)=/iu.test(body), "the export must not reference external assets");
		} finally {
			process.chdir(previousCwd);
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

			ok(exported("America/Chicago").includes("session-1-2026-08-14.html"), exported("America/Chicago").join(", "));
			ok(exported("Asia/Kolkata").includes("session-1-2026-08-15.html"), exported("Asia/Kolkata").join(", "));
			ok(exported("UTC").includes("session-1-2026-08-15.html"), exported("UTC").join(", "));
			// The header inside the file stays UTC: it is the machine-readable half.
			ok(
				readFileSync(join(scratch, ".clio-coder", "exports", "session-1-2026-08-15.html"), "utf8").includes(
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
		runtime.dispatchCommand("/decisions");

		deepStrictEqual(harness.events, ["help:model", "tasks", "decisions"]);
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

	it("clears transcript overrides when /output reapplies the current level", () => {
		const harness = createHarness();
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		harness.deps.getSettings = () => settings;
		harness.deps.commitSetting = () => {};
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.dispatchCommand(`/output ${settings.terminal.outputVerbosity}`);

		strictEqual(harness.events.filter((event) => event === "clear-folds").length, 1);
	});

	it("submits a shared worker result as a user turn, and never expands it", async () => {
		const harness = createHarness();
		const runtime = createInteractiveSlashRuntime(harness.deps);

		runtime.context.submitOperatorNote?.(
			"[worker result] coder · run r1 · ok · shared by the operator\nsee @plan.md and /skill writer",
		);
		await flushAsync();

		// The same path typed text takes, minus expansion: a worker's answer is
		// literal, so an @path or a `/skill <name>` inside it must reach the model as the
		// characters the worker wrote.
		deepStrictEqual(harness.events, [
			"record-turn",
			"footer",
			"user:[worker result] coder · run r1 · ok · shared by the operator\nsee @plan.md and /skill writer",
			"render",
			"submit:[worker result] coder · run r1 · ok · shared by the operator\nsee @plan.md and /skill writer",
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
