import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildCustomizationGraph } from "../../src/cli/config-inspect.js";
import { readLayeredSettings, settingsSourceFor } from "../../src/core/settings-layers.js";
import { loadOperatorProfile, renderOperatorProfile } from "../../src/domains/context/operator-profile.js";
import { loadProjectRules, selectActiveRules } from "../../src/domains/context/project-rules.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { cwd: string; userPath: string } {
	const cwd = mkdtempSync(join(tmpdir(), "clio-cust-"));
	roots.push(cwd);
	mkdirSync(join(cwd, ".clio"), { recursive: true });
	return { cwd, userPath: join(cwd, "user-settings.yaml") };
}

function write(path: string, contents: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

describe("contracts/3a scoped settings layering", () => {
	it("applies built-in < user < project < project.local precedence with per-key sources", () => {
		const { cwd, userPath } = scratch();
		write(userPath, "identity: user-id\nmodelSelector:\n  recentLimit: 5\n");
		write(join(cwd, ".clio", "settings.yaml"), "identity: project-id\nbudget:\n  sessionCeilingUsd: 10\n");
		write(join(cwd, ".clio", "settings.local.yaml"), "theme: midnight\n");

		const result = readLayeredSettings(cwd, { userPath });
		strictEqual(result.settings.identity, "project-id");
		strictEqual(result.settings.modelSelector.recentLimit, 5);
		strictEqual(result.settings.budget.sessionCeilingUsd, 10);
		strictEqual(result.settings.theme, "midnight");

		strictEqual(settingsSourceFor(result.sources, "identity"), "project");
		strictEqual(settingsSourceFor(result.sources, "modelSelector.recentLimit"), "user");
		strictEqual(settingsSourceFor(result.sources, "budget.sessionCeilingUsd"), "project");
		strictEqual(settingsSourceFor(result.sources, "theme"), "project.local");
		// A key no layer set falls back to built-in.
		strictEqual(settingsSourceFor(result.sources, "autonomy"), "built-in");
	});

	it("strips credentials from project layers and never lets them reach effective settings", () => {
		const { cwd, userPath } = scratch();
		write(userPath, "identity: user-id\n");
		write(
			join(cwd, ".clio", "settings.yaml"),
			"targets:\n  - id: t\n    runtime: ollama\n    auth:\n      apiKey: SUPER_SECRET\n",
		);
		const result = readLayeredSettings(cwd, { userPath });
		ok(
			result.issues.some((issue) => issue.message.includes("credentials")),
			"expected a credentials diagnostic",
		);
		ok(!JSON.stringify(result.settings).includes("SUPER_SECRET"), "credential must not survive into effective settings");
	});

	it("degrades a malformed project layer to the lower layers with an issue", () => {
		const { cwd, userPath } = scratch();
		write(userPath, "identity: user-id\n");
		write(join(cwd, ".clio", "settings.yaml"), ":\n  - [bad yaml");
		const result = readLayeredSettings(cwd, { userPath });
		strictEqual(result.settings.identity, "user-id");
		ok(result.issues.length >= 1);
	});
});

describe("contracts/3b path-scoped rules", () => {
	it("loads unconditional and path-scoped rules with hash and token accounting", () => {
		const { cwd } = scratch();
		write(join(cwd, ".clio", "rules", "always.md"), "# Always\nUse tabs.\n");
		write(
			join(cwd, ".clio", "rules", "python.md"),
			"---\npaths:\n  - '**/*.py'\nexcludes:\n  - '**/*.lock'\n---\n# Python\nType-hint everything.\n",
		);
		const loaded = loadProjectRules(cwd);
		strictEqual(loaded.rules.length, 2);
		// Deterministic order by id for cache stability.
		deepStrictEqual(
			loaded.rules.map((rule) => rule.id),
			["always.md", "python.md"],
		);
		for (const rule of loaded.rules) {
			strictEqual(rule.hash.length, 16);
			ok(rule.tokenEstimate > 0);
		}
		deepStrictEqual(loaded.excludes, ["**/*.lock"]);

		// Unconditional always loads; path-scoped loads only when a matching file
		// is already in working context.
		const noContext = selectActiveRules(loaded.rules, []);
		deepStrictEqual(
			noContext.map((rule) => rule.id),
			["always.md"],
		);
		const withPython = selectActiveRules(loaded.rules, ["src/app.py"]);
		deepStrictEqual(
			withPython.map((rule) => rule.id),
			["always.md", "python.md"],
		);
	});

	it("never activates a disabled rule", () => {
		const { cwd } = scratch();
		write(join(cwd, ".clio", "rules", "off.md"), "---\nenabled: false\n---\n# Off\n");
		const loaded = loadProjectRules(cwd);
		strictEqual(selectActiveRules(loaded.rules, []).length, 0);
	});
});

describe("contracts/3c operator profile", () => {
	it("merges user and project profiles and caps the rendered section", () => {
		const { cwd, userPath } = scratch();
		write(userPath, "responsePosture: thorough\nvalidationPreference: manual\n");
		write(join(cwd, ".clio", "profile.yaml"), "responsePosture: concise\ncommitMessageStyle: conventional\n");
		const loaded = loadOperatorProfile(cwd, { userPath });
		strictEqual(loaded.origin, "project");
		strictEqual(loaded.profile.responsePosture, "concise");
		strictEqual(loaded.profile.validationPreference, "manual");
		strictEqual(loaded.profile.commitMessageStyle, "conventional");

		const rendered = renderOperatorProfile(loaded.profile);
		ok(rendered.text.includes("Operator profile"));
		ok(rendered.tokenEstimate > 0);
	});

	it("rejects invalid enum values without throwing and caps local-only paths", () => {
		const { cwd, userPath } = scratch();
		const manyPaths = Array.from({ length: 50 }, (_, i) => `  - secret-${i}/`).join("\n");
		write(userPath, `responsePosture: aggressive\nlocalOnlyPaths:\n${manyPaths}\n`);
		const loaded = loadOperatorProfile(cwd, { userPath });
		strictEqual(loaded.profile.responsePosture, undefined);
		ok(loaded.issues.some((issue) => issue.includes("responsePosture")));
		ok((loaded.profile.localOnlyPaths?.length ?? 0) <= 8);
		const rendered = renderOperatorProfile(loaded.profile);
		ok(rendered.text.length <= 700);
	});
});

describe("contracts/3d config inspect graph", () => {
	it("reports project rules, profile, hooks, and settings sources in the JSON contract", () => {
		const { cwd } = scratch();
		write(join(cwd, ".clio", "settings.yaml"), "identity: graph-project\n");
		write(join(cwd, ".clio", "rules", "r.md"), "# Rule\nbody\n");
		write(join(cwd, ".clio", "profile.yaml"), "responsePosture: concise\n");
		write(join(cwd, ".clio", "hooks.yaml"), "- on: turn_start\n  kind: prompt\n  message: hi\n");

		const graph = buildCustomizationGraph(cwd);
		// Serializable contract.
		const roundTrip = JSON.parse(JSON.stringify(graph)) as typeof graph;
		deepStrictEqual(roundTrip.entries.length, graph.entries.length);

		// The project settings key is attributed to the project layer.
		const identity = graph.settings.find((entry) => entry.key === "identity");
		strictEqual(identity?.source, "project");

		const categories = new Set(graph.entries.map((entry) => entry.category));
		ok(categories.has("rule"), "expected a rule entry");
		ok(categories.has("operator-profile"), "expected an operator-profile entry");
		ok(categories.has("hook"), "expected a hook entry");

		const rule = graph.entries.find((entry) => entry.category === "rule" && entry.id === "r.md");
		ok(rule?.hash, "rule must carry a hash");
		ok((rule?.contextCostTokens ?? 0) > 0, "rule must carry a context cost");
		ok(typeof rule?.reloadClass === "string", "every entry carries a reload class");
	});
});
