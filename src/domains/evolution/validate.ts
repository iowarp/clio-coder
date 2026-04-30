import {
	allowsEmptyEvidenceRefs,
	BUDGET_IMPACT_RISKS,
	type BudgetImpactRisk,
	CHANGE_MANIFEST_VERSION,
	type ChangeManifest,
	type ExpectedBudgetImpact,
	isHighAuthorityLevel,
	MANIFEST_AUTHORITY_LEVELS,
	type ManifestAuthorityLevel,
	type ManifestChange,
} from "./manifest.js";

export interface ManifestValidationIssue {
	path: string;
	message: string;
}

export type ManifestValidationResult =
	| {
			valid: true;
			manifest: ChangeManifest;
			issues: [];
	  }
	| {
			valid: false;
			issues: ManifestValidationIssue[];
			manifest?: undefined;
	  };

export function validateChangeManifest(value: unknown): ManifestValidationResult {
	const issues: ManifestValidationIssue[] = [];
	if (!isRecord(value)) {
		issues.push({ path: "$", message: "expected manifest object" });
		return invalid(issues);
	}

	if (value.version !== CHANGE_MANIFEST_VERSION) {
		issues.push({ path: "$.version", message: "must equal 1" });
	}
	const iterationId = readRequiredString(value, "$.iterationId", issues);
	const baseGitSha = readRequiredString(value, "$.baseGitSha", issues);
	const createdAt = readRequiredString(value, "$.createdAt", issues);
	const changes = readChanges(value, iterationId, issues);

	if (issues.length > 0 || iterationId === null || baseGitSha === null || createdAt === null || changes === null) {
		return invalid(issues);
	}
	return {
		valid: true,
		manifest: {
			version: CHANGE_MANIFEST_VERSION,
			iterationId,
			baseGitSha,
			createdAt,
			changes,
		},
		issues: [],
	};
}

function readChanges(
	record: Record<string, unknown>,
	iterationId: string | null,
	issues: ManifestValidationIssue[],
): ManifestChange[] | null {
	const value = record.changes;
	if (!Array.isArray(value)) {
		issues.push({ path: "$.changes", message: "expected array" });
		return null;
	}
	const changes: ManifestChange[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const change = readChange(value[index], `$.changes[${index}]`, iterationId, issues);
		if (change !== null) changes.push(change);
	}
	return changes;
}

function readChange(
	value: unknown,
	path: string,
	iterationId: string | null,
	issues: ManifestValidationIssue[],
): ManifestChange | null {
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return null;
	}
	const id = readRequiredString(value, `${path}.id`, issues);
	const componentIds = readRequiredStringArray(value, `${path}.componentIds`, issues);
	const filesChanged = readRequiredStringArray(value, `${path}.filesChanged`, issues);
	const authorityLevel = readAuthorityLevel(value, `${path}.authorityLevel`, issues);
	const evidenceRefs = readRequiredStringArray(value, `${path}.evidenceRefs`, issues);
	const rootCause = readRequiredString(value, `${path}.rootCause`, issues);
	const targetedFix = readRequiredString(value, `${path}.targetedFix`, issues);
	const predictedFixes = readRequiredStringArray(value, `${path}.predictedFixes`, issues);
	const predictedRegressions = readRequiredStringArray(value, `${path}.predictedRegressions`, issues);
	const validationPlan = readRequiredStringArray(value, `${path}.validationPlan`, issues);
	const rollbackPlan = readRequiredString(value, `${path}.rollbackPlan`, issues);
	const expectedBudgetImpact = readExpectedBudgetImpact(value, `${path}.expectedBudgetImpact`, issues);

	if (componentIds !== null && filesChanged !== null && componentIds.length === 0 && filesChanged.length === 0) {
		issues.push({ path, message: "requires at least one componentIds or filesChanged entry" });
	}
	if (authorityLevel !== null && predictedRegressions !== null && isHighAuthorityLevel(authorityLevel)) {
		if (predictedRegressions.length === 0) {
			issues.push({ path: `${path}.predictedRegressions`, message: "high-authority changes require an entry" });
		}
	}
	if (evidenceRefs !== null && evidenceRefs.length === 0) {
		if (iterationId === null || !allowsEmptyEvidenceRefs(iterationId)) {
			issues.push({
				path: `${path}.evidenceRefs`,
				message: "empty evidence refs are allowed only for exploratory-1",
			});
		}
	}

	if (
		id === null ||
		componentIds === null ||
		filesChanged === null ||
		authorityLevel === null ||
		evidenceRefs === null ||
		rootCause === null ||
		targetedFix === null ||
		predictedFixes === null ||
		predictedRegressions === null ||
		validationPlan === null ||
		rollbackPlan === null
	) {
		return null;
	}
	const change: ManifestChange = {
		id,
		componentIds,
		filesChanged,
		authorityLevel,
		evidenceRefs,
		rootCause,
		targetedFix,
		predictedFixes,
		predictedRegressions,
		validationPlan,
		rollbackPlan,
	};
	if (expectedBudgetImpact !== undefined) change.expectedBudgetImpact = expectedBudgetImpact;
	return change;
}

function readRequiredString(
	record: Record<string, unknown>,
	path: string,
	issues: ManifestValidationIssue[],
): string | null {
	const field = path.slice(path.lastIndexOf(".") + 1);
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({ path, message: "expected non-empty string" });
		return null;
	}
	return value;
}

function readRequiredStringArray(
	record: Record<string, unknown>,
	path: string,
	issues: ManifestValidationIssue[],
): string[] | null {
	const field = path.slice(path.lastIndexOf(".") + 1);
	const value = record[field];
	if (!Array.isArray(value)) {
		issues.push({ path, message: "expected string array" });
		return null;
	}
	const strings: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || item.trim().length === 0) {
			issues.push({ path: `${path}[${index}]`, message: "expected non-empty string" });
			continue;
		}
		strings.push(item);
	}
	return strings;
}

function readAuthorityLevel(
	record: Record<string, unknown>,
	path: string,
	issues: ManifestValidationIssue[],
): ManifestAuthorityLevel | null {
	const value = record.authorityLevel;
	if (typeof value !== "string" || !isManifestAuthorityLevel(value)) {
		issues.push({ path, message: `expected one of ${MANIFEST_AUTHORITY_LEVELS.join(", ")}` });
		return null;
	}
	return value;
}

function readExpectedBudgetImpact(
	record: Record<string, unknown>,
	path: string,
	issues: ManifestValidationIssue[],
): ExpectedBudgetImpact | undefined {
	if (!Object.hasOwn(record, "expectedBudgetImpact")) return undefined;
	const value = record.expectedBudgetImpact;
	if (!isRecord(value)) {
		issues.push({ path, message: "expected object" });
		return undefined;
	}
	const risk = value.risk;
	if (typeof risk !== "string" || !isBudgetImpactRisk(risk)) {
		issues.push({ path: `${path}.risk`, message: `expected one of ${BUDGET_IMPACT_RISKS.join(", ")}` });
		return undefined;
	}
	const impact: ExpectedBudgetImpact = { risk };
	const tokenDelta = readOptionalNumber(value, `${path}.tokenDelta`, issues);
	const wallTimeDeltaMs = readOptionalNumber(value, `${path}.wallTimeDeltaMs`, issues);
	if (tokenDelta !== undefined) impact.tokenDelta = tokenDelta;
	if (wallTimeDeltaMs !== undefined) impact.wallTimeDeltaMs = wallTimeDeltaMs;
	return impact;
}

function readOptionalNumber(
	record: Record<string, unknown>,
	path: string,
	issues: ManifestValidationIssue[],
): number | undefined {
	const field = path.slice(path.lastIndexOf(".") + 1);
	if (!Object.hasOwn(record, field)) return undefined;
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		issues.push({ path, message: "expected finite number" });
		return undefined;
	}
	return value;
}

function isManifestAuthorityLevel(value: string): value is ManifestAuthorityLevel {
	return MANIFEST_AUTHORITY_LEVELS.includes(value as ManifestAuthorityLevel);
}

function isBudgetImpactRisk(value: string): value is BudgetImpactRisk {
	return BUDGET_IMPACT_RISKS.includes(value as BudgetImpactRisk);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(issues: ManifestValidationIssue[]): ManifestValidationResult {
	return { valid: false, issues };
}
