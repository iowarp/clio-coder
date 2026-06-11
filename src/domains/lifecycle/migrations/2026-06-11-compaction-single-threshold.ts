import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMap, parseDocument } from "yaml";
import { settingsPath } from "../../../core/config.js";
import type { Migration } from "./index.js";

const NEW_DEFAULT_THRESHOLD = 0.8;

/**
 * Rewrite the graduated five-threshold `compaction.thresholds` block in a
 * settings.yaml document to the single-threshold schema:
 *
 *   compaction: { auto, threshold, excludeLastTurns }
 *
 * The new `threshold` takes the old `maskObservations` value (the first
 * stage that acted on context) when it is a valid 0..1 number, otherwise the
 * new default. Comments and unrelated keys are preserved via the yaml
 * document API. Returns the rewritten text, or null when the file has no
 * `compaction.thresholds` block and needs no change.
 */
export function rewriteCompactionThresholds(yamlText: string): string | null {
	const doc = parseDocument(yamlText);
	const compaction = doc.get("compaction");
	if (!isMap(compaction) || !compaction.has("thresholds")) return null;

	const mask = doc.getIn(["compaction", "thresholds", "maskObservations"]);
	const threshold =
		typeof mask === "number" && Number.isFinite(mask) && mask > 0 && mask <= 1 ? mask : NEW_DEFAULT_THRESHOLD;
	doc.deleteIn(["compaction", "thresholds"]);
	doc.setIn(["compaction", "threshold"], threshold);
	return doc.toString();
}

/**
 * One-shot settings.yaml rewrite for the compaction schema collapse. The
 * config reader knows only the new schema; this migration converts existing
 * user files so their customized values survive instead of silently falling
 * back to defaults.
 *
 * The migration manifest lives under the data dir (the `dir` argument), but
 * settings.yaml lives in the config dir, so the path comes from
 * `settingsPath()` directly.
 */
const migration: Migration = {
	id: "2026-06-11-compaction-single-threshold",
	async up(_dir: string): Promise<void> {
		const path = settingsPath();
		if (!existsSync(path)) return;
		const rewritten = rewriteCompactionThresholds(readFileSync(path, "utf8"));
		if (rewritten !== null) writeFileSync(path, rewritten, "utf8");
	},
};

export default migration;
