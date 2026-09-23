import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	armedSkillSurface,
	evaluateSkillToolSurface,
	type PendingSkillToolPolicy,
	SKILL_SURFACE_ENTRY,
	skillSurfaceNames,
	withModelSkillActivation,
} from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { registerLibraryPackage } from "../../src/domains/resources/library.js";
import {
	type LoadSkillsInput,
	loadSkills,
	parsePendingSkillRequests,
} from "../../src/domains/resources/skills/loader.js";
import { type AutonomyLevel, modelMayActivateSkills } from "../../src/domains/safety/autonomy.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { isSessionEntry, isSessionHeader, type SessionEntry } from "../../src/domains/session/index.js";
import { readSessionFileEntries, sessionPaths } from "../../src/engine/session.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoopEvent, type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { createPendingSkillToolPolicy } from "../../src/interactive/chat-loop-messages.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { bashTool } from "../../src/tools/bash.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { limitationTool } from "../../src/tools/limitation.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const roots: string[] = [];

function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-skill-surface-"));
	roots.push(root);
	return root;
}

/** A skill directory whose frontmatter declares the narrowing under test. */
function writeNarrowingSkill(root: string, name: string, frontmatter: ReadonlyArray<string>): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			`description: ${name} interview workflow.`,
			...frontmatter,
			"---",
			"",
			`Run ${name}.`,
			"",
		].join("\n"),
		"utf8",
	);
	return directory;
}

function allowAllSafety(recorded: { reasonCode?: string; decision?: string }[]) {
	return {
		classify: () => ({ actionClass: "read" as const, reasons: [] }),
		evaluate: () => ({ kind: "allow" as const, classification: { actionClass: "read" as const, reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "contract", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: {
			recordCount: () => 0,
			recordToolCall: (row: { reasonCode?: string; decision?: string }) => {
				recorded.push({ ...row });
			},
		},
	};
}

function bashSpec(): ToolSpec {
	return {
		name: ToolNames.Bash,
		description: "contract bash",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok" as const, output: "ran" }),
	};
}

/**
 * The chat loop's per-turn composition, condensed: an operator `/skill` this
 * turn wins, otherwise the turn runs under the surface an earlier turn armed,
 * and the autonomy level stamps model activation on whichever it is.
 */
function turnPolicy(
	input: string,
	root: string,
	armed: PendingSkillToolPolicy | undefined,
	autonomy: AutonomyLevel = "suggest",
): PendingSkillToolPolicy | undefined {
	const list = loadSkills({ cwd: root, disableDiscovery: true, explicitSkillPaths: explicitPaths });
	const requests = parsePendingSkillRequests(input, list, { cwd: root }).pendingSkillRequests;
	return withModelSkillActivation(createPendingSkillToolPolicy(requests) ?? armed, modelMayActivateSkills(autonomy));
}

let explicitPaths: string[] = [];

/** Tool-invoke options for a turn, omitting the key entirely when nothing is armed. */
function invokeOptions(policy: PendingSkillToolPolicy | undefined): { pendingSkillPolicy?: PendingSkillToolPolicy } {
	return policy ? { pendingSkillPolicy: policy } : {};
}

function contextToolFor(root: string) {
	return createContextTool({
		getCwd: () => root,
		getSkillLoaderOptions: () => ({ disableDiscovery: true, explicitSkillPaths: explicitPaths }),
		skillMarketplace: false,
	});
}

describe("skill tool surface lifetime", () => {
	afterEach(() => {
		explicitPaths = [];
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("distinguishes compatibility discoveries from Clio skills in the model inventory", async () => {
		const root = scratchRoot();
		writeNarrowingSkill(join(root, "foreign"), "peer-review", []);
		writeNarrowingSkill(join(root, "native"), "local-review", []);
		const context = createContextTool({
			getCwd: () => root,
			skillMarketplace: false,
			getSkillLoaderOptions: (): LoadSkillsInput => ({
				roots: [
					{ path: join(root, "foreign"), scope: "user", source: "codex", trusted: true },
					{ path: join(root, "native"), scope: "user", source: "clio-coder", trusted: true },
				],
			}),
		});
		const result = await context.run({ scope: "skills" }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") throw new Error("inventory failed");
		match(result.output, /Ready skills in Clio .*\n- local-review \(source: clio-coder/);
		match(result.output, /Explicitly supplied session skills \(not installed packages\)/);
		match(result.output, /peer-review \(source: codex; scope: user; file:/);
		match(result.output, /session availability does not mean Clio installed or copied them/);
		strictEqual(result.output.includes("Installed:"), false);
	});

	it("lets the shipped coding-standards workflow record a scoped finish limitation", async () => {
		const root = scratchRoot();
		const originalCwd = process.cwd();
		process.chdir(root);
		try {
			const directory = join(root, "coding-standards");
			mkdirSync(directory);
			copyFileSync(
				new URL("../../library/skills/coding/coding-standards/SKILL.md", import.meta.url),
				join(directory, "SKILL.md"),
			);
			explicitPaths = [directory];
			const policy = turnPolicy("/skill coding-standards update the fixture", root, undefined);
			ok(policy);
			strictEqual(
				(await contextToolFor(root).run({ scope: "skills", name: "coding-standards" }, invokeOptions(policy))).kind,
				"ok",
			);
			const registry = createRegistry({ safety: allowAllSafety([]) });
			for (const tool of [writeTool, verifyTool, limitationTool, bashTool]) registry.register(tool);
			const entries: unknown[] = [];
			async function invoke(tool: string, args: Record<string, unknown>) {
				const toolCallId = `call-${entries.length}`;
				entries.push({ kind: "message", role: "tool_call", payload: { name: tool, toolCallId, args } });
				const verdict = await registry.invoke({ tool, args }, invokeOptions(policy));
				entries.push({
					kind: "message",
					role: "tool_result",
					payload: {
						toolCallId,
						isError: verdict.kind !== "ok",
						result: verdict.kind === "ok" ? verdict.result : { kind: "error" },
					},
				});
				return verdict;
			}
			const path = join(root, "solver.ts");
			strictEqual((await invoke(ToolNames.Write, { path, content: "export const solver = 1;\n" })).kind, "ok");
			strictEqual(readFileSync(path, "utf8"), "export const solver = 1;\n");
			strictEqual((await invoke(ToolNames.Verify, { check: "test:solver" })).kind, "blocked");
			const unavailable = await invoke(ToolNames.Bash, { command: "npm run test:solver" });
			ok(unavailable.kind === "ok" && unavailable.result.kind === "error", "the scratch project has no test runner");
			strictEqual(assessFinishContract({ sessionEntries: entries }).kind, "engage");
			const recorded = await invoke(ToolNames.Limitation, {
				scope: "The scratch project declares no test runner",
				reason: "no-runner",
				paths: ["test:solver"],
			});
			strictEqual(recorded.kind, "ok", "a mutating skill must be able to record a finish limitation");
			ok(recorded.kind === "ok" && recorded.result.kind === "ok");
			strictEqual(assessFinishContract({ sessionEntries: entries }).reason, "explicit_limitation");
			strictEqual(
				assessFinishContract({
					sessionEntries: entries,
					rigor: "high",
					activeAcceptance: { expectedOutputs: ["solver.ts"], verification: [{ check: "test:solver", timeoutMs: 1000 }] },
				}).reason,
				"explicit_limitation",
			);
			ok(evaluateSkillToolSurface(policy, ToolNames.Verify));
			ok(evaluateSkillToolSurface(policy, ToolNames.Dispatch));
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("records who asked for a skill load so the transcript row can state it", async () => {
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		const context = contextToolFor(root);
		const byOperator = await context.run(
			{ scope: "skills", name: "interview" },
			invokeOptions(turnPolicy("/skill interview start", root, undefined)),
		);
		const byModel = await context.run(
			{ scope: "skills", name: "interview" },
			invokeOptions(turnPolicy("look at the failing test", root, undefined, "full-auto")),
		);
		ok(byOperator.kind === "ok" && byModel.kind === "ok");
		strictEqual((byOperator.details as { activation?: unknown }).activation, "operator");
		strictEqual((byModel.details as { activation?: unknown }).activation, "model");
	});

	it("keeps a loaded skill's narrowing armed on the operator's next turn", async () => {
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		const context = contextToolFor(root);

		// Turn 1: the operator activates the skill and it loads.
		const turnOne = turnPolicy("/skill interview start", root, undefined);
		ok(turnOne !== undefined);
		const loaded = await context.run({ scope: "skills", name: "interview" }, invokeOptions(turnOne));
		strictEqual(loaded.kind, "ok");
		ok(evaluateSkillToolSurface(turnOne, ToolNames.Bash) !== null);

		// Turn 1 settles; the surface it declared stays armed.
		const armed = armedSkillSurface(turnOne);
		ok(armed !== undefined);
		strictEqual(armed.carriedSurface, true);

		// Turn 2 is an ordinary message, and bash is still outside the surface.
		const turnTwo = turnPolicy("next answer", root, armed);
		strictEqual(turnTwo, armed);
		const violation = evaluateSkillToolSurface(turnTwo, ToolNames.Bash);
		ok(violation !== null);
		strictEqual(violation.carriedSurface, true);

		const recorded: { reasonCode?: string; decision?: string }[] = [];
		const registry = createRegistry({ safety: allowAllSafety(recorded) });
		registry.register(bashSpec());
		const verdict = await registry.invoke({ tool: ToolNames.Bash, args: {} }, invokeOptions(turnTwo));
		strictEqual(verdict.kind, "blocked");
		strictEqual(recorded.at(-1)?.reasonCode, "skill_surface");
		if (verdict.kind === "blocked") {
			match(verdict.reason, /stays active for the rest of the session/u);
			match(verdict.reason, /\/skill off/u);
		}
	});

	it("keeps related shipped coding workflows able to record limitations", async () => {
		for (const name of ["tdd", "prototype", "ast-grep"]) {
			const root = scratchRoot();
			const directory = join(root, name);
			mkdirSync(directory);
			copyFileSync(new URL(`../../library/skills/coding/${name}/SKILL.md`, import.meta.url), join(directory, "SKILL.md"));
			explicitPaths = [directory];
			const policy = turnPolicy(`/skill ${name} inspect the fixture`, root, undefined);
			strictEqual((await contextToolFor(root).run({ scope: "skills", name }, invokeOptions(policy))).kind, "ok");
			strictEqual(evaluateSkillToolSurface(policy, ToolNames.Limitation), null, name);
			ok(evaluateSkillToolSurface(policy, ToolNames.Dispatch), name);
		}
	});

	it("preserves read-only narrowing and explicit limitation denials", async () => {
		for (const deniesLimitation of [false, true]) {
			const root = scratchRoot();
			explicitPaths = [
				writeNarrowingSkill(root, "reader", [
					"allowed-tools: read, grep",
					...(deniesLimitation ? ["disallowed-tools: limitation"] : []),
				]),
			];
			const policy = turnPolicy("/skill reader inspect the fixture", root, undefined);
			strictEqual((await contextToolFor(root).run({ scope: "skills", name: "reader" }, invokeOptions(policy))).kind, "ok");
			const registry = createRegistry({ safety: allowAllSafety([]) });
			registry.register(writeTool);
			registry.register(limitationTool);
			strictEqual(
				(
					await registry.invoke(
						{ tool: ToolNames.Write, args: { path: join(root, "refused.ts"), content: "refused" } },
						invokeOptions(policy),
					)
				).kind,
				"blocked",
			);
			const result = await registry.invoke(
				{ tool: ToolNames.Limitation, args: { scope: "No changes were requested", reason: "out-of-scope" } },
				invokeOptions(policy),
			);
			strictEqual(result.kind, deniesLimitation ? "blocked" : "ok");
		}
	});

	for (const route of ["dispatch", "admit", "submitChat"] as const) {
		it(`lifts the narrowing through runtime ${route} before expanding /skill off`, async () => {
			const root = scratchRoot();
			explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
			const context = contextToolFor(root);
			const turnOne = turnPolicy("/skill interview start", root, undefined);
			await context.run({ scope: "skills", name: "interview" }, invokeOptions(turnOne));
			const armed = armedSkillSurface(turnOne);
			ok(armed !== undefined);

			// `/skill off` is its own command: it clears the surface instead of
			// submitting a turn that tries to load a skill named "off".
			deepStrictEqual(parseSlashCommand("/skill off"), { kind: "skill-surface-clear" });
			const notices: Array<[string, string]> = [];
			let submitted = 0;
			let held: PendingSkillToolPolicy | undefined = armed;
			let expanded = 0;
			let asked = 0;
			const cleared: Array<ReadonlyArray<string>> = [];
			const errors: string[] = [];
			const runtime = createInteractiveSlashRuntime({
				io: { stdout() {}, stderr: (text: string) => errors.push(text) },
				chatPanel: { appendReplayBlock() {}, appendUser() {} },
				requestRender() {},
				refreshFooter() {},
				recordSubmittedTurn() {},
				chat: {
					isStreaming: () => false,
					submit: async () => {
						submitted += 1;
					},
					clearSkillSurface: () => {
						const names = skillSurfaceNames(held);
						cleared.push(names);
						held = undefined;
						return names;
					},
				},
				expandSubmit: async (text: string) => {
					expanded += 1;
					const skills = loadSkills({ cwd: root, disableDiscovery: true, explicitSkillPaths: explicitPaths });
					return { ...parsePendingSkillRequests(text, skills, { cwd: root }), images: [], workingContextPaths: [] };
				},
				openAskUser: async () => {
					asked += 1;
					return { cancelled: true, answers: [] };
				},
			} as unknown as InteractiveSlashRuntimeDeps);
			runtime.context.notice = (level, text) => notices.push([level, text]);
			if (route === "dispatch") strictEqual(runtime.dispatchCommand("/skill off"), "accepted");
			else if (route === "admit") await runtime.admitCommand("/skill off");
			else runtime.context.submitChat("/skill off");
			await new Promise<void>((resolve) => setImmediate(resolve));
			deepStrictEqual(errors, []);
			strictEqual(expanded, 0, "clearing must precede skill lookup and expansion");
			strictEqual(asked, 0);
			strictEqual(submitted, 0);
			strictEqual(held, undefined);
			// The TUI states the cleared surface once, as the chat loop's `§`
			// row; `/skill off` adds no reply that repeats it.
			deepStrictEqual(cleared, [["interview"]]);
			deepStrictEqual(notices, []);

			// The next turn runs with the full surface back.
			const turnTwo = turnPolicy("keep going", root, held);
			strictEqual(turnTwo, undefined);
			strictEqual(evaluateSkillToolSurface(turnTwo, ToolNames.Bash), null);
			const registry = createRegistry({ safety: allowAllSafety([]) });
			registry.register(bashSpec());
			const verdict = await registry.invoke({ tool: ToolNames.Bash, args: {} }, invokeOptions(turnTwo));
			strictEqual(verdict.kind, "ok");
		});
	}

	it("states each surface change once, as a § row live and on resume, and names the armed skills for the footer", async () => {
		const env = await isolateClioEnv("clio-coder-skill-surface-rows-");
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.prewarm = false;
		const context = dispatchStubContext({ settings });
		const target = settings.targets[0];
		ok(target);
		settings.chat.target = target.id;
		settings.chat.model = target.defaultModel ?? "gpt-4o";
		const session = createSessionBundle(context).contract;
		const entries = (): SessionEntry[] => {
			const meta = session.current();
			if (!meta) return [];
			return readSessionFileEntries(sessionPaths(meta).current).filter(
				(entry): entry is SessionEntry => !isSessionHeader(entry) && isSessionEntry(entry),
			);
		};
		const registry = createRegistry({ safety: allowAllSafety([]) });
		registry.register(contextToolFor(root));
		const events: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
			knownTargets: () => new Set([target.id]),
			session,
			readSessionEntries: entries,
			toolRegistry: registry,
			createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
				const state = options?.initialState;
				ok(state);
				let listener: ((event: AgentEvent) => void) | undefined;
				return {
					agent: {
						state,
						abort() {},
						subscribe: (callback: (event: AgentEvent) => void) => {
							listener = callback;
							return () => {};
						},
						// The model loads the skill the operator asked for, through the
						// same agent tool, policy and persistence a real turn uses.
						prompt: async () => {
							const tool = state.tools?.find((entry) => entry.name === ToolNames.Context);
							ok(tool);
							const args = { scope: "skills", name: "interview" };
							listener?.({ type: "tool_execution_start", toolName: tool.name, toolCallId: "load", args });
							const result = await tool.execute("load", args);
							listener?.({ type: "tool_execution_end", toolName: tool.name, toolCallId: "load", result, isError: false });
							const message = {
								role: "assistant",
								content: [{ type: "text", text: "Interview started." }],
								stopReason: "stop",
								timestamp: Date.now(),
							} as AgentMessage;
							state.messages?.push(message);
							listener?.({ type: "message_end", message });
						},
					},
					requestCorrelationId: () => undefined,
				};
			}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
		});
		loop.onEvent((event) => events.push(event));
		const surfaceNotices = () =>
			events.flatMap((event) =>
				event.type === "notice" && event.skillSurface !== undefined ? [event.skillSurface.state] : [],
			);
		try {
			const skills = loadSkills({ cwd: root, disableDiscovery: true, explicitSkillPaths: explicitPaths });
			const pending = parsePendingSkillRequests("/skill interview start", skills, { cwd: root });
			await loop.submit(pending.text, {
				pendingSkillRequests: pending.pendingSkillRequests,
				display: { text: "/skill interview start" },
			});
			deepStrictEqual(loop.activeSkillSurface(), ["interview"]);
			deepStrictEqual(surfaceNotices(), ["armed"]);
			deepStrictEqual(loop.clearSkillSurface(), ["interview"]);
			deepStrictEqual(loop.activeSkillSurface(), []);
			deepStrictEqual(surfaceNotices(), ["armed", "cleared"]);
			// Nothing armed: a second `/skill off` changes nothing and states nothing.
			deepStrictEqual(loop.clearSkillSurface(), []);
			deepStrictEqual(surfaceNotices(), ["armed", "cleared"]);

			const recorded = entries().flatMap((entry) =>
				entry.kind === "custom" && entry.customType === SKILL_SURFACE_ENTRY ? [entry.data] : [],
			);
			deepStrictEqual(recorded, [
				{
					version: 1,
					state: "armed",
					names: ["interview"],
					previous: [],
					allowedTools: ["read", "grep"],
					disallowedTools: [],
				},
				{ version: 1, state: "cleared", names: [], previous: ["interview"], allowedTools: [], disallowedTools: [] },
			]);

			// Each change reads as one `§` row and never also as the notice text.
			const surfaceRows = (lines: string[]) => {
				const plain = lines.map(stripTerminalSequences);
				ok(!plain.some((line) => /Skill activated|surface cleared:/u.test(line)), plain.join("\n"));
				return plain.filter((line) => line.startsWith("§ "));
			};
			const live = createChatPanel();
			for (const event of events) live.applyEvent(event);
			const replayed = createChatPanel();
			rehydrateChatPanelFromTurns(replayed, entries());
			// A resumed prompt row leads with the command, as the live row did.
			ok(replayed.render(100).map(stripTerminalSequences).includes("▌ /skill interview start"));
			for (const panel of [live, replayed]) {
				const [load, ...changes] = surfaceRows(panel.render(100));
				match(load ?? "", /^§ loaded skill interview · by operator ✓/u);
				deepStrictEqual(changes, ["§ interview armed · read, grep · /skill off", "§ skill surface cleared"]);
			}
		} finally {
			loop.dispose();
			await loop.whenSettled();
			await session.close();
			env.restore();
		}
	});

	for (const mode of ["installed", "user", "project"] as const) {
		const installed = mode === "installed";
		it(`preserves runtime skill activation when ${installed ? "installed" : `${mode} installation is approved`}`, async () => {
			const root = scratchRoot();
			const directory = writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"]);
			explicitPaths = [directory];
			let available = installed;
			let asked = 0;
			let installs = 0;
			let reloads = 0;
			let submitted = 0;
			let expanded = 0;
			let held: PendingSkillToolPolicy | undefined;
			const painted: string[] = [];
			const errors: string[] = [];
			const runtime = createInteractiveSlashRuntime({
				io: { stdout() {}, stderr: (text: string) => errors.push(text) },
				getCwd: () => root,
				chatPanel: {
					appendReplayBlock() {},
					appendUser: (text: string) => painted.push(text),
				},
				requestRender() {},
				refreshFooter() {},
				recordSubmittedTurn() {},
				chat: {
					isStreaming: () => false,
					submit: async (...[text, options]: Parameters<InteractiveSlashRuntimeDeps["chat"]["submit"]>) => {
						submitted += 1;
						strictEqual(text, "start");
						// The ledger keeps the line the operator typed, with no template note.
						deepStrictEqual(options?.display, { text: "/skill interview start" });
						const policy = createPendingSkillToolPolicy(options?.pendingSkillRequests ?? []);
						ok(policy);
						strictEqual(
							(await contextToolFor(root).run({ scope: "skills", name: "interview" }, invokeOptions(policy))).kind,
							"ok",
						);
						held = armedSkillSurface(policy);
					},
					clearSkillSurface: () => {
						throw new Error("named invocation must not clear the surface");
					},
				},
				expandSubmit: async (text: string) => {
					expanded += 1;
					const skills = loadSkills({ cwd: root, disableDiscovery: true, explicitSkillPaths: explicitPaths });
					const parsed = parsePendingSkillRequests(text, skills, { cwd: root });
					return {
						...parsed,
						pendingSkillRequests: available
							? parsed.pendingSkillRequests
							: [{ name: "interview", args: "start", source: "marketplace", installed: false, marketplaceRef: directory }],
						images: [],
						workingContextPaths: [],
					};
				},
				openAskUser: async () => {
					asked += 1;
					return {
						cancelled: false,
						answers: [{ answer: mode === "project" ? "Install for this project and run" : "Install and run" }],
					};
				},
				installSkill: (input: Parameters<NonNullable<InteractiveSlashRuntimeDeps["installSkill"]>>[0]) => {
					strictEqual(input.source, "interview");
					strictEqual(input.cwd, root);
					strictEqual(input.scope, mode);
					strictEqual("configDir" in input, false);
					installs += 1;
					available = true;
				},
				resources: {
					reload: async () => {
						reloads += 1;
					},
				},
			} as unknown as InteractiveSlashRuntimeDeps);
			await runtime.admitCommand("/skill interview start");
			await new Promise<void>((resolve) => setImmediate(resolve));
			deepStrictEqual(errors, []);
			strictEqual(submitted, 1);
			// The prompt row leads with the command the operator typed; the model gets the task.
			deepStrictEqual(painted, ["/skill interview start"]);
			strictEqual(asked, installed ? 0 : 1);
			strictEqual(installs, installed ? 0 : 1);
			strictEqual(reloads, installed ? 0 : 1);
			strictEqual(expanded, installed ? 1 : 2);
			deepStrictEqual(skillSurfaceNames(held), ["interview"]);
			ok(evaluateSkillToolSurface(held, ToolNames.Bash));
		});
	}

	it("replaces rather than merges when the operator activates a different skill", async () => {
		const root = scratchRoot();
		explicitPaths = [
			writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"]),
			writeNarrowingSkill(root, "builder", ["allowed-tools: write"]),
		];
		const context = contextToolFor(root);
		const turnOne = turnPolicy("/skill interview start", root, undefined);
		await context.run({ scope: "skills", name: "interview" }, invokeOptions(turnOne));
		const armed = armedSkillSurface(turnOne);
		ok(armed !== undefined);

		const turnTwo = turnPolicy("/skill builder go", root, armed);
		ok(turnTwo !== undefined);
		strictEqual(turnTwo === armed, false, "a fresh /skill must not run under the previous skill's policy");
		await context.run({ scope: "skills", name: "builder" }, invokeOptions(turnTwo));
		const replaced = armedSkillSurface(turnTwo);
		ok(replaced !== undefined);
		strictEqual(skillSurfaceNames(replaced).join(","), "builder");
		// The replaced skill's surface is gone, not unioned with the new one.
		strictEqual(evaluateSkillToolSurface(replaced, ToolNames.Write), null);
		ok(evaluateSkillToolSurface(replaced, ToolNames.Read) !== null);
	});
});

describe("model skill activation by autonomy level", () => {
	afterEach(() => {
		explicitPaths = [];
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	for (const autonomy of ["auto-edit", "full-auto"] as const) {
		it(`activates an installed skill on a model call at ${autonomy}`, async () => {
			const root = scratchRoot();
			explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
			const context = contextToolFor(root);
			// No /skill this turn: the model calls context(scope="skills") itself.
			const policy = turnPolicy("look at the failing test", root, undefined, autonomy);
			ok(policy !== undefined);
			strictEqual(policy.modelActivation, true);
			const activated = await context.run({ scope: "skills", name: "interview" }, invokeOptions(policy));
			strictEqual(activated.kind, "ok");
			if (activated.kind === "ok") match(activated.output, /Run interview\./u);

			// The narrowing it declared binds the very next call of the same turn.
			const recorded: { reasonCode?: string; decision?: string }[] = [];
			const registry = createRegistry({ safety: allowAllSafety(recorded) });
			registry.register(bashSpec());
			const verdict = await registry.invoke({ tool: ToolNames.Bash, args: {} }, invokeOptions(policy));
			strictEqual(verdict.kind, "blocked");
			strictEqual(recorded.at(-1)?.reasonCode, "skill_surface");
		});
	}

	for (const autonomy of ["read-only", "suggest"] as const) {
		it(`keeps activation operator-gated at ${autonomy}`, async () => {
			const root = scratchRoot();
			explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
			const context = contextToolFor(root);
			const policy = turnPolicy("look at the failing test", root, undefined, autonomy);
			strictEqual(policy, undefined);
			const refused = await context.run({ scope: "skills", name: "interview" }, invokeOptions(policy));
			strictEqual(refused.kind, "error");
			if (refused.kind === "error") {
				match(refused.message, /only the operator can activate a skill/u);
				match(refused.message, /Suggested skill: \/skill/u);
				deepStrictEqual(refused.details?.refusal, { subject: "skill", name: "interview", kind: "operator-only" });
			}
		});
	}

	it("still refuses an uninstalled marketplace skill at full-auto", async () => {
		const root = scratchRoot();
		explicitPaths = [writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"])];
		// A catalog the operator could install from, holding a skill that is not installed here.
		const catalog = join(root, "catalog");
		mkdirSync(catalog, { recursive: true });
		const source = writeNarrowingSkill(catalog, "marketplace-only", []);
		writeFileSync(
			join(source, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "marketplace-only",
				version: "1.0.0",
				extensions: {
					"ai.iowarp.clio": {
						manifestVersion: 1,
						kind: "skill",
						resources: { skills: "." },
						components: [{ kind: "skill", id: "marketplace-only", path: "SKILL.md" }],
					},
				},
			}),
		);
		registerLibraryPackage(source, { cwd: root, scope: "project" });

		// Marketplace rows only appear when discovery is on, which is what makes
		// this the real not-installed path rather than an unknown-name miss.
		const context = createContextTool({
			getCwd: () => root,
			getSkillLoaderOptions: () => ({ explicitSkillPaths: explicitPaths }),
		});
		const policy = turnPolicy("do the thing", root, undefined, "full-auto");
		ok(policy !== undefined);
		const refused = await context.run({ scope: "skills", name: "marketplace-only" }, invokeOptions(policy));
		strictEqual(refused.kind, "error");
		if (refused.kind === "error") {
			match(refused.message, /is not installed; it is available in the marketplace/u);
			match(refused.message, /offer \/skill marketplace-only to install it/u);
			deepStrictEqual(refused.details?.refusal, { subject: "skill", name: "marketplace-only", kind: "not-installed" });
		}
	});

	it("states why a load was refused as structured details beside the model's unchanged message", async () => {
		const root = scratchRoot();
		explicitPaths = [
			writeNarrowingSkill(root, "interview", ["allowed-tools: read, grep"]),
			writeNarrowingSkill(root, "manual", ["disable-model-invocation: true"]),
		];
		const context = contextToolFor(root);
		const refusal = async (name: string, policy: PendingSkillToolPolicy | undefined) => {
			const result = await context.run({ scope: "skills", name }, invokeOptions(policy));
			ok(result.kind === "error", `${name} must be refused`);
			match(result.message, /^context: /u, "the model still reads the policy text");
			return result.details?.refusal;
		};
		const auto = turnPolicy("look at the failing test", root, undefined, "full-auto");
		deepStrictEqual(await refusal("manual", auto), { subject: "skill", name: "manual", kind: "manual-only" });
		deepStrictEqual(await refusal("absent", auto), { subject: "skill", name: "absent", kind: "unknown" });
		strictEqual((await context.run({ scope: "skills", name: "interview" }, invokeOptions(auto))).kind, "ok");
		deepStrictEqual(await refusal("interview", auto), { subject: "skill", name: "interview", kind: "already-loaded" });
		// An operator request this turn admits only the skill it names.
		const requested = turnPolicy("/skill interview start", root, undefined);
		deepStrictEqual(await refusal("manual", requested), { subject: "skill", name: "manual", kind: "not-requested" });
		strictEqual((await context.run({ scope: "skills", name: "interview" }, invokeOptions(requested))).kind, "ok");
		deepStrictEqual(await refusal("interview", requested), {
			subject: "skill",
			name: "interview",
			kind: "already-loaded",
		});
	});
});
