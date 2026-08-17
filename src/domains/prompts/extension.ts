import { isAbsolute, relative } from "node:path";
import { BusChannels } from "../../core/bus-events.js";
import { detectClioCoderRepo } from "../../core/clio-repo.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { renderFleetPromptSection } from "../agents/catalog.js";
import type { AgentsContract } from "../agents/contract.js";
import type { ConfigContract } from "../config/contract.js";
import {
	type ContextContract,
	loadOperatorProfile,
	loadProjectRules,
	type ProjectPromptContext,
	renderOperatorProfile,
	selectActiveRules,
} from "../context/index.js";
import { compile, compileWorker, type RenderedPromptFragment } from "./compiler.js";
import type { CompileSessionPromptInput, CompileWorkerPromptInput, PromptsContract } from "./contract.js";
import { type FragmentTable, loadFragments } from "./fragment-loader.js";
import { sha256 } from "./hash.js";
import { classifyProjectPreload, type ProjectPreloadClass } from "./preload.js";

export interface PromptsBundleOptions {
	/** When true, the dynamic context.files fragment renders the empty string. */
	noContextFiles?: boolean;
}

const CLIO_REPO_AWARENESS_ID = "context.clio-repo-awareness";
const WORKSPACE_ROOT_ID = "context.workspace-root";

export function createPromptsBundle(
	context: DomainContext,
	options: PromptsBundleOptions = {},
): DomainBundle<PromptsContract> {
	let table: FragmentTable | null = null;
	const suppressContextFiles = options.noContextFiles === true;

	function config(): ConfigContract | undefined {
		return context.getContract<ConfigContract>("config");
	}

	function contextDomain(): ContextContract | undefined {
		return context.getContract<ContextContract>("context");
	}

	function agentsDomain(): AgentsContract | undefined {
		return context.getContract<AgentsContract>("agents");
	}

	/**
	 * The roster is compiled into the prompt, so a session that starts before
	 * the agents domain is available renders no Fleet section rather than a
	 * partial one that would churn the prompt prefix on the next compile.
	 */
	function fleetRoster(): string {
		const specs = agentsDomain()?.listSpecs() ?? [];
		return specs.length > 0 ? renderFleetPromptSection(specs) : "";
	}

	function reload(): void {
		try {
			table = loadFragments();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[clio:prompts] reload failed: ${msg}\n`);
		}
	}

	function diffTouchesFragments(paths: ReadonlyArray<string>): boolean {
		for (const p of paths) {
			if (p.includes("prompt") || p.includes("fragment")) return true;
		}
		return false;
	}

	const contract: PromptsContract = {
		async compileSessionPrompt(input: CompileSessionPromptInput) {
			if (!table) throw new Error("prompts domain not started");
			if (table.byId.size === 0) {
				throw new Error("prompts: no fragments loaded, check startup logs");
			}
			const configContract = config();
			const settings: Readonly<ClioSettings> | undefined = configContract?.get();
			const safety = input.autonomy ?? settings?.autonomy ?? "auto-edit";
			const cwd = input.cwd ?? process.cwd();
			let contextFiles = "";
			let projectPreload: ProjectPreloadClass | null = null;
			if (!suppressContextFiles) {
				const projectContext = contextDomain()?.renderPromptContext(cwd);
				contextFiles = projectContext
					? selectProjectContext(projectContext, input.sessionInputs.providerSupportsTools ?? null)
					: "";
				if (projectContext) {
					projectPreload = classifyProjectPreload({
						hasClioMd: projectContext.clioMd !== null,
						text: projectContext.text,
					});
				}
				for (const warning of projectContext?.warnings ?? []) process.stderr.write(`${warning}\n`);
			}
			const roster = fleetRoster();
			const sessionInputs = {
				...input.sessionInputs,
				...(contextFiles.length > 0 ? { contextFiles } : {}),
				...(roster.length > 0 ? { fleetRoster: roster } : {}),
			};
			const compiled = compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: `safety.${safety}`,
				sessionInputs,
				additionalFragments: [
					...workspaceRootFragment(cwd),
					...clioRepoAwarenessFragments(cwd),
					...customizationFragments(cwd, input.workingContextPaths ?? []),
				],
			});
			return { ...compiled, projectPreload };
		},
		async compileWorkerPrompt(input: CompileWorkerPromptInput) {
			if (!table) throw new Error("prompts domain not started");
			if (table.byId.size === 0) {
				throw new Error("prompts: no fragments loaded, check startup logs");
			}
			const { cwd: inputCwd, workingContextPaths, ...workerInputs } = input;
			const cwd = inputCwd ?? process.cwd();
			return compileWorker(table, {
				...workerInputs,
				additionalFragments: customizationFragments(cwd, workingContextPaths ?? []),
			});
		},
		reload,
	};

	let unsubscribeHotReload: (() => void) | null = null;
	const extension: DomainExtension = {
		async start() {
			try {
				table = loadFragments();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[clio:prompts] initial load failed: ${msg}\n`);
				table = { byId: new Map(), rootDir: "" };
			}
			unsubscribeHotReload = context.bus.on(BusChannels.ConfigHotReload, (payload: unknown) => {
				const diff = (payload as { diff?: { hotReload?: string[] } } | undefined)?.diff;
				const paths = diff?.hotReload ?? [];
				if (!diffTouchesFragments(paths)) return;
				reload();
			});
		},
		async stop() {
			unsubscribeHotReload?.();
			unsubscribeHotReload = null;
		},
	};

	return { extension, contract };
}

/**
 * Inline prompt fragments for the project's customization surfaces. Unconditional
 * `.clio-coder/rules/**` rules load with project context here; path-scoped rules stay
 * out of the base prompt and activate through the rule loader once a matching
 * file is in working context. The operator profile renders as one capped
 * section. Both are deterministic (rules sort by id), so a local model's cached
 * prompt prefix stays stable. Best-effort: a load failure injects nothing.
 */
function customizationFragments(cwd: string, workingContextPaths: ReadonlyArray<string>): RenderedPromptFragment[] {
	const fragments: RenderedPromptFragment[] = [];
	try {
		const loaded = loadProjectRules(cwd);
		const active = selectActiveRules(loaded.rules, normalizeWorkingContextPaths(cwd, workingContextPaths));
		if (active.length > 0) {
			const body = ["# Project rules", ...active.map((rule) => rule.body)].join("\n\n");
			fragments.push({
				id: "context.project-rules",
				relPath: "inline/project-rules",
				body,
				contentHash: sha256(body),
				dynamic: true,
			});
		}
	} catch {
		// Project rules are best-effort; a load failure must not block compilation.
	}
	try {
		const profile = loadOperatorProfile(cwd);
		const rendered = renderOperatorProfile(profile.profile);
		if (rendered.text.length > 0) {
			fragments.push({
				id: "context.operator-profile",
				relPath: "inline/operator-profile",
				body: rendered.text,
				contentHash: sha256(rendered.text),
				dynamic: true,
			});
		}
	} catch {
		// The operator profile is best-effort; a load failure injects nothing.
	}
	return fragments;
}

function normalizeWorkingContextPaths(cwd: string, paths: ReadonlyArray<string>): string[] {
	const normalized = new Set<string>();
	for (const filePath of paths) {
		const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		normalized.add(rel.replace(/\\/g, "/"));
	}
	return [...normalized].sort();
}

/**
 * The absolute workspace root, stated once. Tools take paths and working
 * directories, and a model that was never told the root guesses one: an
 * observed run passed the container convention `/workspace` to bash and had
 * the call blocked as a workspace escape. Naming the real root removes the
 * guess for every tool at once, which no single tool description can do.
 */
function workspaceRootFragment(cwd: string): RenderedPromptFragment[] {
	const body = [
		"# Workspace",
		`Absolute workspace root: ${cwd}`,
		"Relative paths resolve here. Do not invent a root such as /workspace or /repo, and do not pass a working directory unless the command must run in a subdirectory of this root.",
	].join("\n");
	return [
		{
			id: WORKSPACE_ROOT_ID,
			relPath: "inline/workspace-root",
			body,
			contentHash: sha256(body),
			dynamic: true,
		},
	];
}

function clioRepoAwarenessFragments(cwd: string): RenderedPromptFragment[] {
	const awareness = detectClioCoderRepo(cwd);
	if (!awareness.isClioCoderRepo || !awareness.repoRoot) return [];
	const body = [
		"# Clio Source Tree",
		"This workspace is Clio Coder's own source tree.",
		"When running inside this repo, Clio can modify her own TUI, skills, agents, tools, prompts, context/bootstrap, and harness as ordinary local source work when the user asks.",
		"Shared contribution/publishing/push/PR/release requires explicit user intent and normal Git/GitHub etiquette. Do not imply autonomous publishing.",
	].join("\n");
	return [
		{
			id: CLIO_REPO_AWARENESS_ID,
			relPath: "inline/clio-repo-awareness",
			body,
			contentHash: sha256(body),
			dynamic: true,
		},
	];
}

function projectTypeFromPromptContext(text: string): string | null {
	const match = /<project-type>([^<]+)<\/project-type>/.exec(text);
	const value = match?.[1]?.trim();
	return value && value !== "unknown" ? value : null;
}

function hasCodewiki(text: string): boolean {
	return text.includes("<codewiki>");
}

function wikiAvailabilityFromPromptContext(text: string): string | null {
	const match = /<wiki>([^<]+)<\/wiki>/.exec(text);
	const value = match?.[1]?.trim();
	return value && value.length > 0 ? value : null;
}

function renderProjectSynopsis(context: ProjectPromptContext, providerSupportsTools: boolean | null): string {
	const projectType = projectTypeFromPromptContext(context.text);
	const wiki = wikiAvailabilityFromPromptContext(context.text);
	const lines = ["<project-synopsis>"];
	if (projectType) lines.push(`Language: ${projectType}`);
	if (context.clioMd) {
		lines.push(`Project: ${context.clioMd.projectName}`);
		lines.push(
			"CLIO-CODER.md: available; compact synopsis only because the handbook is too large for automatic preload.",
		);
	}
	if (hasCodewiki(context.text)) lines.push("Codewiki: available via code_nav.");
	if (wiki) lines.push(`Wiki: ${wiki}`);
	if (providerSupportsTools === false) {
		lines.push("Tools: unavailable for this target; use this synopsis only as fallback context.");
	} else {
		lines.push('Retrieve exact repository facts with context(scope="workspace"), code_nav, grep, and read.');
	}
	lines.push("</project-synopsis>");
	return lines.join("\n");
}

/**
 * Project context is selected once per session compile: the full CLIO-CODER.md
 * preload when it is small enough, a compact synopsis otherwise. No per-turn
 * selection — the session prompt is stable for the session's lifetime. The
 * cliff itself lives in prompts/preload.ts so reporting surfaces classify
 * with the same rule.
 */
function selectProjectContext(context: ProjectPromptContext, providerSupportsTools: boolean | null): string {
	const preload = classifyProjectPreload({ hasClioMd: context.clioMd !== null, text: context.text });
	if (preload.mode === "none") return "";
	if (preload.mode === "full") return context.text.trim();
	return renderProjectSynopsis(context, providerSupportsTools);
}
