import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { clioConfigDir } from "../../core/xdg.js";
import { type ExtensionResourceKind, enabledExtensionResourceRoots } from "../extensions/index.js";
import type { ResourceDiagnostic, ResourceScope, ResourceSourceInfo } from "./collision.js";

export interface ResourceRoot {
	path: string;
	/** Package root for safely resolving extension-relative prompt references. */
	rootPath?: string;
	scope: ResourceScope;
	source?: string;
	/** Collision rank, higher wins. See {@link ResourceSourceInfo.precedence}. */
	precedence?: number;
	/** Whether the resource is usable without an explicit trust opt-in. Defaults to true. */
	trusted?: boolean;
}

/**
 * Collision tiers shared by every compatibility-aware resource kind. They match
 * the skill precedence table so a foreign prompt root ranks against Clio's own
 * roots exactly the way a foreign skill root does.
 */
export const COMPAT_RESOURCE_PRECEDENCE = {
	extension: 10,
	userCompat: 20,
	user: 30,
	projectCompat: 40,
	project: 50,
} as const;

export type FrontmatterSplitResult =
	| {
			ok: true;
			frontmatter: Record<string, unknown>;
			body: string;
	  }
	| {
			ok: false;
			reason: string;
			body: string;
	  };

export function defaultScopedResourceRoots(kind: ExtensionResourceKind, cwd: string): ResourceRoot[] {
	return [
		...enabledExtensionResourceRoots(kind, cwd).map((root) => ({
			path: root.path,
			rootPath: root.rootPath,
			scope: "package" as const,
			source: root.source,
			precedence: COMPAT_RESOURCE_PRECEDENCE.extension,
		})),
		{
			path: path.join(clioConfigDir(), kind),
			scope: "user" as const,
			source: "config",
			precedence: COMPAT_RESOURCE_PRECEDENCE.user,
		},
		{
			path: path.join(cwd, ".clio-coder", kind),
			scope: "project" as const,
			source: "project",
			precedence: COMPAT_RESOURCE_PRECEDENCE.project,
		},
	];
}

export function sourceInfoForRoot(root: ResourceRoot, filePath: string): ResourceSourceInfo {
	return {
		path: filePath,
		scope: root.scope,
		...(root.source ? { source: root.source } : {}),
		...(root.precedence !== undefined ? { precedence: root.precedence } : {}),
	};
}

export function readRootEntries(
	root: ResourceRoot,
	label: string,
	diagnostics: ResourceDiagnostic[],
): Dirent<string>[] {
	if (!existsSync(root.path)) return [];
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(root.path);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({
			type: "warning",
			message: `${label} root could not be stat'ed: ${reason}`,
			path: root.path,
		});
		return [];
	}
	if (!stat.isDirectory()) {
		diagnostics.push({ type: "warning", message: `${label} root is not a directory`, path: root.path });
		return [];
	}

	try {
		return readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		diagnostics.push({ type: "warning", message: `${label} root could not be read: ${reason}`, path: root.path });
		return [];
	}
}

export function splitYamlFrontmatter(raw: string): FrontmatterSplitResult {
	const opening = raw.match(/^---\r?\n/);
	if (!opening) return { ok: false, reason: "missing", body: raw };

	const closeRegex = /\r?\n---(?:\r?\n|$)/g;
	closeRegex.lastIndex = opening[0].length;
	const closing = closeRegex.exec(raw);
	if (!closing) return { ok: false, reason: "missing closing delimiter", body: raw };

	const body = raw.slice(closing.index + closing[0].length);
	const frontmatterText = raw.slice(opening[0].length, closing.index);
	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatterText);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `invalid YAML: ${reason}`, body };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "must be a YAML object", body };
	}

	return {
		ok: true,
		frontmatter: parsed as Record<string, unknown>,
		body,
	};
}

export function stringField(frontmatter: Record<string, unknown>, key: string): string | null {
	const value = frontmatter[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
