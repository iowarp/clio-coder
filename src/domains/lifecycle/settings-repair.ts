/**
 * One-time repair for settings.yaml files written by older Clio versions.
 *
 * The strict settings validator (core/config.ts) landed after v0.2.2 and
 * rejects keys the lenient v0.2.2 reader accepted, so a file that booted fine
 * on v0.2.2 now fails startup with "unknown key". The migration registry
 * ships empty by design, so this repair is the sanctioned remediation: a
 * narrowly scoped, idempotent transform invoked through `clio doctor --fix`.
 *
 * It touches only the known removed/renamed legacy keys. Genuinely unknown
 * keys (typos, future keys, pre-v0.2.0 provider/runtime dialects) are left
 * untouched so the validator still reports them. A valid file with none of the
 * legacy keys is never rewritten.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMap, isSeq, parseDocument, parse as parseYaml, type YAMLMap } from "yaml";
import { type SettingsIssue, settingsPath, validateSettings, withSettingsLock } from "../../core/config.js";
import { recentModelsPath } from "../../core/recent-models.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";

/** Single-threshold compaction fallback, mirroring core/defaults.ts. */
const NEW_DEFAULT_COMPACTION_THRESHOLD = 0.8;

export interface SettingsRepair {
	/** True when at least one known legacy transform was applied. */
	changed: boolean;
	/** Rewritten YAML text. Equal to the input when `changed` is false. */
	text: string;
	/** Human-readable description of each applied transform, for reporting. */
	transforms: string[];
	/** recentModels harvested from a dropped top-level `state` block, if any. */
	recentModels: string[];
}

/** Coerce a YAML-extracted value into a clean list of non-empty strings. */
function toStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Rename a map's `endpoint` key to `target` in place. When both already exist
 * the legacy `endpoint` is dropped and `target` is kept. Returns true when the
 * map carried a legacy `endpoint`.
 */
function renameEndpointToTarget(node: YAMLMap): boolean {
	if (!node.has("endpoint")) return false;
	if (!node.has("target")) node.set("target", node.get("endpoint", true));
	node.delete("endpoint");
	return true;
}

/**
 * Apply the known v0.2.2 legacy transforms to a settings.yaml document,
 * preserving comments and unrelated keys via the YAML document API. Each
 * transform is guarded so a second pass over already-repaired text is a no-op.
 */
export function repairLegacySettings(yamlText: string): SettingsRepair {
	const doc = parseDocument(yamlText);
	const transforms: string[] = [];
	let recentModels: string[] = [];

	// safetyLevel was renamed to autonomy. The value passes through; an
	// out-of-range value remains a validation error rather than being guessed.
	if (doc.has("safetyLevel")) {
		if (doc.has("autonomy")) {
			transforms.push("dropped stale safetyLevel (autonomy already set)");
		} else {
			doc.set("autonomy", doc.get("safetyLevel", true));
			transforms.push("renamed safetyLevel -> autonomy");
		}
		doc.delete("safetyLevel");
	}

	// endpoints was the old name for targets. Carry the entries over rather
	// than dropping them; only drop when targets is already populated.
	if (doc.has("endpoints")) {
		const endpointsNode = doc.get("endpoints", true);
		const targetsNode = doc.get("targets", true);
		const targetsEmpty = targetsNode == null || (isSeq(targetsNode) && targetsNode.items.length === 0);
		if (targetsEmpty) {
			doc.set("targets", endpointsNode);
			const count = isSeq(endpointsNode) ? endpointsNode.items.length : 0;
			transforms.push(`moved endpoints -> targets (${count} ${count === 1 ? "entry" : "entries"})`);
		} else {
			transforms.push("dropped stale endpoints (targets already populated)");
		}
		doc.delete("endpoints");
	}

	// orchestrator/workers used `endpoint` as the routing key; it is now `target`.
	const orchestrator = doc.get("orchestrator");
	if (isMap(orchestrator) && renameEndpointToTarget(orchestrator)) {
		transforms.push("renamed orchestrator.endpoint -> orchestrator.target");
	}
	const workers = doc.get("workers");
	if (isMap(workers)) {
		const workerDefault = workers.get("default");
		if (isMap(workerDefault) && renameEndpointToTarget(workerDefault)) {
			transforms.push("renamed workers.default.endpoint -> workers.default.target");
		}
		const profiles = workers.get("profiles");
		if (isMap(profiles)) {
			for (const item of profiles.items) {
				if (isMap(item.value) && renameEndpointToTarget(item.value)) {
					transforms.push(`renamed workers.profiles.${String(item.key)}.endpoint -> .target`);
				}
			}
		}
	}

	// recentModels moved out of settings into the state dir. Harvest the list
	// for optional seeding, then drop the whole `state` block.
	if (doc.has("state")) {
		const recentNode = doc.getIn(["state", "recentModels"], true);
		recentModels = isSeq(recentNode) ? toStringList(recentNode.toJSON()) : [];
		doc.delete("state");
		transforms.push(
			recentModels.length > 0
				? `dropped state (carried ${recentModels.length} recent model${recentModels.length === 1 ? "" : "s"})`
				: "dropped state",
		);
	}

	// The graduated compaction.thresholds block collapsed to a single threshold.
	const compaction = doc.get("compaction");
	if (isMap(compaction) && compaction.has("thresholds")) {
		const mask = doc.getIn(["compaction", "thresholds", "maskObservations"]);
		const threshold =
			typeof mask === "number" && Number.isFinite(mask) && mask > 0 && mask <= 1 ? mask : NEW_DEFAULT_COMPACTION_THRESHOLD;
		if (!compaction.has("threshold")) doc.setIn(["compaction", "threshold"], threshold);
		doc.deleteIn(["compaction", "thresholds"]);
		transforms.push("collapsed compaction.thresholds -> compaction.threshold");
	}

	const changed = transforms.length > 0;
	return { changed, text: changed ? doc.toString() : yamlText, transforms, recentModels };
}

export type SettingsRepairStatus = "absent" | "unchanged" | "repaired";

export interface SettingsRepairOutcome {
	status: SettingsRepairStatus;
	/** Transforms applied when status is "repaired". */
	transforms: string[];
	/** Validation issues that survive the repair (genuine unknown keys, typos). */
	remainingIssues: SettingsIssue[];
	/** Backup of the original file when a rewrite happened. */
	backupPath?: string;
}

/**
 * Seed the state-dir recents file from a dropped legacy `state.recentModels`
 * list, but only when no recents file exists yet so fresher state is never
 * clobbered. Best-effort: recents are non-critical state.
 */
function seedRecentModels(refs: ReadonlyArray<string>): void {
	if (refs.length === 0) return;
	const path = recentModelsPath();
	if (existsSync(path)) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(refs, null, "\t")}\n`, "utf8");
	} catch {
		// Recents are a convenience list; failing to seed them is not fatal.
	}
}

/**
 * Repair the on-disk settings.yaml in place under the settings single-writer
 * lock. Reads inside the lock so the transform lands on the freshest file,
 * backs up the original before rewriting, re-validates the result, and only
 * writes when a known legacy key was found. Idempotent.
 */
export function repairLegacySettingsFile(): SettingsRepairOutcome {
	const path = settingsPath();
	if (!existsSync(path)) return { status: "absent", transforms: [], remainingIssues: [] };
	return withSettingsLock(() => {
		if (!existsSync(path)) return { status: "absent", transforms: [], remainingIssues: [] };
		const original = readFileSync(path, "utf8");
		const repair = repairLegacySettings(original);
		if (!repair.changed) return { status: "unchanged", transforms: [], remainingIssues: [] };
		const validation = validateSettings(parseYaml(repair.text));
		const result = safeResourceWrite(path, repair.text, { backup: true, encoding: "utf8", mode: 0o644 });
		seedRecentModels(repair.recentModels);
		return {
			status: "repaired",
			transforms: repair.transforms,
			remainingIssues: validation.issues,
			...(result.backupPath ? { backupPath: result.backupPath } : {}),
		};
	});
}
