import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { join } from "node:path";
import { ClioCliConfigInspector, ClioConfigInspectError, projectConfigInspection } from "../clio-config-inspector.ts";

const FIXTURE = new URL("./config-inspect-child-fixture.ts", import.meta.url).pathname;

function fixtureInspector(
	scenario: "valid" | "timeout" | "overflow",
	options: { readonly timeoutMs?: number; readonly maximumStdoutBytes?: number } = {},
): ClioCliConfigInspector {
	return new ClioCliConfigInspector({
		executable: Deno.execPath(),
		prefixArgs: ["run", "--quiet", "--no-config", FIXTURE, `--scenario=${scenario}`, "--"],
		now: () => Date.parse("2026-08-29T12:00:00.000Z"),
		...options,
	});
}

Deno.test("the config projection keeps exact public routing but redacts values, native paths, diagnostics, and detail", () => {
	const root = "/work/project";
	const projected = projectConfigInspection(
		{
			cwd: root,
			settings: [
				{ key: "orchestrator.target", value: "laboratory", source: "project" },
				{ key: "targets.auth.apiKey", value: "sk-secret", source: "user" },
				{ key: "custom.label", value: "private literal", source: "user" },
				{ key: "retry.enabled", value: true, source: "project.local" },
			],
			entries: [
				{
					category: "rule",
					id: "project-rule",
					scope: "project",
					sourcePath: join(root, ".clio-coder", "rules", "project.yaml"),
					hash: "aabbccdd",
					trust: "trusted",
					precedence: "winner",
					reloadClass: "next-turn",
					detail: { enabled: true, paths: ["private/**"], rawSecret: "must-not-cross" },
				},
				{
					category: "memory",
					id: "memory-store",
					scope: "user",
					sourcePath: "/home/operator/private-memory.json",
					reloadClass: "hot",
					detail: { records: 5, content: "private memory" },
				},
			],
			issues: ["settings user: /home/operator/settings.yaml: sk-secret"],
		},
		root,
		"2026-08-29T12:00:00.000Z",
	);

	deepStrictEqual(projected.settings, [
		{ key: "orchestrator.target", source: "project", value: "laboratory", valueKind: "exact" },
		{ key: "targets.auth.apiKey", source: "user", value: "configured", valueKind: "configured" },
		{ key: "custom.label", source: "user", value: "configured", valueKind: "configured" },
		{ key: "retry.enabled", source: "project.local", value: "true", valueKind: "exact" },
	]);
	deepStrictEqual(projected.entries[0]?.sourcePath, { segments: [".clio-coder", "rules", "project.yaml"] });
	equal(projected.entries[1]?.sourcePath, undefined);
	deepStrictEqual(projected.entries[0]?.facts, [
		{ label: "Enabled", value: "yes" },
		{ label: "Path conditions", value: "1" },
	]);
	deepStrictEqual(projected.issueCounts, [{ surface: "settings", count: 1 }]);
	const frame = JSON.stringify(projected);
	for (
		const forbidden of [
			"sk-secret",
			"private literal",
			"/home/operator",
			"must-not-cross",
			"private memory",
			"private/**",
		]
	) {
		ok(!frame.includes(forbidden), `renderer projection leaked ${forbidden}`);
	}
});

Deno.test("the fixed CLI adapter invokes only config inspect JSON and returns the bounded projection", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-config-inspect-" });
	try {
		const inspection = await fixtureInspector("valid").inspect(root);
		equal(inspection.inspectedAt, "2026-08-29T12:00:00.000Z");
		equal(inspection.settings[0]?.value, "fixture-model");
		equal(inspection.settings[1]?.value, "configured");
		deepStrictEqual(inspection.entries[0]?.sourcePath, { segments: ["CLIO-CODER.md"] });
		equal(inspection.entries[1]?.sourcePath, undefined);
		deepStrictEqual(inspection.entries[1]?.facts, [
			{ label: "Present", value: "yes" },
			{ label: "Records", value: "7" },
		]);
		const frame = JSON.stringify(inspection);
		ok(!frame.includes("raw-api-secret"));
		ok(!frame.includes("/home/operator"));
		ok(!frame.includes("private memory"));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("the CLI adapter terminates inspections that exceed time or byte bounds", async () => {
	const root = await Deno.makeTempDir({ prefix: "workbench-config-bounds-" });
	try {
		await rejects(
			() => fixtureInspector("timeout", { timeoutMs: 40 }).inspect(root),
			(error: unknown) => {
				ok(error instanceof ClioConfigInspectError);
				equal(error.code, "not-ready");
				match(error.message, /did not finish in time/u);
				return true;
			},
		);
		await rejects(
			() => fixtureInspector("overflow", { maximumStdoutBytes: 256 }).inspect(root),
			(error: unknown) => {
				ok(error instanceof ClioConfigInspectError);
				equal(error.code, "internal");
				match(error.message, /byte bound/u);
				return true;
			},
		);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
