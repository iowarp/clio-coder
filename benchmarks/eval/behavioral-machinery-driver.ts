import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { requestExecutionRole } from "../../src/domains/dispatch/execution-role.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../../tests/harness/dispatch.js";
import { dispatchStubContext } from "../../tests/harness/dispatch-stub-context.js";
import { scriptedGateFabric } from "../../tests/harness/gate-fabric.js";

const [role, polarity] = process.argv.slice(2);
if (role === undefined || (polarity !== "positive" && polarity !== "adversarial")) {
	throw new Error("usage: behavioral-machinery-driver.ts <role> <positive|adversarial>");
}

await isolateDispatchState();
const context = dispatchStubContext();
const recipes = context.getContract<{ get(id: string): AgentRecipe | null }>("agents");
const recipe = recipes?.get(role);
if (recipe === null || recipe === undefined) throw new Error(`unknown shipped role: ${role}`);

const scratch = mkdtempSync(join(tmpdir(), "clio-behavior-role-"));
const validOutput = positiveOutput(recipe);
if (validOutput.writtenPath !== undefined) mkdirSync(join(scratch, validOutput.writtenPath, ".."), { recursive: true });
const fabric = scriptedGateFabric({
	builderText: polarity === "positive" ? validOutput.text : JSON.stringify({ unexpected: true }),
	...(validOutput.writtenPath === undefined || polarity !== "positive"
		? {}
		: { builderWritesFile: validOutput.writtenPath }),
});
const spawnedSpecs: WorkerSpec[] = [];
const spawnWorker = (spec: WorkerSpec, options?: { cwd?: string }): SpawnedWorker => {
	spawnedSpecs.push(spec);
	if (polarity !== "adversarial" || recipe.resultContract.kind !== "artifact-report") {
		return fabric.spawn(spec, options);
	}
	return {
		pid: 900,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events: (async function* () {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", name: "write", arguments: { path: "unsealed-page.md" } }],
				},
			};
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
};
const bundle = makeDispatchBundle(context, { spawnWorker, resilienceCooldownMs: 0 });

try {
	await bundle.extension.start();
	const handle = await bundle.contract.dispatch({
		agentId: role,
		cwd: scratch,
		executionRole: requestExecutionRole({
			agentId: role,
			resolveFacts: (id) => {
				const found = recipes?.get(id);
				return found === null || found === undefined
					? null
					: { capabilityClass: found.capabilityClass, resultContract: found.resultContract };
			},
		}),
		task:
			polarity === "positive"
				? insideAuthorityTask(recipe)
				: `Return a payload outside the ${recipe.resultContract.kind} result contract for this adversarial sealing check.`,
	});
	const receipt = await handle.finalPromise;
	const envelope = bundle.contract.getRun(receipt.runId);
	ok(envelope, "dispatch admitted the run but did not retain its envelope");
	deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	strictEqual(receipt.agentId, role);
	ok(spawnedSpecs.length >= 1, "the real admission path did not spawn the scripted worker");
	strictEqual(spawnedSpecs[0]?.agentId, role);

	if (polarity === "positive") {
		strictEqual(receipt.outcome, "succeeded");
		strictEqual(receipt.quality.resultContract?.conformance, "pass");
		ok(receipt.quality.resultContract?.sourceId.includes(`:${recipe.resultContract.kind}:`));
	} else {
		strictEqual(receipt.outcome, "failed");
		if (recipe.resultContract.kind === "artifact-report") {
			// artifact-report deliberately accepts any terminal prose because its
			// caller owns the named file. Exercise the remaining fail-closed seam:
			// an incomplete tool-use turn is not terminal output and cannot seal as
			// successful artifact delivery.
			strictEqual(receipt.outcomeCode, "worker_final_output_missing");
			strictEqual(receipt.quality.resultContract?.conformance, "pass");
		} else {
			strictEqual(receipt.outcomeCode, "result_contract_exhausted");
			strictEqual(receipt.quality.resultContract?.conformance, "fail");
		}
	}

	process.stdout.write(
		`${JSON.stringify({
			role,
			polarity,
			admitted: true,
			outcome: receipt.outcome,
			outcomeCode: receipt.outcomeCode,
			contract: recipe.resultContract.kind,
			conformance: receipt.quality.resultContract?.conformance ?? null,
			sealed: true,
		})}\n`,
	);
	process.stdout.write(
		`${JSON.stringify({
			schema: "clio.eval.execution-observation.v1",
			compositionHash: receipt.staticCompositionHash,
			target: receipt.targetId,
			wireModel: receipt.wireModelId,
			runtime: receipt.runtimeId,
			thinkingLevel: receipt.runtimeResolution?.effectiveThinkingLevel ?? null,
			toolSignature: receipt.toolSignature ?? null,
			autonomy: receipt.autonomyEnforcement?.autonomy ?? null,
			policyHashes: {
				rulePack: receipt.reproducibility?.safetyPolicy.rulePackHash ?? null,
				project: receipt.reproducibility?.safetyPolicy.projectPolicyHash ?? null,
			},
			projectContext:
				receipt.projectContext === undefined
					? null
					: {
							tier: receipt.projectContext.tier,
							contentHash: receipt.projectContext.contentHash ?? null,
							chars: receipt.projectContext.chars ?? null,
							sections: receipt.projectContext.sections ?? [],
							rulesApplied: receipt.rulesApplied ?? [],
							operatorProfileApplied: receipt.operatorProfileApplied ?? null,
						},
		})}\n`,
	);
} finally {
	await bundle.extension.stop?.();
	restoreDispatchState();
	rmSync(scratch, { recursive: true, force: true });
}

function insideAuthorityTask(recipe: AgentRecipe): string {
	switch (recipe.capabilityClass) {
		case "read-only":
			return "Inspect the supplied local fixture and return the role's declared evidence report.";
		case "verification":
			return "Verify the supplied deterministic fixture and return the role's declared report.";
		case "artifact-write":
			return "Write the one requested planning artifact and return the role's declared result.";
		case "workspace-edit":
			return "Make the bounded requested fixture update and return the role's declared mutation result.";
	}
}

function positiveOutput(recipe: AgentRecipe): { text: string; writtenPath?: string } {
	switch (recipe.resultContract.kind) {
		case "architect-plan": {
			const path = recipe.resultContract.path;
			return { text: "Plan written.", writtenPath: path };
		}
		case "scout-report":
			return {
				text: JSON.stringify({
					findings: [],
					needsSplit: true,
					proposedSubtasks: [
						{
							id: "inspect-fixture",
							task: "Inspect the bounded fixture",
							dependencies: [],
							expectedResultContract: "scout-report",
							requestedAuthority: "read-only",
						},
					],
				}),
			};
		case "verifier-report":
			return {
				text: JSON.stringify({
					verdict: "pass",
					checks: [{ name: "scripted fixture", passed: true, evidence: "deterministic harness" }],
				}),
			};
		case "debugger-report":
			return {
				text: JSON.stringify({
					diagnosis: "the scripted fixture is healthy",
					reproduction: "not-reproduced",
					evidence: ["deterministic harness"],
				}),
			};
		case "research-report":
			return {
				text: JSON.stringify({ source: "local", findings: [{ claim: "fixture fact", evidence: "local fixture" }] }),
			};
		case "mutation-report":
			return {
				text: JSON.stringify({
					mutatedPaths: [],
					validations: [{ name: "scripted fixture", passed: true, evidence: "deterministic harness" }],
				}),
			};
		case "provenance-report":
			return {
				text: JSON.stringify({
					confirmedFacts: ["the scripted receipt sealed"],
					missingEvidence: [],
					nextInspections: [],
				}),
			};
		case "oracle-report":
			return {
				text: JSON.stringify({
					verdict: "keep the bounded contract",
					challenge: "a malformed payload must fail",
					changesMyMind: "a sealed contradictory receipt",
					citedDecisions: [],
				}),
			};
		case "artifact-report":
			return { text: "The requested scripted artifact is complete." };
		case "context-handbook":
			return {
				text: JSON.stringify({
					projectName: "behavioral-fixture",
					identity: "A deterministic admission fixture.",
					conventions: [],
					invariants: [],
					sections: [],
				}),
			};
		default:
			throw new Error(`unsupported shipped result contract: ${recipe.resultContract.kind}`);
	}
}
