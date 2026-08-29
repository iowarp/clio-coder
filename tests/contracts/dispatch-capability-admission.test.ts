/**
 * The three things a live drive found the harness willing to seal as success:
 * a read-only recipe admitted against a task it cannot perform, a passing check
 * on a command the run never executed, and a worker prompt that named no
 * workspace while the worker spent a quarter of its call budget looking for one.
 *
 * Ground truth for all three is receipt 1yd79n91i9b0 in
 * REPORT-dispatch-drive-1.md: `verifier` pinned to "fix the off-by-one bug in
 * src/sum.ts", six reads, no shell call, `{"verdict":"pass","checks":[{"name":
 * "npm run typecheck","passed":true,"evidence":"exit 0"}]}` on a project with
 * no typecheck script, sealed `outcome: succeeded / quality: pass`.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateRecipeResult } from "../../src/domains/agents/result-contract.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import { assessCapabilityMismatch } from "../../src/domains/dispatch/capability-match.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	buildDynamicPromptMessages,
	readWorkspaceRootFacts,
	renderWorkerWorkspaceContext,
} from "../../src/domains/dispatch/extension.js";
import { RECEIPT_INTEGRITY_FIELD_COVERAGE } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt, RunReceiptVerification } from "../../src/domains/dispatch/types.js";
import {
	describeUngroundedValidations,
	groundClaimedValidations,
	invalidatesQuality,
} from "../../src/domains/dispatch/validation-grounding.js";
import { adaptRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { receiptEvidenceLabels, workerTextNonEvidenceNotices } from "../../src/tools/worker-evidence.js";

function spec(id: string, capabilityClass: AgentSpec["capabilityClass"]): AgentSpec {
	return { id, capabilityClass } as AgentSpec;
}

const FLEET: AgentSpec[] = [
	spec("scout", "read-only"),
	spec("verifier", "verification"),
	spec("coder", "workspace-edit"),
	spec("tester", "workspace-edit"),
	spec("documenter", "artifact-write"),
];

describe("contracts/dispatch capability admission", () => {
	it("refuses a pinned read-only recipe given an unambiguous mutation task", () => {
		const mismatch = assessCapabilityMismatch({
			agentId: "verifier",
			capabilityClass: "verification",
			task: "Fix the off-by-one bug in src/sum.ts",
			autoSelected: false,
			resultContractKind: "verifier-report",
			specs: FLEET,
		});
		ok(mismatch !== null);
		strictEqual(mismatch.verdict, "refuse");
		strictEqual(mismatch.taskType, "debug");
		strictEqual(mismatch.suggestedAgentId, "coder");
		ok(mismatch.detail.includes("cannot write to the workspace"), mismatch.detail);
		ok(mismatch.detail.includes('agent:"coder"'), mismatch.detail);
	});

	it("flags rather than refuses when a read verb corroborates a read task", () => {
		// classifyAgentTask tests `config` before `code_read`, so this classifies
		// as a mutating shape on an ordered-list accident. Refusing it would cost
		// real reconnaissance to buy back one wasted run.
		const mismatch = assessCapabilityMismatch({
			agentId: "scout",
			capabilityClass: "read-only",
			task: "Explain how the config loader resolves settings and cite file paths",
			autoSelected: false,
			resultContractKind: "scout-report",
			specs: FLEET,
		});
		ok(mismatch !== null);
		strictEqual(mismatch.verdict, "flag");
		ok(mismatch.detail.startsWith("capability_mismatch="), mismatch.detail);
	});

	it("flags rather than refuses an agent the harness chose itself", () => {
		const mismatch = assessCapabilityMismatch({
			agentId: "scout",
			capabilityClass: "read-only",
			task: "Fix the TTL cache bug in src/cache.ts",
			autoSelected: true,
			resultContractKind: "scout-report",
			specs: FLEET,
		});
		strictEqual(mismatch?.verdict, "flag");
	});

	it("leaves sound pairings alone", () => {
		strictEqual(
			assessCapabilityMismatch({
				agentId: "coder",
				capabilityClass: "workspace-edit",
				task: "Fix the off-by-one bug in src/sum.ts",
				autoSelected: false,
				resultContractKind: "mutation-report",
				specs: FLEET,
			}),
			null,
		);
		strictEqual(
			assessCapabilityMismatch({
				agentId: "verifier",
				capabilityClass: "verification",
				task: "Review the diff for boundary violations",
				autoSelected: false,
				resultContractKind: "verifier-report",
				specs: FLEET,
			}),
			null,
		);
	});

	it("suggests only a recipe this install actually has", () => {
		const trimmed = assessCapabilityMismatch({
			agentId: "verifier",
			capabilityClass: "verification",
			task: "Add unit tests for src/format.ts",
			autoSelected: false,
			resultContractKind: "verifier-report",
			specs: [spec("verifier", "verification"), spec("tester", "workspace-edit")],
		});
		strictEqual(trimmed?.suggestedAgentId, "tester");
		const bare = assessCapabilityMismatch({
			agentId: "verifier",
			capabilityClass: "verification",
			task: "Fix the off-by-one bug in src/sum.ts",
			autoSelected: false,
			resultContractKind: "verifier-report",
			specs: [spec("verifier", "verification"), spec("scout", "read-only")],
		});
		strictEqual(bare?.suggestedAgentId, null);
		ok(bare.detail.includes("No installed recipe can change the workspace"), bare.detail);
	});
});

describe("contracts/dispatch validation grounding", () => {
	const verifierReport = JSON.stringify({
		verdict: "pass",
		checks: [{ name: "npm run typecheck", passed: true, evidence: "exit 0" }],
	});

	it("seals a claimed check the run never executed as unverifiable", () => {
		const grounding = groundClaimedValidations({
			contractKind: "verifier-report",
			output: verifierReport,
			executedCommands: new Set(),
			executedCheckingCalls: 0,
		});
		deepStrictEqual(grounding, {
			claimed: 1,
			grounded: 0,
			ungrounded: ["npm run typecheck"],
			basis: "no-command-executed",
		});
		ok(invalidatesQuality(grounding));
		ok(describeUngroundedValidations(grounding).includes('"npm run typecheck"'));
	});

	it("sees the claims in a report the model wrapped in a code fence", () => {
		const grounding = groundClaimedValidations({
			contractKind: "verifier-report",
			output: `\`\`\`json\n${verifierReport}\n\`\`\``,
			executedCommands: new Set(),
			executedCheckingCalls: 0,
		});
		deepStrictEqual(grounding, {
			claimed: 1,
			grounded: 0,
			ungrounded: ["npm run typecheck"],
			basis: "no-command-executed",
		});
	});

	it("leaves a claim the run did execute alone", () => {
		const grounding = groundClaimedValidations({
			contractKind: "verifier-report",
			output: verifierReport,
			executedCommands: new Set(["npm run typecheck"]),
			executedCheckingCalls: 1,
		});
		deepStrictEqual(grounding, { claimed: 1, grounded: 1, ungrounded: [], basis: "unmatched-command" });
	});

	it("grounds a mutation report's validations by name, not by count", () => {
		const output = JSON.stringify({
			mutatedPaths: ["src/sum.ts"],
			validations: [
				{ name: "npm test", passed: true, evidence: "12 passing" },
				{ name: "npm run lint", passed: true, evidence: "clean" },
			],
		});
		const grounding = groundClaimedValidations({
			contractKind: "mutation-report",
			output,
			executedCommands: new Set(["npm test"]),
			executedCheckingCalls: 1,
		});
		deepStrictEqual(grounding, {
			claimed: 2,
			grounded: 1,
			ungrounded: ["npm run lint"],
			basis: "unmatched-command",
		});
		// It ran something the detector could not tie to "npm run lint", which is
		// reported and never used to take the sealed quality label away.
		strictEqual(invalidatesQuality(grounding), false);
	});

	it("matches a claim that decorates the command it ran", () => {
		const output = JSON.stringify({
			mutatedPaths: ["src/sum.ts"],
			validations: [{ name: "npm test (12 passing)", passed: true, evidence: "green" }],
		});
		strictEqual(
			groundClaimedValidations({
				contractKind: "mutation-report",
				output,
				executedCommands: new Set(["npm test"]),
				executedCheckingCalls: 1,
			})?.ungrounded.length,
			0,
		);
	});

	it("reads a claim under the wider grounding vocabulary", () => {
		// `npx -y jest --coverage` shares no substring with the canonical
		// `npx jest`, so this claim only lands once the claim side canonicalizes
		// under the grounding scope. The executed set here stands in for what
		// run-effects records; it still canonicalizes under the strict scope, so
		// the widened shapes only ground once that side is widened too.
		const output = JSON.stringify({
			verdict: "pass",
			checks: [
				{ name: "npx -y jest --coverage", passed: true, evidence: "42 passing" },
				{ name: "git diff review of the patch", passed: true, evidence: "clean" },
			],
		});
		const grounding = groundClaimedValidations({
			contractKind: "verifier-report",
			output,
			executedCommands: new Set(["npx jest", "git diff"]),
			executedCheckingCalls: 2,
		});
		deepStrictEqual(grounding, { claimed: 2, grounded: 2, ungrounded: [], basis: "unmatched-command" });
	});

	it("grounds a git diff claim against the run that executed git diff", () => {
		// End to end over the two sides the split threads together: the recorder
		// reads the executed command under the grounding scope, and the claim side
		// canonicalizes to the same identity. Before the second set existed this
		// claim stayed ungrounded no matter how well either side canonicalized,
		// because run-effects only recorded the strict vocabulary.
		const recorder = createRunEffectsRecorder("/repo");
		recorder.start("call-1", "bash", { command: "git diff -- src/sum.ts" });
		recorder.finish("call-1", false);
		const effects = recorder.snapshot();
		strictEqual(effects.validationCommands.size, 0);
		const grounding = groundClaimedValidations({
			contractKind: "verifier-report",
			output: JSON.stringify({
				verdict: "pass",
				checks: [{ name: "git diff verification", passed: true, evidence: "the off-by-one hunk is applied" }],
			}),
			executedCommands: effects.verificationCommands,
			executedCheckingCalls: 1,
		});
		deepStrictEqual(grounding, { claimed: 1, grounded: 1, ungrounded: [], basis: "unmatched-command" });
	});

	it("still seals a mutation report whose only command was git diff as unmeasured", () => {
		// The other half of the split. Grounding is satisfied by the inspection,
		// and the measured gate is not: `git diff` never enters the strict set, so
		// the report's own validation claim buys it nothing.
		const recorder = createRunEffectsRecorder("/repo");
		recorder.start("call-1", "write", { path: "src/sum.ts", content: "fixed" });
		recorder.finish("call-1", false);
		recorder.start("call-2", "bash", { command: "git diff" });
		recorder.finish("call-2", false);
		const effects = recorder.snapshot();
		const output = JSON.stringify({
			mutatedPaths: ["src/sum.ts"],
			validations: [{ name: "git diff", passed: true, evidence: "the hunk is applied" }],
		});
		const outcome = validateRecipeResult({
			contract: { kind: "mutation-report" },
			reachedTerminalResult: true,
			output,
			cwd: "/repo",
			networkAllowed: false,
			filesystem: { readFile: () => null, pathExists: () => true },
			observedRunEffects: effects,
		});
		ok(outcome !== null);
		ok(outcome.applicable);
		strictEqual(outcome.fact.conformance, "pass");
		strictEqual(outcome.fact.quality, "unmeasured");
		// The claim is grounded, so the receipt says nothing about it either way.
		strictEqual(
			groundClaimedValidations({
				contractKind: "mutation-report",
				output,
				executedCommands: effects.verificationCommands,
				executedCheckingCalls: 1,
			})?.ungrounded.length,
			0,
		);
	});

	it("never accuses a self-reported failure or an ungroundable contract", () => {
		const failing = JSON.stringify({
			verdict: "fail",
			checks: [{ name: "npm test", passed: false, evidence: "3 failing" }],
		});
		strictEqual(
			groundClaimedValidations({
				contractKind: "verifier-report",
				output: failing,
				executedCommands: new Set(),
				executedCheckingCalls: 0,
			}),
			null,
		);
		strictEqual(
			groundClaimedValidations({
				contractKind: "scout-report",
				output: verifierReport,
				executedCommands: new Set(),
				executedCheckingCalls: 0,
			}),
			null,
		);
		strictEqual(
			groundClaimedValidations({
				contractKind: "verifier-report",
				output: "not json",
				executedCommands: new Set(),
				executedCheckingCalls: 0,
			}),
			null,
		);
	});
});

describe("contracts/dispatch worker workspace context", () => {
	it("names the root and the top-level layout, skipping build output", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-workspace-context-"));
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, ".env"), "SECRET=redacted");
		const facts = readWorkspaceRootFacts(
			root,
			() =>
				[
					{ name: "src", isDirectory: () => true },
					{ name: "node_modules", isDirectory: () => true },
					{ name: ".git", isDirectory: () => true },
					{ name: "package.json", isDirectory: () => false },
				] as never,
		);
		deepStrictEqual([...facts.entries], ["package.json", "src/"]);
		strictEqual(facts.truncated, false);
		const body = renderWorkerWorkspaceContext(facts);
		ok(body.includes(`Root: ${root}`), body);
		ok(body.includes("Top level: package.json, src/"), body);
		strictEqual(body.includes("node_modules"), false);
	});

	it("sends the workspace message at every project-context tier", () => {
		const req = { agentId: "scout", task: "map it" } as DispatchRequest;
		const workspace = { root: "/w", entries: ["src/"], truncated: false };
		const none = buildDynamicPromptMessages(req, { projectContextTier: "none", workspace });
		strictEqual(none[0]?.id, "dispatch-workspace");
		const bounded = buildDynamicPromptMessages(req, {
			projectContextTier: "bounded",
			workspace,
			project: { projectName: "clio", conventions: ["local imports end in .js"], invariants: [] },
		});
		deepStrictEqual(
			bounded.map((message) => message.id),
			["dispatch-workspace", "dispatch-project-context"],
		);
	});
});

describe("contracts/dispatch summary line admission facts", () => {
	const integrity = { ok: true as const };
	const unverified: RunReceiptVerification = { state: "unverified", basis: "no-validation-tool" };

	function receipt(overrides: Partial<RunReceipt>): RunReceipt {
		return {
			runId: "run-1",
			agentId: "verifier",
			executionRole: "gate",
			task: "fix it",
			targetId: "mini",
			wireModelId: "m",
			runtimeId: "llamacpp",
			runtimeKind: "agent",
			exitCode: 0,
			outcome: "succeeded",
			tokenCount: 10,
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:01.000Z",
			integrity: { version: 20, algorithm: "sha256", digest: "0".repeat(64) },
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
			quality: {
				version: 1,
				typedValidations: [],
				responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
				resultContract: null,
			},
			...overrides,
		} as RunReceipt;
	}

	it("says the check was never run, on the line the orchestrator reads", () => {
		const run = receipt({
			validationGrounding: {
				claimed: 1,
				grounded: 0,
				ungrounded: ["npm run typecheck"],
				basis: "no-command-executed" as const,
			},
			capabilityMismatch: {
				agentId: "verifier",
				capabilityClass: "verification",
				taskType: "debug",
				suggestedAgentId: "coder",
			},
		});
		const labels = receiptEvidenceLabels(run, unverified, integrity).join(" ");
		ok(labels.includes('validations=claimed:1 grounded:0 unverifiable:"npm run typecheck"'), labels);
		ok(labels.includes("capability_mismatch=verification/debug suggested:coder"), labels);

		const notices = workerTextNonEvidenceNotices(
			run,
			adaptRunReceiptTrustStatus({ ...run, verification: unverified }, { integrity }),
			'{"verdict":"pass"}',
		).join("\n");
		ok(notices.includes("executed no command at all"), notices);
		ok(notices.includes("cannot write to the workspace"), notices);
	});

	it("reports the structured context that was actually sent", () => {
		const labels = receiptEvidenceLabels(
			receipt({ projectContext: { tier: "none", chars: 118, sections: ["workspace-root"] } }),
			unverified,
			integrity,
		).join(" ");
		ok(labels.includes("project_context=none chars:118 sections:workspace-root"), labels);
	});

	it("keeps both new receipt fields under integrity coverage", () => {
		strictEqual(RECEIPT_INTEGRITY_FIELD_COVERAGE.validationGrounding, true);
		strictEqual(RECEIPT_INTEGRITY_FIELD_COVERAGE.capabilityMismatch, true);
	});
});
