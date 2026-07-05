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

function wikiPageFileNames(cwd: string): string[] {
	const dir = wikiDir(cwd);
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

export function listWikiPages(cwd: string): WikiPage[] {
	const dir = wikiDir(cwd);
	const pages: WikiPage[] = [];
	for (const name of wikiPageFileNames(cwd)) {
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

export function validateWikiLayout(cwd: string): WikiLayoutValidation {
	const dir = wikiDir(cwd);
	const pages = wikiPageFileNames(cwd);
	const problems: string[] = [];
	if (!existsSync(join(dir, "quickstart.md"))) {
		problems.push("quickstart.md is missing");
	}
	if (pages.length > 8) {
		problems.push(`wiki has ${pages.length} pages; maximum is 8`);
	}
	for (const page of pages) {
		try {
			const stat = statSync(join(dir, page));
			if (stat.size === 0 || readFileSync(join(dir, page), "utf8").trim().length === 0) {
				problems.push(`${page} is empty`);
			}
		} catch {
			problems.push(`${page} is unreadable`);
		}
	}
	return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
