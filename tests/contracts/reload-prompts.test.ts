import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { createReloadClasses } from "../../src/entry/reload-classes.js";

const fragment = (id: string, body: string) => `---\nid: ${id}\nversion: 1\ndescription: Test.\n---\n${body}\n`;

test("/reload prompts reports a modified fragment by id and keeps the old table when one is broken", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "clio-reload-prompts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "identity"));
	writeFileSync(join(root, "identity", "main.md"), fragment("identity.main", "One."));
	const bus = createTelemetryHub();
	let requested = 0;
	bus.subscribe("prompts.reload_requested", () => {
		requested += 1;
	});
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => root,
		library: () => undefined,
		reloadLibrary: () => {
			throw new Error("unused");
		},
		extensions: () => [],
		fragmentsRoot: root,
	});
	const operators = async () => ({ status: "ok", message: "", failures: [], nextSession: [] });

	writeFileSync(join(root, "identity", "main.md"), fragment("identity.main", "Two."));
	const changed = await reloads.run("prompts", operators);
	strictEqual(changed.failed, false);
	match(changed.text, /modified: 1 \(identity\.main\)/u);
	match(changed.text, /safety rule packs/u);
	strictEqual(requested, 1);

	writeFileSync(join(root, "identity", "broken.md"), "no frontmatter\n");
	const broken = await reloads.run("prompts", operators);
	strictEqual(broken.failed, true);
	ok(broken.text.includes("previous table kept"));
	match(broken.text, /broken\.md/u);
	strictEqual(requested, 1);
});

test("/reload prompts reports a failed recipe rediscovery instead of failed: none", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "clio-reload-recipes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "identity"));
	writeFileSync(join(root, "identity", "main.md"), fragment("identity.main", "One."));
	const bus = createTelemetryHub();
	bus.subscribe("prompts.reload_requested", (payload) => {
		(payload as { failures?: string[] }).failures?.push("agent id collides with plugin recipe x");
	});
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => root,
		library: () => undefined,
		reloadLibrary: () => {
			throw new Error("unused");
		},
		extensions: () => [],
		fragmentsRoot: root,
	});
	const result = await reloads.run("prompts", async () => ({
		status: "ok",
		message: "",
		failures: [],
		nextSession: [],
	}));
	strictEqual(result.failed, true);
	match(result.text, /Agent recipes .*collides with plugin recipe x/u);
	ok(!result.text.includes("failed: none"));
	ok(!result.text.includes("recipes: rediscovered"));
});

test("/reload library does not claim every agent recipe reloaded", async () => {
	const bus = createTelemetryHub();
	const reloads = createReloadClasses({
		config: undefined,
		bus,
		cwd: () => process.cwd(),
		library: () => undefined,
		reloadLibrary: () => ({ generation: 2, packages: [] }) as never,
		extensions: () => [],
		fragmentsRoot: process.cwd(),
	});
	const report = await reloads.run("library", async () => ({
		status: "ok",
		message: "",
		failures: [],
		nextSession: [],
	}));
	match(report.text, /agent recipes only from changed packages/u);
	ok(!/prompts, agents and playbooks reload here/u.test(report.text));
});
