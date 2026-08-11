import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SafeEventBus } from "../../src/core/event-bus.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";

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
		openProviders: () => events.push("providers"),
		openCost: () => events.push("cost"),
		openContextView: () => events.push("context"),
		openFleet: () => events.push("fleet"),
		openTasks: () => events.push("tasks"),
		openMemory: () => events.push("memory"),
		openView: () => events.push("view"),
		openThinking: () => events.push("thinking"),
		openModel: () => events.push("model"),
		openScopedModels: () => events.push("scoped-models"),
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

		runtime.dispatchCommand("/share import --dry-run /tmp/preview.clio-share.json");
		runtime.dispatchCommand("/share import --dry-rnu /tmp/typo.clio-share.json");
		runtime.dispatchCommand("/share import /tmp/extra.clio-share.json unexpected");
		runtime.dispatchCommand("/share import --force /tmp/apply.clio-share.json");

		deepStrictEqual(planned, [
			{
				path: "/tmp/preview.clio-share.json",
				options: { dryRun: true },
			},
		]);
		deepStrictEqual(imported, [
			{
				path: "/tmp/apply.clio-share.json",
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
