import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createExtensionsBundle } from "../../src/domains/extensions/extension.js";
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

const domainContext: DomainContext = { bus: {} as DomainContext["bus"], getContract: () => undefined };

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

describe("extension reload generations", () => {
	afterEach(() => {
		bindExtensionSnapshotStore(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("boots at generation one, increments per commit, and burns rejected reservations", () => {
		const project = scratch();
		installFixture(project);
		let failNextBuild = false;
		const bundle = createExtensionsBundle(domainContext, {
			cwd: () => project,
			listRecords: (cwd, options) => {
				if (failNextBuild) {
					failNextBuild = false;
					throw new Error("simulated listing failure");
				}
				return listInstalledExtensionRecords(cwd, options);
			},
		});
		bundle.extension.start();
		const boot = bundle.contract.snapshot();
		ok(boot);
		strictEqual(boot.generation, 1);
		for (const expected of [2, 3, 4]) {
			const prepared = bundle.contract.prepareReload();
			strictEqual(prepared.status, "prepared");
			if (prepared.status !== "prepared") return;
			const committed = bundle.contract.commitReload(prepared.candidate);
			strictEqual(committed.status, "committed");
			if (committed.status !== "committed") return;
			strictEqual(committed.generation, expected);
			strictEqual(committed.previousGeneration, expected - 1);
			strictEqual(committed.changed, false, "an unchanged tree commits a new generation with changed=false");
			strictEqual(committed.digest, boot.digest);
			deepStrictEqual([committed.added, committed.removed, committed.modified], [[], [], []]);
		}
		failNextBuild = true;
		const rejected = bundle.contract.prepareReload();
		strictEqual(rejected.status, "rejected");
		if (rejected.status !== "rejected") return;
		strictEqual(rejected.reason, "build-failed");
		strictEqual(rejected.generation, 4);
		strictEqual(rejected.diagnostics.entries[0]?.message, "simulated listing failure");
		strictEqual(bundle.contract.generation(), 4);
		const recovered = bundle.contract.prepareReload();
		strictEqual(recovered.status, "prepared");
		if (recovered.status !== "prepared") return;
		strictEqual(recovered.candidate.generation, 6, "the failed candidate burned generation 5");
		strictEqual(bundle.contract.commitReload(recovered.candidate).status, "committed");
		strictEqual(bundle.contract.generation(), 6);
		bundle.extension.stop?.();
	});

	it("refuses reentrant prepares and stale commits without touching the committed generation", () => {
		const project = scratch();
		installFixture(project);
		const bundle = createExtensionsBundle(domainContext, { cwd: () => project });
		bundle.extension.start();
		const committedAtBoot = bundle.contract.snapshot();
		const first = bundle.contract.prepareReload();
		strictEqual(first.status, "prepared");
		if (first.status !== "prepared") return;
		const reentrant = bundle.contract.prepareReload();
		deepStrictEqual(reentrant, {
			status: "rejected",
			reason: "reentrant",
			generation: 1,
			diagnostics: { entries: [], truncated: 0 },
		});
		bundle.contract.discardReload(first.candidate);
		const staleAfterDiscard = bundle.contract.commitReload(first.candidate);
		strictEqual(staleAfterDiscard.status, "rejected");
		if (staleAfterDiscard.status !== "rejected") return;
		strictEqual(staleAfterDiscard.reason, "stale");
		strictEqual(bundle.contract.snapshot(), committedAtBoot);

		const second = bundle.contract.prepareReload();
		strictEqual(second.status, "prepared");
		if (second.status !== "prepared") return;
		strictEqual(second.candidate.generation, 3, "the discarded candidate burned generation 2");
		const foreign = { ...second.candidate, snapshot: buildExtensionSnapshot({ cwd: project, generation: 99 }) };
		strictEqual(
			bundle.contract.commitReload(foreign).status,
			"rejected",
			"a candidate the bundle did not prepare is stale",
		);
		strictEqual(bundle.contract.snapshot(), committedAtBoot);
		strictEqual(bundle.contract.commitReload(second.candidate).status, "committed");
		strictEqual(bundle.contract.snapshot(), second.candidate.snapshot);
		const twice = bundle.contract.commitReload(second.candidate);
		strictEqual(twice.status, "rejected");
		if (twice.status !== "rejected") return;
		strictEqual(twice.reason, "stale");
		strictEqual(bundle.contract.generation(), 3);
		bundle.extension.stop?.();
	});

	it("publishes a prepared candidate only at commit and readers see one generation at a time", () => {
		const project = scratch();
		const other = scratch();
		installFixture(project, "alpha");
		installFixture(other, "elsewhere");
		const bundle = createExtensionsBundle(domainContext, { cwd: () => project });
		bundle.extension.start();
		const bootSnapshot = bundle.contract.snapshot();
		const readerBefore = bundle.contract.resourceRoots("skills");
		deepStrictEqual(
			readerBefore.map((root) => [root.id, root.generation]),
			[["alpha", 1]],
		);
		installFixture(project, "beta");
		const prepared = bundle.contract.prepareReload();
		strictEqual(prepared.status, "prepared");
		if (prepared.status !== "prepared") return;
		strictEqual(prepared.candidate.changed, true);
		deepStrictEqual(prepared.candidate.added, ["beta"]);
		strictEqual(bundle.contract.snapshot(), bootSnapshot, "prepare publishes nothing");
		deepStrictEqual(
			bundle.contract.resourceRoots("skills").map((root) => [root.id, root.generation]),
			[["alpha", 1]],
		);
		strictEqual(bundle.contract.commitReload(prepared.candidate).status, "committed");
		const readerAfter = bundle.contract.resourceRoots("skills");
		deepStrictEqual(
			readerAfter.map((root) => [root.id, root.generation]),
			[
				["alpha", 2],
				["beta", 2],
			],
		);
		deepStrictEqual(
			readerBefore.map((root) => [root.id, root.generation]),
			[["alpha", 1]],
			"a projection captured before the commit is untouched",
		);
		for (const roots of [readerBefore, readerAfter]) {
			strictEqual(new Set(roots.map((root) => root.generation)).size, 1, "no reader mixes generations");
		}
		deepStrictEqual(
			bundle.contract.resourceRoots("skills", other).map((root) => [root.id, root.generation]),
			[["elsewhere", 0]],
			"another cwd gets an ephemeral generation-0 projection",
		);
		strictEqual(bundle.contract.generation(), 2);
		bundle.extension.stop?.();
		strictEqual(enabledExtensionResourceRoots("skills", project)[0]?.generation, 0, "stop unbinds the store");
	});
});
