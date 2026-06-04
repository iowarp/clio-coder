import { BusChannels } from "../../core/bus-events.js";
import { detectClioCoderRepo } from "../../core/clio-repo.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ContextContract, ProjectPromptContext } from "../context/index.js";
import type { ModesContract } from "../modes/contract.js";
import type { ModeName } from "../modes/index.js";
import type { ResourcesContract } from "../resources/index.js";
import { compile, type RenderedPromptFragment } from "./compiler.js";
import type { CompileForTurnInput, ProjectContextPolicyInput, PromptsContract } from "./contract.js";
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
	const lastProjectContextHashByCwd = new Map<string, string>();

	function config(): ConfigContract | undefined {
		return context.getContract<ConfigContract>("config");
	}

	function modes(): ModesContract | undefined {
		return context.getContract<ModesContract>("modes");
	}

	function contextDomain(): ContextContract | undefined {
		return context.getContract<ContextContract>("context");
	}

	function resources(): ResourcesContract | undefined {
		return context.getContract<ResourcesContract>("resources");
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
		async compileForTurn(input: CompileForTurnInput) {
			if (!table) throw new Error("prompts domain not started");
			if (table.byId.size === 0) {
				throw new Error("prompts: no fragments loaded, check startup logs");
			}
			const modesContract = modes();
			const configContract = config();
			const currentMode: ModeName = input.overrideMode ?? modesContract?.current() ?? "default";
			const settings: Readonly<ClioSettings> | undefined = configContract?.get();
			const safety = input.safetyLevel ?? settings?.safetyLevel ?? "auto-edit";
			const cwd = input.cwd ?? process.cwd();
			let contextFiles = "";
			if (!suppressContextFiles) {
				const projectContext = contextDomain()?.renderPromptContext(cwd);
				contextFiles = projectContext
					? selectProjectContextForTurn(cwd, projectContext, input.contextPolicy, lastProjectContextHashByCwd)
					: "";
				for (const warning of projectContext?.warnings ?? []) process.stderr.write(`${warning}\n`);
			}
			const skillsCatalog = resources()?.skillsCatalog(cwd) ?? "";
			const dynamicInputs = {
				...input.dynamicInputs,
				...(typeof input.contextPolicy?.providerSupportsTools === "boolean"
					? { providerSupportsTools: input.contextPolicy.providerSupportsTools }
					: {}),
				...(input.contextPolicy?.sendPolicy ? { sendPolicy: input.contextPolicy.sendPolicy } : {}),
				...(typeof input.contextPolicy?.turnCount === "number" ? { turnCount: input.contextPolicy.turnCount } : {}),
				...(contextFiles.length > 0 ? { contextFiles } : {}),
				...(skillsCatalog.length > 0 ? { skillsCatalog } : {}),
			};
			return compile(table, {
				identity: "identity.clio",
				mode: `modes.${currentMode}`,
				safety: `safety.${safety}`,
				dynamicInputs,
				additionalFragments: clioRepoAwarenessFragments(cwd),
			});
		},
		reload,
	};

	const extension: DomainExtension = {
		async start() {
			try {
				table = loadFragments();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`[clio:prompts] initial load failed: ${msg}\n`);
				table = { byId: new Map(), rootDir: "" };
			}
			context.bus.on(BusChannels.ConfigHotReload, (payload: unknown) => {
				const diff = (payload as { diff?: { hotReload?: string[] } } | undefined)?.diff;
				const paths = diff?.hotReload ?? [];
				if (!diffTouchesFragments(paths)) return;
				reload();
			});
		},
		async stop() {},
	};

	return { extension, contract };
}

function clioRepoAwarenessFragments(cwd: string): RenderedPromptFragment[] {
	const awareness = detectClioCoderRepo(cwd);
	if (!awareness.isClioCoderRepo || !awareness.repoRoot) return [];
	const body = [
		"# Clio Source Tree",
		"This workspace appears to be Clio Coder's own source tree.",
		"Requests about Clio may be handled as ordinary local source-code changes when the user asks for repo work.",
		"Use workspace and codewiki tools to retrieve mutable source details; do not treat this harness notice as repository context.",
		"Clio may edit source, run focused tests, rebuild, reload, and reconfigure only the local Clio installation for this user to test.",
		"Community contribution requires explicit user intent and normal Git/GitHub etiquette.",
		"Do not publish releases, push branches, open PRs, alter remotes, or modify shared/global installs unless the user explicitly asks.",
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

function renderProjectSynopsis(
	context: ProjectPromptContext,
	reason: string,
	providerSupportsTools: boolean | undefined,
): string {
	const projectType = projectTypeFromPromptContext(context.text);
	const lines = ["<project-synopsis>"];
	lines.push(`Reason: ${reason}`);
	if (projectType) lines.push(`Language: ${projectType}`);
	if (context.clioMd) {
		lines.push(`Project: ${context.clioMd.projectName}`);
		lines.push("CLIO.md: available, not preloaded in full.");
	}
	if (hasCodewiki(context.text)) lines.push("Codewiki: available for entry_points, where_is, and find_symbol.");
	if (providerSupportsTools === false) {
		lines.push("Tools: unavailable for this target; use this synopsis only as fallback context.");
	} else {
		lines.push("Retrieve exact repository facts with workspace_context, codewiki tools, grep, and read.");
	}
	lines.push("</project-synopsis>");
	return lines.join("\n");
}

function userTextLooksRepoAware(text: string | undefined): boolean {
	if (!text) return false;
	return /\b(repo|repository|codebase|workspace|source tree|file|files|path|paths|implement|fix|bug|test|tests|build|lint|typecheck|grep|read|diff|commit|clio|context|audit|refactor)\b/i.test(
		text,
	);
}

function selectProjectContextReason(
	cwd: string,
	contextHash: string,
	policy: ProjectContextPolicyInput | undefined,
	lastProjectContextHashByCwd: Map<string, string>,
): string | null {
	if (policy?.providerSupportsTools === false) return "no-tools-fallback";
	if ((policy?.turnCount ?? 0) <= 0) return "first-turn-synopsis";
	const previousHash = lastProjectContextHashByCwd.get(cwd);
	if (previousHash !== undefined && previousHash !== contextHash) return "context-fingerprint-changed";
	if (previousHash === undefined) return "context-fingerprint-changed";
	if (userTextLooksRepoAware(policy?.userText)) return "repo-aware-request";
	return null;
}

function selectProjectContextForTurn(
	cwd: string,
	context: ProjectPromptContext,
	policy: ProjectContextPolicyInput | undefined,
	lastProjectContextHashByCwd: Map<string, string>,
): string {
	const contextText = context.text.trim();
	if (contextText.length === 0) return "";
	const contextHash = sha256(contextText);
	const reason = selectProjectContextReason(cwd, contextHash, policy, lastProjectContextHashByCwd);
	lastProjectContextHashByCwd.set(cwd, contextHash);
	if (!reason) return "";
	return renderProjectSynopsis(context, reason, policy?.providerSupportsTools);
}
