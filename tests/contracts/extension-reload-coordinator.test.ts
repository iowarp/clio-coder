import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionsReloadedPayload } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createExtensionsBundle } from "../../src/domains/extensions/extension.js";
import type {
	ExtensionReloadCandidate,
	ExtensionReloadPrepareResult,
	ExtensionsContract,
} from "../../src/domains/extensions/index.js";
import { enabledExtensionResourceRoots } from "../../src/domains/extensions/resources.js";
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
	ok(result.extension?.loadable, result.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
}

function writeProjectHooks(project: string, hookId: string, message: string): void {
	mkdirSync(path.join(project, ".clio-coder"), { recursive: true });
	writeFileSync(
		path.join(project, ".clio-coder", "hooks.yaml"),
		`- id: ${hookId}\n  on: turn_start\n  kind: prompt\n  message: ${message}\n`,
	);
}

function hostHook(id: string, message = id): MiddlewareHookRegistration {
	return {
		id,
		description: id,
		hooks: ["turn_start"],
		evaluate: () => [{ kind: "inject_reminder", message }],
	};
}

interface LiveHarness {
	bundle: ReturnType<typeof createExtensionsBundle>;
	extensions: ExtensionsContract;
	middleware: MiddlewareContract;
	receipts: HookReceipt[];
	lines: string[];
	events: ExtensionsReloadedPayload[];
	coordinator(overrides?: Partial<ExtensionReloadCoordinatorDeps>): ReturnType<typeof createExtensionReloadCoordinator>;
	stop(): void;
}

function liveHarness(project: string): LiveHarness {
	const bundle = createExtensionsBundle(domainContext, { cwd: () => project });
	bundle.extension.start();
	const middleware = createMiddlewareBundle().contract;
	const receipts: HookReceipt[] = [];
	const lines: string[] = [];
	const events: ExtensionsReloadedPayload[] = [];
	return {
		bundle,
		extensions: bundle.contract,
		middleware,
		receipts,
		lines,
		events,
		coordinator: (overrides = {}) =>
			createExtensionReloadCoordinator({
				extensions: bundle.contract,
				middleware,
				cwd: () => project,
				recordReceipt: (receipt) => receipts.push(receipt),
				runCommand: () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
				now: () => 1,
				report: (line) => lines.push(line),
				onCommitted: (event) => events.push(event),
				...overrides,
			}),
		stop: () => bundle.extension.stop?.(),
	};
}

/**
 * Wrap the two contract boundaries before constructing the coordinator. The
 * wrappers record entry into each publish primitive; observer callbacks add
 * their own entries later, so adjacency is checked against the actual runtime
 * transition instead of inferred from the final state.
 */
function observePublications(extensions: ExtensionsContract, middleware: MiddlewareContract, log: string[]): void {
	const prepareReload = extensions.prepareReload.bind(extensions);
	extensions.prepareReload = () => {
		const prepared = prepareReload();
		if (prepared.status === "prepared") {
			const publish = prepared.candidate.publish.bind(prepared.candidate);
			prepared.candidate.publish = () => {
				log.push(`ext-publish:${prepared.candidate.generation}`);
				publish();
			};
		}
		return prepared;
	};
	const prepareReplacement = middleware.prepareRegistrationReplacement.bind(middleware);
	middleware.prepareRegistrationReplacement = (owner, generation, registrations) => {
		const prepared = prepareReplacement(owner, generation, registrations);
		if (prepared.status === "prepared") {
			const publish = prepared.replacement.publish.bind(prepared.replacement);
			prepared.replacement.publish = () => {
				log.push(`mw-publish:${prepared.replacement.generation}`);
				publish();
			};
		}
		return prepared;
	};
}

describe("extension reload coordinator publication", () => {
	afterEach(() => {
		bindExtensionSnapshotStore(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps boot at generation zero until the composition root publishes the paired first generation", () => {
		const project = scratch();
		installFixture(project, "ext-a");
		const harness = liveHarness(project);
		const log: string[] = [];
		observePublications(harness.extensions, harness.middleware, log);
		const coordinator = harness.coordinator({
			onCommitted: (event) => {
				log.push(`committed:${event.generation}`);
				harness.events.push(event);
			},
		});

		strictEqual(harness.extensions.snapshot(), null, "the extensions domain start publishes nothing");
		strictEqual(harness.extensions.generation(), 0);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 0);
		deepStrictEqual(
			enabledExtensionResourceRoots("skills", project).map((root) => [root.id, root.generation]),
			[["ext-a", 0]],
			"resource readers take the ephemeral path before paired boot publication",
		);
		deepStrictEqual(harness.middleware.runHook({ hook: "turn_start" }).ruleIds, []);
		strictEqual(harness.receipts.length, 0);

		const boot = coordinator.applyBoot();
		strictEqual(boot.status, "committed");
		if (boot.status !== "committed") return;
		deepStrictEqual([boot.generation, boot.previousGeneration, boot.changed], [1, 0, true]);
		deepStrictEqual(log, ["ext-publish:1", "mw-publish:1", "committed:1"]);
		strictEqual(harness.extensions.generation(), 1);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 1);
		deepStrictEqual(
			harness.extensions.resourceRoots("skills").map((root) => [root.id, root.generation]),
			[["ext-a", 1]],
		);
		deepStrictEqual(harness.middleware.runHook({ hook: "turn_start" }).ruleIds, ["ext-a.hook"]);
		strictEqual(harness.receipts.at(-1)?.extension?.generation, 1);
		deepStrictEqual(harness.events, [{ generation: 1, previousGeneration: 0, changed: true, digest: boot.digest }]);
		harness.stop();
	});

	it("keeps project precedence truthful and publishes an unchanged reload as a paired new generation", () => {
		const project = scratch();
		installFixture(project, "ext-a", "shared", "from-extension");
		writeProjectHooks(project, "shared", "from-project");
		const harness = liveHarness(project);
		const coordinator = harness.coordinator();

		const boot = coordinator.applyBoot();
		strictEqual(boot.status, "committed");
		if (boot.status !== "committed") return;
		deepStrictEqual(boot.hooks, { registered: 1, dropped: 0, fileIssues: 0, issues: 0, overridden: 1 });
		deepStrictEqual(harness.middleware.runHook({ hook: "turn_start" }).ruleIds, ["shared"]);
		strictEqual(harness.receipts.at(-1)?.origin, "project");
		strictEqual(harness.receipts.at(-1)?.extension, undefined);
		ok(harness.lines.some((line) => line.includes("overridden by")));

		const reload = coordinator.reload();
		strictEqual(reload.status, "committed");
		if (reload.status !== "committed") return;
		deepStrictEqual([reload.generation, reload.previousGeneration, reload.changed], [2, 1, false]);
		strictEqual(reload.digest, boot.digest);
		deepStrictEqual([reload.added, reload.removed, reload.modified], [[], [], []]);
		deepStrictEqual(reload.hooks, boot.hooks);
		strictEqual(harness.extensions.generation(), 2);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 2);
		deepStrictEqual(harness.middleware.runHook({ hook: "turn_start" }).ruleIds, ["shared"]);
		deepStrictEqual(
			harness.events.map((event) => [event.generation, event.previousGeneration, event.changed]),
			[
				[1, 0, true],
				[2, 1, false],
			],
		);
		harness.stop();
	});

	it("publishes extension and middleware adjacently before diagnostic, event, or report re-entry", () => {
		const project = scratch();
		installFixture(project, "ext-a");
		installFixture(project, "ext-b");
		const harness = liveHarness(project);
		const log: string[] = [];
		const diagnostics: MiddlewareDiagnostic[] = [];
		const samples: Array<{
			at: string;
			extension: number;
			middleware: number;
			roots: number[];
			ruleIds: string[];
			receiptGenerations: number[];
		}> = [];
		const sample = (at: string): void => {
			const before = harness.receipts.length;
			const result = harness.middleware.runHook({ hook: "turn_start" });
			samples.push({
				at,
				extension: harness.extensions.generation(),
				middleware: harness.middleware.ownedGeneration("user-hooks"),
				roots: harness.extensions.resourceRoots("skills").map((root) => root.generation),
				ruleIds: [...result.ruleIds],
				receiptGenerations: harness.receipts
					.slice(before)
					.map((receipt) => receipt.extension?.generation)
					.filter((generation): generation is number => generation !== undefined),
			});
		};

		// ext-a is dropped as an owned hook. Its post-publication diagnostic
		// re-enters registration and takes ext-b too, exercising both directions
		// without letting preparation call the sink.
		harness.middleware.registerHook(hostHook("ext-a.hook", "host-a"));
		observePublications(harness.extensions, harness.middleware, log);
		harness.middleware.setDiagnosticSink((diagnostic) => {
			diagnostics.push(diagnostic);
			log.push(
				diagnostic.kind === "registration_conflict"
					? `sink:${diagnostic.registrationId}:${diagnostic.action}`
					: `sink:${diagnostic.kind}`,
			);
			sample(`sink:${diagnostic.kind}`);
			if (
				diagnostic.kind === "registration_conflict" &&
				diagnostic.registrationId === "ext-a.hook" &&
				diagnostic.action === "dropped"
			) {
				harness.middleware.registerHook(hostHook("ext-b.hook", "host-b"));
			}
		});
		const coordinator = harness.coordinator({
			report: (line) => {
				log.push("report");
				harness.lines.push(line);
				sample("report");
			},
			onCommitted: (event) => {
				log.push(`committed:${event.generation}`);
				harness.events.push(event);
				sample("committed");
			},
		});

		const outcome = coordinator.applyBoot();
		strictEqual(outcome.status, "committed");
		if (outcome.status !== "committed") return;
		const extensionPublish = log.indexOf("ext-publish:1");
		const middlewarePublish = log.indexOf("mw-publish:1");
		ok(extensionPublish >= 0, log.join(" > "));
		strictEqual(middlewarePublish, extensionPublish + 1, `publication calls were not adjacent: ${log.join(" > ")}`);
		for (const prefix of ["sink:", "committed:", "report"]) {
			const observer = log.findIndex((entry) => entry.startsWith(prefix));
			ok(observer > middlewarePublish, `${prefix} ran before paired publication: ${log.join(" > ")}`);
		}
		deepStrictEqual(
			diagnostics.map((diagnostic) =>
				diagnostic.kind === "registration_conflict"
					? [diagnostic.registrationId, diagnostic.conflictsWith, diagnostic.action]
					: [diagnostic.kind],
			),
			[
				["ext-a.hook", "host", "dropped"],
				["ext-b.hook", "host", "evicted"],
			],
		);
		const final = harness.middleware.runHook({ hook: "turn_start" });
		deepStrictEqual(final.ruleIds, ["ext-a.hook", "ext-b.hook"]);
		strictEqual(new Set(final.ruleIds).size, final.ruleIds.length, "sink re-entry introduced a duplicate id");
		strictEqual(harness.extensions.generation(), 1);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 1);
		ok(samples.length >= 4, samples.map((entry) => entry.at).join(", "));
		for (const observed of samples) {
			strictEqual(observed.extension, 1, observed.at);
			strictEqual(observed.middleware, 1, observed.at);
			deepStrictEqual(new Set(observed.roots), new Set([1]), observed.at);
			strictEqual(new Set(observed.ruleIds).size, observed.ruleIds.length, observed.at);
			deepStrictEqual(new Set(observed.receiptGenerations), new Set(observed.receiptGenerations.length > 0 ? [1] : []));
		}
		harness.stop();
	});

	it("samples cwd once, accepts a canonical alias, and refuses a workspace switch before middleware prepare", () => {
		const projectA = scratch();
		const projectB = scratch();
		const aliasParent = scratch();
		const projectAlias = path.join(aliasParent, "project-alias");
		symlinkSync(projectA, projectAlias, "dir");
		installFixture(projectA, "ext-a");
		const harness = liveHarness(projectA);
		let requestedCwd = projectAlias;
		let cwdReads = 0;
		const middlewarePreparations: number[] = [];
		const prepareReplacement = harness.middleware.prepareRegistrationReplacement.bind(harness.middleware);
		harness.middleware.prepareRegistrationReplacement = (owner, generation, registrations) => {
			middlewarePreparations.push(generation);
			return prepareReplacement(owner, generation, registrations);
		};
		const coordinator = harness.coordinator({
			cwd: () => {
				cwdReads += 1;
				return requestedCwd;
			},
		});

		const boot = coordinator.applyBoot();
		strictEqual(boot.status, "committed", "the canonical alias names the same workspace");
		strictEqual(cwdReads, 1);
		deepStrictEqual(middlewarePreparations, [1]);

		requestedCwd = projectB;
		const switched = coordinator.reload();
		strictEqual(switched.status, "rejected");
		if (switched.status !== "rejected") return;
		deepStrictEqual([switched.reason, switched.generation], ["workspace-changed", 1]);
		strictEqual(cwdReads, 2, "the coordinator samples cwd exactly once for the refused run");
		deepStrictEqual(middlewarePreparations, [1], "workspace mismatch is refused before middleware preparation");
		strictEqual(harness.extensions.generation(), 1);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 1);
		deepStrictEqual(
			harness.extensions.resourceRoots("skills").map((root) => root.generation),
			[1],
		);

		requestedCwd = projectAlias;
		const recovered = coordinator.reload();
		strictEqual(recovered.status, "committed");
		if (recovered.status !== "committed") return;
		strictEqual(recovered.generation, 3, "the refused workspace candidate burned generation 2");
		strictEqual(cwdReads, 3);
		deepStrictEqual(middlewarePreparations, [1, 3]);
		strictEqual(harness.extensions.generation(), 3);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 3);
		harness.stop();
	});

	it("publishes project-only hooks on degraded boot and leaves them unchanged on a rejected reload", () => {
		const project = scratch();
		writeProjectHooks(project, "project-only", "still-applies");
		const middleware = createMiddlewareBundle().contract;
		const receipts: HookReceipt[] = [];
		const lines: string[] = [];
		let replacementCalls = 0;
		const replaceRegistrations = middleware.replaceRegistrations.bind(middleware);
		middleware.replaceRegistrations = (owner, generation, registrations) => {
			replacementCalls += 1;
			return replaceRegistrations(owner, generation, registrations);
		};
		const coordinator = createExtensionReloadCoordinator({
			extensions: undefined,
			middleware,
			cwd: () => project,
			recordReceipt: (receipt) => receipts.push(receipt),
			report: (line) => lines.push(line),
		});

		const boot = coordinator.applyBoot();
		strictEqual(boot.status, "rejected");
		if (boot.status !== "rejected") return;
		deepStrictEqual([boot.reason, boot.generation], ["build-failed", 0]);
		strictEqual(middleware.ownedGeneration("user-hooks"), 1);
		deepStrictEqual(middleware.runHook({ hook: "turn_start" }).ruleIds, ["project-only"]);
		strictEqual(receipts.at(-1)?.origin, "project");
		strictEqual(replacementCalls, 1);

		const reload = coordinator.reload();
		strictEqual(reload.status, "rejected");
		if (reload.status !== "rejected") return;
		deepStrictEqual([reload.reason, reload.generation], ["build-failed", 0]);
		strictEqual(middleware.ownedGeneration("user-hooks"), 1);
		deepStrictEqual(middleware.runHook({ hook: "turn_start" }).ruleIds, ["project-only"]);
		strictEqual(replacementCalls, 1, "a rejected degraded reload does not republish project hooks");
		ok(lines.every((line) => line.includes("extensions domain is not loaded")));
	});
});

interface StubCalls {
	extensions: string[];
	middleware: string[];
	timeline: string[];
}

interface StubScript {
	prepare: ExtensionReloadPrepareResult;
	middlewarePrepare?:
		| PrepareRegistrationReplacementResult
		| ((
				generation: number,
				registrations: ReadonlyArray<MiddlewareHookRegistration>,
		  ) => PrepareRegistrationReplacementResult);
}

function candidateFor(
	project: string,
	generation: number,
	calls: StubCalls,
	current: () => boolean = () => true,
): ExtensionReloadCandidate {
	const candidate: ExtensionReloadCandidate = {
		generation,
		previousGeneration: generation - 1,
		snapshot: buildExtensionSnapshot({ cwd: project, generation }),
		changed: true,
		added: [],
		removed: [],
		modified: [],
		current: () => {
			calls.extensions.push(`current:${generation}`);
			calls.timeline.push(`ext-current:${generation}`);
			return current();
		},
		publish: () => {
			calls.extensions.push(`publish:${generation}`);
			calls.timeline.push(`ext-publish:${generation}`);
		},
		discard: () => {
			calls.extensions.push(`discard:${generation}`);
			calls.timeline.push(`ext-discard:${generation}`);
		},
	};
	return candidate;
}

function replacementFor(
	generation: number,
	calls: StubCalls,
	current: () => boolean = () => true,
	size = 0,
): MiddlewareRegistrationReplacement {
	return {
		owner: "user-hooks",
		generation,
		dropped: [],
		conflicts: [],
		size,
		current: () => {
			calls.middleware.push(`current:${generation}`);
			calls.timeline.push(`mw-current:${generation}`);
			return current();
		},
		publish: () => {
			calls.middleware.push(`publish:${generation}`);
			calls.timeline.push(`mw-publish:${generation}`);
		},
		emitConflicts: () => {
			calls.middleware.push(`emit:${generation}`);
			calls.timeline.push(`mw-emit:${generation}`);
		},
		dispose: () => {
			calls.middleware.push(`dispose:${generation}`);
		},
		discard: () => {
			calls.middleware.push(`discard:${generation}`);
			calls.timeline.push(`mw-discard:${generation}`);
		},
	};
}

function stubDeps(
	project: string,
	script: StubScript,
	calls: StubCalls,
): { deps: ExtensionReloadCoordinatorDeps; lines: string[]; events: ExtensionsReloadedPayload[] } {
	const lines: string[] = [];
	const events: ExtensionsReloadedPayload[] = [];
	const extensions: NonNullable<ExtensionReloadCoordinatorDeps["extensions"]> = {
		prepareReload: () => {
			calls.extensions.push("prepare");
			calls.timeline.push("ext-prepare");
			return script.prepare;
		},
		snapshot: () => null,
	};
	const middleware: ExtensionReloadCoordinatorDeps["middleware"] = {
		prepareRegistrationReplacement: (_owner, generation, registrations) => {
			calls.middleware.push(`prepare:${generation}`);
			calls.timeline.push(`mw-prepare:${generation}`);
			const prepared = script.middlewarePrepare;
			if (prepared === undefined) {
				return { status: "prepared", replacement: replacementFor(generation, calls, () => true, registrations.length) };
			}
			return typeof prepared === "function" ? prepared(generation, registrations) : prepared;
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
			onCommitted: (event) => {
				events.push(event);
				calls.timeline.push(`committed:${event.generation}`);
			},
		},
		lines,
		events,
	};
}

describe("extension reload coordinator refusal paths", () => {
	afterEach(() => {
		bindExtensionSnapshotStore(null);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("publishes neither side when either final freshness check refuses", () => {
		for (const staleSide of ["extension", "middleware"] as const) {
			const project = scratch();
			const calls: StubCalls = { extensions: [], middleware: [], timeline: [] };
			const candidate = candidateFor(project, 5, calls, () => staleSide !== "extension");
			const replacement = replacementFor(5, calls, () => staleSide !== "middleware");
			const { deps, events } = stubDeps(
				project,
				{ prepare: { status: "prepared", candidate }, middlewarePrepare: { status: "prepared", replacement } },
				calls,
			);
			const outcome = createExtensionReloadCoordinator(deps).reload();
			strictEqual(outcome.status, "rejected", staleSide);
			if (outcome.status !== "rejected") continue;
			deepStrictEqual([outcome.reason, outcome.generation], ["stale", 4], staleSide);
			ok(!calls.extensions.some((entry) => entry.startsWith("publish:")), staleSide);
			ok(!calls.middleware.some((entry) => entry.startsWith("publish:")), staleSide);
			ok(calls.extensions.includes("discard:5"), staleSide);
			ok(calls.middleware.includes("discard:5"), staleSide);
			deepStrictEqual(events, [], staleSide);
		}
	});

	it("rejects prepare-time refusal before publication and reports no success after it", () => {
		const project = scratch();
		const calls: StubCalls = { extensions: [], middleware: [], timeline: [] };
		const candidate = candidateFor(project, 5, calls);
		const { deps, events } = stubDeps(
			project,
			{
				prepare: { status: "prepared", candidate },
				middlewarePrepare: { status: "rejected", owner: "user-hooks", reason: "stale", activeGeneration: 7 },
			},
			calls,
		);
		const outcome = createExtensionReloadCoordinator(deps).reload();
		strictEqual(outcome.status, "rejected");
		if (outcome.status !== "rejected") return;
		deepStrictEqual([outcome.reason, outcome.generation], ["stale", 4]);
		deepStrictEqual(calls.extensions, ["prepare", "discard:5"]);
		deepStrictEqual(calls.middleware, ["prepare:5"]);
		deepStrictEqual(events, []);
		ok(outcome.lines[0]?.includes("active 7"));
	});

	it("calls assignment-only publication adjacently only after both current checks", () => {
		const project = scratch();
		const calls: StubCalls = { extensions: [], middleware: [], timeline: [] };
		const candidate = candidateFor(project, 5, calls);
		const replacement = replacementFor(5, calls);
		const { deps, events } = stubDeps(
			project,
			{ prepare: { status: "prepared", candidate }, middlewarePrepare: { status: "prepared", replacement } },
			calls,
		);
		const outcome = createExtensionReloadCoordinator(deps).reload();
		strictEqual(outcome.status, "committed");
		if (outcome.status !== "committed") return;
		deepStrictEqual(calls.extensions, ["prepare", "current:5", "publish:5"]);
		deepStrictEqual(calls.middleware, ["prepare:5", "current:5", "publish:5", "emit:5"]);
		deepStrictEqual(calls.timeline, [
			"ext-prepare",
			"mw-prepare:5",
			"ext-current:5",
			"mw-current:5",
			"ext-publish:5",
			"mw-publish:5",
			"mw-emit:5",
			"committed:5",
		]);
		deepStrictEqual(events, [{ generation: 5, previousGeneration: 4, changed: true, digest: candidate.snapshot.digest }]);
	});

	it("returns a rejected extension build without preparing middleware", () => {
		const project = scratch();
		const calls: StubCalls = { extensions: [], middleware: [], timeline: [] };
		const { deps, lines, events } = stubDeps(
			project,
			{
				prepare: {
					status: "rejected",
					reason: "build-failed",
					generation: 4,
					diagnostics: { entries: [{ type: "error", message: "disk exploded" }], truncated: 0 },
				},
			},
			calls,
		);
		const outcome = createExtensionReloadCoordinator(deps).reload();
		strictEqual(outcome.status, "rejected");
		if (outcome.status !== "rejected") return;
		deepStrictEqual([outcome.reason, outcome.generation], ["build-failed", 4]);
		deepStrictEqual(calls.extensions, ["prepare"]);
		deepStrictEqual(calls.middleware, []);
		deepStrictEqual(lines, ["[clio-coder:extensions] disk exploded"]);
		deepStrictEqual(events, []);
	});

	it("refuses callback re-entry while the paired generation is already live", () => {
		const project = scratch();
		installFixture(project, "ext-a");
		const harness = liveHarness(project);
		let nested: ReturnType<ReturnType<typeof harness.coordinator>["reload"]> | null = null;
		let coordinator!: ReturnType<typeof createExtensionReloadCoordinator>;
		coordinator = harness.coordinator({
			onCommitted: (event) => {
				harness.events.push(event);
				nested = coordinator.reload();
			},
		});
		const outer = coordinator.applyBoot();
		strictEqual(outer.status, "committed");
		const nestedOutcome = nested as ReturnType<ReturnType<typeof harness.coordinator>["reload"]> | null;
		ok(nestedOutcome);
		strictEqual(nestedOutcome.status, "rejected");
		if (nestedOutcome.status === "rejected") {
			deepStrictEqual([nestedOutcome.reason, nestedOutcome.generation], ["reentrant", 1]);
		}
		strictEqual(harness.extensions.generation(), 1);
		strictEqual(harness.middleware.ownedGeneration("user-hooks"), 1);
		harness.stop();
	});
});
