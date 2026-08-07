import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WikiPage {
	path: string;
	title: string;
}

export type WikiLayoutValidation = { ok: true } | { ok: false; problems: string[] };

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function wikiPageFileNamesInDir(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name)
		.sort(compareStrings);
}

function titleFromPage(name: string, text: string): string {
	const heading = /^#\s+(.+?)\s*$/m.exec(text)?.[1]?.trim();
	return heading && heading.length > 0 ? heading : name;
}

export function wikiDir(cwd: string): string {
	return join(cwd, ".clio", "wiki");
}

export function listWikiPagesInDir(dir: string): WikiPage[] {
	const pages: WikiPage[] = [];
	for (const name of wikiPageFileNamesInDir(dir)) {
		let text = "";
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			text = "";
		}
		pages.push({ path: name, title: titleFromPage(name, text) });
	}
	return pages;
}

export function listWikiPages(cwd: string): WikiPage[] {
	return listWikiPagesInDir(wikiDir(cwd));
}

export interface WikiPageBounds {
	minPages?: number;
	maxPages?: number;
	minPageBytes?: number;
}

export function validateWikiLayoutInDir(dir: string, bounds: WikiPageBounds = {}): WikiLayoutValidation {
	const pages = wikiPageFileNamesInDir(dir);
	const minPages = bounds.minPages ?? 1;
	const maxPages = bounds.maxPages ?? 16;
	const minPageBytes = bounds.minPageBytes ?? 0;
	const problems: string[] = [];
	if (!existsSync(join(dir, "quickstart.md"))) {
		problems.push("quickstart.md is missing");
	}
	if (pages.length < minPages) {
		problems.push(`wiki has ${pages.length} pages; minimum for this depth is ${minPages}`);
	}
	if (pages.length > maxPages) {
		problems.push(`wiki has ${pages.length} pages; maximum for this depth is ${maxPages}`);
	}
	for (const page of pages) {
		try {
			const stat = statSync(join(dir, page));
			if (stat.size === 0 || readFileSync(join(dir, page), "utf8").trim().length === 0) {
				problems.push(`${page} is empty`);
			} else if (stat.size < minPageBytes) {
				problems.push(`${page} is ${stat.size} bytes; minimum substantive size for this depth is ${minPageBytes}`);
			}
		} catch {
			problems.push(`${page} is unreadable`);
		}
	}
	return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export function validateWikiLayout(cwd: string, bounds: WikiPageBounds = {}): WikiLayoutValidation {
	return validateWikiLayoutInDir(wikiDir(cwd), bounds);
}
