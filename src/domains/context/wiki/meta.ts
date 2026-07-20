import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { type WikiPage, wikiDir } from "./layout.js";

export interface WikiMeta {
	version: 1;
	updatedAt: string;
	gitHead: string | null;
	sourceTreeHash?: string;
	model: string;
	contentHash: string;
	pages: WikiPage[];
}

export type WikiMetaValidation = { ok: true; value: WikiMeta } | { ok: false; problems: string[] };

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizePages(pages: ReadonlyArray<WikiPage>): WikiPage[] {
	return pages.map((page) => ({ path: page.path, title: page.title })).sort((a, b) => a.path.localeCompare(b.path));
}

export function wikiMetaPath(cwd: string): string {
	return join(wikiDir(cwd), "meta.json");
}

export function currentWikiGitHead(cwd: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

export function validateWikiMeta(value: unknown): WikiMetaValidation {
	const problems: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, problems: ["meta must be a JSON object"] };
	}
	if (value.version !== 1) problems.push("version must be 1");
	const updatedAt = stringValue(value.updatedAt);
	if (!updatedAt) problems.push("updatedAt must be a non-empty string");
	const gitHead = value.gitHead;
	if (gitHead !== null && typeof gitHead !== "string") problems.push("gitHead must be a string or null");
	const sourceTreeHash = value.sourceTreeHash;
	if (sourceTreeHash !== undefined && (typeof sourceTreeHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceTreeHash))) {
		problems.push("sourceTreeHash must be a sha256 hex string when present");
	}
	const model = stringValue(value.model);
	if (!model) problems.push("model must be a non-empty string");
	const contentHash = stringValue(value.contentHash);
	if (!contentHash || !/^[a-f0-9]{64}$/.test(contentHash)) {
		problems.push("contentHash must be a sha256 hex string");
	}
	if (!Array.isArray(value.pages)) {
		problems.push("pages must be an array");
	} else {
		for (const [index, page] of value.pages.entries()) {
			if (!isRecord(page)) {
				problems.push(`pages[${index}] must be an object`);
				continue;
			}
			if (!stringValue(page.path)) problems.push(`pages[${index}].path must be a non-empty string`);
			if (!stringValue(page.title)) problems.push(`pages[${index}].title must be a non-empty string`);
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		value: {
			version: 1,
			updatedAt: updatedAt as string,
			gitHead: gitHead as string | null,
			...(sourceTreeHash !== undefined ? { sourceTreeHash: sourceTreeHash as string } : {}),
			model: model as string,
			contentHash: contentHash as string,
			pages: normalizePages(value.pages as WikiPage[]),
		},
	};
}

export function isWikiMeta(value: unknown): value is WikiMeta {
	return validateWikiMeta(value).ok;
}

export function readWikiMeta(cwd: string): WikiMeta | null {
	const filePath = wikiMetaPath(cwd);
	if (!existsSync(filePath)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
	const validation = validateWikiMeta(parsed);
	return validation.ok ? validation.value : null;
}

export function writeWikiMeta(cwd: string, meta: WikiMeta): void {
	const normalized: WikiMeta = {
		version: 1,
		updatedAt: meta.updatedAt,
		gitHead: meta.gitHead,
		...(meta.sourceTreeHash ? { sourceTreeHash: meta.sourceTreeHash } : {}),
		model: meta.model,
		contentHash: meta.contentHash,
		pages: normalizePages(meta.pages),
	};
	safeResourceWrite(wikiMetaPath(cwd), `${JSON.stringify(normalized)}\n`, { encoding: "utf8" });
}

export function computeWikiContentHashOfDir(dir: string): string {
	let names: string[];
	try {
		names = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort(compareStrings);
	} catch {
		names = [];
	}
	const hash = createHash("sha256");
	for (const name of names) {
		let text = "";
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			text = "";
		}
		hash.update(`${name}\0${text.length}\0`);
		hash.update(text);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function computeWikiContentHash(cwd: string): string {
	return computeWikiContentHashOfDir(wikiDir(cwd));
}
