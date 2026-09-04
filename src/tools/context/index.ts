import { type Dirent, readdirSync } from "node:fs";
import path from "node:path";
import type { ContextRecalledPayload } from "../../core/bus-events.js";
import {
	SKILL_INSTALL_OFFER_OPTION_NEVER,
	SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
	SKILL_INSTALL_OFFER_OPTION_PROJECT,
	SKILL_INSTALL_OFFER_OPTION_USER,
	SKILL_SUGGESTION_ANCHOR,
} from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import { foldWorkingSet } from "../../domains/context/working-set/fold.js";
import {
	buildRecallFields,
	recallErrorMessage,
	recallParentTurnId,
	resolveRecall,
} from "../../domains/context/working-set/recall.js";
import {
	checkSkillDrift,
	discoverMarketplaceSkills,
	type LoadSkillsInput,
	loadSkills,
	type MarketplaceSkill,
	modelVisibleSkills,
	type Skill,
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
 * unchanged from the absorbed read_skill tool), scope=recall readmits an
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

function pendingSkillPolicyError(name: string, options: ToolInvokeOptions | undefined): string | null {
	const policy = options?.pendingSkillPolicy;
	if (!policy) {
		return NO_PENDING_SKILL_DENIAL;
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
		return `context: skill ${name} already loaded ${window}; continue with the loaded workflow and call ask_user if an interview/choice is needed.`;
	}
	const allowed = [...new Set(policy.allowedSkillNames.map((entry) => entry.trim()).filter(Boolean))];
	if (allowed.length === 0) {
		return NO_PENDING_SKILL_DENIAL;
	}
	if (!allowed.includes(name)) {
		if (recipeBound) return `context: this agent run may load only its declared skill(s): ${allowed.join(", ")}.`;
		// A carried surface is a skill the operator activated on an earlier
		// turn, not a request waiting to be loaded now. Claiming a pending
		// request here would invite a retry of a load nothing asked for.
		if (policy.carriedSurface === true) return NO_PENDING_SKILL_DENIAL;
		return `context: this turn has pending skill request(s): ${allowed.join(", ")}. Load only those before doing anything else.`;
	}
	if (policy.loadedSkillNames.has(name)) {
		if (recipeBound) return `context: skill ${name} is already loaded in this run; continue with its workflow.`;
		const window = policy.carriedSurface === true ? "in this session" : "this turn";
		return `context: pending skill ${name} already loaded ${window}; continue with the loaded workflow and call ask_user if an interview/choice is needed.`;
	}
	return null;
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
	const installedNames = new Set(installed.map((skill) => skill.name));
	try {
		return discoverMarketplaceSkills({ cwd: cwdFromDeps(deps) }).skills.filter(
			(entry) => !installedNames.has(entry.name),
		);
	} catch {
		return [];
	}
}

function renderSkillsList(
	skills: ReadonlyArray<Skill>,
	marketplace: ReadonlyArray<MarketplaceSkill>,
	marketplaceOffered: boolean,
	modelActivation: boolean,
): string {
	if (skills.length === 0 && marketplace.length === 0) {
		// A registry that never offers the marketplace (a worker) must not
		// claim none is configured; it simply has nothing to list.
		return marketplaceOffered ? "No skills are installed and no marketplace is configured." : "No skills are installed.";
	}
	// The header names the listing and nothing more. The reply protocol is
	// stated once, as the recency anchor at the bottom, because that is the
	// line literal models act on; a second copy up here cost every listing
	// call the same sentences again.
	const lines = ["Available skills.", ""];
	if (skills.length > 0) {
		lines.push("Installed:");
		for (const skill of skills) {
			lines.push(`- ${skill.name} (${skill.scope}): ${skill.description}`);
		}
	} else {
		lines.push("Installed: none.");
	}
	if (marketplace.length > 0) {
		// Installable rows are suggested exactly like installed ones: the
		// operator's /skill <name> prompts to install before it runs, so the
		// model's move is the same suggest-and-wait. Only the body is out of
		// reach until then, which is why the description is all that appears.
		lines.push("", "Marketplace (not installed; /skill <name> offers to install):");
		for (const entry of marketplace) {
			const category = entry.category ? ` [${entry.category}]` : "";
			lines.push(`- ${entry.name}${category}: ${entry.description}`);
		}
	}
	// Recency anchor with an exact reply shape: literal models act on an output
	// template where they skip conditional prose in the header.
	lines.push(
		"",
		modelActivation
			? `If one skill above matches the current task, load it now with context(scope="skills", name="<name>") and continue in the same turn; at this autonomy level you activate installed skills yourself and do not wait for the operator. Marketplace rows below are not installed and still need the operator. If none match, do not mention skills.`
			: `If one skill above matches the current task, begin your reply with the line \`${SKILL_SUGGESTION_ANCHOR}\` (a comma-separated sequence, in order, when several compose), then continue the task in the same turn without it; only the operator can run it. If none match, do not mention skills.`,
	);
	if (marketplace.length > 0) {
		// The offer protocol mirrors the marketplace-offer middleware: fixed
		// option labels so the harness recognizes the answer, and the model
		// never performs an install itself.
		lines.push(
			`When no installed skill serves the task but a marketplace skill above genuinely does, you may instead ask the operator with ask_user (mode=single_question, header "Install skill") whether to install it, offering exactly: "${SKILL_INSTALL_OFFER_OPTION_PROJECT}", "${SKILL_INSTALL_OFFER_OPTION_USER}", "${SKILL_INSTALL_OFFER_OPTION_NOT_NOW}", "${SKILL_INSTALL_OFFER_OPTION_NEVER}". The harness handles the answer and any install; never install or load a skill yourself.`,
		);
	}
	return lines.join("\n");
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
	const payload = withSkillsPointer(deps, snap);
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
		skills: `Skills: ${installed} installed, ${installable} installable from the marketplace. If one matches this task, or the operator names a skill, list them with context(scope="skills") and suggest /skill <name> to the operator; load only on operator request.`,
	};
}

function runDocsScope(
	args: Record<string, unknown>,
	reservation: ObservationReservation,
	options: ToolInvokeOptions | undefined,
): ToolResult {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	if (query.length === 0) {
		// No query: return the corpus listing (files + counts) the model needs to
		// pick a search term, instead of an error that wastes a round.
		const corpus = listDocsCorpus();
		if (!corpus.ok) return { kind: "error", message: `context: ${corpus.message}` };
		// Compact JSON: docs payloads charge the shared per-turn observation
		// pool, and 2-space indentation roughly doubles the bytes for zero
		// model-visible information.
		return finalizeObservation({
			tool: ToolNames.Context,
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
	if (!outcome.ok) return { kind: "error", message: `context: ${outcome.message}` };
	return finalizeObservation({
		tool: ToolNames.Context,
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
		const rendered = renderSkillsList(
			visible,
			marketplace,
			deps.skillMarketplace !== false,
			options?.pendingSkillPolicy?.modelActivation === true,
		);
		// The catalog is bounded but not small: the whole listing must fit the
		// per-call cap like any observation, and a cut list says so instead of
		// silently dropping the marketplace tail.
		const truncation = truncateHead(rendered, { maxBytes: reservation.callCapBytes, maxLines: Number.MAX_SAFE_INTEGER });
		const total = visible.length + marketplace.length;
		return finalizeObservation({
			tool: ToolNames.Context,
			unit: "entries",
			output: truncation.content,
			...(truncation.truncated ? { fullOutput: rendered } : {}),
			shownCount: total,
			totalCount: total,
			truncated: truncation.truncated,
			details: {
				skills: visible.map((skill) => ({ name: skill.name, scope: skill.scope })),
				marketplace: marketplace.map((entry) => ({
					name: entry.name,
					...(entry.category ? { category: entry.category } : {}),
				})),
			},
			reservation,
			...(options ? { options } : {}),
		});
	}
	const policyError = pendingSkillPolicyError(name, options);
	if (policyError) return { kind: "error", message: policyError };
	const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
	const visible = modelVisibleSkills(list.items);
	const pendingRequest = pendingSkillRequestFor(name, options);
	const skill =
		visible.find((item) => item.name === name) ??
		list.items.find((item) => item.name === name && operatorRequestedManualSkill(item, pendingRequest));
	if (!skill) {
		// A marketplace entry is a skill that exists and is not installed. Saying
		// "unknown skill" about it denies the operator a thing the listing just
		// offered; name the state and the one move that changes it.
		const installable = marketplaceRowsFor(deps, list.items, options).some((entry) => entry.name === name);
		if (installable) {
			return {
				kind: "error",
				message: `context: skill "${name}" is not installed; it is available in the marketplace. Ask the operator to run /skill ${name}, which offers to install it, and wait. Do not retry this load.`,
			};
		}
		const available = visible.map((item) => item.name).join(", ");
		const suffix = available.length > 0 ? ` Available skills: ${available}.` : " No skills are currently available.";
		return { kind: "error", message: `context: unknown skill "${name}".${suffix}` };
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
	const driftWarning =
		driftReport?.verdict === "mismatch"
			? `WARNING skill_drift: '${skill.name}' content (sha256 ${skill.hash.slice(0, 12)}…) no longer matches the hash recorded for it ${
					driftReport.authority === "pinned-manifest"
						? "in the audited skill catalog"
						: "when it was installed on this machine"
				} (expected ${driftReport.expected.slice(0, 12)}…); the installed skill drifted from the content it claims to be.`
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
			diagnostics: skill.diagnostics.map((d) => d.message),
			metadata: skill.metadata,
			...(skill.provenance ? { provenance: skill.provenance } : {}),
			...(drift !== null ? { drift } : {}),
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
	const session = deps.session;
	if (!session?.hasSession()) {
		return { kind: "error", message: "context: recall scope requires a bound session; none is active here" };
	}
	const ref = typeof args.ref === "string" ? args.ref.trim() : "";
	if (ref.length === 0) {
		return {
			kind: "error",
			message: "context: recall scope requires ref=<turnId>, the ref named in the [evicted ...] marker",
		};
	}
	const entries = session.readEntries();
	const leaf = session.activeLeafTurnId();
	const view = foldWorkingSet(entries, leaf);
	const resolved = resolveRecall(entries, view, ref, leaf);
	if (!resolved.ok) return { kind: "error", message: `context: ${recallErrorMessage(resolved.error, entries, view)}` };
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

export function createContextTool(deps: ContextToolDeps = {}): ToolSpec {
	return {
		...contextToolSurface,
		async run(args, options): Promise<ToolResult> {
			const scope = typeof args.scope === "string" ? args.scope : "";
			if (scope !== "workspace" && scope !== "docs" && scope !== "skills" && scope !== "recall") {
				return { kind: "error", message: `context: scope must be workspace, docs, skills, or recall; got '${scope}'` };
			}
			const selfCap =
				scope === "docs"
					? OBSERVE_SELF_CAPS.contextDocs
					: scope === "skills"
						? OBSERVE_SELF_CAPS.contextSkills
						: OBSERVE_SELF_CAPS.contextWorkspace;
			const reservation = reserveObservation(selfCap, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.Context,
					unit: scope === "docs" ? "sections" : scope === "skills" ? "entries" : "results",
					reservation,
					subject: `scope=${scope}`,
					hint: "Continue in a follow-up turn.",
				});
			}
			if (scope === "workspace") return runWorkspaceScope(deps, reservation, options);
			if (scope === "docs") return runDocsScope(args, reservation, options);
			if (scope === "recall") return runRecallScope(deps, args, reservation, options);
			return runSkillsScope(deps, args, reservation, options);
		},
	};
}
