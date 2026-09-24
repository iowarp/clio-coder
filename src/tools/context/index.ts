import { type Dirent, readdirSync } from "node:fs";
import path from "node:path";
import type { ContextRecalledPayload } from "../../core/bus-events.js";
import type { ClioSettings } from "../../core/config.js";
import type { PrecomputedRanking } from "../../core/precomputed-rank.js";
import { settingsAwareness } from "../../core/settings-awareness.js";
import { SKILL_SUGGESTION_ANCHOR, type SkillLoadRefusal, type SkillRefusalKind } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { BudgetProvider } from "../../domains/context/budget/inspection.js";
import type { WorkerRecall } from "../../domains/context/worker/recall.js";
import { foldWorkingSet } from "../../domains/context/working-set/fold.js";
import {
	buildRecallFields,
	recallableRefListing,
	recallErrorMessage,
	recallParentTurnId,
	resolveRecall,
} from "../../domains/context/working-set/recall.js";
import { withPluginDiscoveryPass } from "../../domains/plugins/index.js";
import {
	buildSkillCatalogView,
	checkSkillDrift,
	checkSkillDriftBatch,
	discoverMarketplaceSkills,
	installedSkillNames,
	installedSkillPackages,
	type LoadSkillsInput,
	loadSkills,
	type MarketplaceSkill,
	modelVisibleSkills,
	type Skill,
	type SkillCatalogRowKind,
} from "../../domains/resources/index.js";
import type { SessionEntryInput } from "../../domains/session/contract.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import {
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	type ObservationReservation,
	observationBudgetExhausted,
	reserveObservation,
} from "../observation.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import { truncateHead } from "../truncate.js";
import { listDocsCorpus, searchDocs } from "./docs-engine.js";
import { contextToolSurface } from "./surface.js";

/**
 * The context tool: one OBSERVE entry point for material about the working
 * environment rather than the tree itself. scope=workspace returns the session
 * workspace snapshot, scope=docs retrieves cited sections from Clio's bundled
 * documentation, scope=skills lists available skills or loads a requested
 * skill body (the skill-activation and pending-request contracts are
 * unchanged from the absorbed read_skill tool), scope=library reads the bounded
 * body-free recipe catalog (see ./library.ts), scope=recall readmits an
 * evicted tool-result body by ref and records the `contextRecall` entry.
 */

const DEFAULT_TREE_ENTRIES = 50;

export interface ContextWorkspaceDeps {
	hasSession(): boolean;
	getSnapshot(): WorkspaceSnapshot | null;
	probeWorkspace(): WorkspaceSnapshot;
	saveSnapshot(snapshot: WorkspaceSnapshot): void;
}

/** Ledger access for scope=recall: read the full ledger, fold it at the live leaf, append the recall record. */
export interface ContextSessionDeps {
	hasSession(): boolean;
	readEntries(): ReadonlyArray<SessionEntry>;
	/** The live append point (`/tree` pin or tree leaf); undefined lets the fold infer it. */
	activeLeafTurnId(): string | undefined;
	appendEntry(entry: SessionEntryInput): SessionEntry;
	/** Called after the recall entry is recorded; the orchestrator publishes it as BusChannels.ContextRecalled. */
	onRecalled?: (payload: ContextRecalledPayload) => void;
}

export interface ContextToolDeps {
	/** Refreshes this run's native budget; absent for external/worker registries. */
	getContextBudget?: BudgetProvider;
	/** Live session view, including overrides. Omit when no authoritative settings snapshot exists. */
	getSettings?: () => Readonly<ClioSettings>;
	/** Run-scoped evidence port; never reads or appends the parent session. */
	workerRecall?: WorkerRecall;
	getCwd?: () => string;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
	/** Absent in worker registries without a session; scope=workspace errors cleanly. */
	workspace?: ContextWorkspaceDeps;
	/** Absent in worker registries without a session; scope=recall errors cleanly. */
	session?: ContextSessionDeps;
	/**
	 * Whether scope=skills may list marketplace entries beside installed
	 * skills. Worker registries set false: a worker can neither install a
	 * skill nor address the operator who could, so installable rows would only
	 * invite a load the pending-skill policy rejects. Undefined means true.
	 */
	skillMarketplace?: boolean;
	/**
	 * Per-skill relevance scores this turn's pre-turn decision pass resolved, or
	 * undefined when the `skills` site is unbound and whenever the pass produced
	 * nothing usable. This handler is synchronous, so the scores have to already
	 * exist by the time it runs; they order the listing and never shorten it.
	 */
	getSkillRelevance?: () => PrecomputedRanking | undefined;
}

function cwdFromDeps(deps?: ContextToolDeps): string {
	return deps?.getCwd?.() ?? process.cwd();
}

function buildResourceTree(baseDir: string, maxEntries: number): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		if (out.length >= maxEntries) return;
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= maxEntries) return;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(baseDir, full).split(path.sep).join("/");
			if (entry.isDirectory()) {
				out.push(`${rel}/`);
				walk(full);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	};
	walk(baseDir);
	return out;
}

function skillSourceOrigin(skill: Skill): string {
	return skill.sourceInfo.source ?? `${skill.source}-${skill.scope}`;
}

/**
 * The frame every loaded skill is read under. Skills are portable documents:
 * most were written against another harness, so they name tools and subagents
 * Clio does not have, and they live outside the project the operator is working
 * in. Both mistakes are silent and expensive, so the frame states the workspace
 * root and the substitution rule before the skill's own prose begins.
 */
function skillExecutionFrame(skill: Skill, workspaceRoot: string): string[] {
	return [
		"How to read this skill:",
		`- Workspace root: ${workspaceRoot}. Run every command and resolve every repository path there. ${skill.baseDir} holds only this skill's own resource files; it is never the working directory.`,
		"- This skill may name tools, subagents, or commands from another harness. Use Clio's equivalent from your own tool list; if there is no equivalent, say so and continue without that step. Never invent one, and never substitute repeated calls to a different agent for an agent the skill named.",
		"- The skill describes a workflow. Your safety policy, permissions, and tool surface still bind it.",
		"",
	];
}

function renderSkillBody(skill: Skill, tree: string[] | null): string {
	const sourceOrigin = skillSourceOrigin(skill);
	const lines = [
		`<skill name="${skill.name}" scope="${skill.scope}" source="${skill.source}" origin="${sourceOrigin}" hash="${skill.hash}">`,
		`path: ${skill.filePath}`,
		`base_dir: ${skill.baseDir}`,
		`source_origin: ${sourceOrigin}`,
		`disable_model_invocation: ${skill.disableModelInvocation}`,
	];
	if (skill.allowedTools) lines.push(`allowed_tools: ${skill.allowedTools.join(", ")}`);
	if (skill.disallowedTools) lines.push(`disallowed_tools: ${skill.disallowedTools.join(", ")}`);
	if (skill.diagnostics.length > 0) {
		lines.push(`diagnostics: ${skill.diagnostics.map((d) => d.message).join("; ")}`);
	}
	const metadataKeys = Object.keys(skill.metadata);
	if (metadataKeys.length > 0) lines.push(`metadata: ${metadataKeys.join(", ")}`);
	if (tree) {
		lines.push("resources:");
		for (const entry of tree) lines.push(`  ${entry}`);
	}
	lines.push("", skill.content, "</skill>");
	return lines.join("\n");
}

function policyIsRecipeBound(policy: { requests: ReadonlyArray<{ source: string }> }): boolean {
	return policy.requests.length > 0 && policy.requests.every((request) => request.source === "recipe");
}

// The denial must name the model's compliant next move, not just the gate:
// a model whose operator asked for a skill in plain language has no way to
// load it (only the operator activates), so its move is suggest-and-wait.
const NO_PENDING_SKILL_DENIAL =
	"context: no pending skill request is active this turn; only the operator can activate a skill, so do not retry this load. " +
	`If a listed skill matches the task, open your reply with the line \`${SKILL_SUGGESTION_ANCHOR}\` and continue the task without it; only the operator can run it. Otherwise continue without skills.`;

/** A policy refusal: the model-facing text and the kind the transcript states. */
interface SkillPolicyError {
	message: string;
	kind: SkillRefusalKind;
}

const operatorOnly = (): SkillPolicyError => ({ message: NO_PENDING_SKILL_DENIAL, kind: "operator-only" });

function pendingSkillPolicyError(name: string, options: ToolInvokeOptions | undefined): SkillPolicyError | null {
	const policy = options?.pendingSkillPolicy;
	if (!policy) {
		return operatorOnly();
	}
	const recipeBound = policyIsRecipeBound(policy);
	// auto-edit / full-auto: the operator already chose to let the model act
	// without being asked, and a skill only ever narrows the tool surface, so
	// the model activates an installed skill itself under the same per-run
	// policy `/skill` produces. A skill that is not installed still fails the
	// lookup below with the operator-gated marketplace message.
	if (policy.modelActivation === true && !recipeBound) {
		if (!policy.loadedSkillNames.has(name)) return null;
		const window = policy.carriedSurface === true ? "in this session" : "this turn";
		return {
			message: `context: skill ${name} already loaded ${window}; continue with the loaded workflow and call ask_user if an interview/choice is needed.`,
			kind: "already-loaded",
		};
	}
	const allowed = [...new Set(policy.allowedSkillNames.map((entry) => entry.trim()).filter(Boolean))];
	if (allowed.length === 0) {
		return operatorOnly();
	}
	if (!allowed.includes(name)) {
		if (recipeBound)
			return {
				message: `context: this agent run may load only its declared skill(s): ${allowed.join(", ")}.`,
				kind: "recipe-bound",
			};
		// A carried surface is a skill the operator activated on an earlier
		// turn, not a request waiting to be loaded now. Claiming a pending
		// request here would invite a retry of a load nothing asked for.
		if (policy.carriedSurface === true) return operatorOnly();
		return {
			message: `context: this turn has pending skill request(s): ${allowed.join(", ")}. Load only those before doing anything else.`,
			kind: "not-requested",
		};
	}
	if (policy.loadedSkillNames.has(name)) {
		if (recipeBound)
			return {
				message: `context: skill ${name} is already loaded in this run; continue with its workflow.`,
				kind: "already-loaded",
			};
		const window = policy.carriedSurface === true ? "in this session" : "this turn";
		return {
			message: `context: pending skill ${name} already loaded ${window}; continue with the loaded workflow and call ask_user if an interview/choice is needed.`,
			kind: "already-loaded",
		};
	}
	return null;
}

/**
 * A refused load as the tool returns it: the model-facing message, and the
 * structured reason the transcript states instead of that message.
 */
function skillRefusal(message: string, refusal: Omit<SkillLoadRefusal, "subject">): ToolResult {
	return { kind: "error", message, details: { refusal: { subject: "skill", ...refusal } } };
}

function pendingSkillRequestFor(name: string, options: ToolInvokeOptions | undefined) {
	return options?.pendingSkillPolicy?.requests.find((request) => request.name === name) ?? null;
}

/**
 * A hidden skill is intentionally absent from model discovery, but
 * `disable-model-invocation` still promises that the operator may activate it
 * by hand. Slash-command and selector requests are the two authenticated
 * interactive paths for that choice. Recipe and marketplace requests do not
 * widen visibility: neither proves that the operator selected an installed
 * manual-only skill for this turn.
 */
function operatorRequestedManualSkill(skill: Skill, request: ReturnType<typeof pendingSkillRequestFor>): boolean {
	return (
		skill.trusted &&
		skill.disableModelInvocation &&
		request?.installed === true &&
		(request.source === "slash-command" || request.source === "selector")
	);
}

function renderPendingSkillTask(name: string, options: ToolInvokeOptions | undefined): string[] {
	const request = pendingSkillRequestFor(name, options);
	if (!request) return [];
	// Recipe-bound loads carry no user task; the worker already has its assignment.
	if (request.source === "recipe") return [];
	const task = request.args.trim();
	const lines = [
		"Pending skill request",
		`name: ${request.name}`,
		`source: ${request.source}`,
		`task: ${task.length > 0 ? task : "(none supplied)"}`,
	];
	if (task.length > 0) {
		lines.push(
			"",
			"Treat task as the user's starting subject for this skill workflow. Do not ask what the subject is again; ask_user only for missing follow-up decisions.",
		);
	}
	lines.push("");
	return lines;
}

/**
 * Marketplace rows the listing may show. Absent for every worker registry
 * (`skillMarketplace: false`), when discovery is switched off for the run
 * (a `--no-skills` run), and for a recipe-bound policy, whose
 * context(scope=skills) admits exactly its bound names: none of these can
 * install anything, so installable rows would only invite a load the policy
 * rejects. Whatever discovery reports as broken stays out of the listing; the
 * CLI and the hub carry those diagnostics.
 */
function marketplaceRowsFor(
	deps: ContextToolDeps,
	installed: ReadonlyArray<Skill>,
	options: ToolInvokeOptions | undefined,
): MarketplaceSkill[] {
	if (deps.skillMarketplace === false) return [];
	if (deps.getSkillLoaderOptions?.().disableDiscovery === true) return [];
	const policy = options?.pendingSkillPolicy;
	if (policy && policyIsRecipeBound(policy)) return [];
	const installedNames = installedSkillNames(installed, cwdFromDeps(deps));
	try {
		return discoverMarketplaceSkills({ cwd: cwdFromDeps(deps) }).skills.filter(
			(entry) => !installedNames.has(entry.name),
		);
	} catch {
		return [];
	}
}

/**
 * Ready rows whose installed content no longer matches the hash recorded for
 * it, resolved for the whole listing in one manifest read.
 *
 * Drift used to be checked only in the activation branch below, so the listing
 * reported a drifted skill as ready with no caveat and the warning arrived only
 * after the model had already spent its turn loading it. This is the same
 * comparison, one step earlier, through the batched entry point so a listing
 * does not re-parse the pin manifest once per row.
 *
 * It annotates and nothing else. The skill stays listed, stays ready and stays
 * loadable, the installed copy keeps its ownership, and the activation warning
 * is unchanged. A skill with no recorded hash is not marked, because absence of
 * evidence is not drift, and a failure here yields an unmarked listing rather
 * than no listing.
 */
function driftedSkillNames(skills: ReadonlyArray<Skill>, cwd: string): Set<string> {
	try {
		const reports = checkSkillDriftBatch(skills, cwd);
		return new Set([...reports].filter(([, report]) => report.verdict === "mismatch").map(([name]) => name));
	} catch {
		return new Set<string>();
	}
}

function runWorkspaceScope(
	deps: ContextToolDeps,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
): ToolResult {
	const workspace = deps.workspace;
	if (!workspace?.hasSession()) {
		return { kind: "error", message: "context: workspace scope requires a bound session; none is active here" };
	}
	let snap = workspace.getSnapshot();
	if (!snap) {
		snap = workspace.probeWorkspace();
		workspace.saveSnapshot(snap);
	}
	// Orientation is where the model actually looks before multi-step work, so
	// the snapshot carries a one-line pointer at the skill catalog. Pointer
	// only: no catalog entries here, and loading stays operator-gated.
	const payload = {
		...withSkillsPointer(deps, snap),
		...(deps.getSettings
			? { configuration: 'For current autonomy, limits, and configuration guidance, call context(scope="settings").' }
			: {}),
	};
	return finalizeObservation({
		tool: ToolNames.Context,
		unit: "results",
		format: "json",
		output: JSON.stringify(payload, null, 2),
		shownCount: 1,
		totalCount: 1,
		truncated: false,
		reservation,
		...(options ? { options } : {}),
	});
}

function withSkillsPointer(deps: ContextToolDeps, snap: WorkspaceSnapshot): Record<string, unknown> {
	let installed = 0;
	let installable = 0;
	try {
		const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
		const visible = modelVisibleSkills(list.items);
		installed = visible.length;
		installable = marketplaceRowsFor(deps, visible, undefined).length;
	} catch {
		return { ...snap };
	}
	if (installed === 0 && installable === 0) return { ...snap };
	return {
		...snap,
		skills: `Skills: ${installed} available in Clio (ready workflows, not a marketplace installation count), ${installable} installable from the marketplace. If one matches this task, or the operator names a skill, list them with context(scope="skills") and suggest /skill <name> to the operator; load only on operator request.`,
	};
}

/**
 * The bundled-documentation read: a corpus listing without a query, ranked
 * sections with one. Exported for the `clio_docs` gateway capability, which
 * is this function under its own tool name; `toolName` labels the envelope
 * notice and the error prefix.
 */
export function runDocsScope(
	args: Record<string, unknown>,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
	toolName: string = ToolNames.Context,
): ToolResult {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	if (query.length === 0) {
		// No query: return the corpus listing (files + counts) the model needs to
		// pick a search term, instead of an error that wastes a round.
		const corpus = listDocsCorpus();
		if (!corpus.ok) return { kind: "error", message: `${toolName}: ${corpus.message}` };
		// Compact JSON: docs payloads charge the shared per-turn observation
		// pool, and 2-space indentation roughly doubles the bytes for zero
		// model-visible information.
		return finalizeObservation({
			tool: toolName,
			unit: "entries",
			format: "json",
			output: JSON.stringify(corpus.payload),
			shownCount: corpus.fileCount,
			totalCount: corpus.fileCount,
			truncated: false,
			reservation,
			...(options ? { options } : {}),
		});
	}
	const outcome = searchDocs(query, args.limit);
	if (!outcome.ok) return { kind: "error", message: `${toolName}: ${outcome.message}` };
	return finalizeObservation({
		tool: toolName,
		unit: "sections",
		format: "json",
		output: JSON.stringify(outcome.payload),
		shownCount: outcome.resultCount,
		totalCount: outcome.rankedTotal,
		truncated: outcome.resultCount < outcome.rankedTotal,
		...(outcome.next !== null ? { next: outcome.next } : {}),
		reservation,
		...(options ? { options } : {}),
	});
}

function runSkillsScope(
	deps: ContextToolDeps,
	args: Record<string, unknown>,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
): ToolResult {
	const name = typeof args.name === "string" ? args.name.trim() : "";
	if (name.length === 0) {
		const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
		const visible = modelVisibleSkills(list.items);
		const marketplace = marketplaceRowsFor(deps, list.items, options);
		const packages =
			deps.skillMarketplace === false || deps.getSkillLoaderOptions?.().disableDiscovery === true
				? []
				: installedSkillPackages(
						list.items,
						cwdFromDeps(deps),
						deps.getSkillLoaderOptions?.().trustProjectCompatRoots === true,
					);
		// A ranking that cannot be read is simply no ranking; the listing is the
		// model's map of its own capabilities and must render either way.
		let relevance: PrecomputedRanking | undefined;
		try {
			relevance = deps.getSkillRelevance?.();
		} catch {
			relevance = undefined;
		}
		// The catalog is bounded but not small, and it has to fit the per-call cap
		// like any observation. It is cut by whole rows with the reply protocol
		// reserved first, rather than by head-truncating the finished string:
		// head truncation keeps the head, and the tail is the one line a model
		// acts on. `query`, `limit` and `offset` are the context tool's existing
		// optional arguments, wired here so a caller can ask for less than all of
		// it; omitting them still lists every row.
		const view = buildSkillCatalogView({
			skills: visible,
			packages,
			marketplace,
			drifted: driftedSkillNames(visible, cwdFromDeps(deps)),
			marketplaceOffered: deps.skillMarketplace !== false,
			modelActivation: options?.pendingSkillPolicy?.modelActivation === true,
			query: typeof args.query === "string" ? args.query : "",
			limit: typeof args.limit === "number" ? args.limit : undefined,
			offset: typeof args.offset === "number" ? args.offset : 0,
			capBytes: reservation.callCapBytes,
			...(relevance === undefined ? {} : { relevance }),
		});
		// Shown rows are selected by the row's own stable key, not by its name. An
		// installed standalone skill has a ready row and a package row under one
		// name, and the same package id can be installed at user and project scope,
		// so a name set puts rows in `details` that the text never carried.
		const shownKeys = new Set(view.rows.map((row) => row.key));
		const shown = (kind: SkillCatalogRowKind, identity: string): boolean => shownKeys.has(`${kind}:${identity}`);
		return finalizeObservation({
			tool: ToolNames.Context,
			unit: "entries",
			output: view.text,
			shownCount: view.shown,
			totalCount: view.total,
			truncated: view.nextOffset !== undefined || view.shown < view.total,
			// Offsets index the filtered result set. A continuation carrying only
			// the offset would be applied to the unfiltered catalog, which repeats
			// rows and skips matches, so the envelope says the query is part of it.
			...(view.nextOffset !== undefined
				? {
						next: view.filtered ? `offset=${view.nextOffset} with the same query` : `offset=${view.nextOffset}`,
					}
				: {}),
			details: {
				// Rows on this page, so a caller reading `details` sees the same
				// listing the text carries. The totals beside them are how a
				// filtered or paged view is told apart from a complete one.
				skills: visible
					.filter((skill) => shown("ready", skill.filePath) || shown("session", skill.filePath))
					.map((skill) => ({
						name: skill.name,
						scope: skill.scope,
						source: skill.source,
						path: skill.filePath,
						...(view.driftedNames.includes(skill.name) ? { drift: "mismatch" } : {}),
					})),
				installedPackages: packages.filter((pkg) => shown("package", `${pkg.scope}:${pkg.path}`)),
				marketplace: marketplace
					.filter((entry) => shown("marketplace", entry.sourceUrl))
					.map((entry) => ({
						name: entry.name,
						...(entry.category ? { category: entry.category } : {}),
					})),
				totalSkills: visible.length,
				totalPackages: packages.length,
				totalMarketplace: marketplace.length,
				...(view.filtered ? { query: (args.query as string).trim(), matchMode: view.matchMode } : {}),
				...(view.driftedNames.length > 0 ? { drifted: view.driftedNames } : {}),
			},
			reservation,
			...(options ? { options } : {}),
		});
	}
	const policyError = pendingSkillPolicyError(name, options);
	if (policyError) return skillRefusal(policyError.message, { name, kind: policyError.kind });
	const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
	const visible = modelVisibleSkills(list.items);
	const pendingRequest = pendingSkillRequestFor(name, options);
	const skill =
		visible.find((item) => item.name === name) ??
		list.items.find((item) => item.name === name && operatorRequestedManualSkill(item, pendingRequest));
	if (!skill) {
		if (deps.skillMarketplace !== false && deps.getSkillLoaderOptions?.().disableDiscovery !== true) {
			const installed = installedSkillPackages(
				list.items,
				cwdFromDeps(deps),
				deps.getSkillLoaderOptions?.().trustProjectCompatRoots === true,
			).find((pkg) => pkg.names.includes(name));
			if (installed && installed.state !== "ready")
				return skillRefusal(
					`context: skill "${name}" is installed in ${installed.scope} scope but ${installed.state}. Inspect it in /library; do not reinstall it.`,
					{ name, kind: "not-ready", scope: installed.scope, state: installed.state },
				);
		}
		const unavailable = list.items.find((item) => item.name === name);
		if (unavailable) {
			if (unavailable.trusted)
				return skillRefusal(
					`context: skill "${name}" requires explicit operator activation with /skill ${name}; it disables model invocation. Do not retry this load.`,
					{ name, kind: "manual-only" },
				);
			if (unavailable.source === "plugin")
				return skillRefusal(
					`context: skill "${name}" is imported but untrusted. Review it in /library, then enable integrations.projectResources.trustProjectImports to use it. Do not retry this load.`,
					{ name, kind: "untrusted" },
				);
			return skillRefusal(
				`context: skill "${name}" is discovered in ${unavailable.source}/${unavailable.scope}, not imported into Clio. Use interop adopt or library import explicitly; the trust setting alone does not activate it. Do not retry this load.`,
				{ name, kind: "not-imported", source: unavailable.source, scope: unavailable.scope },
			);
		}

		// A marketplace entry is a skill that exists and is not installed. Saying
		// "unknown skill" about it denies the operator a thing the listing just
		// offered; name the state and the one move that changes it.
		const installable = marketplaceRowsFor(deps, list.items, options).some((entry) => entry.name === name);
		if (installable) {
			return skillRefusal(
				`context: skill "${name}" is not installed; it is available in the marketplace. If installation has not been declined, offer /skill ${name} to install it. If the operator chose Not now or Cancel, continue without this skill and do not offer it again. Do not retry this load.`,
				{ name, kind: "not-installed" },
			);
		}
		const available = visible.map((item) => item.name).join(", ");
		const suffix = available.length > 0 ? ` Available skills: ${available}.` : " No skills are currently available.";
		return skillRefusal(`context: unknown skill "${name}".${suffix}`, { name, kind: "unknown" });
	}
	const includeTree = args.include_tree === true;
	const tree = includeTree ? buildResourceTree(skill.baseDir, DEFAULT_TREE_ENTRIES) : null;
	const pendingTask = pendingRequest?.args.trim() ?? "";
	// Provenance: the activated content is compared against whatever recorded
	// hash can speak for it, the audited catalog's pinned manifest or the
	// skill's own install record. A mismatch annotates the result and is
	// recorded with the activation; it never blocks, the normal tool safety
	// gates still govern whatever the skill asks for.
	const driftReport = checkSkillDrift(skill, cwdFromDeps(deps));
	const drift = driftReport?.verdict ?? null;
	// A normal skill id can be copied into a command; unusual frontmatter names
	// remain a placeholder so model-facing guidance cannot become shell syntax.
	const reviewName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(skill.name) ? skill.name : "<name>";
	const driftWarning =
		driftReport?.verdict === "mismatch"
			? `WARNING skill_drift: ${driftReport.authority === "pinned-manifest" ? "catalog" : "install-record"} sha256=${driftReport.expected} installed normalized sha256=${skill.normalizedHash}. Review the body-free owner with clio-coder library recipes ${reviewName} --kind skill --json; if managed, preview clio-coder library update <owner-ref> --dry-run --json with --user or --project for that copy before replacing local changes. A loose skill has no Library update target.`
			: null;
	const body = [
		...(driftWarning !== null ? [driftWarning] : []),
		...renderPendingSkillTask(name, options),
		...skillExecutionFrame(skill, cwdFromDeps(deps)),
		renderSkillBody(skill, tree),
	].join("\n");
	const pendingPolicy = options?.pendingSkillPolicy;
	if (pendingPolicy) {
		pendingPolicy.loadedSkillNames.add(name);
		pendingPolicy.loadedSkillPolicies.set(name, {
			...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
			...(skill.disallowedTools ? { disallowedTools: skill.disallowedTools } : {}),
		});
	}
	const truncation = truncateHead(body, { maxBytes: reservation.callCapBytes, maxLines: Number.MAX_SAFE_INTEGER });
	return finalizeObservation({
		tool: ToolNames.Context,
		unit: "sections",
		output: truncation.content,
		...(truncation.truncated ? { fullOutput: body } : {}),
		shownCount: 1,
		totalCount: 1,
		truncated: truncation.truncated,
		details: {
			name: skill.name,
			description: skill.description,
			// Who asked for this load: a pending operator request (`/skill`, the
			// selector, a marketplace install), the recipe a worker is bound to, or
			// the model under model activation. The transcript row states it.
			activation: pendingRequest === null ? "model" : pendingRequest.source === "recipe" ? "recipe" : "operator",
			...(pendingTask.length > 0 ? { pendingTask } : {}),
			path: skill.filePath,
			baseDir: skill.baseDir,
			hash: skill.hash,
			source: skill.source,
			sourceOrigin: skillSourceOrigin(skill),
			sourceInfo: skill.sourceInfo,
			scope: skill.scope,
			disableModelInvocation: skill.disableModelInvocation,
			...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
			...(skill.disallowedTools ? { disallowedTools: skill.disallowedTools } : {}),
			...(pendingPolicy?.allowListAdvisory === true ? { allowListAdvisory: true } : {}),
			diagnostics: skill.diagnostics.map((d) => d.message),
			metadata: skill.metadata,
			...(skill.provenance ? { provenance: skill.provenance } : {}),
			...(drift !== null ? { drift } : {}),
			...(driftReport?.verdict === "mismatch"
				? { driftExpectedHash: driftReport.expected, driftInstalledHash: skill.normalizedHash }
				: {}),
			...(tree ? { tree } : {}),
		},
		reservation,
		...(options ? { options } : {}),
	});
}

/**
 * scope=recall: the body goes back through the observation envelope like any
 * OBSERVE result, so the per-turn pool and the self cap still apply; an
 * oversize body is offloaded by the envelope and the notice carries the
 * pointer. A body whose original result was itself offloaded already ends in
 * that tool's own `full: <path>` pointer, which is what the model gets back;
 * the file is never inlined. The `contextRecall` entry is appended before the
 * result returns; it is the churn record, not an un-eviction, so the marker
 * and the prefix cache stay where they are.
 */
function runRecallScope(
	deps: ContextToolDeps,
	args: Record<string, unknown>,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
): ToolResult {
	if (deps.workerRecall) {
		const result = deps.workerRecall(args);
		if ("error" in result) return { kind: "error", message: `context: ${result.error}` };
		const truncated = truncateHead(result.body, {
			maxBytes: reservation.callCapBytes,
			maxLines: Number.MAX_SAFE_INTEGER,
		});
		return finalizeObservation({
			tool: ToolNames.Context,
			unit: "results",
			output: truncated.content,
			...(truncated.truncated ? { fullOutput: result.body } : {}),
			shownCount: result.shown,
			totalCount: result.total,
			truncated: truncated.truncated || result.nextOffset !== undefined,
			details: { workerRecall: { ref: args.ref ?? null, nextOffset: result.nextOffset ?? null } },
			reservation,
			...(options ? { options } : {}),
		});
	}
	const session = deps.session;
	if (!session?.hasSession()) {
		return { kind: "error", message: "context: recall scope requires a bound session; none is active here" };
	}
	const ref = typeof args.ref === "string" ? args.ref.trim() : "";
	const entries = session.readEntries();
	const leaf = session.activeLeafTurnId();
	const view = foldWorkingSet(entries, leaf);
	if (args.ref === undefined) {
		const listing = recallableRefListing(entries, view, {
			...(leaf === undefined ? {} : { activeLeafTurnId: leaf }),
			...(typeof args.query === "string" ? { query: args.query } : {}),
			...(typeof args.limit === "number" ? { limit: args.limit } : {}),
			...(typeof args.offset === "number" ? { offset: args.offset } : {}),
		});
		const output = [
			...listing.refs,
			listing.nextOffset === undefined
				? "End of matching recallable refs."
				: `More matches: repeat this query with offset=${listing.nextOffset}.`,
			'Recall an exact persisted body with context(scope="recall", ref="<turnId>").',
		].join("\n");
		const truncation = truncateHead(output, { maxBytes: reservation.callCapBytes, maxLines: Number.MAX_SAFE_INTEGER });
		return finalizeObservation({
			tool: ToolNames.Context,
			unit: "results",
			output: truncation.content,
			...(truncation.truncated ? { fullOutput: output } : {}),
			shownCount: listing.refs.length,
			totalCount: listing.total,
			truncated: truncation.truncated || listing.remaining > 0,
			details: { recallDiscovery: listing },
			reservation,
			...(options ? { options } : {}),
		});
	}
	const resolved = resolveRecall(entries, view, ref, leaf);
	if (!resolved.ok)
		return { kind: "error", message: `context: ${recallErrorMessage(resolved.error, entries, view, leaf)}` };
	const { result } = resolved;
	const fields = buildRecallFields(result, {
		trigger: "tool",
		...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}),
	});
	// The recall record parents onto the live leaf so the fold sees it on
	// this branch and only this branch.
	const parentTurnId = recallParentTurnId(entries, leaf);
	let recorded: SessionEntry;
	try {
		recorded = session.appendEntry({ ...fields, parentTurnId });
	} catch (err) {
		return {
			kind: "error",
			message: `context: recall of ${result.ref.entry} could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	session.onRecalled?.({ ref: result.ref.entry, trigger: "tool", tokensReadmitted: result.tokens, at: Date.now() });
	const evictedState = view.evicted.get(result.ref.entry);
	const truncation = truncateHead(result.body, {
		maxBytes: reservation.callCapBytes,
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	return finalizeObservation({
		tool: ToolNames.Context,
		unit: "results",
		output: truncation.content,
		...(truncation.truncated ? { fullOutput: result.body } : {}),
		shownCount: 1,
		totalCount: 1,
		truncated: truncation.truncated,
		details: {
			recall: {
				ref: result.ref.entry,
				state: result.state,
				tokensReadmitted: result.tokens,
				recallTurnId: recorded.turnId,
				...(evictedState ? { reason: evictedState.reason, evictedAtTurnId: evictedState.evictedAtTurnId } : {}),
				...(result.offloadPath !== undefined ? { offloadPath: result.offloadPath } : {}),
			},
		},
		reservation,
		...(options ? { options } : {}),
	});
}

/** A byte-fitted JSON observation. Inspection never spills to disk. */
function runBudgetScope(
	deps: ContextToolDeps,
	reservation: ObservationReservation,
	options?: ToolInvokeOptions,
): ToolResult {
	const inspection = deps.getContextBudget?.() ?? {
		status: "unavailable",
		reason:
			"This run has no native session budget port. Worker and external-agent budgets are not the parent session's budget.",
	};
	const payload =
		inspection.status === "available"
			? {
					...inspection,
					mode: "enforced",
					admissionNote:
						"Submission and continuation enforce input plus reserved output against the effective window. Counts are estimates unless provider-attested; pressure advice remains advisory.",
				}
			: inspection;
	const full = JSON.stringify(payload);
	const fits = Buffer.byteLength(full, "utf8") <= reservation.callCapBytes;
	// Do not pass fullOutput to finalizeObservation: an inspection must not
	// persist its view even when an optional projection contains huge text.
	const output = fits
		? full
		: JSON.stringify({
				status: "unavailable",
				reason: "observation-limit",
				message:
					"The budget view exceeds the available observation bytes. Continue in a follow-up turn; do not retry this turn.",
			});
	return finalizeObservation({
		tool: ToolNames.Context,
		unit: "results",
		format: "json",
		output,
		shownCount: fits ? 1 : 0,
		totalCount: 1,
		totalBytes: Buffer.byteLength(full, "utf8"),
		truncated: !fits,
		reservation,
		...(options ? { options } : {}),
	});
}

export function createContextTool(deps: ContextToolDeps = {}): ToolSpec {
	return {
		...contextToolSurface,
		async run(args, options): Promise<ToolResult> {
			const scope = typeof args.scope === "string" ? args.scope : "";
			if (scope === "docs" || scope === "library") {
				// The two secondary reads moved behind the gateway. Name the exact
				// replacement so a model that learned the old scope recovers in one
				// step instead of retrying the same shape.
				const capability = scope === "docs" ? ToolNames.ClioDocs : ToolNames.ClioLibrary;
				return {
					kind: "error",
					message: `context: scope "${scope}" is a gateway capability now: call gateway(op="call", capability="${capability}", args={...}) or gateway(op="describe", capability="${capability}") for its arguments.`,
				};
			}
			if (
				scope !== "workspace" &&
				scope !== "settings" &&
				scope !== "skills" &&
				scope !== "recall" &&
				scope !== "budget"
			) {
				return {
					kind: "error",
					message: `context: scope must be workspace, settings, skills, recall, or budget; got '${scope}'`,
				};
			}
			if (scope === "budget" && Object.keys(args).some((key) => key !== "scope")) {
				return { kind: "error", message: 'context: scope="budget" accepts only scope; it inspects the current request.' };
			}
			const selfCap = scope === "skills" ? OBSERVE_SELF_CAPS.contextSkills : OBSERVE_SELF_CAPS.contextWorkspace;
			// Reserved before any scope handler runs, so an exhausted pool answers
			// with the notice and no scope does its work for nothing.
			const reservation = reserveObservation(selfCap, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.Context,
					unit: scope === "skills" ? "entries" : "results",
					...(scope === "budget" ? { format: "json" as const } : {}),
					reservation,
					subject: `scope=${scope}`,
					hint: "Continue in a follow-up turn.",
				});
			}
			if (scope === "settings") {
				if (!deps.getSettings)
					return {
						kind: "error",
						message:
							"An authoritative live settings snapshot is unavailable in this run. Ask the user to open /settings or run clio-coder config inspect; do not infer current limits from defaults.",
					};
				const offset = args.offset === undefined ? 0 : args.offset;
				const limit = args.limit === undefined ? 12 : args.limit;
				if (
					typeof offset !== "number" ||
					!Number.isSafeInteger(offset) ||
					offset < 0 ||
					typeof limit !== "number" ||
					!Number.isSafeInteger(limit) ||
					limit < 1 ||
					limit > 12
				)
					return { kind: "error", message: "Use a non-negative integer offset and a limit from 1 to 12." };
				const snapshot = settingsAwareness(
					deps.getSettings(),
					typeof args.query === "string" ? args.query : "",
					offset,
					limit,
				);
				return finalizeObservation({
					tool: ToolNames.Context,
					unit: "entries",
					format: "json",
					output: JSON.stringify(snapshot, null, 2),
					shownCount: snapshot.rows.length,
					totalCount: snapshot.total,
					truncated: snapshot.nextOffset !== null,
					reservation,
					...(options ? { options } : {}),
				});
			}
			if (scope === "budget") return runBudgetScope(deps, reservation, options);
			// Both scopes read the skill catalog and installed packages several
			// times; one discovery pass verifies each plugin tree once for all of it.
			if (scope === "workspace") return withPluginDiscoveryPass(() => runWorkspaceScope(deps, reservation, options));
			if (scope === "recall") return runRecallScope(deps, args, reservation, options);
			return withPluginDiscoveryPass(() => runSkillsScope(deps, args, reservation, options));
		},
	};
}
