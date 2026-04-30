import { readFile } from "node:fs/promises";

export const CHANGE_MANIFEST_VERSION = 1;

export const FIRST_EXPLORATORY_ITERATION_ID = "exploratory-1";

export const MANIFEST_AUTHORITY_LEVELS = [
	"prompt",
	"tool-description",
	"tool-implementation",
	"middleware",
	"memory",
	"runtime",
	"safety",
	"schema",
	"cli",
] as const;

export type ManifestAuthorityLevel = (typeof MANIFEST_AUTHORITY_LEVELS)[number];

export const HIGH_AUTHORITY_LEVELS = [
	"tool-implementation",
	"middleware",
	"runtime",
	"safety",
	"schema",
	"cli",
] as const satisfies ReadonlyArray<ManifestAuthorityLevel>;

export const BUDGET_IMPACT_RISKS = ["lower", "same", "higher"] as const;

export type BudgetImpactRisk = (typeof BUDGET_IMPACT_RISKS)[number];

export interface ChangeManifest {
	version: 1;
	iterationId: string;
	baseGitSha: string;
	createdAt: string;
	changes: ManifestChange[];
}

export interface ManifestChange {
	id: string;
	componentIds: string[];
	filesChanged: string[];
	authorityLevel: ManifestAuthorityLevel;
	evidenceRefs: string[];
	rootCause: string;
	targetedFix: string;
	predictedFixes: string[];
	predictedRegressions: string[];
	validationPlan: string[];
	rollbackPlan: string;
	expectedBudgetImpact?: ExpectedBudgetImpact;
}

export interface ExpectedBudgetImpact {
	tokenDelta?: number;
	wallTimeDeltaMs?: number;
	risk: BudgetImpactRisk;
}

export interface ChangeManifestSummary {
	iterationId: string;
	baseGitSha: string;
	changeCount: number;
	authorityLevels: ManifestAuthorityLevel[];
	componentIds: string[];
	filesChanged: string[];
	predictedRegressions: string[];
	validationPlanCount: number;
}

export async function loadChangeManifestJson(path: string): Promise<unknown> {
	const raw = await readFile(path, "utf8");
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${path}: invalid JSON: ${message}`);
	}
}

export function createChangeManifestTemplate(): ChangeManifest {
	return {
		version: CHANGE_MANIFEST_VERSION,
		iterationId: FIRST_EXPLORATORY_ITERATION_ID,
		baseGitSha: "0000000000000000000000000000000000000000",
		createdAt: "2026-04-29T00:00:00.000Z",
		changes: [
			{
				id: "change-1",
				componentIds: ["context-file:CLIO.md"],
				filesChanged: ["CLIO.md"],
				authorityLevel: "prompt",
				evidenceRefs: [],
				rootCause: "First exploratory iteration; no evidence corpus exists yet.",
				targetedFix: "Describe the smallest proposed harness change.",
				predictedFixes: ["One expected improvement."],
				predictedRegressions: [],
				validationPlan: ["npm run test"],
				rollbackPlan: "Revert the filesChanged entries for this change.",
				expectedBudgetImpact: {
					risk: "same",
				},
			},
		],
	};
}

export function isHighAuthorityLevel(level: ManifestAuthorityLevel): boolean {
	return (HIGH_AUTHORITY_LEVELS as ReadonlyArray<ManifestAuthorityLevel>).includes(level);
}

export function allowsEmptyEvidenceRefs(iterationId: string): boolean {
	return iterationId === FIRST_EXPLORATORY_ITERATION_ID;
}

export function summarizeChangeManifest(manifest: ChangeManifest): ChangeManifestSummary {
	const authoritySet = new Set<ManifestAuthorityLevel>();
	const componentIds = new Set<string>();
	const filesChanged = new Set<string>();
	const predictedRegressions = new Set<string>();
	let validationPlanCount = 0;
	for (const change of manifest.changes) {
		authoritySet.add(change.authorityLevel);
		for (const componentId of change.componentIds) componentIds.add(componentId);
		for (const file of change.filesChanged) filesChanged.add(file);
		for (const regression of change.predictedRegressions) predictedRegressions.add(regression);
		validationPlanCount += change.validationPlan.length;
	}
	return {
		iterationId: manifest.iterationId,
		baseGitSha: manifest.baseGitSha,
		changeCount: manifest.changes.length,
		authorityLevels: MANIFEST_AUTHORITY_LEVELS.filter((level) => authoritySet.has(level)),
		componentIds: [...componentIds].sort(compareStrings),
		filesChanged: [...filesChanged].sort(compareStrings),
		predictedRegressions: [...predictedRegressions].sort(compareStrings),
		validationPlanCount,
	};
}

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}
