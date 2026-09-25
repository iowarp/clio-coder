import { match, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "../../src/core/config.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { migrateSettingsV1Document } from "../../src/domains/lifecycle/migrations/2026-09-01-settings-v2.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("the user settings loader accepts only default and yolo autonomy", async (t) => {
	const home = await isolateClioEnv("clio-autonomy-loader-");
	t.after(() => home.restore());
	const file = join(home.dir, "config", "settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	for (const value of ["default", "yolo"]) {
		writeFileSync(file, `version: 2\nsafety:\n  autonomy: ${value}\n`);
		strictEqual(readSettings().safety.autonomy, value);
	}
	for (const value of ["suggest", "auto-edit", "full-auto", "read-only", "other"]) {
		writeFileSync(file, `version: 2\nsafety:\n  autonomy: ${value}\n`);
		throws(
			() => readSettings(),
			(error: unknown) => {
				match(String(error), /safety\.autonomy.*default.*yolo/u);
				return true;
			},
			value,
		);
	}
});

test("the v1 rewrite retains canonical autonomy and resets every other value with a note", () => {
	for (const value of ["default", "yolo"]) {
		const result = migrateSettingsV1Document({ version: 1, autonomy: value });
		strictEqual((result.document.safety as { autonomy: unknown }).autonomy, value);
		strictEqual(result.notes.length, 0);
	}
	for (const value of ["suggest", "auto-edit", "full-auto", "read-only", "other", 42]) {
		const result = migrateSettingsV1Document({ version: 1, autonomy: value });
		strictEqual((result.document.safety as { autonomy: unknown }).autonomy, "default");
		match(result.notes.join(" "), /autonomy.*default/u);
	}
});

test("project and local settings cannot override user autonomy, whether trusted or not", async (t) => {
	const home = await isolateClioEnv("clio-autonomy-project-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	const projectDir = join(workspace, ".clio-coder");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\nsafety:\n  autonomy: default\n");
	writeFileSync(join(projectDir, "settings.yaml"), "safety:\n  autonomy: yolo\n");
	writeFileSync(join(projectDir, "settings.local.yaml"), "safety:\n  autonomy: yolo\n");
	for (const trusted of [false, true]) {
		if (trusted) {
			const snapshot = captureProjectSurface(workspace, "settings");
			if (!snapshot.contentHash) throw new Error("missing project settings hash");
			recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
		}
		const layered = readLayeredSettings(workspace);
		strictEqual(layered.settings.safety.autonomy, "default");
		strictEqual(layered.sources["safety.autonomy"], "user");
		for (const origin of ["project", "project.local"]) {
			const issue = layered.issues.find((item) => item.origin === origin && item.path === "safety.autonomy");
			match(issue?.message ?? "", /autonomy.*operator|autonomy.*user settings/u);
		}
	}
});
