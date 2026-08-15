import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { BusChannels, type ConfigReloadFailedPayload } from "../../src/core/bus-events.js";
import {
	formatSettingsFailure,
	readSettings,
	SettingsValidationError,
	settingsPath,
	updateSettings,
	validateSettings,
	validateSettingsFile,
} from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { expandConfigPath, expandConfigValue } from "../../src/core/resolve-config-value.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import { createConfigBundle } from "../../src/domains/config/extension.js";
import { advanceScopedTarget } from "../../src/entry/orchestrator.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/config", () => {
	it("keeps first-run default settings YAML generic, parseable, and schema-clean", () => {
		const forbidden = [
			/\bmini\b/i,
			/\bdynamo\b/i,
			/\bzbook\b/i,
			/\b192\.168\./,
			/\bQwopus\b/i,
			/\bAgenticQwen\b/i,
			/\bQwen3\.6\b/i,
			/\bNemotron\b/i,
			/\bgemma-4\b/i,
			/\b262144\b/,
			/\b65536\b/,
			/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/,
			/http:\/\/(?!localhost(?::|\/|$)|127\.0\.0\.1(?::|\/|$))[a-z0-9.-]+(?::\d+)?/i,
		];
		for (const pattern of forbidden) {
			strictEqual(pattern.test(DEFAULT_SETTINGS_YAML), false, `DEFAULT_SETTINGS_YAML leaked ${pattern}`);
		}

		const parsed = parseYaml(DEFAULT_SETTINGS_YAML) as unknown;
		const result = validateSettings(parsed);
		deepStrictEqual(result.issues, []);
		deepStrictEqual(result.settings, DEFAULT_SETTINGS);
	});

	// BUG-008: validateSettingsFile falls back to defaults for a genuinely missing
	// file before calling validateSettings, so a null/undefined/empty document
	// reaching validateSettings is a present, malformed file, not a valid default.
	it("rejects a present null, undefined, or empty settings document as a root-shape issue", () => {
		for (const raw of [null, undefined, parseYaml(""), parseYaml("null\n")]) {
			const result = validateSettings(raw);
			strictEqual(
				result.issues.some(
					(issue) => issue.path === "(root)" && /expected a map, got (null|undefined)/.test(issue.message),
				),
				true,
				`expected a root-shape issue for ${JSON.stringify(raw)}`,
			);
			deepStrictEqual(result.settings, DEFAULT_SETTINGS);
		}
	});

	it("validates target config and fills default/fallback models", () => {
		const result = validateSettings({
			identity: "clio",
			targets: [
				{
					id: "hosted-target",
					runtime: "openai-codex",
					wireModels: ["primary-model", "worker-model", "primary-model"],
				},
			],
			orchestrator: {
				target: "missing-target",
				model: "stale-model",
				thinkingLevel: "xhigh",
			},
			background: {
				target: "hosted-target",
				model: "worker-model",
				thinkingLevel: "low",
			},
			workers: {
				default: {
					target: "hosted-target",
					model: null,
					thinkingLevel: "medium",
				},
			},
		});

		deepStrictEqual(result.issues, []);
		const settings = result.settings;
		strictEqual(settings.targets[0]?.defaultModel, "primary-model");
		deepStrictEqual(settings.targets[0]?.wireModels, ["primary-model", "worker-model"]);
		// Dangling routing references are normalized away, not aliased.
		strictEqual(settings.orchestrator.target, null);
		strictEqual(settings.orchestrator.model, null);
		strictEqual(settings.background.target, "hosted-target");
		strictEqual(settings.background.model, "worker-model");
		strictEqual(settings.background.thinkingLevel, "low");
		strictEqual(settings.workers.default.target, "hosted-target");
		strictEqual(settings.workers.default.model, "primary-model");
		strictEqual(settings.skills.trustProjectCompatRoots, false);
	});

	it("validates proactive-memory trigger settings and classifies them for the next turn", () => {
		const result = validateSettings({
			memory: {
				intervention: {
					enabled: false,
					everyNTools: 6,
					windowSteps: 12,
					maxTokens: 250,
					timeoutMs: 7_500,
				},
			},
		});
		deepStrictEqual(result.issues, []);
		deepStrictEqual(result.settings.memory.intervention, {
			enabled: false,
			everyNTools: 6,
			windowSteps: 12,
			maxTokens: 250,
			timeoutMs: 7_500,
		});
		const changed = diffSettings(DEFAULT_SETTINGS, result.settings);
		deepStrictEqual(changed.nextTurn, [
			"memory.intervention.enabled",
			"memory.intervention.everyNTools",
			"memory.intervention.windowSteps",
			"memory.intervention.maxTokens",
			"memory.intervention.timeoutMs",
		]);
	});

	it("rejects malformed proactive-memory settings without accepting partial invalid values", () => {
		const result = validateSettings({
			memory: {
				intervention: { enabled: "yes", everyNTools: 0, timeoutMs: 1.5, extra: true },
			},
		});
		deepStrictEqual(result.issues.map((issue) => issue.path).sort(), [
			"memory.intervention.enabled",
			"memory.intervention.everyNTools",
			"memory.intervention.extra",
			"memory.intervention.timeoutMs",
		]);
		deepStrictEqual(result.settings.memory.intervention, DEFAULT_SETTINGS.memory.intervention);
	});

	it("reports unknown keys as validation errors with exact paths", () => {
		const result = validateSettings({
			defaultMode: "super",
			safetyLevel: "full-auto",
			state: {
				recentModels: ["model-a"],
			},
			compaction: {
				threshold: 0.92,
				thresholds: { llmSummary: 0.99 },
			},
		});
		const paths = result.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["compaction.thresholds", "defaultMode", "safetyLevel", "state"]);
		for (const issue of result.issues) strictEqual(issue.message, "unknown key");
		// Valid fields still land on the built settings.
		strictEqual(result.settings.compaction.threshold, 0.92);
	});

	it("reports type and enum violations as validation errors with exact paths", () => {
		const result = validateSettings({
			autonomy: "bananas",
			budget: { concurrency: 0 },
			targets: [{ runtime: "openai-compat" }],
			retry: { maxRetries: 1.5 },
		});
		const paths = result.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["autonomy", "budget.concurrency", "retry.maxRetries", "targets[0].id"]);
		// Invalid fields fall back to defaults on the built settings.
		strictEqual(result.settings.autonomy, DEFAULT_SETTINGS.autonomy);
		strictEqual(result.settings.budget.concurrency, "auto");
	});

	it("validates active routing roles and postures as strict unique lists", () => {
		const valid = validateSettings({
			routing: {
				activeRoles: ["researcher", "judge"],
				activePostures: ["balanced", "quality"],
				agentAutomation: { activeAgentRoles: [{ agentId: "scout", executionRole: "researcher" }] },
			},
		});
		deepStrictEqual(valid.issues, []);
		deepStrictEqual(valid.settings.routing, {
			activeRoles: ["researcher", "judge"],
			activePostures: ["balanced", "quality"],
			agentAutomation: { activeAgentRoles: [{ agentId: "scout", executionRole: "researcher" }] },
		});

		const invalid = validateSettings({
			routing: {
				activeRoles: ["builder", "judge", "judge"],
				activePostures: ["manual"],
				agentAutomation: {
					activeAgentRoles: [
						{ agentId: "auto", executionRole: "recovery" },
						{ agentId: "scout", executionRole: "researcher", extra: true },
					],
				},
			},
		});
		const invalidPaths = invalid.issues.map((issue) => issue.path);
		deepStrictEqual(invalidPaths.slice(0, 3), ["routing.activeRoles", "routing.activeRoles", "routing.activePostures"]);
		strictEqual(invalidPaths.includes("routing.agentAutomation.activeAgentRoles[0].agentId"), true);
		strictEqual(invalidPaths.includes("routing.agentAutomation.activeAgentRoles[0].executionRole"), true);
		strictEqual(invalidPaths.includes("routing.agentAutomation.activeAgentRoles[1].extra"), true);
		deepStrictEqual(invalid.settings.routing, DEFAULT_SETTINGS.routing);
	});

	it("validates the guardrails section and rejects bad values and unknown subkeys", () => {
		const ok = validateSettings({ guardrails: { turnToolCallBudget: 30, readMaxBytes: 4096 } });
		deepStrictEqual(ok.issues, []);
		strictEqual(ok.settings.guardrails.turnToolCallBudget, 30);
		strictEqual(ok.settings.guardrails.readMaxBytes, 4096);
		// Unset keys keep the shipped defaults.
		strictEqual(ok.settings.guardrails.workerToolCallCap, DEFAULT_SETTINGS.guardrails.workerToolCallCap);

		const bad = validateSettings({ guardrails: { turnToolCallBudget: 0, maxRuns: 5 } });
		const paths = bad.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["guardrails.maxRuns", "guardrails.turnToolCallBudget"]);
		strictEqual(bad.settings.guardrails.turnToolCallBudget, DEFAULT_SETTINGS.guardrails.turnToolCallBudget);
	});

	it("validates defaults.maxTokens and rejects bad values and unknown subkeys", () => {
		const ok = validateSettings({ defaults: { maxTokens: 16384 } });
		deepStrictEqual(ok.issues, []);
		strictEqual(ok.settings.defaults.maxTokens, 16384);

		// 0 is a valid sentinel meaning "fall back to per-model caps".
		strictEqual(validateSettings({ defaults: { maxTokens: 0 } }).settings.defaults.maxTokens, 0);

		const bad = validateSettings({ defaults: { maxTokens: -1, foo: 1 } });
		const paths = bad.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["defaults.foo", "defaults.maxTokens"]);
		// Invalid value falls back to the shipped default.
		strictEqual(bad.settings.defaults.maxTokens, DEFAULT_SETTINGS.defaults.maxTokens);
	});

	it("rejects duplicate target ids and duplicate delegation agent ids", () => {
		const result = validateSettings({
			targets: [
				{ id: "local", runtime: "openai-compat" },
				{ id: "local", runtime: "llamacpp" },
			],
			delegation: {
				agents: [
					{ id: "opencode", command: "opencode" },
					{ id: "opencode", command: "ignored" },
				],
			},
		});
		const paths = result.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["delegation.agents[1].id", "targets[1].id"]);
		strictEqual(result.settings.targets.length, 1);
		strictEqual(result.settings.delegation.agents.length, 1);
	});

	it("validates skills trust settings and treats them as next-turn changes", () => {
		const result = validateSettings({
			skills: {
				trustProjectCompatRoots: true,
			},
		});
		deepStrictEqual(result.issues, []);
		strictEqual(result.settings.skills.trustProjectCompatRoots, true);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.skills.trustProjectCompatRoots = true;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn, ["skills.trustProjectCompatRoots"]);
		deepStrictEqual(diff.restartRequired, []);
	});

	it("validates ACP delegation agents and treats them as next-turn settings", () => {
		const result = validateSettings({
			delegation: {
				defaults: {
					connectTimeoutMs: 7,
					turnTimeoutMs: 11,
					permissionTimeoutMs: 13,
					toolGovernance: "deny-all",
				},
				agents: [
					{
						id: "opencode",
						command: "opencode",
						args: ["acp", "--cwd", "."],
						toolGovernance: "clio-policy",
						labels: { specialty: "coding" },
					},
				],
			},
		});

		deepStrictEqual(result.issues, []);
		const settings = result.settings;
		strictEqual(settings.delegation.defaults.connectTimeoutMs, 7);
		strictEqual(settings.delegation.defaults.toolGovernance, "deny-all");
		strictEqual(settings.delegation.agents.length, 1);
		strictEqual(settings.delegation.agents[0]?.id, "opencode");
		strictEqual(settings.delegation.agents[0]?.turnTimeoutMs, 11);
		strictEqual(settings.delegation.agents[0]?.toolGovernance, "clio-policy");
		deepStrictEqual(settings.delegation.agents[0]?.args, ["acp", "--cwd", "."]);
		// Project context is explicit opt-in: absent key stays absent (dispatch
		// treats absent as "none").
		strictEqual(settings.delegation.agents[0]?.projectContext, undefined);

		const optedIn = validateSettings({
			delegation: {
				agents: [{ id: "opencode", command: "opencode", projectContext: "bounded" }],
			},
		});
		deepStrictEqual(optedIn.issues, []);
		strictEqual(optedIn.settings.delegation.agents[0]?.projectContext, "bounded");

		const badTier = validateSettings({
			delegation: {
				agents: [{ id: "opencode", command: "opencode", projectContext: "full" }],
			},
		});
		strictEqual(
			badTier.issues.some((issue) => issue.path === "delegation.agents[0].projectContext"),
			true,
		);

		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.delegation.agents = settings.delegation.agents;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn, ["delegation.agents.0"]);
		deepStrictEqual(diff.restartRequired, []);
	});

	it("rejects unschedulable ACP request bounds while preserving the documented zero stall disable", () => {
		for (const invalid of [0, MAX_TIMER_DELAY_MS + 1]) {
			const result = validateSettings({
				delegation: {
					defaults: {
						connectTimeoutMs: invalid,
						turnTimeoutMs: invalid,
						permissionTimeoutMs: invalid,
					},
					agents: [
						{
							id: "silent",
							command: "silent-acp",
							connectTimeoutMs: invalid,
							turnTimeoutMs: invalid,
							permissionTimeoutMs: invalid,
							stallTimeoutMs: 0,
						},
					],
				},
			});

			deepStrictEqual(result.issues.map((issue) => issue.path).sort(), [
				"delegation.agents[0].connectTimeoutMs",
				"delegation.agents[0].permissionTimeoutMs",
				"delegation.agents[0].turnTimeoutMs",
				"delegation.defaults.connectTimeoutMs",
				"delegation.defaults.permissionTimeoutMs",
				"delegation.defaults.turnTimeoutMs",
			]);
			deepStrictEqual(result.settings.delegation.defaults, DEFAULT_SETTINGS.delegation.defaults);
			strictEqual(
				result.settings.delegation.agents[0]?.connectTimeoutMs,
				DEFAULT_SETTINGS.delegation.defaults.connectTimeoutMs,
			);
			strictEqual(result.settings.delegation.agents[0]?.turnTimeoutMs, DEFAULT_SETTINGS.delegation.defaults.turnTimeoutMs);
			strictEqual(
				result.settings.delegation.agents[0]?.permissionTimeoutMs,
				DEFAULT_SETTINGS.delegation.defaults.permissionTimeoutMs,
			);
			strictEqual(result.settings.delegation.agents[0]?.stallTimeoutMs, 0);
		}
	});

	it("classifies settings changes next-turn updates", () => {
		const prev = structuredClone(DEFAULT_SETTINGS);
		const next = structuredClone(DEFAULT_SETTINGS);
		next.compaction.auto = false;
		next.compaction.threshold = 0.9;
		const diff = diffSettings(prev, next);
		deepStrictEqual(diff.hotReload, []);
		deepStrictEqual(diff.nextTurn.sort(), ["compaction.auto", "compaction.threshold"]);
	});

	it("skips targets whose runtime is unregistered or non-http in scoped cycling", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "chat", runtime: "openai-compat", defaultModel: "chat-model" },
			// codex-cli was removed from the registry; an unresolved runtime target
			// must be skipped rather than cycled into the orchestrator slot.
			{ id: "codex-worker", runtime: "codex-cli", defaultModel: "gpt-5.4" },
		];
		settings.orchestrator.target = "chat";
		settings.orchestrator.model = "chat-model";
		settings.scope = ["codex-worker", "chat"];

		strictEqual(advanceScopedTarget(settings, "forward")?.target, "chat");
		settings.scope = ["codex-worker"];
		strictEqual(advanceScopedTarget(settings, "forward"), null);
	});

	// A renamed or temporarily removed target is the common way a cycle-set ref
	// goes stale. Dropping it at load destroyed a preference the operator never
	// touched, before the checklist's Unavailable group could disclose it.
	it("keeps scope refs whose target is not configured, and skips them when cycling", () => {
		const result = validateSettings({
			targets: [{ id: "chat", runtime: "openai-compat", defaultModel: "chat-model" }],
			orchestrator: { target: "chat", model: "chat-model" },
			scope: ["ghost-target/ghost-model", "chat/chat-model", "phantom-target", "chat/chat-model"],
		});

		deepStrictEqual(result.issues, []);
		deepStrictEqual(result.settings.scope, ["ghost-target/ghost-model", "chat/chat-model", "phantom-target"]);
		// Routing must not resolve the ghosts: cycling steps over them.
		deepStrictEqual(advanceScopedTarget(result.settings, "forward"), { target: "chat", model: "chat-model" });
		deepStrictEqual(advanceScopedTarget(result.settings, "backward"), { target: "chat", model: "chat-model" });
		const ghostsOnly = structuredClone(result.settings);
		ghostsOnly.scope = ["ghost-target/ghost-model", "phantom-target"];
		strictEqual(advanceScopedTarget(ghostsOnly, "forward"), null);
	});

	it("expands environment variable references", () => {
		strictEqual(
			expandConfigValue(`Bearer $${"{CLIO_CODER_TOKEN}"}`, { env: { CLIO_CODER_TOKEN: "secret" } }),
			"Bearer secret",
		);
	});

	it("expands home-relative and env-bearing paths", () => {
		strictEqual(expandConfigPath("~/skills"), join(homedir(), "skills"));
		strictEqual(
			expandConfigPath("$PROJECT_DIR/skills", { cwd: "/tmp/repo", env: { PROJECT_DIR: "local" } }),
			"/tmp/repo/local/skills",
		);
	});

	it("validates workers resilience configuration", () => {
		const result = validateSettings({
			workers: {
				default: {
					target: null,
					model: null,
					thinkingLevel: "off",
				},
				maxRetries: 4,
				resilienceCooldownMs: 8000,
			},
		});
		deepStrictEqual(result.issues, []);
		strictEqual(result.settings.workers.maxRetries, 4);
		strictEqual(result.settings.workers.resilienceCooldownMs, 8000);
	});
});

/**
 * A settings file that goes bad while a session is live used to reach the
 * operator as `console.error("reload rejected:", err)`, which inside the TUI
 * printed a util.inspect dump of the error (visible `\n` escapes, the `issues`
 * array) plus a stack trace naming a dist chunk, straight over the live frame.
 * A permission error was also announced as `invalid YAML` with remedies about
 * fixing keys. The reload now goes through formatSettingsFailure and the bus.
 */
describe("contracts/config runtime reload failure", () => {
	let scratch: ReturnType<typeof isolateClioEnv>;

	beforeEach(() => {
		scratch = isolateClioEnv("clio-config-reload-");
		writeFileSync(settingsPath(), DEFAULT_SETTINGS_YAML, "utf8");
	});

	afterEach(() => {
		chmodSync(settingsPath(), 0o644);
		scratch.restore();
	});

	it("calls an unreadable file unreadable, not invalid YAML, and names a remedy that fits", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads mode 000
		chmodSync(settingsPath(), 0o000);

		const issues = validateSettingsFile().issues;
		strictEqual(issues.length, 1);
		strictEqual(issues[0]?.kind, "unreadable");
		match(issues[0]?.message ?? "", /^unreadable: EACCES/);

		let thrown: unknown;
		try {
			readSettings();
		} catch (err) {
			thrown = err;
		}
		ok(thrown instanceof SettingsValidationError);
		const line = formatSettingsFailure(thrown);
		match(line, /EACCES/);
		match(line, /restore read access to .*settings\.yaml/);
		ok(!/invalid YAML/.test(line), `a permission error must not be called invalid YAML: ${line}`);
		ok(!/edit the named keys/.test(line), `no key is at fault: ${line}`);

		// The thrown message is what the cold-start CLI prints, and it used to
		// tell an EACCES reader to fix keys that were never at fault.
		match(thrown.message, /settings\.yaml cannot be loaded:/);
		match(thrown.message, /Restore read access to .*settings\.yaml/);
		ok(!/Fix the keys above/.test(thrown.message), `no key is at fault: ${thrown.message}`);
	});

	it("folds a parse failure to one line with no stack and no error dump", () => {
		writeFileSync(settingsPath(), "\t\t: : :\n", "utf8");

		let thrown: unknown;
		try {
			readSettings();
		} catch (err) {
			thrown = err;
		}
		ok(thrown instanceof SettingsValidationError);
		strictEqual(thrown.issues[0]?.kind, "syntax");
		match(thrown.message, /Fix the YAML in .*settings\.yaml/);
		ok(!/Fix the keys above/.test(thrown.message), `no key is at fault: ${thrown.message}`);
		const line = formatSettingsFailure(thrown);
		ok(!line.includes("\n"), `the notice must be one line: ${JSON.stringify(line)}`);
		ok(!line.includes("\\n"), `no escaped newlines from an inspected error: ${line}`);
		ok(!/\bat \S+\.js:\d+/.test(line), `no stack frames: ${line}`);
		ok(!line.includes("issues: ["), `no inspected issues array: ${line}`);
		match(line, /fix the YAML in .*settings\.yaml/);
	});

	/**
	 * Both surfaces that render this line clamp it to the frame width and offer
	 * no way to expand it: the footer cuts it, and the Alt+U notices pane cuts it
	 * the same way. So a line that ended with the remedy ended with the only
	 * actionable part off-screen, and the tail it did show was the caret diagram
	 * the YAML parser appends to its message, folded into "column 1: : : : ^^".
	 */
	it("leads with the remedy and quotes no raw source, because the tail is what a clamp cuts", () => {
		writeFileSync(settingsPath(), "\t\t: : :\n", "utf8");
		let thrown: unknown;
		try {
			readSettings();
		} catch (err) {
			thrown = err;
		}
		ok(thrown instanceof SettingsValidationError);
		const line = formatSettingsFailure(thrown);

		// The failure kind, then the fix, before anything that can be cut away.
		const remedyAt = line.indexOf("fix the YAML in");
		ok(remedyAt > 0, `the remedy is present: ${line}`);
		ok(
			remedyAt < line.indexOf("Tabs are not allowed"),
			`the remedy must precede the detail so a clamp cuts detail, not the fix: ${line}`,
		);
		match(line.slice(0, remedyAt), /is not valid YAML/);

		// The parser's excerpt and caret diagram are the operator's own file
		// quoted back at them, and folded to one line they read as corruption of
		// the message. The summary already names the line and the column.
		ok(!line.includes(": : :"), `the raw source fragment is gone: ${line}`);
		ok(!line.includes("^^"), `the caret diagram is gone: ${line}`);
		match(line, /line 1, column 1/);

		// A clamp at the narrowest supported frame still shows the fix.
		ok(line.slice(0, 60).includes("fix the YAML"), `clamped to 60 the fix survives: ${line.slice(0, 60)}`);
	});

	it("keys a schema failure to the offending path", () => {
		writeFileSync(settingsPath(), "version: 1\ntypoKey: 3\n", "utf8");
		let thrown: unknown;
		try {
			readSettings();
		} catch (err) {
			thrown = err;
		}
		ok(thrown instanceof SettingsValidationError);
		match(thrown.message, /settings\.yaml failed validation:/);
		match(thrown.message, /Fix the keys above in .*settings\.yaml/);
		const line = formatSettingsFailure(thrown);
		match(line, /typoKey: unknown key/);
		match(line, /edit the named keys in .*settings\.yaml/);
	});

	it("publishes the rejection on the bus and keeps the previous settings active", async () => {
		const bus = createSafeEventBus();
		const context: DomainContext = { bus, getContract: () => undefined };
		const events: ConfigReloadFailedPayload[] = [];
		bus.on(BusChannels.ConfigReloadFailed, (payload) => {
			events.push(payload);
		});
		const bundle = createConfigBundle(context);
		await bundle.extension.start();
		const before = bundle.contract.get();
		try {
			writeFileSync(settingsPath(), "version: 1\ntypoKey: 3\n", "utf8");
			const failure = await waitForReloadFailure(events);

			match(failure, /typoKey: unknown key/);
			ok(!failure.includes("\n"), `the notice must be one line: ${JSON.stringify(failure)}`);
			strictEqual(bundle.contract.get(), before, "the previous good snapshot stays active");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("contracts/config stale scope refs", () => {
	let scratch: ReturnType<typeof isolateClioEnv>;

	beforeEach(() => {
		scratch = isolateClioEnv("clio-config-scope-");
	});

	afterEach(() => {
		scratch.restore();
	});

	it("round-trips a scope ref whose target is gone through load and save", () => {
		writeFileSync(
			settingsPath(),
			[
				"targets:",
				"  - id: chat",
				"    runtime: openai-compat",
				"    defaultModel: chat-model",
				"scope:",
				"  - ghost-target/ghost-model",
				"  - chat/chat-model",
				"  - phantom-target",
				"",
			].join("\n"),
			"utf8",
		);

		deepStrictEqual(readSettings().scope, ["ghost-target/ghost-model", "chat/chat-model", "phantom-target"]);

		updateSettings((settings) => {
			settings.retry.maxRetries = 5;
		});

		const saved = parseYaml(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
		deepStrictEqual(saved.scope, ["ghost-target/ghost-model", "chat/chat-model", "phantom-target"]);
		deepStrictEqual(readSettings().scope, ["ghost-target/ghost-model", "chat/chat-model", "phantom-target"]);
	});
});

/** Wait for the config watcher (80ms debounce) to publish a rejection. */
async function waitForReloadFailure(events: ConfigReloadFailedPayload[]): Promise<string> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const message = events.find((event) => typeof event.message === "string")?.message;
		if (typeof message === "string") return message;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("no config.reloadFailed event with a message arrived");
}
