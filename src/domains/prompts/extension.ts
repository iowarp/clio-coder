import { BusChannels } from "../../core/bus-events.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ModesContract } from "../modes/contract.js";
import type { ModeName } from "../modes/index.js";
import { compile } from "./compiler.js";
import { loadProjectContextFiles, renderProjectContextFiles } from "./context-files.js";
import type { CompileForTurnInput, PromptsContract } from "./contract.js";
import { type FragmentTable, loadFragments } from "./fragment-loader.js";

export interface PromptsBundleOptions {
	/** When true, the dynamic context.files fragment renders the empty string
	 * even if AGENTS.md / CLAUDE.md / CODEX.md exist on disk. Set by the
	 * top-level `--no-context-files` (alias `-nc`) startup flag. */
	noContextFiles?: boolean;
}

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
		compileForTurn(input: CompileForTurnInput) {
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
			const contextFiles = suppressContextFiles ? "" : renderProjectContextFiles(loadProjectContextFiles({ cwd }), cwd);
			const dynamicInputs = contextFiles.length > 0 ? { ...input.dynamicInputs, contextFiles } : input.dynamicInputs;
			return compile(table, {
				identity: "identity.clio",
				mode: `modes.${currentMode}`,
				safety: `safety.${safety}`,
				...(contextFiles.length > 0 ? { context: "context.files" } : {}),
				providers: "providers.dynamic",
				session: "session.dynamic",
				dynamicInputs,
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
