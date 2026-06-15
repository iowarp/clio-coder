import type { Codewiki, CodewikiFile, CodewikiSymbol } from "./indexer.js";

function compareStrings(a: string, b: string): number {
	return a.localeCompare(b);
}

function topTwoSegments(path: string): string {
	const parts = path.split("/").slice(0, -1);
	if (parts.length === 0) return ".";
	return parts.slice(0, 2).join("/");
}

function sourceFiles(codewiki: Codewiki): CodewikiFile[] {
	return codewiki.files.filter((file) => file.lang !== "config").sort((a, b) => a.path.localeCompare(b.path));
}

function countBy<T extends string>(items: Iterable<T>): Array<[T, number]> {
	const counts = new Map<T, number>();
	for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function entryPoints(codewiki: Codewiki, limit: number): CodewikiFile[] {
	const files = sourceFiles(codewiki);
	const tagged = files.filter((file) => file.role === "entry");
	if (tagged.length >= limit) return tagged.slice(0, limit);
	const fileById = new Map(files.map((file) => [file.id, file] as const));
	const inDegree = new Map<string, number>();
	for (const edge of codewiki.edges) {
		if ("toFileId" in edge) inDegree.set(edge.toFileId, (inDegree.get(edge.toFileId) ?? 0) + 1);
	}
	const taggedIds = new Set(tagged.map((file) => file.id));
	const ranked = [...inDegree.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([id]) => fileById.get(id))
		.filter((file): file is CodewikiFile => file !== undefined && !taggedIds.has(file.id));
	return [...tagged, ...ranked].slice(0, limit);
}

function keySymbols(codewiki: Codewiki, limit: number): CodewikiSymbol[] {
	const rank = new Map<string, number>([
		["class", 0],
		["trait", 1],
		["iface", 2],
		["type", 3],
		["func", 4],
		["method", 5],
		["const", 6],
		["var", 7],
	]);
	return [...codewiki.symbols]
		.sort((a, b) => {
			const rankCmp = (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99);
			return rankCmp || a.name.localeCompare(b.name) || a.fileId.localeCompare(b.fileId) || a.line - b.line;
		})
		.slice(0, limit);
}

function dependencyLines(codewiki: Codewiki, limit: number): string[] {
	const fileById = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const byFile = new Map<string, { internal: string[]; external: string[] }>();
	for (const edge of codewiki.edges) {
		const deps = byFile.get(edge.fileId) ?? { internal: [], external: [] };
		if ("toFileId" in edge) {
			const target = fileById.get(edge.toFileId);
			if (target) deps.internal.push(target.path);
		} else {
			deps.external.push(edge.externalModule);
		}
		byFile.set(edge.fileId, deps);
	}
	return [...byFile.entries()]
		.map(([fileId, deps]) => {
			const file = fileById.get(fileId);
			if (!file) return "";
			const internal = [...new Set(deps.internal)].sort(compareStrings).slice(0, 4);
			const external = [...new Set(deps.external)].sort(compareStrings).slice(0, 4);
			return `- ${file.path}: internal=[${internal.join(", ")}] external=[${external.join(", ")}]`;
		})
		.filter((line) => line.length > 0)
		.sort(compareStrings)
		.slice(0, limit);
}

function fitLines(lines: string[], tokenBudget: number): string {
	const maxChars = Math.max(256, Math.floor(tokenBudget * 4));
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		const next = used + line.length + 1;
		if (next > maxChars) {
			out.push("[digest truncated]");
			break;
		}
		out.push(line);
		used = next;
	}
	return out.join("\n");
}

export function renderCodewikiDigest(codewiki: Codewiki, tokenBudget = 1200): string {
	const files = sourceFiles(codewiki);
	const areaCounts = countBy(files.map((file) => topTwoSegments(file.path)))
		.slice(0, 10)
		.map(([area, count]) => `${area}=${count}`);
	const languageCounts = countBy(files.map((file) => file.lang))
		.map(([language, count]) => `${language}=${count}`)
		.join(", ");
	const roleCounts = countBy(files.map((file) => file.role))
		.map(([role, count]) => `${role}=${count}`)
		.join(", ");
	const fileById = new Map(codewiki.files.map((file) => [file.id, file] as const));
	const lines = [
		`codewiki v${codewiki.version} language=${codewiki.language} files=${files.length} configs=${codewiki.files.length - files.length} symbols=${codewiki.symbols.length} edges=${codewiki.edges.length}`,
		`languages: ${languageCounts || "none"}`,
		`roles: ${roleCounts || "none"}`,
		`areas: ${areaCounts.join(", ") || "none"}`,
		"entry points:",
		...entryPoints(codewiki, 12).map((file) => `- ${file.path} (${file.lang}, ${file.loc} loc)`),
		"key symbols:",
		...keySymbols(codewiki, 40).map((symbol) => {
			const file = fileById.get(symbol.fileId);
			const location = file ? `${file.path}:${symbol.line}` : `${symbol.fileId}:${symbol.line}`;
			return `- ${symbol.name} ${symbol.kind} ${location}`;
		}),
		"dependencies:",
		...dependencyLines(codewiki, 24),
	];
	return fitLines(lines, tokenBudget);
}
