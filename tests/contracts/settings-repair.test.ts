import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import { repairLegacySettings } from "../../src/domains/lifecycle/settings-repair.js";

/** Validate the repaired YAML text the way the loader would. */
function issuesAfter(text: string): string[] {
	return validateSettings(parseYaml(text)).issues.map((i) => i.path);
}

describe("contracts/settings-repair", () => {
	it("renames safetyLevel to autonomy, preserving the value", () => {
		const repair = repairLegacySettings("version: 1\nsafetyLevel: full-auto\ntargets: []\n");
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as Record<string, unknown>;
		strictEqual("safetyLevel" in parsed, false);
		strictEqual(parsed.autonomy, "full-auto");
		deepStrictEqual(issuesAfter(repair.text), []);
	});

	it("leaves an out-of-range autonomy value as a validation error rather than guessing", () => {
		const repair = repairLegacySettings("version: 1\nsafetyLevel: yolo\ntargets: []\n");
		strictEqual(repair.changed, true);
		deepStrictEqual(issuesAfter(repair.text), ["autonomy"]);
	});

	it("moves endpoints to targets when targets is absent or empty, never dropping entries", () => {
		const yaml = [
			"version: 1",
			"endpoints:",
			"  - id: keepme",
			"    runtime: ollama-native",
			"    url: http://localhost:11434",
			"    defaultModel: m1",
			"targets: []",
			"",
		].join("\n");
		const repair = repairLegacySettings(yaml);
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as { endpoints?: unknown; targets: Array<{ id: string }> };
		strictEqual("endpoints" in parsed, false);
		strictEqual(parsed.targets.length, 1);
		strictEqual(parsed.targets[0]?.id, "keepme");
		deepStrictEqual(issuesAfter(repair.text), []);
	});

	it("drops a stale endpoints list when targets is already populated", () => {
		const yaml = [
			"version: 1",
			"endpoints:",
			"  - id: stale",
			"    runtime: ollama-native",
			"targets:",
			"  - id: current",
			"    runtime: ollama-native",
			"",
		].join("\n");
		const repair = repairLegacySettings(yaml);
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as { endpoints?: unknown; targets: Array<{ id: string }> };
		strictEqual("endpoints" in parsed, false);
		deepStrictEqual(
			parsed.targets.map((t) => t.id),
			["current"],
		);
	});

	it("renames orchestrator/workers endpoint keys to target", () => {
		const yaml = [
			"version: 1",
			"targets:",
			"  - id: t1",
			"    runtime: ollama-native",
			"    defaultModel: m1",
			"orchestrator:",
			"  endpoint: t1",
			"  model: m1",
			"workers:",
			"  default:",
			"    endpoint: t1",
			"    model: m1",
			"  profiles:",
			"    fast:",
			"      endpoint: t1",
			"      model: m1",
			"",
		].join("\n");
		const repair = repairLegacySettings(yaml);
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as {
			orchestrator: { endpoint?: unknown; target: string };
			workers: { default: { endpoint?: unknown; target: string }; profiles: { fast: { target: string } } };
		};
		strictEqual("endpoint" in parsed.orchestrator, false);
		strictEqual(parsed.orchestrator.target, "t1");
		strictEqual(parsed.workers.default.target, "t1");
		strictEqual(parsed.workers.profiles.fast.target, "t1");
		deepStrictEqual(issuesAfter(repair.text), []);
	});

	it("drops the state block and harvests recentModels for seeding", () => {
		const yaml = ["version: 1", "targets: []", "state:", "  recentModels:", "    - t1/m1", "    - t1/m2", ""].join("\n");
		const repair = repairLegacySettings(yaml);
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as Record<string, unknown>;
		strictEqual("state" in parsed, false);
		deepStrictEqual(repair.recentModels, ["t1/m1", "t1/m2"]);
		deepStrictEqual(issuesAfter(repair.text), []);
	});

	it("collapses graduated compaction.thresholds to a single threshold", () => {
		const yaml = [
			"version: 1",
			"targets: []",
			"compaction:",
			"  auto: true",
			"  thresholds:",
			"    maskObservations: 0.7",
			"    llmSummary: 0.95",
			"",
		].join("\n");
		const repair = repairLegacySettings(yaml);
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as { compaction: { thresholds?: unknown; threshold: number } };
		strictEqual("thresholds" in parsed.compaction, false);
		strictEqual(parsed.compaction.threshold, 0.7);
		deepStrictEqual(issuesAfter(repair.text), []);
	});

	it("falls back to the default threshold when maskObservations is out of range", () => {
		const yaml = ["version: 1", "targets: []", "compaction:", "  thresholds:", "    maskObservations: 9", ""].join("\n");
		const repair = repairLegacySettings(yaml);
		strictEqual(parseYaml(repair.text).compaction.threshold, 0.8);
	});

	it("is idempotent: repairing already-repaired text changes nothing", () => {
		const yaml = [
			"version: 1",
			"safetyLevel: auto-edit",
			"endpoints:",
			"  - id: t1",
			"    runtime: ollama-native",
			"orchestrator:",
			"  endpoint: t1",
			"state:",
			"  recentModels:",
			"    - t1/m1",
			"compaction:",
			"  thresholds:",
			"    maskObservations: 0.7",
			"",
		].join("\n");
		const first = repairLegacySettings(yaml);
		strictEqual(first.changed, true);
		const second = repairLegacySettings(first.text);
		strictEqual(second.changed, false);
		strictEqual(second.text, first.text);
		deepStrictEqual(issuesAfter(first.text), []);
	});

	it("never rewrites a valid settings file", () => {
		const repair = repairLegacySettings(DEFAULT_SETTINGS_YAML);
		strictEqual(repair.changed, false);
		strictEqual(repair.text, DEFAULT_SETTINGS_YAML);
		deepStrictEqual(repair.transforms, []);
	});

	it("repairs known legacy keys but leaves a genuine typo for the validator to reject", () => {
		const repair = repairLegacySettings("version: 1\nsafetyLevel: auto-edit\nbogusTypoKey: 1\ntargets: []\n");
		strictEqual(repair.changed, true);
		const parsed = parseYaml(repair.text) as Record<string, unknown>;
		strictEqual(parsed.autonomy, "auto-edit");
		ok("bogusTypoKey" in parsed, "the unknown key is preserved, not silently dropped");
		deepStrictEqual(issuesAfter(repair.text), ["bogusTypoKey"]);
	});
});
