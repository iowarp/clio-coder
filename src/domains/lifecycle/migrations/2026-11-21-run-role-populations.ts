import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { settingsPath, validateSettings, withSettingsLock } from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import { discoverAgentRecipes, normalizeAgentSpec } from "../../agents/index.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Moves persisted live state onto the one role rule (DESIGN 4.2, fleet M12). Before it, a run's execution role came
 * from its recipe alone: a `verifier-report` or `review-verdict` contract made a checker, a read-only class an
 * explorer, and anything else a builder, so a Debugger (a verification recipe) journaled `builder` and a Coder asked
 * to write nothing journaled `builder` too. The role now follows the run's envelope: a verification recipe is a
 * checker, and a run that may write nothing is an explorer. Two live stores carry those populations:
 *
 * - the dispatch ledger, `runs.json`, which the next process reads as live fleet state. A first-attempt row takes the
 *   role its envelope ran under; a row with no envelope takes the rule over its gate position, its permit's class and
 *   its read-only marker; a recovery row and a row with neither (the main agent's) stay as written.
 * - the user settings.yaml, whose `fleet.adaptiveRouting.agentRoles` pairs activate one agent's population. A pair
 *   naming the population its agent used to journal becomes the pairs naming where those runs journal now: a
 *   verification recipe's `builder` pair becomes `checker`, and a writing recipe's `builder` pair also covers its
 *   no-write runs as `explorer`. A pair for an agent this home cannot resolve, and the project layers, stay as written.
 *
 * Sealed run journals are history: they keep the role they were written with.
 */
const ID = "2026-11-21-run-role-populations";

/** The role rule as this migration applies it; fixed here so the migration means the same thing in every release. */
function runRole(gateRole: unknown, capabilityClass: unknown, readOnly: boolean): string {
	if (gateRole === "reviewer") return "reviewer";
	if (gateRole === "judge" || gateRole === "synthesis") return "judge";
	if (gateRole === "member") return "seat";
	if (capabilityClass === "verification") return "checker";
	return readOnly || capabilityClass === "read-only" ? "explorer" : "builder";
}

interface RoleFacts {
	capabilityClass: string;
	contractKind: string;
	hoare: boolean;
}

/** The population an agent's runs journaled before this migration, outside a gate. */
function previousRole(facts: RoleFacts): string {
	if (facts.contractKind === "verifier-report" || facts.contractKind === "review-verdict") return "checker";
	return facts.capabilityClass === "read-only" ? "explorer" : "builder";
}

/** Every population those same runs journal now: with their write scope, and asked to write nothing. */
function currentRoles(facts: RoleFacts): string[] {
	const roles = [
		runRole(undefined, facts.capabilityClass, facts.hoare),
		runRole(undefined, facts.capabilityClass, true),
	];
	return [...new Set(roles)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentFacts(): Map<string, RoleFacts> {
	const facts = new Map<string, RoleFacts>();
	for (const recipe of discoverAgentRecipes()) {
		const spec = normalizeAgentSpec(recipe);
		facts.set(spec.id, {
			capabilityClass: spec.capabilityClass,
			contractKind: spec.resultContract.kind,
			hoare: spec.resultContract.kind === "verifier-report" && spec.resultContract.assurance !== undefined,
		});
	}
	return facts;
}

async function migrateSettings(report: MigrationReport): Promise<void> {
	await withSettingsLock(() => {
		const file = settingsPath();
		if (!existsSync(file)) return;
		const doc = parseDocument(readFileSync(file, "utf8"));
		if (doc.errors.length > 0) throw new Error(`run role populations migration: ${doc.errors[0]?.message}`);
		const before = doc.toJS() as unknown;
		if (!isRecord(before) || (before.version !== undefined && before.version !== 2)) return;
		const pairs = doc.getIn(["fleet", "adaptiveRouting", "agentRoles"], true);
		if (!isSeq(pairs) || pairs.items.length === 0) return;
		const facts = agentFacts();
		const changed: string[] = [];
		const items = [...pairs.items];
		pairs.items = [];
		const seen = new Set<string>();
		for (const item of items) {
			const agentId = isMap(item) ? item.get("agentId") : undefined;
			const role = isMap(item) ? item.get("executionRole") : undefined;
			const agent = typeof agentId === "string" ? facts.get(agentId) : undefined;
			const names = agent !== undefined && role === previousRole(agent) ? currentRoles(agent) : null;
			if (!isMap(item) || names === null) {
				pairs.items.push(item);
				continue;
			}
			for (const name of names) {
				const key = `${String(agentId)}\u0000${name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const pair = name === role ? item : item.clone();
				if (name !== role) pair.set("executionRole", name);
				pairs.items.push(pair);
			}
			if (names.length !== 1 || names[0] !== role)
				changed.push(
					`fleet.adaptiveRouting.agentRoles: ${String(agentId)}/${String(role)} → ${names.map((name) => `${String(agentId)}/${name}`).join(", ")}.`,
				);
		}
		if (changed.length === 0) return;
		const next = doc.toString({ lineWidth: 0 });
		// The rewrite only moves roles between valid names; an issue it introduces means it misread the file.
		const known = new Set(validateSettings(before).issues.map((issue) => issue.path));
		const introduced = validateSettings(parseDocument(next).toJS()).issues.filter((issue) => !known.has(issue.path));
		if (introduced.length > 0)
			throw new Error(
				`run role populations migration left settings.yaml unchanged: the rewrite would introduce ${introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
			);
		const backupPath = `${file}.run-roles.bak`;
		safeResourceWrite(file, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE, backup: { path: backupPath } });
		report.changed.push(
			`Moved agent routing pairs in settings.yaml to the role each agent's runs now record (the previous file is ${backupPath}):`,
			...changed,
		);
	});
}

/** The role a ledger row's run ran under by the one rule, or the row's own value when the row cannot say. */
function ledgerRole(row: Record<string, unknown>): unknown {
	if (row.executionRole === "recovery") return row.executionRole;
	if (isRecord(row.lineage) && typeof row.lineage.attempt === "number" && row.lineage.attempt > 0)
		return row.executionRole;
	if (isRecord(row.envelope) && typeof row.envelope.role === "string") return row.envelope.role;
	if (!isRecord(row.permit) || typeof row.permit.capabilityClass !== "string") return row.executionRole;
	return runRole(isRecord(row.gate) ? row.gate.role : undefined, row.permit.capabilityClass, row.readOnly === true);
}

async function migrateLedger(stateDir: string, report: MigrationReport): Promise<void> {
	const path = join(stateDir, "runs.json");
	if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) return;
	const moved = await withStateFileLock(path, () => {
		const text = readFileSync(path, "utf8").trim();
		if (text.length === 0) return 0;
		let rows: unknown;
		try {
			rows = JSON.parse(text) as unknown;
		} catch {
			// The ledger replaces a file it cannot read on its next write; there is nothing to move.
			return 0;
		}
		if (!Array.isArray(rows)) return 0;
		let count = 0;
		const next = rows.map((row) => {
			if (!isRecord(row)) return row;
			const role = ledgerRole(row);
			if (role === row.executionRole) return row;
			count += 1;
			return { ...row, executionRole: role };
		});
		if (count > 0) safeResourceWrite(path, JSON.stringify(next));
		return count;
	});
	if (moved > 0)
		report.changed.push(
			`Moved the execution role of ${moved} dispatch ledger row(s) to the role each run's envelope ran under.`,
		);
}

const migration: Migration = {
	id: ID,
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		await migrateSettings(report);
		await migrateLedger(stateDir, report);
		return report;
	},
};

export default migration;
