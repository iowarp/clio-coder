import { BusChannels } from "../../core/bus-events.js";
import { detectClioCoderRepo } from "../../core/clio-repo.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ContextContract, ProjectPromptContext } from "../context/index.js";
import { compile, type RenderedPromptFragment } from "./compiler.js";
import type { CompileSessionPromptInput, PromptsContract } from "./contract.js";
import { type FragmentTable, loadFragments } from "./fragment-loader.js";
import { sha256 } from "./hash.js";

export interface PromptsBundleOptions {
	/** When true, the dynamic context.files fragment renders the empty string. */
	noContextFiles?: boolean;
}

const CLIO_REPO_AWARENESS_ID = "context.clio-repo-awareness";

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
			if (!suppressContextFiles) {
				const projectContext = contextDomain()?.renderPromptContext(cwd);
				contextFiles = projectContext
					? selectProjectContext(projectContext, input.sessionInputs.providerSupportsTools ?? null)
					: "";
				for (const warning of projectContext?.warnings ?? []) process.stderr.write(`${warning}\n`);
			}
			const sessionInputs = {
				...input.sessionInputs,
				...(contextFiles.length > 0 ? { contextFiles } : {}),
			};
			return compile(table, {
				identity: "identity.clio",
				operatingContract: "operating.contract",
				safety: `safety.${safety}`,
				sessionInputs,
				additionalFragments: clioRepoAwarenessFragments(cwd),
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

function renderProjectSynopsis(context: ProjectPromptContext, providerSupportsTools: boolean | null): string {
	const projectType = projectTypeFromPromptContext(context.text);
	const lines = ["<project-synopsis>"];
	if (projectType) lines.push(`Language: ${projectType}`);
	if (context.clioMd) {
		lines.push(`Project: ${context.clioMd.projectName}`);
		lines.push("CLIO.md: available; compact synopsis only because the handbook is too large for automatic preload.");
	}
	if (hasCodewiki(context.text)) lines.push("Codewiki: available via code_nav.");
	if (providerSupportsTools === false) {
		lines.push("Tools: unavailable for this target; use this synopsis only as fallback context.");
	} else {
		lines.push("Retrieve exact repository facts with workspace_context, codewiki tools, grep, and read.");
	}
	lines.push("</project-synopsis>");
	return lines.join("\n");
}

const FULL_PROJECT_CONTEXT_MAX_CHARS = 8000;
const FULL_PROJECT_CONTEXT_MAX_LINES = 220;

function shouldPreloadProjectContext(context: ProjectPromptContext): boolean {
	if (!context.clioMd) return false;
	if (context.text.length > FULL_PROJECT_CONTEXT_MAX_CHARS) return false;
	const lines = context.text.split("\n").length;
	return lines <= FULL_PROJECT_CONTEXT_MAX_LINES;
}

/**
 * Project context is selected once per session compile: the full CLIO.md
 * preload when it is small enough, a compact synopsis otherwise. No per-turn
 * selection — the session prompt is stable for the session's lifetime.
 */
function selectProjectContext(context: ProjectPromptContext, providerSupportsTools: boolean | null): string {
	const contextText = context.text.trim();
	if (contextText.length === 0) return "";
	if (shouldPreloadProjectContext(context)) return contextText;
	return renderProjectSynopsis(context, providerSupportsTools);
}
