/**
 * Library lifecycle: one reviewed plan per operation, applied per package above
 * the atomic package writers. Planning stages sources and writes nothing; apply
 * rechecks reviewed facts inside each writer's lock, keeps every committed write
 * when a later step fails, releases every staged source, and reports disk/state
 * verification, actual recipe admission and host refresh as separate facts.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LibraryImportApplyResult, LibraryImportPlan } from "../interop/import.js";
import {
	disablePlugin,
	enablePlugin,
	type InstalledPlugin,
	listInstalledPlugins,
	newlyBrokenDependents,
	observePluginCopy,
	type PluginDependentBreak,
	type PluginDiagnostic,
	type PluginExpectedCopy,
	type PluginMutationResult,
	type PluginScope,
	type PluginSnapshot,
	PluginWriterRefusal,
	pluginBaseDir,
	pluginContentDigest,
	readPluginInstallRecord,
	reloadPluginResources,
	removePlugin,
	withPluginScopeLock,
} from "../plugins/index.js";
import {
	classifyLibraryRequirements,
	commitLibraryInstallPlan,
	discoverLibrary,
	type LibraryInstallPlan,
	libraryEntryRef,
	planLibraryInstall,
	planLibraryUpdate,
	releaseLibraryPlan,
	resolveInstalledLibraryEntry,
	resolveLibraryPackage,
} from "./library.js";
import { type LibraryCopyState, libraryCopyState, readLibraryInventory } from "./library-inventory.js";
import {
	isLibraryKind,
	type LibraryEntryKind,
	type LibraryRequirementRef,
	type LibraryResourceKind,
} from "./library-types.js";
import { validateLibraryPackage } from "./library-validation.js";

export type LibraryOperation = "install" | "update" | "enable" | "disable" | "remove";

export interface LibraryPackageIdentity {
	ref: LibraryRequirementRef;
	kind: LibraryEntryKind;
	name: string;
	scope: PluginScope;
}

export interface LibraryLifecycleRequest {
	operation: LibraryOperation;
	/** "kind:name", a bare name when unambiguous, or (install) a local path / GitHub tree. */
	ref: string;
	scope?: PluginScope;
	/** Existing replace-with-recovery semantics only; never a dependency bypass. */
	force?: boolean;
	withRequirements?: boolean;
	catalog?: string;
	cwd?: string;
}

export type LibraryExpectedCopy = PluginExpectedCopy;

export interface LibraryPlanStep {
	operation: LibraryOperation;
	identity: LibraryPackageIdentity;
	destination: string;
	source?: { sourceUrl: string; sha256: string; staged: boolean };
	content?: {
		valid: boolean;
		resources: Array<{ kind: LibraryResourceKind; name: string; valid: boolean }>;
		diagnostics: string[];
	};
	expected: LibraryExpectedCopy[];
	dependencies: {
		requires: LibraryRequirementRef[];
		missing: LibraryRequirementRef[];
		inactive: LibraryRequirementRef[];
	};
	dependents: { newlyBroken: PluginDependentBreak[]; preexisting: PluginDependentBreak[] };
	effectiveAfter?: { scope: PluginScope; loadable: boolean; state: LibraryCopyState };
	fallbackNote: string;
	recovery: string;
	refusal?: string;
}

export interface LibraryLifecyclePlan {
	version: 1;
	id: string;
	createdAt: string;
	cwd: string;
	request: LibraryLifecycleRequest;
	steps: LibraryPlanStep[];
	applicable: boolean;
	diagnostics: string[];
}

export type LibraryStepStatus = "committed" | "failed" | "unattempted";

export interface LibraryStepVerification {
	/** Whether the admission read ran before or after the host refreshed its snapshot. */
	evidence: "pre-refresh" | "post-refresh";
	tree: "present" | "absent" | "changed";
	record: "recorded" | "absent" | "unreadable";
	copy?: LibraryCopyState;
	resources: Array<{ kind: LibraryResourceKind; name: string; available: boolean; reason?: string }>;
	effective: { scope: PluginScope; loadable: boolean } | null;
}

export interface LibraryStepOutcome {
	status: LibraryStepStatus;
	operation: LibraryOperation;
	identity: LibraryPackageIdentity;
	verification?: LibraryStepVerification;
	recovery?: { packageBackup?: string; stateBackup?: string };
	diagnostics: string[];
	error?: {
		code: "stale_plan" | "locked" | "refused" | "writer" | "verification";
		message: string;
		changed?: PluginWriterRefusal["changed"];
		next: string;
	};
}

export type LibraryRefreshResult =
	| { status: "refreshed"; generation: number; changed: boolean }
	| { status: "failed"; error: string }
	| { status: "not-applicable"; reason: string };

/** Provided by the active host. Must never re-run a lifecycle write. */
export type LibraryRefreshHost = (cwd: string) => LibraryRefreshResult;

export interface LibraryApplyResult {
	planId: string;
	dryRun: boolean;
	outcomes: LibraryStepOutcome[];
	committed: number;
	failed: number;
	unattempted: number;
	refresh: LibraryRefreshResult;
}

// ---------------------------------------------------------------------------
// Staging registry: plans stay JSON-safe; staged sources are tracked by plan id.
// ---------------------------------------------------------------------------

const staged = new Map<string, Map<string, LibraryInstallPlan>>();

function stepKey(identity: LibraryPackageIdentity): string {
	return `${identity.scope}:${identity.ref}`;
}

function retain(planId: string, identity: LibraryPackageIdentity, plan: LibraryInstallPlan): void {
	const byStep = staged.get(planId) ?? new Map<string, LibraryInstallPlan>();
	byStep.set(stepKey(identity), plan);
	staged.set(planId, byStep);
}

/** Cancel: release every staged source and write nothing. Idempotent. */
export function releaseLibraryLifecycle(plan: Pick<LibraryLifecyclePlan, "id">): void {
	const byStep = staged.get(plan.id);
	staged.delete(plan.id);
	for (const item of byStep?.values() ?? []) releaseLibraryPlan(item);
}

/** Plans carry no callbacks or bytes; this exists so callers can treat them symmetrically with import summaries. */
export function libraryLifecyclePlanSummary(plan: LibraryLifecyclePlan): LibraryLifecyclePlan {
	return plan;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function peerOf(scope: PluginScope): PluginScope {
	return scope === "user" ? "project" : "user";
}

function identityOf(kind: LibraryEntryKind, name: string, scope: PluginScope): LibraryPackageIdentity {
	return { ref: `${kind}:${name}`, kind, name, scope };
}

function copyOf(
	entries: ReadonlyArray<InstalledPlugin>,
	identity: LibraryPackageIdentity,
): InstalledPlugin | undefined {
	return entries.find(
		(item) => item.id === identity.name && (item.kind ?? "plugin") === identity.kind && item.scope === identity.scope,
	);
}

function observe(cwd: string, scope: PluginScope, id: string, diagnostics: string[]): LibraryExpectedCopy | undefined {
	try {
		return observePluginCopy(scope, id, cwd);
	} catch (error) {
		diagnostics.push(`state for ${scope}:${id} unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/**
 * Facts to recheck for one step: the mutated copy, its peer-scope copy when the
 * peer plugin directory exists, and every dependent consulted. Copies written by
 * earlier steps of the same batch are excluded so a plan cannot stale itself.
 */
function expectedFor(
	cwd: string,
	identity: LibraryPackageIdentity,
	consulted: ReadonlyArray<{ scope: PluginScope; id: string }>,
	earlier: ReadonlyArray<LibraryPackageIdentity>,
	diagnostics: string[],
): LibraryExpectedCopy[] {
	const wanted = new Map<string, { scope: PluginScope; id: string }>();
	wanted.set(`${identity.scope}:${identity.name}`, { scope: identity.scope, id: identity.name });
	if (existsSync(pluginBaseDir(peerOf(identity.scope), cwd)))
		wanted.set(`${peerOf(identity.scope)}:${identity.name}`, { scope: peerOf(identity.scope), id: identity.name });
	for (const item of consulted) wanted.set(`${item.scope}:${item.id}`, item);
	for (const item of earlier) wanted.delete(`${item.scope}:${item.name}`);
	const out: LibraryExpectedCopy[] = [];
	for (const item of wanted.values()) {
		const fact = observe(cwd, item.scope, item.id, diagnostics);
		if (fact) out.push(fact);
	}
	return out;
}

function stateAfterInstall(entries: ReadonlyArray<InstalledPlugin>, identity: LibraryPackageIdentity) {
	const peer = entries.find(
		(item) => item.id === identity.name && item.scope === peerOf(identity.scope) && item.valid && item.compatible,
	);
	if (identity.scope === "user" && peer) {
		return {
			effectiveAfter: { scope: "project" as const, loadable: peer.loadable, state: libraryCopyState(peer) },
			fallbackNote: `the project copy stays effective; the new user copy is shadowed until the project copy is removed`,
		};
	}
	return {
		effectiveAfter: { scope: identity.scope, loadable: true, state: "loadable" as const },
		fallbackNote:
			peer && identity.scope === "project"
				? "the new project copy shadows the existing user copy"
				: "this copy becomes the effective copy",
	};
}

function contentOf(root: string): NonNullable<LibraryPlanStep["content"]> {
	const result = validateLibraryPackage(root);
	return {
		valid: result.valid,
		resources: result.validation.resources
			.filter((item): item is typeof item & { kind: LibraryResourceKind } => item.kind !== "plugin")
			.map((item) => ({ kind: item.kind, name: item.name, valid: item.valid })),
		diagnostics: [...result.diagnostics.map((d) => d.message), ...result.validation.diagnostics.map((d) => d.message)],
	};
}

function installStep(
	planId: string,
	cwd: string,
	scope: PluginScope,
	staged: LibraryInstallPlan,
	operation: "install" | "update",
	entries: ReadonlyArray<InstalledPlugin>,
	earlier: ReadonlyArray<LibraryPackageIdentity>,
	dependencies: LibraryPlanStep["dependencies"],
	diagnostics: string[],
): LibraryPlanStep {
	const identity = identityOf(staged.entry.kind, staged.entry.name, scope);
	retain(planId, identity, staged);
	const existing = copyOf(entries, identity);
	const expected = expectedFor(cwd, identity, [], earlier, diagnostics);
	staged.expect = { copies: expected };
	const refusal =
		existing && operation === "install" && !staged.force
			? `${identity.ref} is already installed in ${scope} scope; use update or force`
			: undefined;
	return {
		operation,
		identity,
		destination: staged.path,
		source: { sourceUrl: staged.entry.sourceUrl, sha256: staged.sha256, staged: staged.sourceRoot !== undefined },
		content: contentOf(staged.sourceRoot as string),
		expected,
		dependencies,
		dependents: { newlyBroken: [], preexisting: [] },
		...stateAfterInstall(entries, identity),
		recovery: existing
			? "files in the current tree that differ from its record are kept beside it as a backup copy"
			: "nothing to recover; the destination is empty",
		...(refusal ? { refusal } : {}),
	};
}

function requirementRefs(status: ReturnType<typeof classifyLibraryRequirements>): LibraryPlanStep["dependencies"] {
	return {
		requires: status.ordered.map(libraryEntryRef),
		missing: status.unsatisfied.map(libraryEntryRef),
		inactive: (status.inactive ?? []).map(libraryEntryRef),
	};
}

export function planLibraryLifecycle(request: LibraryLifecycleRequest): LibraryLifecyclePlan {
	const cwd = path.resolve(request.cwd ?? process.cwd());
	const id = randomBytes(8).toString("hex");
	const diagnostics: string[] = [];
	const steps: LibraryPlanStep[] = [];
	const discoveryOptions = { cwd, ...(request.catalog ? { catalog: request.catalog } : {}) };
	const entries = listInstalledPlugins(cwd, { all: true });
	try {
		if (request.operation === "install") {
			const scope = request.scope ?? "user";
			const entry = resolveLibraryPackage(request.ref, discoveryOptions);
			let status: ReturnType<typeof classifyLibraryRequirements> = { ordered: [], satisfied: [], unsatisfied: [] };
			let refusal: string | undefined;
			try {
				status = classifyLibraryRequirements(entry, discoverLibrary(discoveryOptions).entries, { cwd });
			} catch (error) {
				// A requirement absent from every index, or a cycle: refuse, do not throw.
				refusal = error instanceof Error ? error.message : String(error);
			}
			const dependencies = requirementRefs(status);
			if (!refusal && status.inactive?.length)
				refusal = `library_requirement_inactive: ${dependencies.inactive.join(", ")}; enable or repair those packages first`;
			else if (!refusal && status.unsatisfied.length && !request.withRequirements)
				refusal = `library_requirement_missing: ${dependencies.missing.join(", ")}; plan with requirements`;
			const identity = identityOf(entry.kind, entry.name, scope);
			if (refusal) {
				// Refused before staging: nothing is fetched for a plan that cannot apply.
				steps.push({
					operation: "install",
					identity,
					destination: path.join(pluginBaseDir(scope, cwd), entry.name),
					source: { sourceUrl: entry.sourceUrl, sha256: entry.sha256 ?? "", staged: false },
					expected: [],
					dependencies,
					dependents: { newlyBroken: [], preexisting: [] },
					fallbackNote: "no change",
					recovery: "nothing changes",
					refusal,
				});
			} else {
				const earlier: LibraryPackageIdentity[] = [];
				for (const dependency of status.unsatisfied) {
					const step = installStep(
						id,
						cwd,
						scope,
						planLibraryInstall(dependency, { cwd, scope }),
						"install",
						entries,
						earlier,
						requirementRefs(classifyLibraryRequirements(dependency, discoverLibrary(discoveryOptions).entries, { cwd })),
						diagnostics,
					);
					steps.push(step);
					earlier.push(step.identity);
				}
				steps.push(
					installStep(
						id,
						cwd,
						scope,
						planLibraryInstall(entry, { cwd, scope, force: request.force ?? false }),
						"install",
						entries,
						earlier,
						dependencies,
						diagnostics,
					),
				);
			}
		} else if (request.operation === "update") {
			const identity = resolveInstalledLibraryEntry(request.ref, {
				cwd,
				...(request.scope ? { scope: request.scope } : {}),
			});
			let stagedPlan: LibraryInstallPlan | undefined;
			let refusal: string | undefined;
			try {
				stagedPlan = planLibraryUpdate(request.ref, {
					cwd,
					scope: identity.scope,
					force: request.force ?? false,
					...(request.catalog ? { catalog: request.catalog } : {}),
				});
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			const requires = identity.requires ?? [];
			const dependencies = {
				requires,
				missing: requires.filter(
					(ref) => !entries.some((item) => item.loadable && `${item.kind ?? "plugin"}:${item.id}` === ref),
				),
				inactive: [],
			};
			if (stagedPlan)
				steps.push(installStep(id, cwd, identity.scope, stagedPlan, "update", entries, [], dependencies, diagnostics));
			else {
				const target = identityOf(identity.kind, identity.name, identity.scope);
				steps.push({
					operation: "update",
					identity: target,
					destination: path.join(pluginBaseDir(identity.scope, cwd), identity.name),
					expected: [],
					dependencies,
					dependents: { newlyBroken: [], preexisting: [] },
					fallbackNote: "no change",
					recovery: "nothing changes",
					refusal: refusal ?? "update source unavailable",
				});
			}
		} else {
			const resolved = resolveInstalledLibraryEntry(request.ref, {
				cwd,
				...(request.scope ? { scope: request.scope } : {}),
			});
			const identity = identityOf(resolved.kind, resolved.name, resolved.scope);
			const copy = copyOf(entries, identity);
			if (!copy) throw new Error(`package not installed: ${identity.ref} (${identity.scope})`);
			let refusal: string | undefined;
			let dependents: LibraryPlanStep["dependents"] = { newlyBroken: [], preexisting: [] };
			let effectiveAfter: LibraryPlanStep["effectiveAfter"];
			let fallbackNote: string;
			const requires = copy.manifest?.clio.requires ?? [];
			const missing = requires.filter(
				(ref) => !entries.some((item) => item.loadable && `${item.kind ?? "plugin"}:${item.id}` === ref),
			);
			if (request.operation === "enable") {
				if (!copy.valid || !copy.compatible)
					refusal = `${identity.ref} cannot be enabled: ${copy.diagnostics.map((d) => d.message).join("; ")}`;
				else if (missing.length)
					refusal = `library_requirement_missing: ${missing.join(", ")}; install or enable those first`;
				const winner = entries.find((item) => item.id === identity.name && item.effective);
				effectiveAfter = winner
					? {
							scope: winner.scope,
							loadable: winner === copy ? copy.valid && copy.compatible : winner.loadable,
							state: winner === copy ? "loadable" : libraryCopyState(winner),
						}
					: undefined;
				fallbackNote =
					winner && winner !== copy
						? `the ${winner.scope} copy stays effective; this ${identity.scope} copy remains shadowed`
						: "this copy becomes loadable";
			} else {
				const projection = newlyBrokenDependents(entries, {
					scope: identity.scope,
					id: identity.name,
					operation: request.operation,
				});
				dependents = { newlyBroken: projection.newlyBroken, preexisting: projection.preexisting };
				if (projection.newlyBroken.length)
					refusal = `${request.operation} would break ${projection.newlyBroken
						.map((item) => `${item.scope}:${item.ref} (missing ${item.missing.join(", ")})`)
						.join("; ")}; disable or remove those dependents first`;
				const survivor = projection.effectiveAfter;
				effectiveAfter = survivor
					? { scope: survivor.scope, loadable: survivor.loadable, state: libraryCopyState(survivor) }
					: undefined;
				if (request.operation === "disable")
					fallbackNote =
						survivor && survivor.scope === identity.scope
							? survivor.overriddenBy || entries.some((item) => item.id === identity.name && item.scope !== identity.scope)
								? `the disabled ${identity.scope} copy still shadows the ${peerOf(identity.scope)} copy; removal would reveal it`
								: "no other copy exists; nothing falls back"
							: "another copy is already effective";
				else
					fallbackNote = survivor
						? `the ${survivor.scope} copy becomes effective (${survivor.loadable ? "loadable" : libraryCopyState(survivor)})`
						: "no other copy exists; the package will be absent";
			}
			const consulted = entries
				.filter((item) => item.loadable && (item.manifest?.clio.requires?.length ?? 0) > 0)
				.map((item) => ({ scope: item.scope, id: item.id }));
			steps.push({
				operation: request.operation,
				identity,
				destination: copy.rootPath,
				...(request.operation === "enable" ? { content: contentOf(copy.rootPath) } : {}),
				expected: expectedFor(cwd, identity, consulted, [], diagnostics),
				dependencies: { requires, missing, inactive: [] },
				dependents,
				...(effectiveAfter ? { effectiveAfter } : {}),
				fallbackNote,
				recovery:
					request.operation === "remove"
						? "files that differ from the recorded content are kept beside the destination as a removed backup"
						: "only the enabled flag in state.json changes; no files move",
				...(refusal ? { refusal } : {}),
			});
		}
	} catch (error) {
		releaseLibraryLifecycle({ id });
		throw error;
	}
	return {
		version: 1,
		id,
		createdAt: new Date().toISOString(),
		cwd,
		request,
		steps,
		applicable: steps.every((step) => !step.refusal),
		diagnostics,
	};
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Read back one copy: tree, record, inventory state, actual recipe admission and the surviving effective copy. */
export function verifyLibraryStep(
	identity: LibraryPackageIdentity,
	cwd: string,
	evidence: LibraryStepVerification["evidence"] = "pre-refresh",
): LibraryStepVerification {
	const entries = listInstalledPlugins(cwd, { all: true });
	const copy = copyOf(entries, identity);
	const root = path.join(pluginBaseDir(identity.scope, cwd), identity.name);
	let record: LibraryStepVerification["record"] = "absent";
	let recordedDigest: string | undefined;
	try {
		const saved = readPluginInstallRecord(identity.name, { cwd, scope: identity.scope });
		record = saved ? "recorded" : "absent";
		recordedDigest = saved?.contentDigest;
	} catch {
		record = "unreadable";
	}
	let tree: LibraryStepVerification["tree"] = "absent";
	if (existsSync(root)) {
		try {
			tree = recordedDigest && pluginContentDigest(root) !== recordedDigest ? "changed" : "present";
		} catch {
			tree = "changed";
		}
	}
	const kinds = new Set<LibraryResourceKind>();
	for (const kind of Object.keys(copy?.resources ?? {}))
		if (kind === "skills" || kind === "agents" || kind === "prompts" || kind === "fleets")
			kinds.add(kind.slice(0, -1) as LibraryResourceKind);
	const resources: LibraryStepVerification["resources"] = [];
	if (copy && kinds.size) {
		const inventory = readLibraryInventory({
			cwd,
			include: { packages: false, copies: false },
			kinds: [...kinds],
			sources: ["package"],
		});
		for (const resource of inventory.resources)
			if (resource.owner?.ref === identity.ref && resource.owner.scope === identity.scope)
				resources.push({
					kind: resource.kind,
					name: resource.name,
					available: resource.availability === "available",
					...(resource.reason ? { reason: resource.reason } : {}),
				});
	}
	const effective = entries.find((item) => item.id === identity.name && item.effective);
	return {
		evidence,
		tree,
		record,
		...(copy ? { copy: libraryCopyState(copy) } : {}),
		resources,
		effective: effective ? { scope: effective.scope, loadable: effective.loadable } : null,
	};
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function nextFor(code: NonNullable<LibraryStepOutcome["error"]>["code"]): string {
	switch (code) {
		case "stale_plan":
			return "review a fresh plan";
		case "locked":
			return "retry the same plan when the other operation finishes";
		case "refused":
			return "resolve the refusal and review a fresh plan";
		case "verification":
			return "inspect the copy and its recovery paths";
		default:
			return "inspect the diagnostics and recovery paths, then review a fresh plan";
	}
}

function failed(
	step: LibraryPlanStep,
	code: NonNullable<LibraryStepOutcome["error"]>["code"],
	message: string,
	extra: Pick<Partial<LibraryStepOutcome>, "diagnostics" | "recovery"> = {},
): LibraryStepOutcome {
	return {
		status: "failed",
		operation: step.operation,
		identity: step.identity,
		diagnostics: [],
		...extra,
		error: { code, message, next: nextFor(code) },
	};
}

function writerError(diagnostics: PluginDiagnostic[]): PluginDiagnostic | undefined {
	return diagnostics.find((item) => item.type === "error");
}

function runWriter(plan: LibraryLifecyclePlan, step: LibraryPlanStep): PluginMutationResult {
	const { identity } = step;
	const scoped = { cwd: plan.cwd, scope: identity.scope, expect: { copies: step.expected } };
	if (step.operation === "install" || step.operation === "update") {
		const stagedPlan = staged.get(plan.id)?.get(stepKey(identity));
		if (!stagedPlan) throw new Error(`plan ${plan.id} has no staged source for ${identity.ref}; it was released`);
		stagedPlan.expect = scoped.expect;
		return commitLibraryInstallPlan(stagedPlan);
	}
	if (step.operation === "enable") return enablePlugin(identity.name, scoped);
	if (step.operation === "disable") return disablePlugin(identity.name, scoped);
	return removePlugin(identity.name, scoped);
}

function applyStep(plan: LibraryLifecyclePlan, step: LibraryPlanStep): LibraryStepOutcome {
	const peer = peerOf(step.identity.scope);
	const holdPeer = step.expected.some((fact) => fact.scope === peer) && existsSync(pluginBaseDir(peer, plan.cwd));
	let result: PluginMutationResult;
	try {
		result = holdPeer ? withPluginScopeLock(peer, plan.cwd, () => runWriter(plan, step)) : runWriter(plan, step);
	} catch (error: unknown) {
		if (error instanceof PluginWriterRefusal) {
			const outcome = failed(step, error.code === "dependents" ? "refused" : error.code, error.message);
			if (error.changed && outcome.error) outcome.error.changed = error.changed;
			return outcome;
		}
		return failed(step, "writer", error instanceof Error ? error.message : String(error));
	}
	const problem = writerError(result.diagnostics);
	if (problem) {
		const code = problem.code === "dependents" ? "refused" : (problem.code ?? "writer");
		const outcome = failed(step, code, problem.message, {
			diagnostics: result.diagnostics.map((d) => d.message),
			...(result.recovery ? { recovery: result.recovery } : {}),
		});
		if (problem.changed && outcome.error) outcome.error.changed = problem.changed;
		return outcome;
	}
	// The writer committed durably. Verification can only annotate that fact;
	// a read-back failure never turns the commit into a failed step.
	const outcome: LibraryStepOutcome = {
		status: "committed",
		operation: step.operation,
		identity: step.identity,
		...(result.recovery ? { recovery: result.recovery } : {}),
		diagnostics: result.diagnostics.map((d) => d.message),
	};
	annotateVerification(outcome, plan.cwd, "pre-refresh", step.operation === "remove");
	return outcome;
}

function annotateVerification(
	outcome: LibraryStepOutcome,
	cwd: string,
	evidence: LibraryStepVerification["evidence"],
	wantsAbsent: boolean,
): void {
	let verification: LibraryStepVerification;
	try {
		verification = verifyLibraryStep(outcome.identity, cwd, evidence);
	} catch (error) {
		outcome.error = {
			code: "verification",
			message: `${evidence} read-back failed: ${error instanceof Error ? error.message : String(error)}`,
			next: nextFor("verification"),
		};
		return;
	}
	outcome.verification = verification;
	const diskOk = wantsAbsent
		? verification.tree === "absent" && verification.record === "absent"
		: verification.tree === "present" && verification.record === "recorded";
	if (diskOk) delete outcome.error;
	else
		outcome.error = {
			code: "verification",
			message: `writer reported success but the ${outcome.identity.scope} copy reads back tree=${verification.tree} record=${verification.record}`,
			next: nextFor("verification"),
		};
}

function unattempted(step: LibraryPlanStep): LibraryStepOutcome {
	return { status: "unattempted", operation: step.operation, identity: step.identity, diagnostics: [] };
}

export function applyLibraryLifecycle(
	plan: LibraryLifecyclePlan,
	options: { dryRun?: boolean; refresh?: LibraryRefreshHost } = {},
): LibraryApplyResult {
	const outcomes: LibraryStepOutcome[] = [];
	try {
		if (options.dryRun) {
			for (const step of plan.steps) outcomes.push(unattempted(step));
			return summarize(plan, true, outcomes, { status: "not-applicable", reason: "dry run; nothing committed" });
		}
		if (!plan.applicable) {
			for (const step of plan.steps)
				outcomes.push(step.refusal ? failed(step, "refused", step.refusal) : { ...unattempted(step) });
			return summarize(plan, false, outcomes, { status: "not-applicable", reason: "plan refused; nothing committed" });
		}
		let aborted = false;
		for (const step of plan.steps) {
			if (aborted) {
				outcomes.push(unattempted(step));
				continue;
			}
			const outcome = applyStep(plan, step);
			outcomes.push(outcome);
			// A durable commit with a verification problem still stops the batch;
			// later steps must not build on a copy whose state cannot be proven.
			if (outcome.status !== "committed" || outcome.error) aborted = true;
		}
	} finally {
		releaseLibraryLifecycle(plan);
	}
	const committed = outcomes.filter((item) => item.status === "committed");
	const refresh = committed.length
		? retryLibraryRefresh(plan.cwd, options.refresh)
		: ({ status: "not-applicable", reason: "nothing committed" } as const);
	if (refresh.status === "refreshed")
		for (const outcome of committed)
			annotateVerification(outcome, plan.cwd, "post-refresh", outcome.operation === "remove");
	return summarize(plan, false, outcomes, refresh);
}

function summarize(
	plan: LibraryLifecyclePlan,
	dryRun: boolean,
	outcomes: LibraryStepOutcome[],
	refresh: LibraryRefreshResult,
): LibraryApplyResult {
	return {
		planId: plan.id,
		dryRun,
		outcomes,
		committed: outcomes.filter((item) => item.status === "committed").length,
		failed: outcomes.filter((item) => item.status === "failed").length,
		unattempted: outcomes.filter((item) => item.status === "unattempted").length,
		refresh,
	};
}

/** Refresh only. Never reinstalls or removes; safe after a partial batch or a failed refresh. */
export function retryLibraryRefresh(cwd: string, refresh?: LibraryRefreshHost): LibraryRefreshResult {
	if (!refresh)
		return {
			status: "not-applicable",
			reason: "no active session in this process; use /library reload in the running TUI",
		};
	try {
		return refresh(cwd);
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/** Default host adapter over the snapshot reload; the TUI wraps it with its bus notification. */
export function pluginSnapshotRefreshHost(
	reload: (cwd: string) => PluginSnapshot = reloadPluginResources,
	previousGeneration: (cwd: string) => number = () => 0,
): LibraryRefreshHost {
	return (cwd) => {
		const before = previousGeneration(cwd);
		const next = reload(cwd);
		return { status: "refreshed", generation: next.generation, changed: before === 0 || next.generation !== before };
	};
}

/** The typed kind of an import: the applied install record when published, else the reviewed manifest bytes. */
function importedKind(plan: LibraryImportPlan, result: LibraryImportApplyResult, name: string): LibraryEntryKind {
	if (result.published) {
		try {
			const saved = readPluginInstallRecord(name, { cwd: plan.cwd, scope: plan.scope });
			if (saved?.kind) return saved.kind;
		} catch {
			// Fall through to the reviewed bytes.
		}
	}
	try {
		const manifest = plan.files?.["plugin.json"];
		const parsed = manifest ? (JSON.parse(manifest) as { extensions?: Record<string, { kind?: unknown }> }) : undefined;
		const kind = parsed?.extensions?.["ai.iowarp.clio"]?.kind;
		if (isLibraryKind(kind)) return kind;
	} catch {
		// Unreadable review bytes: portable default.
	}
	return "plugin";
}

/** Read-only projection of an explicit import into the shared outcome shape. Trust stays foreign; nothing re-runs. */
export function libraryImportOutcome(plan: LibraryImportPlan, result: LibraryImportApplyResult): LibraryStepOutcome {
	const name = result.installed ?? plan.id ?? path.basename(plan.source.root);
	const identity = identityOf(importedKind(plan, result, name), name, plan.scope);
	if (!result.published)
		return {
			status: "failed",
			operation: "install",
			identity,
			diagnostics: result.diagnostics,
			error: {
				code: "refused",
				message: result.diagnostics.join("; ") || "import not published",
				next: nextFor("refused"),
			},
		};
	const outcome: LibraryStepOutcome = {
		status: "committed",
		operation: "install",
		identity,
		diagnostics: [...result.diagnostics, `foreign trust; project-import gate ${String(result.admission.gateEnabled)}`],
	};
	annotateVerification(outcome, plan.cwd, "pre-refresh", false);
	return outcome;
}
