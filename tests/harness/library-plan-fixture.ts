import type { PluginScope } from "../../src/domains/plugins/types.js";
import type {
	LibraryApplyResult,
	LibraryEntryKind,
	LibraryLifecyclePlan,
	LibraryOperation,
	LibraryPlanStep,
	LibraryRequirementRef,
	LibraryStepOutcome,
} from "../../src/domains/resources/index.js";

export interface LibraryPlanFixtureOptions {
	operation?: LibraryOperation;
	ref?: LibraryRequirementRef;
	scope?: PluginScope;
	destination?: string;
	sourceUrl?: string;
	sha256?: string;
	refusal?: string;
	newlyBroken?: LibraryPlanStep["dependents"]["newlyBroken"];
	missing?: LibraryRequirementRef[];
	steps?: LibraryPlanStep[];
}

/** One reviewed plan, in the domain's own shape, for layout and wording tests. */
export function libraryPlanFixture(options: LibraryPlanFixtureOptions = {}): LibraryLifecyclePlan {
	const ref = options.ref ?? "plugin:fixture";
	const [kind, name] = ref.split(":") as [LibraryEntryKind, string];
	const operation = options.operation ?? "install";
	const scope = options.scope ?? "user";
	const step: LibraryPlanStep = {
		operation,
		identity: { ref, kind, name, scope },
		destination: options.destination ?? `/tmp/${name}`,
		...(options.sourceUrl
			? { source: { sourceUrl: options.sourceUrl, sha256: options.sha256 ?? "0".repeat(64), staged: true } }
			: {}),
		expected: [
			{ scope, id: name, recorded: operation !== "install", tree: operation === "install" ? "absent" : "0".repeat(64) },
		],
		dependencies: { requires: [], missing: options.missing ?? [], inactive: [] },
		dependents: { newlyBroken: options.newlyBroken ?? [], preexisting: [] },
		fallbackNote: "No copy in the other scope, so nothing becomes effective in its place.",
		recovery: "Changed files are kept beside the package and their path is reported.",
		...(options.refusal ? { refusal: options.refusal } : {}),
	};
	const steps = options.steps ?? [step];
	return {
		version: 1,
		id: "plan-fixture",
		createdAt: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp",
		request: { operation, ref, scope },
		steps,
		applicable: steps.every((candidate) => candidate.refusal === undefined),
		diagnostics: [],
	};
}

export interface LibraryOutcomeFixtureOptions {
	outcomes?: LibraryStepOutcome[];
	refresh?: LibraryApplyResult["refresh"];
}

/** One apply result, in the domain's own shape. */
export function libraryApplyFixture(options: LibraryOutcomeFixtureOptions = {}): LibraryApplyResult {
	const outcomes = options.outcomes ?? [];
	return {
		planId: "plan-fixture",
		dryRun: false,
		outcomes,
		committed: outcomes.filter((outcome) => outcome.status === "committed").length,
		failed: outcomes.filter((outcome) => outcome.status === "failed").length,
		unattempted: outcomes.filter((outcome) => outcome.status === "unattempted").length,
		refresh: options.refresh ?? { status: "not-applicable", reason: "nothing committed" },
	};
}
