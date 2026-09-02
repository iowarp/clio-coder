import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { enabledExtensionResourceRoots } from "../../src/domains/extensions/resources.js";
import { buildExtensionSnapshot, diffExtensionSnapshots } from "../../src/domains/extensions/snapshot.js";
import {
	bindExtensionSnapshotStore,
	createExtensionSnapshotStore,
} from "../../src/domains/extensions/snapshot-store.js";
import {
	type InstalledExtensionRecord,
	installExtension,
	listInstalledExtensionRecords,
} from "../../src/domains/extensions/state.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-extension-snapshot-"));
	roots.push(root);
	return root;
}

function writePackage(root: string, id: string, hookMessage = "generation one"): void {
	mkdirSync(path.join(root, "skills"), { recursive: true });
	writeFileSync(
		path.join(root, "clio-coder-extension.yaml"),
		[
			"manifestVersion: 1",
			`id: ${id}`,
			`name: ${id}`,
			"version: 1.0.0",
			"description: Snapshot fixture.",
			"resources:",
			"  skills: skills",
			"",
		].join("\n"),
	);
	writeFileSync(
		path.join(root, "hooks.yaml"),
		`- id: ${id}.hook\n  on: turn_start\n  kind: prompt\n  message: ${hookMessage}\n`,
	);
}

function installFixture(project: string, id = "snapshot-fixture"): string {
	const source = scratch();
	writePackage(source, id);
	const result = installExtension(source, { cwd: project, scope: "project" });
	ok(result.extension?.loadable);
	return path.join(project, ".clio-coder", "extensions", id);
}

function walkFrozen(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	strictEqual(Object.isFrozen(value), true);
	for (const child of Object.values(value as Record<string, unknown>)) walkFrozen(child, seen);
}

describe("extension snapshot contract", () => {
	afterEach(() => {
		bindExtensionSnapshotStore(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("deep-freezes the complete committed projection", () => {
		const project = scratch();
		installFixture(project);
		const snapshot = buildExtensionSnapshot({ cwd: project, generation: 1 });
		walkFrozen(snapshot);
		throws(() => (snapshot.packages as unknown[]).push({}), TypeError);
		throws(() => (snapshot.resourceRoots.skills as unknown[]).push({}), TypeError);
		throws(() => {
			(snapshot.packages[0]?.provenance as { id: string }).id = "mutated";
		}, TypeError);
	});

	it("keeps content identity stable across generations and reports drift", () => {
		const project = scratch();
		const installedRoot = installFixture(project);
		const first = buildExtensionSnapshot({ cwd: project, generation: 1, now: () => new Date(1) });
		const unchanged = buildExtensionSnapshot({ cwd: project, generation: 2, now: () => new Date(2) });
		strictEqual(unchanged.digest, first.digest);
		deepStrictEqual(diffExtensionSnapshots(first, unchanged), {
			changed: false,
			added: [],
			removed: [],
			modified: [],
		});

		writeFileSync(path.join(installedRoot, "hooks.yaml"), "[]\n");
		const drifted = buildExtensionSnapshot({ cwd: project, generation: 3 });
		notStrictEqual(drifted.digest, first.digest);
		deepStrictEqual(diffExtensionSnapshots(first, drifted), {
			changed: true,
			added: [],
			removed: [],
			modified: ["snapshot-fixture"],
		});
		strictEqual(drifted.packages[0]?.loadable, false);
		deepStrictEqual(drifted.hookSources, []);
	});

	it("retains captured declarations after disk changes", () => {
		const project = scratch();
		const installedRoot = installFixture(project, "captured-hook");
		const snapshot = buildExtensionSnapshot({ cwd: project, generation: 1 });
		writeFileSync(
			path.join(installedRoot, "hooks.yaml"),
			"- id: replacement\n  on: turn_start\n  kind: prompt\n  message: replacement\n",
		);
		deepStrictEqual(snapshot.hookSources[0]?.declarations, [
			{
				id: "captured-hook.hook",
				on: "turn_start",
				kind: "prompt",
				message: "generation one",
			},
		]);
	});

	it("commits only strictly newer snapshots and never reuses reservations", () => {
		const project = scratch();
		installFixture(project);
		const store = createExtensionSnapshotStore();
		const one = buildExtensionSnapshot({ cwd: project, generation: store.nextGeneration() });
		strictEqual(one.generation, 1);
		strictEqual(store.commit(one), true);
		strictEqual(store.commit(one), false);
		strictEqual(store.nextGeneration(), 2);
		strictEqual(store.nextGeneration(), 3, "a discarded candidate burns generation 2");
		const three = buildExtensionSnapshot({ cwd: project, generation: 3 });
		strictEqual(store.commit(three), true);
		strictEqual(store.current(), three);
	});

	it("uses a bound snapshot only for its canonical cwd and leaves it untouched for ephemeral reads", () => {
		const firstProject = scratch();
		const secondProject = scratch();
		installFixture(firstProject, "bound-one");
		installFixture(secondProject, "ephemeral-two");
		const store = createExtensionSnapshotStore();
		const committed = buildExtensionSnapshot({ cwd: firstProject, generation: 7 });
		strictEqual(store.commit(committed), true);
		bindExtensionSnapshotStore(store);
		deepStrictEqual(
			enabledExtensionResourceRoots("skills", firstProject).map((root) => [root.id, root.generation]),
			[["bound-one", 7]],
		);
		deepStrictEqual(
			enabledExtensionResourceRoots("skills", secondProject).map((root) => [root.id, root.generation]),
			[["ephemeral-two", 0]],
		);
		strictEqual(store.current(), committed);
	});

	it("bounds diagnostics per package, globally, and by message length", () => {
		const project = scratch();
		installFixture(project, "noisy-package");
		const [base] = listInstalledExtensionRecords(project, { scope: "project", all: true });
		ok(base);
		const noisy: InstalledExtensionRecord = {
			...base,
			entry: {
				...base.entry,
				diagnostics: Array.from({ length: 50 }, (_, index) => ({
					type: "error" as const,
					message: `${index}:${"x".repeat(700)}`,
				})),
			},
		};
		const snapshot = buildExtensionSnapshot({
			cwd: project,
			generation: 1,
			listRecords: () => [noisy],
		});
		strictEqual(snapshot.diagnostics.entries.length, 20);
		strictEqual(snapshot.diagnostics.truncated, 30);
		ok(snapshot.diagnostics.entries.every((entry) => entry.message.length <= 512));
		ok(snapshot.diagnostics.entries.every((entry) => entry.extensionId === "noisy-package"));
	});
});
