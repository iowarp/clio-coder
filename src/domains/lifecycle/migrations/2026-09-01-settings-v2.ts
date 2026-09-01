import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SettingsValidationError, settingsPath, validateSettings, withSettingsLock } from "../../../core/config.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Migration } from "./index.js";

export const SETTINGS_V2_MIGRATION_ID = "2026-09-01-settings-v2";

export interface SettingsV2MigrationReport {
	fromVersion: 1;
	toVersion: 2;
	backupPath: string;
	moved: string[];
	dropped: string[];
	notes: string[];
}

export class SettingsV2CollisionError extends Error {
	readonly collisions: ReadonlyArray<string>;

	constructor(collisions: ReadonlyArray<string>) {
		super(
			"settings v1 to v2 migration refused source/destination collisions:\n" +
				collisions.map((collision) => `  ${collision}`).join("\n") +
				"\nThe original settings.yaml was left untouched. Remove either each v1 source or its v2 destination, then re-run `clio-coder upgrade`.",
		);
		this.name = "SettingsV2CollisionError";
		this.collisions = collisions;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function segments(path: string): string[] {
	return path.split(".");
}

function hasPath(root: Record<string, unknown>, path: string): boolean {
	let current: unknown = root;
	for (const segment of segments(path)) {
		if (!isPlainObject(current) || !(segment in current)) return false;
		current = current[segment];
	}
	return true;
}

function getPath(root: Record<string, unknown>, path: string): unknown {
	let current: unknown = root;
	for (const segment of segments(path)) {
		if (!isPlainObject(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
	const parts = segments(path);
	let current = root;
	for (const segment of parts.slice(0, -1)) {
		const child = current[segment];
		if (isPlainObject(child)) current = child;
		else {
			const created: Record<string, unknown> = {};
			current[segment] = created;
			current = created;
		}
	}
	const leaf = parts.at(-1);
	if (leaf !== undefined) current[leaf] = value;
}

function deletePath(root: Record<string, unknown>, path: string): boolean {
	const parts = segments(path);
	const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
	let current = root;
	for (const segment of parts.slice(0, -1)) {
		const child = current[segment];
		if (!isPlainObject(child)) return false;
		parents.push({ parent: current, key: segment });
		current = child;
	}
	const leaf = parts.at(-1);
	if (leaf === undefined || !(leaf in current)) return false;
	delete current[leaf];
	for (let index = parents.length - 1; index >= 0; index -= 1) {
		const entry = parents[index];
		if (entry === undefined) continue;
		const child = entry.parent[entry.key];
		if (isPlainObject(child) && Object.keys(child).length === 0) delete entry.parent[entry.key];
		else break;
	}
	return true;
}

export interface SettingsV2DocumentTransform {
	document: Record<string, unknown>;
	moved: string[];
	dropped: string[];
	notes: string[];
	collisions: string[];
}

type ValueTransform = (value: unknown, transform: SettingsV2DocumentTransform) => unknown;

function destinationConflict(root: Record<string, unknown>, path: string): string | null {
	const parts = segments(path);
	let current: Record<string, unknown> = root;
	let traversed = "";
	for (let index = 0; index < parts.length; index += 1) {
		const segment = parts[index];
		if (segment === undefined) return null;
		traversed = traversed ? `${traversed}.${segment}` : segment;
		if (!(segment in current)) return null;
		const child = current[segment];
		if (index === parts.length - 1) return traversed;
		if (!isPlainObject(child)) return traversed;
		current = child;
	}
	return null;
}

function move(
	transform: SettingsV2DocumentTransform,
	from: string,
	to: string,
	valueTransform: ValueTransform = cloneValue,
): void {
	if (!hasPath(transform.document, from)) return;
	const conflict = destinationConflict(transform.document, to);
	if (conflict !== null) {
		transform.collisions.push(`${from} collides with ${conflict}`);
		return;
	}
	setPath(transform.document, to, valueTransform(getPath(transform.document, from), transform));
	deletePath(transform.document, from);
	transform.moved.push(`${from} -> ${to}`);
}

function drop(transform: SettingsV2DocumentTransform, path: string, reason: string): void {
	if (!deletePath(transform.document, path)) return;
	transform.dropped.push(`${path}: ${reason}`);
}

function migrateRosters(value: unknown, transform: SettingsV2DocumentTransform): unknown {
	const rosters = cloneValue(value);
	if (!isPlainObject(rosters)) return rosters;
	for (const [rosterName, roster] of Object.entries(rosters)) {
		if (!isPlainObject(roster) || !Array.isArray(roster.members)) continue;
		for (let index = 0; index < roster.members.length; index += 1) {
			const member = roster.members[index];
			if (!isPlainObject(member) || !("thinking" in member)) continue;
			const from = `workers.rosters.${rosterName}.members[${index}].thinking`;
			const to = `fleet.rosters.${rosterName}.members[${index}].thinkingLevel`;
			if ("thinkingLevel" in member) {
				transform.collisions.push(`${from} collides with ${to}`);
				continue;
			}
			member.thinkingLevel = member.thinking;
			delete member.thinking;
			transform.moved.push(`${from} -> ${to}`);
		}
	}
	return rosters;
}

function migrateFleetNodeAliases(transform: SettingsV2DocumentTransform): void {
	const nodes = getPath(transform.document, "fleet.nodes");
	if (!Array.isArray(nodes)) return;
	for (let index = 0; index < nodes.length; index += 1) {
		const node = nodes[index];
		if (!isPlainObject(node) || !("clioEntry" in node)) continue;
		const from = `fleet.nodes[${index}].clioEntry`;
		const to = `fleet.nodes[${index}].clioCoderEntry`;
		if ("clioCoderEntry" in node) {
			delete node.clioEntry;
			transform.dropped.push(`${from}: discarded because canonical ${to} was also present and wins`);
			continue;
		}
		node.clioCoderEntry = node.clioEntry;
		delete node.clioEntry;
		transform.moved.push(`${from} -> ${to}`);
	}
}

/** Pure in-memory transformation used by the lifecycle migration and archive import. */
export function migrateSettingsV1Document(raw: unknown): SettingsV2DocumentTransform {
	if (!isPlainObject(raw)) throw new Error("settings v1 to v2 migration expected a YAML map at the document root");
	const version = raw.version;
	if (version !== undefined && version !== 1) {
		throw new Error(`settings v1 to v2 migration expected version 1, got ${String(version)}`);
	}
	const transform: SettingsV2DocumentTransform = {
		document: cloneValue(raw),
		moved: [],
		dropped: [],
		notes: version === undefined ? ["version was absent; interpreted using the pre-v2 schema"] : [],
		collisions: [],
	};

	const moves: ReadonlyArray<readonly [string, string, ValueTransform?]> = [
		["autonomy", "safety.autonomy"],
		["orchestrator.target", "chat.target"],
		["orchestrator.model", "chat.model"],
		["orchestrator.thinkingLevel", "chat.thinkingLevel"],
		["scope", "chat.modelPicker.cycleSet"],
		["modelSelector.favorites", "chat.modelPicker.favorites"],
		["modelSelector.recentLimit", "chat.modelPicker.recentLimit"],
		["defaults.maxTokens", "chat.maxOutputTokens"],
		["prewarm.enabled", "chat.prewarm"],
		["retry", "chat.retry"],
		["workers.default", "fleet.default"],
		["workers.profiles", "fleet.profiles"],
		["workers.rosters", "fleet.rosters", migrateRosters],
		["workers.agentBindings", "fleet.agentProfiles"],
		["routing.activeRoles", "fleet.adaptiveRouting.roles"],
		["routing.activePostures", "fleet.adaptiveRouting.postures"],
		["routing.agentAutomation.activeAgentRoles", "fleet.adaptiveRouting.agentRoles"],
		["budget.concurrency", "fleet.concurrency"],
		["workers.maxRetries", "fleet.retry.maxRetries"],
		["workers.resilienceCooldownMs", "fleet.retry.routeCooldownMs"],
		["workers.onPermission", "fleet.permissions.mode"],
		["workers.escalation", "fleet.permissions.escalation"],
		["guardrails.workerToolCallCap", "fleet.limits.toolCallsPerRun"],
		["guardrails.internalDispatchTimeoutMs", "fleet.limits.internalRunTimeoutMs"],
		["guardrails.maxDispatchRuns", "fleet.history.maxRuns"],
		["compaction.auto", "context.compaction.auto"],
		["compaction.threshold", "context.compaction.threshold"],
		["compaction.model", "context.compaction.model"],
		["compaction.systemPrompt", "context.compaction.systemPrompt"],
		["background.target", "context.memory.target"],
		["background.model", "context.memory.model"],
		["memory.intervention.enabled", "context.memory.enabled"],
		["memory.intervention.everyNTools", "context.memory.cadenceToolCalls"],
		["memory.intervention.windowSteps", "context.memory.trajectorySteps"],
		["memory.intervention.maxTokens", "context.memory.maxOutputTokens"],
		["memory.intervention.timeoutMs", "context.memory.timeoutMs"],
		["budget.sessionCeilingUsd", "safety.limits.sessionCostUsd"],
		["guardrails.turnToolCallBudget", "safety.limits.chatToolCallsPerTurn"],
		["guardrails.readMaxBytes", "safety.limits.readBytesPerCall"],
		["guardrails.observationTurnBudgetBytes", "safety.limits.observationBytesPerTurn"],
		["watchdog", "safety.review"],
		["terminal.outputVerbosity", "interface.outputDetail"],
		["terminal.smoothStreaming", "interface.smoothStreaming"],
		["terminal.tuiMode", "interface.mode"],
		["terminal.fullscreenScrollbar", "interface.fullscreenScrollbar"],
		["terminal.showTerminalProgress", "interface.terminalProgress"],
		["terminal.notify", "interface.desktopNotifications"],
		["panes.enabled", "interface.panes.enabled"],
		["panes.notifications", "interface.panes.notifications"],
		["panes.journal", "fleet.history.journal"],
		["panes.yazi.enabled", "interface.panes.files.enabled"],
		["panes.yazi.mode", "interface.panes.files.mode"],
		["panes.yazi.profile", "interface.panes.files.profile"],
		["panes.yazi.followCwd", "interface.panes.files.followCwd"],
		["keybindings", "interface.keybindings"],
		["skills.trustProjectCompatRoots", "integrations.projectResources.trustProjectImports"],
		["delegation.defaults", "integrations.externalAgents.defaults"],
		["delegation.agents", "integrations.externalAgents.entries"],
		["runtimePlugins", "integrations.runtimePlugins"],
		["library", "integrations.library"],
		["attribution.gitCommits", "integrations.git.commitAttribution"],
	];
	for (const [from, to, valueTransform] of moves) move(transform, from, to, valueTransform);

	drop(transform, "identity", "accepted and ignored; no behavior was lost");
	drop(transform, "background.thinkingLevel", "unused; proactive memory always resolves thinking off");
	drop(transform, "theme", "inactive; runtime rendering did not read it");
	drop(transform, "compaction.excludeLastTurns", "legacy-mask only; context.workingSet.protectLastTurns remains");
	// The keys v0.4.0 shipped moved above; what can remain under `panes` is the
	// retired agents/keepFailed pair (normally already stripped by the
	// retire-panes-knobs migration, which runs first) or unknown keys, none of
	// which has a v2 home.
	drop(
		transform,
		"panes",
		"remaining panes keys have no v2 successor; the shipped keys moved to interface.panes.* and fleet.history.journal",
	);
	migrateFleetNodeAliases(transform);

	if (transform.collisions.length > 0) throw new SettingsV2CollisionError(transform.collisions);
	transform.document.version = 2;
	const validated = validateSettings(transform.document);
	if (validated.issues.length > 0) throw new SettingsValidationError(validated.issues);
	return transform;
}

function reportPath(stateDir: string): string {
	return join(stateDir, "migration-reports", `${SETTINGS_V2_MIGRATION_ID}.json`);
}

const migration: Migration = {
	id: SETTINGS_V2_MIGRATION_ID,
	async up(stateDir: string): Promise<void> {
		withSettingsLock(() => {
			const path = settingsPath();
			if (!existsSync(path)) return;
			let rawText: string;
			let parsed: unknown;
			try {
				rawText = readFileSync(path, "utf8");
				parsed = parseYaml(rawText);
			} catch (error) {
				throw new Error(
					`settings v1 to v2 migration could not read and parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (isPlainObject(parsed) && parsed.version === 2) return;
			const transformed = migrateSettingsV1Document(parsed);
			const backupPath = `${path}.v1.bak`;
			safeResourceWrite(path, stringifyYaml(transformed.document), {
				encoding: "utf8",
				mode: 0o644,
				backup: { path: backupPath },
			});
			const report: SettingsV2MigrationReport = {
				fromVersion: 1,
				toVersion: 2,
				backupPath,
				moved: transformed.moved,
				dropped: transformed.dropped,
				notes: transformed.notes,
			};
			const target = reportPath(stateDir);
			mkdirSync(join(stateDir, "migration-reports"), { recursive: true });
			safeResourceWrite(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
		});
	},
};

export default migration;
