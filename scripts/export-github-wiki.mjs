#!/usr/bin/env node
/**
 * Turn a generated wiki tree into a GitHub wiki checkout.
 *
 * Fails closed: it writes nothing unless the tree is a complete publication
 * whose links resolve and whose text passes the private-material scan. It never
 * commits or pushes.
 *
 *   node scripts/export-github-wiki.mjs --from <wiki-dir> --to <wiki-checkout>
 *     [--repo <source-checkout>] [--ref <commit>] [--deny-file <path>]
 *
 * `--deny-file` holds one case-insensitive regular expression per line, so a
 * maintainer's host names and retired vocabulary stay out of this repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/iowarp/clio-coder";
const WIKI = `${REPOSITORY}/wiki`;
const WEBSITE = "https://coder.iowarp.ai";
const WIKI_TITLE = "Clio Coder Wiki";

/** Private material no public page may carry. Matched values are never echoed. */
const PRIVATE_PATTERNS = [
	["local home path", /(?:^|[\s`"'(=:])\/(?:home|Users)\/[A-Za-z0-9._-]+/gm],
	["local home path", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g],
	[
		"private network address",
		/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
	],
	["private directory", /(?:^|[\s`"'(/])\.mine\b/gm],
	["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
	["Anthropic token", /\bsk-ant-[A-Za-z0-9_-]{8,}/g],
	["API token", /\bsk-[A-Za-z0-9]{20,}/g],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
	["AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
	["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
	["Hugging Face token", /\bhf_[A-Za-z0-9]{20,}/g],
	["JSON web token", /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./g],
	["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g],
];

function parseArguments(argv) {
	const options = { repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") };
	const names = new Map([
		["--from", "from"],
		["--to", "to"],
		["--repo", "repo"],
		["--ref", "ref"],
		["--deny-file", "denyFile"],
	]);
	for (let index = 0; index < argv.length; index += 2) {
		const name = names.get(argv[index]);
		const value = argv[index + 1];
		if (!name || value === undefined) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
		options[name] = path.isAbsolute(value) || name === "ref" ? value : path.resolve(value);
	}
	if (!options.from || !options.to)
		throw new Error("Usage: export-github-wiki.mjs --from <wiki-dir> --to <wiki-checkout>");
	return options;
}

function git(repo, ...args) {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 1 << 28,
	});
}

/** GitHub's flat page name. `domains/system-one.md` becomes `Domains-System-One`. */
function slugFor(file) {
	if (file === "quickstart.md" || file === "index.md") return "Home";
	return file
		.replace(/\.md$/, "")
		.split(/[/-]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("-");
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
function anchorFor(heading) {
	return heading
		.replace(/`/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
}

/** Apply `transform` to prose only. Fenced code stays byte-for-byte intact. */
function mapProse(body, transform) {
	return body
		.split(/(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$)/gm)
		.filter((_, index) => index % 3 !== 2)
		.map((part, index) => (index % 2 === 1 ? part : transform(part)))
		.join("");
}

function encodePath(value) {
	return value.split("/").map(encodeURIComponent).join("/");
}

function listMarkdown(root) {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
		.filter((file) => !file.split("/").some((part) => part.startsWith("_")))
		.sort();
}

function splitFrontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
	return match ? { yaml: match[1], body: text.slice(match[0].length).trimStart() } : { yaml: null, body: text };
}

/** A complete publication only: a partial or uncertified tree must not reach readers. */
function readCertification(from, problems) {
	const metaPath = path.join(from, "meta.json");
	if (!existsSync(metaPath)) {
		problems.push(`${metaPath}: missing generation metadata`);
		return null;
	}
	const meta = JSON.parse(readFileSync(metaPath, "utf8"));
	const { pagesPlanned, pagesWritten } = meta.generation ?? {};
	if (pagesPlanned === undefined || pagesPlanned !== pagesWritten) {
		problems.push(`meta.json: incomplete generation, ${pagesWritten ?? "?"} of ${pagesPlanned ?? "?"} pages written`);
	}
	if (!meta.gitHead) problems.push("meta.json: no certified source commit");
	return meta;
}

function renderPages(options, meta, ref, problems) {
	const { from } = options;
	const tracked = new Set(git(options.repo, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean));
	const blob = (repoPath, suffix = "") => `${REPOSITORY}/blob/${ref}/${encodePath(repoPath)}${suffix}`;
	const files = listMarkdown(from).filter((file) => file !== "index.md");
	if (!files.includes("quickstart.md")) problems.push("Missing quickstart.md, which becomes the Home page");
	const slugs = new Map([...files.map((file) => [file, slugFor(file)]), ["index.md", "Home"]]);
	const flat = files.map((file) => slugFor(file).toLowerCase());
	for (const name of new Set(flat.filter((slug, index) => flat.indexOf(slug) !== index))) {
		problems.push(`Page names collide after flattening: ${name}`);
	}

	const rewriteLink = (file, target) => {
		if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) return target;
		const [, pathname, suffix = ""] = /^([^?#]*)([?#].*)?$/.exec(target);
		const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(pathname)));
		if (slugs.has(resolved)) return `${WIKI}/${slugs.get(resolved)}${suffix}`;
		// A link that climbs out of the wiki tree is relative to docs/wiki in the source checkout.
		const repoPath = path.posix.normalize(path.posix.join("docs/wiki", resolved));
		if (tracked.has(repoPath)) return blob(repoPath, suffix);
		if (tracked.has(resolved)) return blob(resolved, suffix);
		problems.push(`${file}: unresolved link ${target}`);
		return target;
	};
	/** A backticked repository path becomes a source link pinned to the generating commit. */
	const linkCitations = (text) =>
		text.replace(/(?<![[\w])`([^`\n]+)`(?!\]\()/g, (whole, span) => {
			const match = /^([\w@./-]+?)(?::(\d+)(?:-(\d+))?(?::[\w$.]+)?)?$/.exec(span);
			if (!match || !tracked.has(match[1])) return whole;
			const lines = match[2] ? `#L${match[2]}${match[3] ? `-L${match[3]}` : ""}` : "";
			return `[\`${span}\`](${blob(match[1], lines)})`;
		});

	const pages = new Map();
	const titles = new Map();
	for (const file of files) {
		const { yaml, body: original } = splitFrontmatter(readFileSync(path.join(from, file), "utf8"));
		const title = /^title:\s*"?(.+?)"?\s*$/m.exec(yaml ?? "")?.[1] ?? /^#\s+(.+)$/m.exec(original)?.[1] ?? slugFor(file);
		titles.set(file, title);
		let body = mapProse(original, (prose) =>
			linkCitations(
				prose.replace(
					/(\[[^\]\n]*\]\()(?:<([^>\n]+)>|([^\s)]+))([^\n]*?\))/g,
					(_, start, angle, plain, end) => `${start}${rewriteLink(file, angle ?? plain)}${end}`,
				),
			),
		);
		if (yaml) {
			body += `\n\n<details>\n<summary>Source and generation metadata</summary>\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n</details>`;
		}
		if (file === "quickstart.md") {
			const commit = `[\`${ref.slice(0, 9)}\`](${REPOSITORY}/tree/${ref})`;
			const stamp = `Generated from ${commit} on ${String(meta.updatedAt).slice(0, 10)} by \`clio-coder context wiki\`. This is an implementation reference. The [authored documentation](${REPOSITORY}/tree/${ref}/docs) defines product contracts.`;
			body = body.replace(/^#\s+.*$/m, `# ${WIKI_TITLE}\n\n${stamp}`);
		}
		pages.set(`${slugFor(file)}.md`, `${body.trimEnd()}\n`);
	}

	const sections = new Map();
	for (const file of files) {
		if (file === "quickstart.md" || path.posix.basename(file) === "index.md") continue;
		const section = file.includes("/") ? file.split("/")[0] : "";
		sections.set(section, [...(sections.get(section) ?? []), file]);
	}
	const sidebar = [`**[Home](${WIKI}/Home)**`, ""];
	for (const section of [...sections.keys()].sort()) {
		if (section) sidebar.push(`**${section.charAt(0).toUpperCase()}${section.slice(1)}**`, "");
		for (const file of sections.get(section)) sidebar.push(`- [${titles.get(file)}](${WIKI}/${slugFor(file)})`);
		sidebar.push("");
	}
	pages.set("_Sidebar.md", sidebar.join("\n"));
	pages.set(
		"_Footer.md",
		`Clio Coder · [Repository](${REPOSITORY}) · [Website](${WEBSITE}) · [Documentation](${REPOSITORY}/tree/${ref}/docs)\n\n` +
			`Generated from \`${ref.slice(0, 9)}\` on ${String(meta.updatedAt).slice(0, 10)} with ${meta.model}. Source links are pinned to that commit.\n`,
	);
	return pages;
}

/** Every wiki link and heading anchor in the finished output must land on something. */
function checkInternalLinks(pages, problems) {
	const anchors = new Map();
	for (const [name, text] of pages) {
		const found = new Set();
		mapProse(text, (prose) => {
			for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) found.add(anchorFor(match[1]));
			return prose;
		});
		anchors.set(name.replace(/\.md$/, ""), found);
	}
	const wikiLink = new RegExp(`${WIKI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^\\s)#"]+)(?:#([^\\s)"]+))?`, "g");
	for (const [name, text] of pages) {
		mapProse(text, (prose) => {
			for (const match of prose.matchAll(wikiLink)) {
				const known = anchors.get(match[1]);
				if (!known) problems.push(`${name}: link to missing page ${match[1]}`);
				else if (match[2] && !known.has(decodeURIComponent(match[2]))) {
					problems.push(`${name}: link to missing anchor ${match[1]}#${match[2]}`);
				}
			}
			return prose;
		});
	}
}

function scanPrivateMaterial(pages, denyFile, problems) {
	const patterns = [...PRIVATE_PATTERNS];
	if (denyFile) {
		for (const line of readFileSync(denyFile, "utf8").split(/\r?\n/)) {
			const source = line.trim();
			if (source && !source.startsWith("#")) patterns.push(["denied term", new RegExp(source, "gi")]);
		}
	}
	for (const [name, text] of pages) {
		const lines = text.split("\n");
		for (const [label, pattern] of patterns) {
			lines.forEach((line, index) => {
				pattern.lastIndex = 0;
				if (!pattern.test(line)) return;
				// A denied term is the maintainer's own list, so naming the pattern exposes nothing new.
				problems.push(`${name}:${index + 1}: ${label}${label === "denied term" ? ` /${pattern.source}/` : ""}`);
			});
		}
	}
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const relativeTarget = path.relative(options.repo, options.to);
	if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget))) {
		throw new Error("Export into a separate checkout outside the source repository.");
	}
	const problems = [];
	const meta = readCertification(options.from, problems);
	if (!meta) return fail(problems);
	const ref = options.ref ?? meta.gitHead;
	if (!ref) return fail(problems);
	const commit = git(options.repo, "rev-parse", "--verify", `${ref}^{commit}`).trim();
	const pages = renderPages(options, meta, commit, problems);
	checkInternalLinks(pages, problems);
	scanPrivateMaterial(pages, options.denyFile, problems);
	if (problems.length > 0) return fail(problems);

	mkdirSync(options.to, { recursive: true });
	const kept = new Set([".git"]);
	const previous = readdirSync(options.to).filter((name) => !kept.has(name));
	for (const name of previous) rmSync(path.join(options.to, name), { recursive: true, force: true });
	for (const [name, text] of pages) writeFileSync(path.join(options.to, name), text);
	process.stdout.write(
		`Exported ${pages.size} files from ${commit}, replacing ${previous.length}. Nothing committed.\n`,
	);
	return 0;
}

function fail(problems) {
	process.stderr.write(`Export refused, nothing written. ${problems.length} problem(s):\n`);
	for (const problem of problems) process.stderr.write(`  ${problem}\n`);
	return 1;
}

try {
	process.exitCode = main();
} catch (error) {
	process.stderr.write(`Export refused, nothing written: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
