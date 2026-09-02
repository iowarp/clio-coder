import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createExtensionsBundle } from "../../src/domains/extensions/extension.js";
import type {
	ExtensionReloadCandidate,
	ExtensionReloadPrepareResult,
	ExtensionReloadResult,
	ExtensionsContract,
} from "../../src/domains/extensions/index.js";
import { buildExtensionSnapshot } from "../../src/domains/extensions/snapshot.js";
import { bindExtensionSnapshotStore } from "../../src/domains/extensions/snapshot-store.js";
import { installExtension } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { HookReceipt } from "../../src/domains/middleware/hooks.js";
import type {
	MiddlewareContract,
	MiddlewareDiagnostic,
	MiddlewareHookRegistration,
	MiddlewareRegistrationReplacement,
	PrepareRegistrationReplacementResult,
} from "../../src/domains/middleware/index.js";
import {
	createExtensionReloadCoordinator,
	type ExtensionReloadCoordinatorDeps,
	type ExtensionsReloadedEvent,
} from "../../src/entry/extension-reload.js";

const roots: string[] = [];
const domainContext: DomainContext = { bus: {} as DomainContext["bus"], getContract: () => undefined };

function scratch(): string {
	const root = mkdtempSync(path.join(tmpdir(), "clio-extension-reload-"));
	roots.push(root);
	return root;
}

function writePackage(root: string, id: string, hookId: string, message: string): void {
	mkdirSync(path.join(root, "skills"), { recursive: true });
	writeFileSync(
		path.join(root, "clio-coder-extension.yaml"),
		[
			"manifestVersion: 1",
			`id: ${id}`,
			`name: ${id}`,
			"version: 1.0.0",
			"description: Reload fixture.",
			"resources:",
			"  skills: skills",
			"",
		].join("\n"),
	);
	writeFileSync(
		path.join(root, "hooks.yaml"),
		`- id: ${hookId}\n  on: turn_start\n  kind: prompt\n  message: ${message}\n`,
	);
}

function installFixture(project: string, id: string, hookId = `${id}.hook`, message = id): void {
	const source = scratch();
	writePackage(source, id, hookId, message);
	const result = installExtension(source, { cwd: project, scope: "project" });
	ok(result.extension?.loadable, result.diagnostics.map((d) => d.message).join("; "));
}

function writeProjectHooks(project: string, hookId: string, message: string): void {
	mkdirSync(path.join(project, ".clio-coder"), { recursive: true });
	writeFileSync(
		path.join(project, ".clio-coder", "hooks.yaml"),
		`- id: ${hookId}\n  on: turn_start\n  kind: prompt\n  message: ${message}\n`,
	);
}

interface Harness {
	extensions: ExtensionsContract;
	middleware: MiddlewareContract;
	receipts: HookReceipt[];
	diagnostics: MiddlewareDiagnostic[];
	lines: string[];
	events: ExtensionsReloadedEvent[];
	stop(): void;
}

function bootHarness(
	project: string,
	overrides: Partial<ExtensionReloadCoordinatorDeps> = {},
): Harness & {
	coordinator: ReturnType<typeof createExtensionReloadCoordinator>;
} {
	const bundle = createExtensionsBundle(domainContext, { cwd: () => project });
	bundle.extension.start();
	const diagnostics: MiddlewareDiagnostic[] = [];
	const middleware = createMiddlewareBundle({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) }).contract;
	const receipts: HookReceipt[] = [];
	const lines: string[] = [];
	const events: ExtensionsReloadedEvent[] = [];
	const coordinator = createExtensionReloadCoordinator({
		extensions: bundle.contract,
		middleware,
		cwd: () => project,
		recordReceipt: (receipt) => receipts.push(receipt),
		runCommand: () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
		now: () => 1,
		report: (line) => lines.push(line),
		onCommitted: (event) => events.push(event),
		...overrides,
	});
	return {
		extensions: bundle.contract,
		middleware,
		receipts,
		diagnostics,
		lines,
		events,
		coordinator,
		stop: () => bundle.extension.stop?.(),
	};
}

describe("extension reload coordinator", () => {
	afterEach(() => {
		bindExtensionSnapshotStore(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("applies the boot generation with project hooks overriding extension hooks by id", () => {
		const project = scratch();
		installFixture(project, "ext-a", "shared", "from-extension");
		writeProjectHooks(project, "shared", "from-project");
		const harness = bootHarness(project);
		const built = harness.coordinator.applyCurrent();
		deepStrictEqual(
			built.hooks.map((hook) => [hook.id, hook.source.origin]),
			[["shared", "project"]],
		);
		deepStrictEqual(
			built.overridden.map(({ winner, loser }) => [
				winner.origin,
				loser.source.origin,
				loser.source.extension?.generation,
			]),
			[["project", "extension", 1]],
		);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 1);
		const result = harness.middleware.runHook({ hook: "turn_start" });
		deepStrictEqual(result.ruleIds, ["shared"]);
		strictEqual(harness.receipts[0]?.origin, "project");
		strictEqual(harness.receipts[0]?.extension, undefined);
		ok(harness.lines.some((line) => line.includes("overridden by")));
		harness.stop();
	});

	it("commits resources and hooks back-to-back so every observer sees one generation", () => {
		const project = scratch();
		installFixture(project, "ext-a");
		const log: string[] = [];
		const samples: Array<{ at: string; extension: number; roots: number[]; hooks: number[] }> = [];
		let harness!: ReturnType<typeof bootHarness>;
		const sample = (at: string): void => {
			const before = harness.receipts.length;
			harness.middleware.runHook({ hook: "turn_start" });
			const hooks = harness.receipts
				.slice(before)
				.map((receipt) => receipt.extension?.generation)
				.filter((generation): generation is number => generation !== undefined);
			samples.push({
				at,
				extension: harness.extensions.generation(),
				roots: harness.extensions.resourceRoots("skills").map((root) => root.generation),
				hooks,
			});
		};
		harness = bootHarness(project, {
			report: (line) => {
				log.push(`report:${line.length > 0 ? "line" : ""}`);
				sample("report");
			},
			onCommitted: (event) => {
				log.push("committed");
				sample("committed");
				harness.events.push(event);
			},
		});
		// Wrap both commit points so their adjacency is asserted on the log.
		const rawCommit = harness.extensions.commitReload.bind(harness.extensions);
		harness.extensions.commitReload = (candidate) => {
			log.push("ext-commit");
			return rawCommit(candidate);
		};
		const rawPrepare = harness.middleware.prepareRegistrationReplacement.bind(harness.middleware);
		harness.middleware.prepareRegistrationReplacement = (owner, generation, registrations) => {
			const prepared = rawPrepare(owner, generation, registrations);
			if (prepared.status !== "prepared") return prepared;
			const replacement = prepared.replacement;
			const rawReplacementCommit = replacement.commit.bind(replacement);
			replacement.commit = () => {
				log.push("mw-commit");
				return rawReplacementCommit();
			};
			return prepared;
		};
		harness.middleware.setDiagnosticSink((diagnostic) => {
			harness.diagnostics.push(diagnostic);
			log.push(`sink:${diagnostic.kind}`);
			sample("sink");
		});
		// The coordinator built by bootHarness closed over the unwrapped
		// contracts; rebuild it against the wrapped ones.
		const coordinator = createExtensionReloadCoordinator({
			extensions: harness.extensions,
			middleware: harness.middleware,
			cwd: () => project,
			recordReceipt: (receipt) => harness.receipts.push(receipt),
			now: () => 1,
			report: (line) => {
				log.push("report");
				sample(`report:${line}`);
			},
			onCommitted: (event) => {
				log.push("committed");
				sample("committed");
				harness.events.push(event);
			},
		});
		coordinator.applyCurrent();
		sample("boot");
		// A host registration that takes the id ext-b will declare forces a
		// registration_conflict diagnostic during prepare, which is a user
		// callback that runs before the commits and must observe the old
		// generation in full.
		harness.middleware.registerHook({
			id: "ext-b.hook",
			description: "host holder",
			hooks: ["turn_start"],
			evaluate: () => [],
		});
		installFixture(project, "ext-b");
		log.length = 0;
		const outcome = coordinator.reload();
		strictEqual(outcome.status, "committed");
		if (outcome.status !== "committed") return;
		strictEqual(outcome.generation, 2);
		strictEqual(outcome.changed, true);
		deepStrictEqual(outcome.added, ["ext-b"]);
		deepStrictEqual(outcome.hooks, { registered: 1, dropped: 1, fileIssues: 0, issues: 0, overridden: 0 });
		sample("after");

		const extCommit = log.indexOf("ext-commit");
		const mwCommit = log.indexOf("mw-commit");
		ok(extCommit >= 0 && mwCommit === extCommit + 1, `commits must be adjacent: ${log.join(" > ")}`);
		ok(log.indexOf("sink:registration_conflict") < extCommit, `diagnostics precede the commits: ${log.join(" > ")}`);
		ok(log.indexOf("committed") > mwCommit, `the reload event follows both commits: ${log.join(" > ")}`);
		ok(log.indexOf("report") > mwCommit, `issue reporting follows both commits: ${log.join(" > ")}`);
		deepStrictEqual(harness.events, [{ generation: 2, previousGeneration: 1, changed: true, digest: outcome.digest }]);

		ok(
			samples.length >= 5,
			`expected boot, sink, committed, report, after samples: ${samples.map((s) => s.at).join(",")}`,
		);
		for (const observed of samples) {
			const expected = observed.extension;
			deepStrictEqual(
				new Set(observed.roots),
				new Set([expected]),
				`${observed.at}: resource roots must match generation ${expected}`,
			);
			ok(observed.hooks.length > 0, `${observed.at}: an extension hook must have evaluated`);
			deepStrictEqual(
				new Set(observed.hooks),
				new Set([expected]),
				`${observed.at}: hook receipts must match generation ${expected}`,
			);
		}
		strictEqual(samples.find((s) => s.at === "sink")?.extension, 1);
		strictEqual(samples.find((s) => s.at === "committed")?.extension, 2);
		harness.stop();
	});

	it("reloads an unchanged tree as a new generation with changed=false and the same hook set", () => {
		const project = scratch();
		installFixture(project, "ext-a");
		const harness = bootHarness(project);
		harness.coordinator.applyCurrent();
		const first = harness.coordinator.reload();
		strictEqual(first.status, "committed");
		if (first.status !== "committed") return;
		deepStrictEqual([first.generation, first.previousGeneration, first.changed], [2, 1, false]);
		strictEqual(first.hooks.registered, 1);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 2);
		deepStrictEqual(harness.middleware.runHook({ hook: "turn_start" }).ruleIds, ["ext-a.hook"]);
		strictEqual(harness.receipts.at(-1)?.extension?.generation, 2);
		deepStrictEqual(
			harness.events.map((event) => event.changed),
			[false],
		);
		harness.stop();
	});

	it("refuses to re-enter from a callback and reports a missing extensions domain without touching middleware", () => {
		const project = scratch();
		installFixture(project, "ext-a");
		let nested: ReturnType<ReturnType<typeof createExtensionReloadCoordinator>["reload"]> | null = null;
		let harness!: ReturnType<typeof bootHarness>;
		harness = bootHarness(project, {
			onCommitted: () => {
				nested = harness.coordinator.reload();
			},
		});
		harness.coordinator.applyCurrent();
		const outer = harness.coordinator.reload();
		strictEqual(outer.status, "committed");
		ok(nested);
		deepStrictEqual((nested as { status: string; reason?: string; generation?: number }).status, "rejected");
		deepStrictEqual((nested as { reason?: string }).reason, "reentrant");
		strictEqual((nested as { generation: number }).generation, 2);
		strictEqual(harness.extensions.generation(), 2);
		harness.stop();

		const middleware = createMiddlewareBundle().contract;
		writeProjectHooks(project, "project-only", "still-applies");
		const degraded = createExtensionReloadCoordinator({
			extensions: undefined,
			middleware,
			cwd: () => project,
			recordReceipt: () => undefined,
			report: () => undefined,
		});
		deepStrictEqual(
			degraded.applyCurrent().hooks.map((hook) => hook.id),
			["project-only"],
		);
		strictEqual(middleware.ownedGeneration("user-hooks"), 1);
		const rejected = degraded.reload();
		strictEqual(rejected.status, "rejected");
		if (rejected.status !== "rejected") return;
		strictEqual(rejected.reason, "build-failed");
		ok(rejected.lines[0]?.includes("extensions domain is not loaded"));
		strictEqual(middleware.ownedGeneration("user-hooks"), 1);
	});
});

interface StubCalls {
	extensions: string[];
	middleware: string[];
}

function candidateFor(project: string, generation: number): ExtensionReloadCandidate {
	return {
		generation,
		previousGeneration: generation - 1,
		snapshot: buildExtensionSnapshot({ cwd: project, generation }),
		changed: true,
		added: [],
		removed: [],
		modified: [],
	};
}

function stubDeps(
	project: string,
	script: {
		prepare: ExtensionReloadPrepareResult;
		commit?: ExtensionReloadResult;
		middlewarePrepare?:
			| PrepareRegistrationReplacementResult
			| ((generation: number) => PrepareRegistrationReplacementResult);
	},
): { deps: ExtensionReloadCoordinatorDeps; calls: StubCalls; lines: string[] } {
	const calls: StubCalls = { extensions: [], middleware: [] };
	const lines: string[] = [];
	const extensions: ExtensionReloadCoordinatorDeps["extensions"] = {
		prepareReload: () => {
			calls.extensions.push("prepare");
			return script.prepare;
		},
		commitReload: (candidate) => {
			calls.extensions.push(`commit:${candidate.generation}`);
			return (
				script.commit ?? {
					status: "committed",
					generation: candidate.generation,
					previousGeneration: candidate.previousGeneration,
					changed: candidate.changed,
					digest: candidate.snapshot.digest,
					added: candidate.added,
					removed: candidate.removed,
					modified: candidate.modified,
					diagnostics: candidate.snapshot.diagnostics,
				}
			);
		},
		discardReload: (candidate) => {
			calls.extensions.push(`discard:${candidate.generation}`);
		},
		snapshot: () => null,
	};
	const middleware: ExtensionReloadCoordinatorDeps["middleware"] = {
		prepareRegistrationReplacement: (_owner, generation, _registrations: ReadonlyArray<MiddlewareHookRegistration>) => {
			calls.middleware.push(`prepare:${generation}`);
			const scripted = script.middlewarePrepare;
			if (scripted === undefined) {
				const replacement: MiddlewareRegistrationReplacement = {
					owner: "user-hooks",
					generation,
					dropped: [],
					size: 0,
					current: () => true,
					commit: () => {
						calls.middleware.push(`commit:${generation}`);
						return {
							applied: true,
							owner: "user-hooks",
							activeGeneration: generation,
							dropped: [],
							dispose: () => undefined,
						};
					},
					discard: () => {
						calls.middleware.push(`discard:${generation}`);
					},
				};
				return { status: "prepared", replacement };
			}
			return typeof scripted === "function" ? scripted(generation) : scripted;
		},
		replaceRegistrations: () => {
			calls.middleware.push("replace");
			return { applied: true, owner: "user-hooks", activeGeneration: 1, dropped: [], dispose: () => undefined };
		},
		ownedGeneration: () => 0,
	};
	return {
		deps: {
			extensions,
			middleware,
			cwd: () => project,
			recordReceipt: () => undefined,
			report: (line) => lines.push(line),
		},
		calls,
		lines,
	};
}

describe("extension reload coordinator failure paths", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("returns a rejected build without preparing middleware", () => {
		const project = scratch();
		const { deps, calls, lines } = stubDeps(project, {
			prepare: {
				status: "rejected",
				reason: "build-failed",
				generation: 4,
				diagnostics: { entries: [{ type: "error", message: "disk exploded" }], truncated: 0 },
			},
		});
		const outcome = createExtensionReloadCoordinator(deps).reload();
		deepStrictEqual(
			[outcome.status, (outcome as { reason?: string }).reason, outcome.generation],
			["rejected", "build-failed", 4],
		);
		deepStrictEqual(calls, { extensions: ["prepare"], middleware: [] });
		deepStrictEqual(lines, ["[clio-coder:extensions] disk exploded"]);
		deepStrictEqual(outcome.lines, lines);
	});

	it("discards the candidate when middleware refuses the generation as stale", () => {
		const project = scratch();
		const candidate = candidateFor(project, 5);
		const { deps, calls } = stubDeps(project, {
			prepare: { status: "prepared", candidate },
			middlewarePrepare: { status: "rejected", owner: "user-hooks", reason: "stale", activeGeneration: 7 },
		});
		const outcome = createExtensionReloadCoordinator(deps).reload();
		deepStrictEqual(
			[outcome.status, (outcome as { reason?: string }).reason, outcome.generation],
			["rejected", "stale", 4],
		);
		deepStrictEqual(calls, { extensions: ["prepare", "discard:5"], middleware: ["prepare:5"] });
		ok(outcome.lines[0]?.includes("active 7"));
	});

	it("discards both sides when the prepared replacement is superseded before the commits", () => {
		const project = scratch();
		const candidate = candidateFor(project, 5);
		const { deps, calls } = stubDeps(project, {
			prepare: { status: "prepared", candidate },
			middlewarePrepare: (generation) => ({
				status: "prepared",
				replacement: {
					owner: "user-hooks",
					generation,
					dropped: [],
					size: 0,
					current: () => false,
					commit: () => {
						calls.middleware.push("commit:unexpected");
						return {
							applied: false,
							owner: "user-hooks",
							activeGeneration: 9,
							reason: "stale",
							dropped: [],
							dispose: () => undefined,
						};
					},
					discard: () => {
						calls.middleware.push(`discard:${generation}`);
					},
				},
			}),
		});
		const outcome = createExtensionReloadCoordinator(deps).reload();
		deepStrictEqual([outcome.status, (outcome as { reason?: string }).reason], ["rejected", "stale"]);
		deepStrictEqual(calls, { extensions: ["prepare", "discard:5"], middleware: ["prepare:5", "discard:5"] });
	});

	it("discards the prepared replacement when the extension commit is refused", () => {
		const project = scratch();
		const candidate = candidateFor(project, 5);
		const { deps, calls } = stubDeps(project, {
			prepare: { status: "prepared", candidate },
			commit: {
				status: "rejected",
				reason: "stale",
				generation: 6,
				diagnostics: { entries: [], truncated: 0 },
			},
		});
		const outcome = createExtensionReloadCoordinator(deps).reload();
		deepStrictEqual(
			[outcome.status, (outcome as { reason?: string }).reason, outcome.generation],
			["rejected", "stale", 6],
		);
		deepStrictEqual(calls, { extensions: ["prepare", "commit:5"], middleware: ["prepare:5", "discard:5"] });
	});
});
