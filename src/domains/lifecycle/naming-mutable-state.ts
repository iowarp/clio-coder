import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { safeResourceWrite } from "../../core/safe-resource-write.js";

export const MUTABLE_NAMING_BACKUP_SUFFIX = ".pre-clio-coder-naming.bak";

const MUTABLE_STATE_FILES = [
	"dispatch-admission.json",
	"dispatch-verification-memo.json",
	"endpoint-slots.json",
	"fleet-preflight.json",
	"interop.json",
] as const;

export interface MutableNamingCounts {
	lifecycle: number;
	toolGovernance: number;
	source: number;
}

export interface MutableNamingStateReport {
	path: string;
	changed: boolean;
	backupPath: string | null;
	counts: MutableNamingCounts;
	error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Field-aware transform: user text and unknown string values are never searched or replaced. */
export function transformMutableNamingState(value: unknown): { value: unknown; counts: MutableNamingCounts } {
	const next = structuredClone(value);
	const counts: MutableNamingCounts = { lifecycle: 0, toolGovernance: 0, source: 0 };
	const visit = (current: unknown): void => {
		if (Array.isArray(current)) {
			for (const entry of current) visit(entry);
			return;
		}
		if (!isRecord(current)) return;
		for (const [key, entry] of Object.entries(current)) {
			if (key === "lifecycle" && entry === "clio-managed") {
				current[key] = "clio-coder-managed";
				counts.lifecycle += 1;
				continue;
			}
			if (key === "toolGovernance" && entry === "clio-policy") {
				current[key] = "clio-coder-policy";
				counts.toolGovernance += 1;
				continue;
			}
			if (key === "source" && entry === "clio") {
				current[key] = "clio-coder";
				counts.source += 1;
				continue;
			}
			visit(entry);
		}
	};
	visit(next);
	return { value: next, counts };
}

function total(counts: MutableNamingCounts): number {
	return counts.lifecycle + counts.toolGovernance + counts.source;
}

/**
 * Rewrite only the audited mutable, unsealed JSON allowlist. Run/session
 * ledgers, receipts, evidence, evals, trace, gate decisions, protected
 * artifacts, and exported archives are deliberately unreachable here.
 */
export function migrateMutableNamingState(stateDir: string): MutableNamingStateReport[] {
	const reports: MutableNamingStateReport[] = [];
	for (const name of MUTABLE_STATE_FILES) {
		const path = join(stateDir, name);
		if (!existsSync(path)) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			const transformed = transformMutableNamingState(parsed);
			const changed = total(transformed.counts) > 0;
			const backupPath = changed ? `${path}${MUTABLE_NAMING_BACKUP_SUFFIX}` : null;
			if (changed) {
				safeResourceWrite(path, `${JSON.stringify(transformed.value, null, 2)}\n`, {
					encoding: "utf8",
					backup: { path: backupPath as string },
				});
			}
			reports.push({ path, changed, backupPath, counts: transformed.counts, error: null });
		} catch (error) {
			reports.push({
				path,
				changed: false,
				backupPath: null,
				counts: { lifecycle: 0, toolGovernance: 0, source: 0 },
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return reports;
}
