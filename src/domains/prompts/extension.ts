import { execFileSync } from "node:child_process";
import { BusChannels } from "../../core/bus-events.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { HarnessIntrospection } from "../../harness/state.js";
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
	/** Retained for CLI option compatibility. Project context now comes only from CLIO.md. */
	devRepoRoot?: string;
	getHarnessIntrospection?: () => HarnessIntrospection;
	renderSelfDevMemory?: () => Promise<string>;
}

const SELF_DEV_FRAGMENT_IDS = [
	"selfdev.identity",
	"selfdev.authority",
	"selfdev.iteration",
	"selfdev.state",
	"selfdev.memory",
] as const;

type SelfDevFragmentId = (typeof SELF_DEV_FRAGMENT_IDS)[number];
type FragmentRenderer = () => Promise<string>;

export function createPromptsBundle(
	context: DomainContext,
	options: PromptsBundleOptions = {},
): DomainBundle<PromptsContract> {
	let table: FragmentTable | null = null;
	const suppressContextFiles = options.noContextFiles === true;
	const includeSelfDev = typeof options.devRepoRoot === "string" && options.devRepoRoot.length > 0;
	const renderers = includeSelfDev ? selfDevRenderers(options) : new Map<SelfDevFragmentId, FragmentRenderer>();

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
			table = loadFragments({ includeSelfDev });
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
				additionalFragments: await selfDevFragments(table, renderers),
			});
		},
		reload,
	};

	const extension: DomainExtension = {
		async start() {
			try {
				table = loadFragments({ includeSelfDev });
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

function readGit(repoRoot: string, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function readGitLines(repoRoot: string, args: ReadonlyArray<string>): string[] {
	const raw = readGit(repoRoot, args);
	if (!raw) return [];
	return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

function defaultHarnessIntrospection(): HarnessIntrospection {
	return {
		last_restart_required_paths: [],
		last_hot_succeeded: null,
		last_hot_failed: null,
		queue_depth: 0,
	};
}

function harnessVerdict(state: HarnessIntrospection): string {
	if (state.last_restart_required_paths.length > 0) return "restart-required";
	if (state.queue_depth > 0) return `worker-pending:${state.queue_depth}`;
	if (state.last_hot_failed) return "hot-failed";
	if (state.last_hot_succeeded) return "hot-succeeded";
	return "idle";
}

function createStateRenderer(options: PromptsBundleOptions): FragmentRenderer {
	let cache: { at: number; body: string } | null = null;
	return async () => {
		const now = Date.now();
		if (cache && now - cache.at < 1000) return cache.body;
		const repoRoot = options.devRepoRoot ?? process.cwd();
		const branch = readGit(repoRoot, ["branch", "--show-current"]) ?? "unknown";
		const dirtyCount = readGitLines(repoRoot, ["status", "--short"]).length;
		const harness = options.getHarnessIntrospection?.() ?? defaultHarnessIntrospection();
		const lastHotReload = harness.last_hot_succeeded
			? `${harness.last_hot_succeeded.path}:${harness.last_hot_succeeded.elapsedMs}`
			: "none";
		const lastRestart =
			harness.last_restart_required_paths.length > 0
				? (harness.last_restart_required_paths[harness.last_restart_required_paths.length - 1] ?? "none")
				: "none";
		const body = [
			"## Live state",
			`- branch: ${branch}`,
			`- dirty: ${dirtyCount === 0 ? "clean" : `${dirtyCount} changed paths`}`,
			`- harness: ${harnessVerdict(harness)}`,
			`- last hot reload: ${lastHotReload}`,
			`- last restart trigger: ${lastRestart}`,
		].join("\n");
		cache = { at: now, body };
		return body;
	};
}

function selfDevRenderers(options: PromptsBundleOptions): Map<SelfDevFragmentId, FragmentRenderer> {
	const renderers = new Map<SelfDevFragmentId, FragmentRenderer>();
	renderers.set("selfdev.state", createStateRenderer(options));
	renderers.set("selfdev.memory", options.renderSelfDevMemory ?? (async () => ""));
	return renderers;
}

async function selfDevFragments(
	table: FragmentTable,
	renderers: ReadonlyMap<SelfDevFragmentId, FragmentRenderer>,
): Promise<RenderedPromptFragment[]> {
	const rendered: RenderedPromptFragment[] = [];
	for (const id of SELF_DEV_FRAGMENT_IDS) {
		const fragment = table.byId.get(id);
		if (!fragment) continue;
		if (fragment.dynamic) {
			const body = (await renderers.get(id)?.()) ?? "";
			rendered.push({
				id: fragment.id,
				relPath: fragment.relPath,
				body,
				contentHash: sha256(body),
				dynamic: true,
			});
			continue;
		}
		rendered.push({
			id: fragment.id,
			relPath: fragment.relPath,
			body: fragment.body,
			contentHash: fragment.contentHash,
			dynamic: fragment.dynamic,
		});
	}
	return rendered;
}
