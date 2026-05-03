import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { SelfDevMode } from "../../core/self-dev.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ToolResult, ToolSpec } from "../../tools/registry.js";

interface IntrospectDeps {
	mode: SelfDevMode;
}

interface PackageJson {
	version?: string;
}

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

function jsonResult(value: unknown): ToolResult {
	return { kind: "ok", output: JSON.stringify(value) };
}

export function clioIntrospectTool(deps: IntrospectDeps): ToolSpec {
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
    repo_root: string`,
		parameters: Type.Object({
			view: Type.Union([Type.Literal("whoami")], {
				description: "Introspection view to render.",
			}),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args): Promise<ToolResult> {
			const view = typeof args.view === "string" ? args.view : "";
			if (view !== "whoami") return { kind: "error", message: `clio_introspect: unknown view ${view}` };
			const repoRoot = deps.mode.repoRoot;
			return jsonResult({
				version: readPackageVersion(repoRoot),
				commit: readGit(repoRoot, ["rev-parse", "HEAD"]),
				branch: readGit(repoRoot, ["branch", "--show-current"]) ?? deps.mode.branch,
				dirty_summary: dirtySummary(repoRoot),
				dev_mode_source: deps.mode.source,
				engine_writes_allowed: deps.mode.engineWritesAllowed,
				repo_root: repoRoot,
			});
		},
	};
}
