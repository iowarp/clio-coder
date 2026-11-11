import { posix } from "node:path";
import type { CommitAttributionEvidence } from "../../core/commit-attribution.js";
import type { ExecutionPlan, ExecutionPlanCodeStep } from "./execution-plan.js";

export interface FleetCommitPriorResult {
	succeeded: boolean;
	integrityValid: boolean;
	runDigest: string;
	/** Decision refs from the step's run; they become `Clio-Decision:` trailers. */
	decisionRefs?: ReadonlyArray<string>;
}

/**
 * Derive one fleet commit's semantic attribution from scheduler-owned facts.
 * Agent output text is deliberately absent from this input: prose cannot turn
 * into testing or review evidence.
 */
export function deriveFleetCommitAttribution(input: {
	plan: ExecutionPlan;
	step: ExecutionPlanCodeStep;
	priorResults: ReadonlyMap<string, FleetCommitPriorResult>;
	validationFresh: boolean;
	independentReviewFresh: boolean;
}): CommitAttributionEvidence {
	const byId = new Map(input.plan.steps.map((step) => [step.id, step] as const));
	let materiallyAuthored = false;
	let run: CommitAttributionEvidence["run"];
	let decisions: CommitAttributionEvidence["decisions"];
	for (const candidate of input.step.commitFrom ?? []) {
		const source = byId.get(candidate);
		const result = input.priorResults.get(candidate);
		if (
			source?.kind !== "agent" ||
			source.scope !== "workspace" ||
			result?.succeeded !== true ||
			result.integrityValid !== true
		) {
			continue;
		}
		materiallyAuthored = true;
		if (result.decisionRefs !== undefined && result.decisionRefs.length > 0) decisions = [...result.decisionRefs];
		if (/^[0-9a-f]{64}$/u.test(result.runDigest)) {
			run = {
				version: 1,
				algorithm: "sha256",
				digest: result.runDigest,
				integrityValid: true,
				directlyRelevant: true,
			};
		}
		break;
	}
	return {
		materiallyAssisted: materiallyAuthored,
		materiallyAuthored,
		validationSucceeded: input.validationFresh,
		independentReviewPassed: input.independentReviewFresh,
		...(run === undefined ? {} : { run }),
		...(decisions === undefined ? {} : { decisions }),
	};
}

const PACKAGE_CONFIG_FILES = new Set(["package.json", ".npmrc", "pnpm-workspace.yaml"]);

/**
 * The check's own files among `changedPaths` (repository-relative): a package manifest or package-manager config,
 * whose scripts a check may run, or a file the check's argv names. A pass over files the worker wrote earns no
 * `Tested-by` trailer. Directories the argv names are the code under check, not the check, so they do not count.
 */
export function changedCheckFiles(
	command: { argv: ReadonlyArray<string>; cwd: string },
	changedPaths: Iterable<string>,
): string[] {
	const operands = new Set<string>();
	for (const [index, token] of command.argv.entries()) {
		const value = token.startsWith("-") ? (token.includes("=") ? token.slice(token.indexOf("=") + 1) : "") : token;
		if (value === "" || /\s/u.test(value) || (index === 0 && !value.includes("/"))) continue;
		const resolved = posix.normalize(posix.join(command.cwd, value));
		if (!resolved.startsWith("../") && !posix.isAbsolute(resolved)) operands.add(resolved);
	}
	const hits = new Set<string>();
	for (const path of changedPaths) {
		const segments = path.split("/");
		if (segments.includes("node_modules")) continue;
		if (PACKAGE_CONFIG_FILES.has(segments.at(-1) ?? "") || operands.has(path)) hits.add(path);
	}
	return [...hits].sort();
}

const NO_OP_COMMANDS = new Set(["true", ":"]);
const NO_OP_SCRIPTS = /^\s*(?:true|:|exit\s+0)?\s*;?\s*$/u;

/**
 * A check whose argv cannot fail (`true`, `:`, or a shell running only that) proves nothing, so its pass earns no
 * `Tested-by` trailer. The registry is repository-owned; this only refuses the trivially vacuous forms.
 */
export function isVacuousCheckArgv(argv: ReadonlyArray<string>): boolean {
	const [program, ...rest] = argv;
	if (program === undefined) return true;
	const name = program.split("/").at(-1) ?? program;
	if (NO_OP_COMMANDS.has(name) && rest.length === 0) return true;
	if (["sh", "bash", "dash", "zsh"].includes(name) && rest.length === 2 && rest[0] === "-c")
		return NO_OP_SCRIPTS.test(rest[1] ?? "");
	return false;
}
