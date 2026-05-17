import { BusChannels } from "../../core/bus-events.js";
import { detectClioCoderRepo } from "../../core/clio-repo.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ContextContract } from "../context/index.js";
import type { ModesContract } from "../modes/contract.js";
import type { ModeName } from "../modes/index.js";
import { compile, type RenderedPromptFragment } from "./compiler.js";
import type { CompileForTurnInput, PromptsContract } from "./contract.js";
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

	function modes(): ModesContract | undefined {
		return context.getContract<ModesContract>("modes");
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
				contextFiles = projectContext?.text ?? "";
				for (const warning of projectContext?.warnings ?? []) process.stderr.write(`${warning}\n`);
			}
			const dynamicInputs = contextFiles.length > 0 ? { ...input.dynamicInputs, contextFiles } : input.dynamicInputs;
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
		`Clio is operating inside her own source tree at ${awareness.repoRoot}.`,
		"Requests about Clio herself may be handled as ordinary local source-code changes.",
		"Clio may edit her source, run focused tests, rebuild, reload, and reconfigure only the local Clio installation for this user to test.",
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
