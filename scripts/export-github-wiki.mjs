#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Export docs/wiki without changing generated pages or their checkpoint.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "docs/wiki");
const destination = process.argv[2];
const reference = process.argv[3] ?? "main";
if (!destination || process.argv.length > 4) {
	throw new Error("Usage: node scripts/export-github-wiki.mjs <wiki-checkout> [public-source-ref]");
}
const output = path.resolve(destination);
const relativeOutput = path.relative(root, output);
if (relativeOutput === "" || (!relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput))) {
	throw new Error("Export into a separate directory outside the source checkout.");
}
const repository = "https://github.com/iowarp/clio-coder";
const wiki = `${repository}/wiki`;
const encodePath = (value) => value.split("/").map(encodeURIComponent).join("/");
const files = readdirSync(source, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
	.map((entry) => path.relative(source, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
	.sort();
const slugs = new Map(
	files.map((file) => [
		file,
		file === "index.md"
			? "Home"
			: file
					.replace(/\.md$/, "")
					.split(/[/-]/)
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("-"),
	]),
);
if (!slugs.has("index.md")) throw new Error("Missing docs/wiki/index.md.");
if (new Set([...slugs.values()].map((slug) => slug.toLowerCase())).size !== files.length) {
	throw new Error("Wiki page names collide after flattening.");
}
const titles = new Map();
let rewrittenLinks = 0;
function rewriteTarget(file, target) {
	if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) return target;
	const match = /^([^?#]*)([?#].*)?$/.exec(target);
	const pathname = decodeURIComponent(match[1]);
	const suffix = match[2] ?? "";
	const resolved = path.resolve(path.dirname(path.join(source, file)), pathname);
	const wikiPath = path.relative(source, resolved).split(path.sep).join("/");
	if (slugs.has(wikiPath)) {
		rewrittenLinks++;
		return `${wiki}/${slugs.get(wikiPath)}${suffix}`;
	}
	const sourcePath = path.relative(root, resolved).split(path.sep).join("/");
	if (sourcePath.startsWith("../") || path.isAbsolute(sourcePath) || !existsSync(resolved)) {
		throw new Error(`${file}: unresolved relative link ${target}`);
	}
	rewrittenLinks++;
	return `${repository}/blob/${encodePath(reference)}/${encodePath(sourcePath)}${suffix}`;
}
const pages = new Map();
for (const file of files) {
	const original = readFileSync(path.join(source, file), "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(original);
	let body = frontmatter ? original.slice(frontmatter[0].length).trimStart() : original;
	const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? slugs.get(file);
	titles.set(file, title);
	// Code examples remain byte-for-byte intact, including Mermaid diagrams.
	body = body
		.split(/(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$)/gm)
		.filter((_, index) => index % 3 !== 2)
		.map((part, index) =>
			index % 2 === 1
				? part
				: part.replace(
						/(\[[^\]\n]*\]\()(?:<([^>\n]+)>|([^\s)]+))([^\n]*?\))/g,
						(_, start, angle, plain, end) => `${start}${rewriteTarget(file, angle ?? plain)}${end}`,
					),
		)
		.join("");
	if (frontmatter) {
		body += `\n\n<details>\n<summary>Source and generation metadata</summary>\n\n\`\`\`yaml\n${frontmatter[1]}\n\`\`\`\n\n</details>\n`;
	}
	if (file === "index.md") {
		body = body.replace(/^# Wiki\s*/m, "# Clio Coder Wiki\n\n");
		body = body.replace(
			"# Clio Coder Wiki\n\n",
			`# Clio Coder Wiki\n\nStart with the [overview](${wiki}/Quickstart), [architecture](${wiki}/Architecture), or [command-line surfaces](${wiki}/Cli).\n\n`,
		);
	}
	pages.set(`${slugs.get(file)}.md`, `${body.trimEnd()}\n`);
}
const sidebar = [
	`[Home](${wiki}/Home) · [Overview](${wiki}/Quickstart)`,
	"",
	...files.filter((file) => file !== "index.md").map((file) => `- [${titles.get(file)}](${wiki}/${slugs.get(file)})`),
	"",
].join("\n");
const snapshot = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const footer = `Clio Coder · [Repository](${repository}) · [Website](https://coder.iowarp.ai) · [Documentation](${repository}/tree/${encodePath(reference)}/docs)\n\nWiki v0.1 · Developing implementation reference · Source snapshot: \`${snapshot.slice(0, 9)}\`. Authored architecture documents define the product contracts.\n`;
pages.set("_Sidebar.md", sidebar);
pages.set("_Footer.md", footer);
// Resolve everything before writing: a broken link must not produce a partial export.
mkdirSync(output, { recursive: true });
for (const [filename, content] of pages) writeFileSync(path.join(output, filename), content);
console.log(`Exported ${files.length} pages plus sidebar and footer; rewrote ${rewrittenLinks} relative links.`);
console.log(`Source snapshot: ${snapshot}; output: ${output}`);
