import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePackageRoot } from "../../core/package-root.js";
import { buildSafeToolEnv } from "../../core/safe-exec.js";
import { isSemanticVersion } from "../extensions/compatibility.js";
import { isLibraryKind, type LibraryPackageEntry, type LibraryRequirementRef } from "../resources/library-types.js";
import { isPluginId } from "./discovery.js";

export type PluginCatalogEntry = LibraryPackageEntry;

export interface PluginSource {
	root: string;
	cleanup: () => void;
}

/** Explicit GitHub tree URLs identify both the revision and the bundle directory. */
export function parsePluginGithubSource(source: string): { url: string; ref: string; subdir: string } | undefined {
	const match =
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/([A-Za-z0-9_.-]+)(?:\/(.*?))?\/?$/.exec(source);
	if (!match?.[1] || !match[2] || !match[3]) return undefined;
	const subdir = match[4] ?? "";
	if (subdir.split("/").some((part) => part === ".." || part === ".") || subdir.includes("\\") || subdir.includes("\0"))
		return undefined;
	return { url: `https://github.com/${match[1]}/${match[2]}.git`, ref: match[3], subdir };
}

export function pluginLocalPath(source: string, cwd = process.cwd()): string {
	return path.resolve(cwd, source.startsWith("~/") ? path.join(homedir(), source.slice(2)) : source);
}

/** The same bounded, vector-only Git transport used by the skill installer. */
export function fetchPluginSource(source: string, cwd = process.cwd()): PluginSource {
	const local = pluginLocalPath(source, cwd);
	if (existsSync(local)) return { root: local, cleanup: () => {} };
	const remote = parsePluginGithubSource(source);
	if (!remote)
		throw new Error(
			`unsupported plugin source: ${source}; use a local directory or https://github.com/owner/repo/tree/ref/path`,
		);
	const temp = mkdtempSync(path.join(tmpdir(), "clio-coder-plugin-"));
	const cleanup = (): void => rmSync(temp, { recursive: true, force: true });
	try {
		execFileSync(
			"git",
			["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--branch", remote.ref, "--", remote.url, temp],
			{
				stdio: "pipe",
				timeout: 120_000,
				maxBuffer: 1_000_000,
				env: buildSafeToolEnv({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" }),
			},
		);
		const root = path.join(temp, remote.subdir);
		if (!existsSync(root) || !statSync(root).isDirectory())
			throw new Error(`plugin source has no directory ${remote.subdir || "."}: ${source}`);
		const relative = path.relative(realpathSync(temp), realpathSync(root));
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
			throw new Error("plugin source escapes repository");
		// Repository metadata is transport state, not part of a root-level package.
		if (!remote.subdir) rmSync(path.join(temp, ".git"), { recursive: true, force: true });
		return { root, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

export function readPluginCatalog(file: string, diagnostics: string[]): LibraryPackageEntry[] {
	if (!existsSync(file)) return [];
	try {
		const parsed: unknown = parseYaml(readFileSync(file, "utf8"));
		const rows: unknown[] | undefined = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
				? (parsed as { entries: unknown[] }).entries
				: undefined;
		if (!rows) throw new Error("library index must be a list or contain an entries list");
		return rows.flatMap((row): LibraryPackageEntry[] => {
			if (!row || typeof row !== "object") {
				diagnostics.push(`library index entry malformed: ${file}`);
				return [];
			}
			const item = row as Record<string, unknown>;
			if (
				!isLibraryKind(item.kind) ||
				typeof item.name !== "string" ||
				!isPluginId(item.name) ||
				typeof item.description !== "string" ||
				typeof item.sourceUrl !== "string" ||
				item.sourceUrl.trim().length === 0 ||
				!isSemanticVersion(item.version) ||
				typeof item.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(item.sha256)
			) {
				diagnostics.push(
					`library index entry requires name, description, sourceUrl, version, and full-tree sha256: ${String(item.name ?? file)}`,
				);
				return [];
			}
			if (
				item.requires !== undefined &&
				(!Array.isArray(item.requires) || item.requires.some((ref) => typeof ref !== "string"))
			) {
				diagnostics.push(`library_requirement_malformed: ${item.name}`);
				return [];
			}
			const remote = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(item.sourceUrl);
			if (remote && !parsePluginGithubSource(item.sourceUrl)) {
				diagnostics.push(`unsupported library index source: ${item.sourceUrl}`);
				return [];
			}
			return [
				{
					kind: item.kind,
					name: item.name,
					description: item.description,
					sourceUrl: remote ? item.sourceUrl : path.resolve(path.dirname(file), item.sourceUrl),
					version: item.version,
					sha256: item.sha256,
					origin: "catalog",
					...(typeof item.category === "string" ? { category: item.category } : {}),
					...(["pass", "warn", "fail", "unknown"].includes(String(item.audit))
						? { audit: item.audit as NonNullable<LibraryPackageEntry["audit"]> }
						: {}),
					...(Array.isArray(item.triggers)
						? { triggers: item.triggers.filter((value): value is string => typeof value === "string") }
						: {}),
					...(Array.isArray(item.requires) ? { requires: item.requires as LibraryRequirementRef[] } : {}),
				},
			];
		});
	} catch (error) {
		diagnostics.push(`library index unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

export function bundledPluginCatalog(diagnostics: string[]): LibraryPackageEntry[] {
	try {
		return readPluginCatalog(path.join(resolvePackageRoot(), "library", "registry.yaml"), diagnostics);
	} catch (error) {
		diagnostics.push(`library index unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
