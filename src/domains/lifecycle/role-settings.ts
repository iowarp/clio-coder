/**
 * The settings half of the role rule (row 352, DESIGN 4.2). `fleet.adaptiveRouting` activates adaptive routing per
 * role, and per agent and role. Two kinds of entry there no longer name runs the rule produces:
 *
 * - a retired role name (`researcher`, `verifier`), which the loader refuses with the names that replace it;
 * - an `agentRoles` pair whose agent's runs moved to another population (a Debugger is a checker, never a builder),
 *   which loads but activates nothing.
 *
 * There is no migration: `doctor --fix`, which the installer also runs against the home on post-install, rewrites
 * both here. A retired name becomes every name that covers its runs; a moved pair becomes the agent's populations by
 * `agentRunRoles`. A pair for an agent this workspace cannot resolve and the project layers stay as written.
 */

import { existsSync, readFileSync } from "node:fs";
import { type Document, isMap, isScalar, isSeq, parseDocument, parse as parseYaml, Scalar } from "yaml";
import { settingsPath, validateSettings, withSettingsLock } from "../../core/config.js";
import { RETIRED_ROUTING_ROLE_NAMES, SETTINGS_FILE_MODE } from "../../core/defaults.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { discoverAgentRecipes, normalizeAgentSpec } from "../agents/index.js";
import { type AgentRoleFacts, agentRunRoles } from "../dispatch/execution-role.js";

export interface RoleSettingsRepair {
	/** One line per rewritten entry, `path: before -> after`. */
	changes: string[];
	/** Whether the file was rewritten; false for a read-only plan. */
	written: boolean;
	/** Why a needed rewrite was not written: it would have introduced a validation issue. */
	refused: string | null;
}

const UNGATED = new Set(["builder", "explorer", "checker"]);

function retiredNames(value: unknown): ReadonlyArray<string> | null {
	return typeof value === "string" && Object.hasOwn(RETIRED_ROUTING_ROLE_NAMES, value)
		? (RETIRED_ROUTING_ROLE_NAMES[value] ?? null)
		: null;
}

/**
 * Recipe facts for the population check. Recipe discovery reads settings, so while the file still names a retired role
 * it cannot run; every agent is then unknown and its pairs stay as written until the names are fixed.
 */
function agentFacts(): (agentId: string) => AgentRoleFacts | null {
	let facts: Map<string, AgentRoleFacts> | null = null;
	return (agentId) => {
		if (facts === null) {
			facts = new Map();
			try {
				for (const recipe of discoverAgentRecipes()) {
					const spec = normalizeAgentSpec(recipe);
					facts.set(spec.id, { capabilityClass: spec.capabilityClass, resultContract: spec.resultContract });
				}
			} catch {
				// The settings row reports why the file does not load.
			}
		}
		return facts.get(agentId) ?? null;
	};
}

/**
 * The rewrite on the YAML document, so comments and every other byte stay as written. Without recipe facts it
 * rewrites only retired names.
 */
function rewrite(doc: Document, resolveFacts: ((agentId: string) => AgentRoleFacts | null) | null): string[] {
	const changes: string[] = [];
	const roles = doc.getIn(["fleet", "adaptiveRouting", "roles"], true);
	if (isSeq(roles)) {
		const before = roles.items.map((item) => (isScalar(item) ? item.value : item));
		const after: unknown[] = [];
		for (const value of before)
			for (const name of retiredNames(value) ?? [value]) if (!after.includes(name)) after.push(name);
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			roles.items = after.map((value) => (typeof value === "string" ? new Scalar(value) : value)) as typeof roles.items;
			changes.push(`fleet.adaptiveRouting.roles: ${before.join(", ")} -> ${after.join(", ")}`);
		}
	}
	const pairs = doc.getIn(["fleet", "adaptiveRouting", "agentRoles"], true);
	if (!isSeq(pairs)) return changes;
	const items = [...pairs.items];
	pairs.items = [];
	const seen = new Set<string>();
	for (const item of items) {
		const agentId = isMap(item) ? item.get("agentId") : undefined;
		const role = isMap(item) ? item.get("executionRole") : undefined;
		if (!isMap(item) || typeof agentId !== "string" || typeof role !== "string") {
			pairs.items.push(item);
			continue;
		}
		const population = resolveFacts === null ? null : agentRunRoles(agentId, resolveFacts);
		const names: string[] = [];
		for (const name of retiredNames(role) ?? [role]) {
			const moved = population !== null && UNGATED.has(name) && !(population as string[]).includes(name);
			for (const next of moved ? population : [name]) if (!names.includes(next)) names.push(next);
		}
		for (const name of names) {
			const key = `${agentId}\u0000${name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const pair = name === role ? item : item.clone();
			if (name !== role) pair.set("executionRole", name);
			pairs.items.push(pair);
		}
		if (names.length !== 1 || names[0] !== role)
			changes.push(`${agentId}/${role} -> ${names.map((name) => `${agentId}/${name}`).join(", ")}`);
	}
	return changes;
}

interface Planned {
	changes: string[];
	next: string;
	before: unknown;
}

function plan(text: string, resolveFacts: ((agentId: string) => AgentRoleFacts | null) | null): Planned | null {
	const doc = parseDocument(text);
	if (doc.errors.length > 0) return null;
	const before = doc.toJS() as unknown;
	const version = typeof before === "object" && before !== null ? (before as { version?: unknown }).version : null;
	if (version !== undefined && version !== 2) return null;
	const changes = rewrite(doc, resolveFacts);
	return changes.length === 0 ? null : { changes, next: doc.toString({ lineWidth: 0 }), before };
}

/** The validation issues a rewrite would introduce, or null when it introduces none. */
function introducedIssues(planned: Planned): string | null {
	const known = new Set(validateSettings(planned.before).issues.map((issue) => issue.path));
	const introduced = validateSettings(parseYaml(planned.next)).issues.filter((issue) => !known.has(issue.path));
	return introduced.length === 0 ? null : introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

/**
 * Rewrite retired role names and moved agent populations in the user settings.yaml, or, with `write: false`, only
 * say what a rewrite would change. The names go first: recipe discovery reads settings, so the population check runs
 * on the file once it loads. Nothing is written that introduces a new validation issue.
 */
export function repairRoleSettings(options: { write: boolean }): RoleSettingsRepair {
	const file = settingsPath();
	const result: RoleSettingsRepair = { changes: [], written: false, refused: null };
	if (!existsSync(file)) return result;
	if (!options.write) {
		const names = plan(readFileSync(file, "utf8"), null);
		const populations = plan(names?.next ?? readFileSync(file, "utf8"), names === null ? agentFacts() : null);
		result.changes.push(...(names?.changes ?? []), ...(populations?.changes ?? []));
		return result;
	}
	return withSettingsLock(() => {
		for (const facts of [null, agentFacts()]) {
			const planned = plan(readFileSync(file, "utf8"), facts);
			if (planned === null) continue;
			result.changes.push(...planned.changes);
			result.refused = introducedIssues(planned);
			if (result.refused !== null) return result;
			safeResourceWrite(file, planned.next, { encoding: "utf8", mode: SETTINGS_FILE_MODE });
			result.written = true;
		}
		return result;
	});
}
