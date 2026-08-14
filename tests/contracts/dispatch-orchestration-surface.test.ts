/**
 * The three surfaces that decide whether the main agent can orchestrate at all:
 * whether it can see the fleet without a tool round trip, whether `agent:"auto"`
 * lands on a worker that may do the work, and whether a run line tells it what
 * the worker actually did. A live drive against a local model found all three
 * broken in the same turn: no roster in the prompt, `auto` resolving to a
 * read-only recon agent for "fix the bug in cache.ts", and a verifier that
 * changed nothing reporting `exit=0` with a fabricated passing check.
 */

import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DomainContext, DomainContract } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { renderFleetPromptSection } from "../../src/domains/agents/catalog.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { type AgentSpec, normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { RunReceipt, RunReceiptVerification } from "../../src/domains/dispatch/types.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { PromptsManifest } from "../../src/domains/prompts/manifest.js";
import { autoBaselineAgentId, dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";
import { receiptEvidenceLabels, workerTextNonEvidenceNotices } from "../../src/tools/worker-evidence.js";

const DISPATCH_HINT = {
	tool: "dispatch",
	hint:
		"Call dispatch with list:true only when the operator asks about agents, workers, or the fleet; never use it to inventory direct tools.",
};

function builtinSpecs(): ReadonlyArray<AgentSpec> {
	const dir = join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
	return loadRecipesFromDir({ dir, source: "builtin" }).map(normalizeAgentSpec);
}

describe("contracts/orchestration fleet roster in the session prompt", () => {
	it("renders every dispatchable recipe with the capability class that decides what it may do", () => {
		const section = renderFleetPromptSection(builtinSpecs());
		for (const id of ["coder", "tester", "documenter", "verifier", "debugger", "architect", "git-master"]) {
			ok(section.includes(`- ${id} (`), `missing operator-facing ${id}: ${section}`);
		}
		for (const id of ["scout", "provenance", "researcher"]) {
			ok(section.includes(`- ${id} (`), `missing shadow ${id}: ${section}`);
		}
		// Internal-only recipes back a CLI command and are not dispatch targets.
		strictEqual(section.includes("context-bootstrap"), false, section);
		ok(section.includes("- coder (workspace-edit,"), section);
		ok(section.includes("- scout (read-only,"), section);
		ok(section.includes("Internal specialists, dispatch-only:"), section);
	});

	it("stays inside the prompt budget the roster has to earn", () => {
		const section = renderFleetPromptSection(builtinSpecs());
		// ceilChars() is the compiler's estimator: 4 chars per token.
		const tokens = Math.ceil(section.length / 4);
		ok(tokens <= 400, `fleet section is ${tokens} tokens:\n${section}`);
		for (const line of section.split("\n")) {
			ok(line.length <= 220, `roster line too long: ${line}`);
		}
	});

	it("is byte-stable across renders so the prompt prefix does not churn", () => {
		const specs = builtinSpecs();
		strictEqual(renderFleetPromptSection(specs), renderFleetPromptSection([...specs].reverse()));
		strictEqual(renderFleetPromptSection([]), "");
	});

	it("compiles into the session prompt only when the dispatch tool is on the surface", () => {
		const table = loadFragments();
		const fleetRoster = renderFleetPromptSection(builtinSpecs());
		const withDispatch = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { providerSupportsTools: true, toolPromptHints: [DISPATCH_HINT], fleetRoster },
		});
		ok(withDispatch.systemPrompt.includes("# Fleet"), withDispatch.systemPrompt);
		ok(withDispatch.systemPrompt.includes("- tester ("), withDispatch.systemPrompt);
		ok(withDispatch.sections.some((section) => section.id === "fleet"));

		const withoutDispatch = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { providerSupportsTools: true, toolPromptHints: [], fleetRoster },
		});
		strictEqual(withoutDispatch.systemPrompt.includes("# Fleet"), false);
		strictEqual(
			withoutDispatch.sections.some((section) => section.id === "fleet"),
			false,
		);

		const toolless = compile(table, {
			identity: "identity.clio",
			operatingContract: "operating.contract",
			safety: "safety.auto-edit",
			sessionInputs: { providerSupportsTools: false, toolPromptHints: [DISPATCH_HINT], fleetRoster },
		});
		strictEqual(toolless.systemPrompt.includes("# Fleet"), false);
	});
});

describe("contracts/orchestration agent auto baseline", () => {
	const parserOptions = {
		auto: { approvedAuthorities: ["read-only", "workspace-edit"] as const, authorityBasis: "full-auto-policy" as const },
	};

	it("baselines mutation-shaped work onto a worker that may write", () => {
		strictEqual(autoBaselineAgentId("Fix the TTL cache bug in src/cache.ts"), "coder");
		strictEqual(autoBaselineAgentId("Implement the retry helper in src/net.ts"), "coder");
		strictEqual(autoBaselineAgentId("Refactor the parser to drop the duplicate branch"), "coder");
		strictEqual(autoBaselineAgentId("Add unit tests for src/format.ts"), "tester");
		strictEqual(autoBaselineAgentId("Update the README and the changelog"), "documenter");
	});

	it("keeps read-shaped work on the read-only specialists", () => {
		strictEqual(autoBaselineAgentId("Map the dispatch subsystem and cite file paths"), "scout");
		strictEqual(autoBaselineAgentId("Review the diff for boundary violations"), "verifier");
		strictEqual(autoBaselineAgentId("Research the retry backoff standard and cite primary sources"), "researcher");
		strictEqual(autoBaselineAgentId("thing"), "scout");
	});

	it("falls back when the mapped recipe is not installed", () => {
		strictEqual(
			autoBaselineAgentId("Fix the off-by-one in src/sum.ts", (id) => id === "scout"),
			"scout",
		);
		strictEqual(
			autoBaselineAgentId("Fix the off-by-one in src/sum.ts", (id) => id === "coder"),
			"coder",
		);
	});

	it("carries the resolved baseline into the request and its auto selection", () => {
		const parsed = dispatchRequestsFromArgs(
			{ agent: "auto", tasks: [{ task: "Fix the TTL cache bug in src/cache.ts so expired entries return undefined" }] },
			parserOptions,
		);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		const request = parsed.requests[0];
		strictEqual(request?.agentId, "coder");
		strictEqual(request?.agentSelection?.mode, "auto");
		strictEqual(request?.agentSelection?.baselineAgentId, "coder");

		const recon = dispatchRequestsFromArgs(
			{ agent: "auto", tasks: [{ task: "Map the modules that resolve fleet routing and cite file paths" }] },
			parserOptions,
		);
		strictEqual(recon.ok, true);
		if (!recon.ok) return;
		strictEqual(recon.requests[0]?.agentId, "scout");
		strictEqual(recon.requests[0]?.agentSelection?.baselineAgentId, "scout");
	});

	it("leaves an explicitly pinned agent alone", () => {
		const parsed = dispatchRequestsFromArgs(
			{ agent: "verifier", tasks: [{ task: "Fix the bug in src/sum.ts" }] },
			parserOptions,
		);
		strictEqual(parsed.ok, true);
		if (!parsed.ok) return;
		strictEqual(parsed.requests[0]?.agentId, "verifier");
		strictEqual(parsed.requests[0]?.agentSelection, undefined);
	});
});

describe("contracts/orchestration dispatch summary honesty", () => {
	const integrity = { ok: true as const };
	const EMPTY_RESPONSE_SCHEMA = {
		sourceId: null,
		schemaDigest: null,
		runtimeEnforceable: false,
		enforcementPassed: null,
	};
	const unverified: RunReceiptVerification = { state: "unverified", basis: "no-validation-tool" };

	function receipt(overrides: Partial<RunReceipt>): RunReceipt {
		return {
			runId: "run-1",
			agentId: "coder",
			executionRole: "builder",
			task: "fix it",
			targetId: "mini",
			wireModelId: "m",
			runtimeId: "llamacpp",
			runtimeKind: "agent",
			exitCode: 0,
			outcome: "succeeded",
			tokenCount: 10,
			inputTokenCount: 5,
			outputTokenCount: 5,
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:01.000Z",
			integrity: { version: 15, algorithm: "sha256", digest: "0".repeat(64) },
			verification: unverified,
			routingIntent: {
				posture: "balanced",
				maxCostUsd: null,
				deadlineMs: null,
				minimumQuality: null,
				requiredCapabilities: [],
				locality: "any",
				failover: "none",
			},
			quality: { version: 1, typedValidations: [], responseSchema: EMPTY_RESPONSE_SCHEMA, resultContract: null },
			...overrides,
		} as RunReceipt;
	}

	it("prints the sealed work counters next to the exit code", () => {
		const labels = receiptEvidenceLabels(
			receipt({ toolActivity: { calls: 20, succeeded: 10, failed: 6, blocked: 4, mutatingSucceeded: true } }),
			unverified,
			integrity,
		);
		ok(labels.includes("work=calls:20 ok:10 failed:6 blocked:4 mutations:yes"), labels.join(" "));
	});

	it("never prints a bare success for a mutation-class run that changed nothing", () => {
		const run = receipt({
			toolActivity: { calls: 6, succeeded: 4, failed: 1, blocked: 1, mutatingSucceeded: false },
			findingsSummary: { tags: ["blocked-tool"], firstPassSuccess: false, findingCount: 1 },
		});
		const labels = receiptEvidenceLabels(run, unverified, integrity).join(" ");
		ok(labels.includes("mutation_effect=none"), labels);
		ok(labels.includes("first_pass=false"), labels);
		ok(labels.includes("findings=blocked-tool"), labels);

		const notices = workerTextNonEvidenceNotices(run, unverified, '{"verdict":"pass"}').join("\n");
		ok(notices.includes("no mutating tool call succeeded"), notices);
		ok(notices.includes("Confirm with a diff"), notices);
	});

	it("does not call read-only reconnaissance a missing mutation", () => {
		const notApplicable: RunReceiptVerification = { state: "not_applicable", basis: "read-only-agent" };
		const run = receipt({
			agentId: "scout",
			executionRole: "researcher",
			toolActivity: { calls: 3, succeeded: 3, failed: 0, blocked: 0, mutatingSucceeded: false },
		});
		const labels = receiptEvidenceLabels(run, notApplicable, integrity).join(" ");
		ok(labels.includes("work=calls:3 ok:3 failed:0 blocked:0 mutations:no"), labels);
		strictEqual(labels.includes("mutation_effect=none"), false, labels);
		strictEqual(
			workerTextNonEvidenceNotices(run, notApplicable, "src/a.ts:2 holds it.").join("\n").includes("mutating tool call"),
			false,
		);
	});

	it("flags a mutation-report contract even when the role is not builder", () => {
		const run = receipt({
			agentId: "verifier",
			executionRole: "verifier",
			toolActivity: { calls: 6, succeeded: 4, failed: 1, blocked: 1, mutatingSucceeded: false },
			quality: {
				version: 1,
				typedValidations: [],
				responseSchema: EMPTY_RESPONSE_SCHEMA,
				resultContract: {
					sourceId: "agent-result-contract:mutation-report:abc",
					validatorDigest: "d",
					conformance: "pass",
					quality: "pass",
				},
			},
		});
		ok(receiptEvidenceLabels(run, unverified, integrity).join(" ").includes("mutation_effect=none"));
	});

	it("omits the counters entirely when the receipt carries no activity", () => {
		const labels = receiptEvidenceLabels(receipt({}), unverified, integrity).join(" ");
		strictEqual(labels.includes("work=calls"), false, labels);
		strictEqual(labels.includes("mutation_effect"), false, labels);
	});
});

describe("contracts/orchestration prompts domain wiring", () => {
	async function compileWithAgents(specs: ReadonlyArray<AgentSpec> | null) {
		const bus = createSafeEventBus();
		const contracts = new Map<string, DomainContract>();
		if (specs !== null) {
			contracts.set("agents", {
				list: () => [],
				get: () => null,
				diagnostics: () => [],
				listSpecs: () => specs,
				getSpec: () => null,
				reload: () => {},
			} satisfies AgentsContract as unknown as DomainContract);
		}
		const domainContext: DomainContext = {
			bus,
			getContract<T extends DomainContract>(name: string): T | undefined {
				return contracts.get(name) as T | undefined;
			},
		};
		const bundle = createPromptsBundle(domainContext, { noContextFiles: true });
		await bundle.extension.start();
		try {
			return await bundle.contract.compileSessionPrompt({
				sessionInputs: { providerSupportsTools: true, toolPromptHints: [DISPATCH_HINT] },
			});
		} finally {
			await bundle.extension.stop?.();
		}
	}

	it("pulls the roster from the agents domain into the compiled prompt", async () => {
		const compiled = await compileWithAgents(builtinSpecs());
		ok(compiled.systemPrompt.includes("# Fleet"), compiled.systemPrompt);
		ok(compiled.systemPrompt.includes("- provenance (read-only,"), compiled.systemPrompt);
		const fleet = compiled.sections.find((section) => section.id === "fleet");
		ok(fleet !== undefined);
		ok(fleet.tokenEstimate <= 400, `fleet section is ${fleet.tokenEstimate} tokens`);
	});

	it("compiles a fleet-free prompt when no agents domain is loaded", async () => {
		const compiled = await compileWithAgents(null);
		strictEqual(compiled.systemPrompt.includes("# Fleet"), false);
	});

	it("declares the agents dependency it now reads", () => {
		ok(PromptsManifest.dependsOn.includes("agents"));
	});
});
