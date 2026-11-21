import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml";
import { settingsPath, validateSettings, withSettingsLock } from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * Moves persisted live state onto the fleet role vocabulary (fleet M12). Before it, a run's execution role was
 * `researcher` for read-only reconnaissance and for a council member alike, and `verifier` for a direct typed check;
 * the vocabulary names them `explorer`, `seat` and `checker`. Two live stores carry those names:
 *
 * - the user settings.yaml, whose `fleet.adaptiveRouting.roles` and `agentRoles[].executionRole` activate adaptive
 *   routing per role. `researcher` authorized both populations it covered, so it becomes `explorer` and `seat`;
 *   `verifier` becomes `checker`. Project layers are the repository's and stay as written.
 * - the dispatch ledger, `runs.json`, which the next process reads as live fleet state. A row's `researcher` becomes
 *   `seat` when the row sat in a council (`gate.role` member) and `explorer` otherwise; `verifier` becomes `checker`.
 *
 * Sealed run journals are history: they keep the names they were written with and read as recorded.
 */
const ID = "2026-11-21-fleet-role-names";

const RENAMED: Readonly<Record<string, ReadonlyArray<string>>> = {
	researcher: ["explorer", "seat"],
	verifier: ["checker"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One role list with each retired name replaced by the names it covered, in place, without duplicates. */
function renamedList(values: ReadonlyArray<unknown>): unknown[] {
	const out: unknown[] = [];
	for (const value of values) {
		const names = typeof value === "string" ? (RENAMED[value] ?? [value]) : [value];
		for (const name of names) if (!out.includes(name)) out.push(name);
	}
	return out;
}

/** The agent-role pairs with each retired role replaced by the pairs it covered, without duplicates. */
function renamedPairs(values: ReadonlyArray<unknown>): unknown[] {
	const out: unknown[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const role = isRecord(value) ? value.executionRole : undefined;
		const names = typeof role === "string" ? (RENAMED[role] ?? [role]) : [role];
		for (const name of names) {
			const pair = isRecord(value) && name !== undefined ? { ...value, executionRole: name } : value;
			const key = isRecord(pair) ? `${String(pair.agentId)}\u0000${String(pair.executionRole)}` : null;
			if (key !== null && seen.has(key)) continue;
			if (key !== null) seen.add(key);
			out.push(pair);
		}
	}
	return out;
}

/** The settings rewrite over a plain document, for the strict-reader projection. */
function projectRoleNames(raw: unknown): unknown {
	if (!isRecord(raw) || !isRecord(raw.fleet) || !isRecord(raw.fleet.adaptiveRouting)) return raw;
	const adaptive = raw.fleet.adaptiveRouting;
	const next: Record<string, unknown> = { ...adaptive };
	if (Array.isArray(adaptive.roles)) next.roles = renamedList(adaptive.roles);
	if (Array.isArray(adaptive.agentRoles)) next.agentRoles = renamedPairs(adaptive.agentRoles);
	return { ...raw, fleet: { ...raw.fleet, adaptiveRouting: next } };
}

/** The same rewrite on the YAML document, so comments and every other byte stay as written. */
function rewriteSettings(doc: Document): string[] {
	const changed: string[] = [];
	const roles = doc.getIn(["fleet", "adaptiveRouting", "roles"], true);
	if (isSeq(roles)) {
		const before = roles.items.map((item) => (isScalar(item) ? item.value : item));
		const after = renamedList(before);
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			roles.items = after.map((value) => (typeof value === "string" ? new Scalar(value) : value)) as typeof roles.items;
			changed.push(`fleet.adaptiveRouting.roles: ${before.join(", ")} → ${after.join(", ")}.`);
		}
	}
	const pairs = doc.getIn(["fleet", "adaptiveRouting", "agentRoles"], true);
	if (isSeq(pairs)) {
		const items = [...pairs.items];
		pairs.items = [];
		const seen = new Set<string>();
		for (const item of items) {
			const role = isMap(item) ? item.get("executionRole") : undefined;
			const names = typeof role === "string" ? (RENAMED[role] ?? [role]) : null;
			if (!isMap(item) || names === null) {
				pairs.items.push(item);
				continue;
			}
			const agentId = String(item.get("agentId"));
			for (const name of names) {
				const key = `${agentId}\u0000${name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const pair = name === role ? item : item.clone();
				if (name !== role) pair.set("executionRole", name);
				pairs.items.push(pair);
			}
			if (names[0] !== role)
				changed.push(
					`fleet.adaptiveRouting.agentRoles: ${agentId}/${String(role)} → ${names.map((name) => `${agentId}/${name}`).join(", ")}.`,
				);
		}
	}
	return changed;
}

async function migrateSettings(report: MigrationReport): Promise<void> {
	await withSettingsLock(() => {
		const file = settingsPath();
		if (!existsSync(file)) return;
		const doc = parseDocument(readFileSync(file, "utf8"));
		if (doc.errors.length > 0) throw new Error(`fleet role names migration: ${doc.errors[0]?.message}`);
		const before = doc.toJS() as unknown;
		if (!isRecord(before) || (before.version !== undefined && before.version !== 2)) return;
		const changed = rewriteSettings(doc);
		if (changed.length === 0) return;
		const next = doc.toString({ lineWidth: 0 });
		// The rewrite only renames roles; an issue it introduces means it misread the file.
		const known = new Set(validateSettings(before).issues.map((issue) => issue.path));
		const introduced = validateSettings(parseDocument(next).toJS()).issues.filter((issue) => !known.has(issue.path));
		if (introduced.length > 0)
			throw new Error(
				`fleet role names migration left settings.yaml unchanged: the rewrite would introduce ${introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
			);
		const backupPath = `${file}.roles.bak`;
		safeResourceWrite(file, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE, backup: { path: backupPath } });
		report.changed.push(
			`Renamed worker roles in settings.yaml to the fleet role vocabulary (the previous file is ${backupPath}):`,
			...changed,
		);
	});
}

/** The role a ledger row runs under in the fleet vocabulary, or the row's own value when it holds no retired name. */
function ledgerRole(row: Record<string, unknown>): unknown {
	if (row.executionRole === "verifier") return "checker";
	if (row.executionRole !== "researcher") return row.executionRole;
	return isRecord(row.gate) && row.gate.role === "member" ? "seat" : "explorer";
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
			// The ledger replaces a file it cannot read on its next write; there is nothing to rename.
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
			`Renamed the execution role of ${moved} dispatch ledger row(s) to the fleet role vocabulary (researcher to explorer or seat, verifier to checker).`,
		);
}

const migration: Migration = {
	id: ID,
	projectSettings(raw: unknown): unknown {
		if (!isRecord(raw) || (raw.version !== undefined && raw.version !== 2)) return raw;
		return projectRoleNames(raw);
	},
	async up(stateDir: string): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		await migrateSettings(report);
		await migrateLedger(stateDir, report);
		return report;
	},
};

export default migration;
