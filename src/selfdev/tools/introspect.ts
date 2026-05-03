import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { SelfDevMode } from "../../core/self-dev.js";
import { ToolNames } from "../../core/tool-names.js";
import { createComponentSnapshot } from "../../domains/components/index.js";
import { loadFragments } from "../../domains/prompts/fragment-loader.js";
import type { HarnessIntrospection } from "../../harness/state.js";
import type { ToolRegistry, ToolResult, ToolSpec } from "../../tools/registry.js";

interface IntrospectDeps {
	mode: SelfDevMode;
	registry: ToolRegistry;
	getHarnessIntrospection?: () => HarnessIntrospection;
}

interface PackageJson {
	version?: string;
}

type IntrospectView = "whoami" | "domains" | "tools" | "fragments" | "harness" | "recent";

interface RecentSnapshot {
	at: number;
	value: {
		commit_subjects: string[];
		status_short: string[];
	};
}

const RECENT_CACHE_MS = 5000;

function readPackageVersion(repoRoot: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageJson;
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
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

function dirtySummary(repoRoot: string): string {
	const status = readGit(repoRoot, ["status", "--short"]);
	if (!status) return "clean";
	const lines = status.split(/\r?\n/).filter((line) => line.trim().length > 0);
	return lines.length === 0 ? "clean" : `${lines.length} changed path(s)`;
}

function defaultHarnessIntrospection(): HarnessIntrospection {
	return {
		last_restart_required_paths: [],
		last_hot_succeeded: null,
		last_hot_failed: null,
		queue_depth: 0,
	};
}

function readGitLines(repoRoot: string, args: ReadonlyArray<string>): string[] {
	const raw = readGit(repoRoot, args);
	if (!raw) return [];
	return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

function jsonResult(value: unknown): ToolResult {
	return { kind: "ok", output: JSON.stringify(value) };
}

export function clioIntrospectTool(deps: IntrospectDeps): ToolSpec {
	let recentCache: RecentSnapshot | null = null;

	async function viewDomains(): Promise<ToolResult> {
		const snapshot = await createComponentSnapshot({ root: deps.mode.repoRoot });
		return jsonResult(
			snapshot.components.map((component) => ({
				name: component.id,
				kind: component.kind,
				authority: component.authority,
				reload_class: component.reloadClass,
			})),
		);
	}

	function viewTools(): ToolResult {
		return jsonResult(
			deps.registry.listAll().map((spec) => ({
				name: spec.name,
				allowed_modes: spec.allowedModes ? [...spec.allowedModes] : [],
				source_path: null,
			})),
		);
	}

	function viewFragments(): ToolResult {
		const table = loadFragments();
		return jsonResult(
			[...table.byId.values()].map((fragment) => ({
				id: fragment.id,
				version: fragment.version,
				dynamic: fragment.dynamic,
				content_hash: fragment.contentHash,
				rel_path: fragment.relPath,
			})),
		);
	}

	function viewHarness(): ToolResult {
		return jsonResult(deps.getHarnessIntrospection?.() ?? defaultHarnessIntrospection());
	}

	function viewRecent(): ToolResult {
		const now = Date.now();
		if (recentCache && now - recentCache.at < RECENT_CACHE_MS) return jsonResult(recentCache.value);
		const value = {
			commit_subjects: readGitLines(deps.mode.repoRoot, ["log", "-n", "20", "--format=%s"]),
			status_short: readGitLines(deps.mode.repoRoot, ["status", "--short"]),
		};
		recentCache = { at: now, value };
		return jsonResult(value);
	}

	return {
		name: ToolNames.ClioIntrospect,
		description: `Read-only self-development introspection for Clio's own repository.

schema:
  whoami:
    version: string | null
    commit: string | null
    branch: string | null
    dirty_summary: string
    dev_mode_source: "--dev" | "CLIO_DEV=1" | "CLIO_SELF_DEV=1"
    engine_writes_allowed: boolean
    repo_root: string
  domains:
    - { name: string, kind: string, authority: string, reload_class: string }
  tools:
    - { name: string, allowed_modes: string[], source_path: string | null }
  fragments:
    - { id: string, version: number, dynamic: boolean, content_hash: string, rel_path: string }
  harness:
    last_restart_required_paths: string[]
    last_hot_succeeded: { path: string, elapsedMs: number, at: number } | null
    last_hot_failed: { path: string, error: string, at: number } | null
    queue_depth: number
  recent:
    commit_subjects: string[]
    status_short: string[]`,
		parameters: Type.Object({
			view: Type.Union(
				[
					Type.Literal("whoami"),
					Type.Literal("domains"),
					Type.Literal("tools"),
					Type.Literal("fragments"),
					Type.Literal("harness"),
					Type.Literal("recent"),
				],
				{
					description: "Introspection view to render.",
				},
			),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args): Promise<ToolResult> {
			const view = typeof args.view === "string" ? (args.view as IntrospectView) : "whoami";
			const repoRoot = deps.mode.repoRoot;
			switch (view) {
				case "whoami":
					return jsonResult({
						version: readPackageVersion(repoRoot),
						commit: readGit(repoRoot, ["rev-parse", "HEAD"]),
						branch: readGit(repoRoot, ["branch", "--show-current"]) ?? deps.mode.branch,
						dirty_summary: dirtySummary(repoRoot),
						dev_mode_source: deps.mode.source,
						engine_writes_allowed: deps.mode.engineWritesAllowed,
						repo_root: repoRoot,
					});
				case "domains":
					return await viewDomains();
				case "tools":
					return viewTools();
				case "fragments":
					return viewFragments();
				case "harness":
					return viewHarness();
				case "recent":
					return viewRecent();
			}
		},
	};
}
