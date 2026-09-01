import { createHash } from "node:crypto";
import { discoverAgentRecipes } from "../agents/registry.js";
import { agentSpecFingerprint, normalizeAgentSpec } from "../agents/spec.js";
import type { RunReceipt } from "../dispatch/types.js";
import { loadFragments } from "../prompts/fragment-loader.js";
import { createSafetyPolicyEngine } from "../safety/policy-engine.js";
import type { EvalLedgerSnapshot, EvalPromptManifestObservation } from "./metrics/tracked.js";
import type { EvalExecutionEnvelopeV1, EvalPromptFragmentIdentityV1 } from "./schema/execution-envelope.js";
import { EVAL_EXECUTION_ENVELOPE_SCHEMA_V1 } from "./schema/execution-envelope.js";
import type { EvalSuiteTargetV2, EvalSuiteTaskV2 } from "./schema/suite.js";

/** Bounded execution facts a deterministic grader can surface from an in-process dispatch. */
export interface EvalExecutionObservationV1 {
	compositionHash: string | null;
	target: string | null;
	wireModel: string | null;
	runtime: string | null;
	thinkingLevel: string | null;
	toolSignature: string | null;
	autonomy: string | null;
	policyHashes: { rulePack: string | null; project: string | null };
	projectContext: {
		tier: string | null;
		contentHash: string | null;
		chars: number | null;
		sections: string[];
		rulesApplied: string[];
		operatorProfileApplied: boolean | null;
	} | null;
}

export interface BuildEvalExecutionEnvelopeInput {
	task: EvalSuiteTaskV2;
	target: EvalSuiteTargetV2;
	cwd: string | null;
	receipt: RunReceipt | null;
	ledger: EvalLedgerSnapshot;
	observation?: EvalExecutionObservationV1;
}

/**
 * Bind one behavioral result to the exact model-facing and policy-facing
 * identity available at the runner boundary. Nulls mean the declared
 * machinery-only mode has no such model concept; they never stand in for a
 * guessed value.
 */
export function buildEvalExecutionEnvelopeV1(input: BuildEvalExecutionEnvelopeInput): EvalExecutionEnvelopeV1 {
	const scenario = input.task.behavioral;
	if (scenario === undefined) throw new Error(`behavioral task ${input.task.id} has no behavioral scenario`);
	const manifest = input.ledger.promptManifests.at(-1) ?? null;
	const contextSnapshot = input.ledger.contextSnapshots.at(-1) ?? null;
	const recipe = recipeIdentity(
		input,
		scenario.execution.subject.kind === "worker" ? scenario.execution.subject.role : null,
	);
	const policy = policyIdentity(input.cwd, input.receipt, input.observation);
	const autonomy =
		input.receipt?.autonomyEnforcement?.autonomy ?? input.observation?.autonomy ?? input.task.runner.autonomy ?? null;
	const promptFragments = promptFragmentIdentities(manifest, recipe, autonomy);
	const compositionHash =
		input.receipt?.staticCompositionHash ??
		input.observation?.compositionHash ??
		manifest?.systemPromptHash ??
		contextSnapshot?.promptHash ??
		null;
	const projectContext = projectContextIdentity(input, manifest, promptFragments);
	return {
		schema: EVAL_EXECUTION_ENVELOPE_SCHEMA_V1,
		prompt: { fragments: promptFragments, compositionHash },
		recipe: recipe === null ? null : { id: recipe.id, version: recipe.version, contentHash: recipe.contentHash },
		target: input.receipt?.targetId ?? input.observation?.target ?? input.target.id,
		wireModel:
			input.receipt?.wireModelId ?? input.observation?.wireModel ?? contextSnapshot?.modelId ?? input.target.model ?? null,
		runtime: input.receipt?.runtimeId ?? input.observation?.runtime ?? contextSnapshot?.runtimeId ?? null,
		thinkingLevel:
			input.receipt?.runtimeResolution?.effectiveThinkingLevel ??
			input.observation?.thinkingLevel ??
			manifest?.thinkingLevel ??
			input.target.thinking ??
			null,
		toolSignature:
			input.receipt?.toolSignature ?? input.observation?.toolSignature ?? contextSnapshot?.toolSignature ?? null,
		autonomy,
		policyHashes: policy,
		projectContext,
		corpus: { ...scenario.corpus },
	};
}

function recipeIdentity(
	input: BuildEvalExecutionEnvelopeInput,
	role: string | null,
): { id: string; version: number; contentHash: string; personaHash: string } | null {
	const id = input.receipt?.agentId ?? input.task.runner.agent ?? role;
	if (id === null || input.cwd === null) return null;
	try {
		const recipe = discoverAgentRecipes(input.cwd).find((entry) => entry.id === id);
		if (recipe === undefined) return null;
		return {
			id: recipe.id,
			version: recipe.version,
			contentHash: agentSpecFingerprint(normalizeAgentSpec(recipe)),
			personaHash: sha256(recipe.body),
		};
	} catch {
		return null;
	}
}

function promptFragmentIdentities(
	manifest: EvalPromptManifestObservation | null,
	recipe: { id: string; version: number; personaHash: string } | null,
	autonomy: string | null,
): EvalPromptFragmentIdentityV1[] {
	let versions = new Map<string, number>();
	try {
		versions = new Map([...loadFragments().byId.values()].map((fragment) => [fragment.id, fragment.version]));
	} catch {
		// The manifest still carries exact hashes; only authored versions become unavailable.
	}
	if (manifest !== null) {
		return manifest.fragments
			.map((fragment) => ({
				id: fragment.id,
				version: versions.get(fragment.id) ?? ("unversioned" as const),
				contentHash: fragment.contentHash,
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
	}
	if (recipe === null) return [];
	const selected = ["identity.clio-coder-worker", "operating.contract", "operating.worker"];
	if (autonomy !== null) selected.push(`safety.${autonomy}`);
	const fragments: EvalPromptFragmentIdentityV1[] = [];
	try {
		const table = loadFragments();
		for (const id of selected) {
			const fragment = table.byId.get(id);
			if (fragment !== undefined) {
				fragments.push({ id, version: fragment.version, contentHash: fragment.contentHash });
			}
		}
	} catch {
		// The composition hash remains authoritative when resource discovery fails.
	}
	fragments.push({ id: `persona.${recipe.id}`, version: recipe.version, contentHash: recipe.personaHash });
	return fragments.sort((left, right) => left.id.localeCompare(right.id));
}

function policyIdentity(
	cwd: string | null,
	receipt: RunReceipt | null,
	observation: EvalExecutionObservationV1 | undefined,
): EvalExecutionEnvelopeV1["policyHashes"] {
	const sealed = receipt?.reproducibility?.safetyPolicy;
	if (sealed !== undefined) return { rulePack: sealed.rulePackHash, project: sealed.projectPolicyHash };
	if (observation !== undefined) return { ...observation.policyHashes };
	if (cwd === null) return { rulePack: null, project: null };
	try {
		const metadata = createSafetyPolicyEngine({ cwd }).metadata();
		return { rulePack: metadata.rulePackHash, project: metadata.projectPolicyHash };
	} catch {
		return { rulePack: null, project: null };
	}
}

function projectContextIdentity(
	input: BuildEvalExecutionEnvelopeInput,
	manifest: EvalPromptManifestObservation | null,
	fragments: ReadonlyArray<EvalPromptFragmentIdentityV1>,
): EvalExecutionEnvelopeV1["projectContext"] {
	const receipt = input.receipt;
	if (receipt?.projectContext !== undefined) {
		const sections = [...(receipt.projectContext.sections ?? [])].sort();
		const hasContentBearingContext = sections.some((section) => section !== "workspace-root");
		return {
			kind: "worker",
			tier: receipt.projectContext.tier,
			contentHash: hasContentBearingContext ? (receipt.projectContext.contentHash ?? null) : null,
			chars: hasContentBearingContext ? (receipt.projectContext.chars ?? null) : null,
			sections,
			rulesApplied: [...(receipt.rulesApplied ?? [])].sort(),
			operatorProfileApplied: receipt.operatorProfileApplied ?? null,
		};
	}
	const observed = input.observation?.projectContext;
	if (observed !== undefined && observed !== null) {
		const sections = [...observed.sections].sort();
		const hasContentBearingContext = sections.some((section) => section !== "workspace-root");
		return {
			kind: "worker",
			tier: observed.tier,
			contentHash: hasContentBearingContext ? observed.contentHash : null,
			chars: hasContentBearingContext ? observed.chars : null,
			sections,
			rulesApplied: [...observed.rulesApplied].sort(),
			operatorProfileApplied: observed.operatorProfileApplied,
		};
	}
	if (manifest !== null) {
		const contextFragments = fragments.filter((fragment) => fragment.id.startsWith("context."));
		const preload = manifest.projectPreload;
		const identity = {
			preload,
			fragments: contextFragments.map((fragment) => [fragment.id, fragment.contentHash]),
		};
		return {
			kind: "session",
			tier: preload?.mode ?? null,
			contentHash: sha256(stableJson(identity)),
			chars: preload?.chars ?? null,
			sections: contextFragments.map((fragment) => fragment.id).sort(),
			rulesApplied: [],
			operatorProfileApplied: contextFragments.some((fragment) => fragment.id === "context.operator-profile"),
		};
	}
	return {
		kind: "none",
		tier: null,
		contentHash: null,
		chars: null,
		sections: [],
		rulesApplied: [],
		operatorProfileApplied: null,
	};
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
