import { type Dirent, readdirSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { SKILL_SUGGESTION_ANCHOR } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import {
	checkSkillDrift,
	type LoadSkillsInput,
	loadSkills,
	modelVisibleSkills,
	type Skill,
} from "../../domains/resources/index.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import {
	finalizeObservation,
	OBSERVE_SELF_CAPS,
	type ObservationReservation,
	observationBudgetExhausted,
	reserveObservation,
} from "../observation.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "../registry.js";
import { stringEnum } from "../string-enum.js";
import { truncateHead } from "../truncate.js";
import { listDocsCorpus, searchDocs } from "./docs-engine.js";

/**
 * The context tool: one OBSERVE entry point for material about the working
 * environment rather than the tree itself. scope=workspace returns the session
 * workspace snapshot, scope=docs retrieves cited sections from Clio's bundled
 * documentation, scope=skills lists available skills or loads a requested
 * skill body (the skill-activation and pending-request contracts are
 * unchanged from the absorbed read_skill tool).
 */

const DEFAULT_TREE_ENTRIES = 50;

export interface ContextWorkspaceDeps {
	hasSession(): boolean;
	getSnapshot(): WorkspaceSnapshot | null;
	probeWorkspace(): WorkspaceSnapshot;
	saveSnapshot(snapshot: WorkspaceSnapshot): void;
}

export interface ContextToolDeps {
	getCwd?: () => string;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
	/** Absent in worker registries without a session; scope=workspace errors cleanly. */
	workspace?: ContextWorkspaceDeps;
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
	`If a listed skill matches the task, open your reply with the line \`${SKILL_SUGGESTION_ANCHOR}\` and wait for the operator to run it; otherwise continue without skills.`;

function pendingSkillPolicyError(name: string, options: ToolInvokeOptions | undefined): string | null {
	const policy = options?.pendingSkillPolicy;
	if (!policy) {
		return NO_PENDING_SKILL_DENIAL;
	}
	const allowed = [...new Set(policy.allowedSkillNames.map((entry) => entry.trim()).filter(Boolean))];
	if (allowed.length === 0) {
		return NO_PENDING_SKILL_DENIAL;
	}
	const recipeBound = policyIsRecipeBound(policy);
	if (!allowed.includes(name)) {
		return recipeBound
			? `context: this agent run may load only its declared skill(s): ${allowed.join(", ")}.`
			: `context: this turn has pending skill request(s): ${allowed.join(", ")}. Load only those before doing anything else.`;
	}
	if (policy.loadedSkillNames.has(name)) {
		return recipeBound
			? `context: skill ${name} is already loaded in this run; continue with its workflow.`
			: `context: pending skill ${name} already loaded this turn; continue with the loaded workflow and call ask_user if an interview/choice is needed.`;
	}
	return null;
}

function pendingSkillRequestFor(name: string, options: ToolInvokeOptions | undefined) {
	return options?.pendingSkillPolicy?.requests.find((request) => request.name === name) ?? null;
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

function renderSkillsList(skills: ReadonlyArray<Skill>): string {
	if (skills.length === 0) return "No skills are installed.";
	const lines = [
		"Available skills. Match the current task against the descriptions below: when one fits, suggest the operator run /skill:<name>; when several compose, suggest the sequence in order. Skill bodies load only after an explicit operator request; never load one without it.",
		"",
	];
	for (const skill of skills) {
		lines.push(`- ${skill.name} (${skill.scope}): ${skill.description}`);
	}
	// Recency anchor with an exact reply shape: literal models act on an output
	// template where they skip conditional prose in the header.
	lines.push(
		"",
		`If one skill above matches the current task, begin your reply with the line \`${SKILL_SUGGESTION_ANCHOR}\` (a comma-separated sequence, in order, when several compose) and wait for the operator to run it. If none match, do not mention skills.`,
	);
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
	let count = 0;
	try {
		const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
		count = modelVisibleSkills(list.items).length;
	} catch {
		return { ...snap };
	}
	if (count === 0) return { ...snap };
	return {
		...snap,
		skills: `Installed skills: ${count}. If one matches this task, list them with context(scope="skills") and suggest /skill:<name> to the operator; load only on operator request.`,
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
		return finalizeObservation({
			tool: ToolNames.Context,
			unit: "entries",
			output: renderSkillsList(visible),
			shownCount: visible.length,
			totalCount: visible.length,
			truncated: false,
			details: { skills: visible.map((skill) => ({ name: skill.name, scope: skill.scope })) },
			reservation,
			...(options ? { options } : {}),
		});
	}
	const policyError = pendingSkillPolicyError(name, options);
	if (policyError) return { kind: "error", message: policyError };
	const list = loadSkills({ cwd: cwdFromDeps(deps), ...(deps.getSkillLoaderOptions?.() ?? {}) });
	const visible = modelVisibleSkills(list.items);
	const skill = visible.find((item) => item.name === name);
	if (!skill) {
		const available = visible.map((item) => item.name).join(", ");
		const suffix = available.length > 0 ? ` Available skills: ${available}.` : " No skills are currently available.";
		return { kind: "error", message: `context: unknown skill "${name}".${suffix}` };
	}
	const includeTree = args.include_tree === true;
	const tree = includeTree ? buildResourceTree(skill.baseDir, DEFAULT_TREE_ENTRIES) : null;
	const pendingRequest = pendingSkillRequestFor(name, options);
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

export function createContextTool(deps: ContextToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.Context,
		description:
			"Environment context: scope=workspace returns the git/project snapshot, scope=docs searches Clio's bundled documentation (omit query to list the corpus), scope=skills lists available skills or loads one by name. For repository code and the repo's generated wiki use code_nav (mode=wiki).",
		parameters: Type.Object({
			scope: stringEnum(["workspace", "docs", "skills"], "Context source."),
			query: Type.Optional(Type.String({ description: "scope=docs: question or terms; omit to list the corpus." })),
			name: Type.Optional(Type.String({ description: "scope=skills: skill name to load; omit to list." })),
			limit: Type.Optional(Type.Number({ description: "scope=docs: max sections (default 5, max 12)." })),
			include_tree: Type.Optional(Type.Boolean({ description: "scope=skills: list files under the skill base_dir." })),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const scope = typeof args.scope === "string" ? args.scope : "";
			if (scope !== "workspace" && scope !== "docs" && scope !== "skills") {
				return { kind: "error", message: `context: scope must be workspace, docs, or skills; got '${scope}'` };
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
			return runSkillsScope(deps, args, reservation, options);
		},
	};
}
