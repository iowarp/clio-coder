#!/usr/bin/env node
// Every guide is HTML before it reaches a browser. No dependency installation needed.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as markedModule from "./vendor/marked.min.js";

// The standalone Docker context loads UMD as CommonJS; the repository is ESM.
const marked = markedModule.default ?? globalThis.marked;

const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out ?? join(root, "public"));
if (out === "/" || out === root || root.startsWith(`${out}/`)) throw new Error("Output must not replace source files.");
const product = JSON.parse(await readFile(join(root, "product.json"), "utf8"));
const docsManifest = JSON.parse(await readFile(join(root, "content/docs-manifest.json"), "utf8"));
const origin = product.origin;
const escapeHtml = (text) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const index = JSON.parse(await readFile(join(root, "content/index.json"), "utf8"));
const docs = new Set(index.map((item) => item.path));
const sourceRef = docsManifest.source.ref;
const sourceCommit = docsManifest.source.commit;
const sourceVersion = docsManifest.source.version;
if (sourceVersion !== product.version)
	throw new Error("Documentation source version differs from the website version.");
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Documentation source commit is not a full Git commit.");
if (docsManifest.files.some((item) => item.path === "wiki" || item.path.startsWith("wiki/")))
	throw new Error("Generated Wiki pages cannot enter the product documentation snapshot.");
const sourceRefPath = sourceRef.split("/").map(encodeURIComponent).join("/");
const repository = product.repository.replace(/\/$/, "");
const docUrl = (path) => (path === "README.md" ? "/docs.html" : `/docs/${path.replace(/\.md$/, ".html")}`);
const version = product.version;
const recordings = JSON.parse(await readFile(join(root, "content/recordings.json"), "utf8"));
const template = await readFile(join(root, "docs.html"), "utf8");
const urls = [];
const home = await readFile(join(root, "index.html"), "utf8");
const mast = home.match(/<header class="mast">[\s\S]*?<\/header>/)[0];
const colophon = home.match(/<footer class="colophon">[\s\S]*?<\/footer>/)[0];

function shell(html, path) {
	const active = path.startsWith("/docs/") ? "/docs.html" : path;
	const header = mast.replace(
		/href="([^"]+)"/g,
		(_all, href) =>
			`href="${href}"${(href === "index.html" ? "/" : `/${href}`) === active ? ' aria-current="page"' : ""}`,
	);
	return html
		.replace(/<header class="mast">[\s\S]*?<\/header>/, header)
		.replace(/<footer class="colophon">[\s\S]*?<\/footer>/, colophon)
		.replace(/<p class="spine">/, '<p class="spine" aria-hidden="true">');
}

function links(html) {
	return html.replace(/(href|src)="([^"\s]+)"/g, (all, attr, url) => {
		if (url === "index.html") return `${attr}="/"`;
		if (/^(?:[a-z]+:|\/|#)/i.test(url)) return all;
		if (url.startsWith("docs.html?d=")) {
			const u = new URL(url, origin),
				target = u.searchParams.get("d");
			if (docs.has(target)) return `${attr}="${docUrl(target)}${u.hash}"`;
		}
		return `${attr}="/${url}"`;
	});
}

function metadata(html, path, title, description, type = "WebPage") {
	const canonical = `${origin}${path}`;
	if (title) html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`);
	if (description)
		html = html.replace(
			/<meta\s+name="description"[^>]*>/,
			`<meta name="description" content="${escapeHtml(description)}">`,
		);
	const pageTitle = title ?? html.match(/<title>(.*?)<\/title>/s)?.[1]?.trim();
	const pageDescription = description ?? html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1];
	html = html.replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${canonical}">`);
	for (const [key, value] of [
		["og:url", canonical],
		["og:title", pageTitle],
		["og:description", pageDescription],
		["twitter:title", pageTitle],
		["twitter:description", pageDescription],
	]) {
		html = html.replace(
			new RegExp(`<meta\\s+(?:property|name)="${key}"[^>]*>`),
			`<meta ${key.startsWith("og:") ? "property" : "name"}="${key}" content="${escapeHtml(value)}">`,
		);
	}
	html = html.replace(/<script type="application\/ld\+json">.*?<\/script>\s*/gs, "");
	const graph = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${origin}/#website`,
				url: `${origin}/`,
				name: "Clio Coder",
				publisher: { "@id": `${origin}/#organization` },
			},
			{
				"@type": "Organization",
				"@id": `${origin}/#organization`,
				name: "IOWarp",
				url: "https://iowarp.ai",
				logo: `${origin}/assets/logo-512.webp`,
			},
			{
				"@type": type,
				"@id": `${canonical}#page`,
				url: canonical,
				name: pageTitle,
				description: pageDescription,
				isPartOf: { "@id": `${origin}/#website` },
				inLanguage: "en",
			},
		],
	};
	if (path === "/")
		graph["@graph"].push({
			"@type": "SoftwareSourceCode",
			name: "Clio Coder",
			description: pageDescription,
			codeRepository: "https://github.com/iowarp/clio-coder",
			programmingLanguage: "TypeScript",
			runtimePlatform: "Node.js 22.19 or newer",
			version,
			license: "https://www.apache.org/licenses/LICENSE-2.0",
			url: origin,
			author: { "@type": "Organization", name: "Gnosis Research Center", url: "https://grc.iit.edu" },
		});
	if (type === "TechArticle" && path !== "/docs.html")
		graph["@graph"].push({
			"@type": "BreadcrumbList",
			itemListElement: [
				{ "@type": "ListItem", position: 1, name: "Clio Coder", item: origin },
				{ "@type": "ListItem", position: 2, name: "Documentation", item: `${origin}/docs.html` },
				{ "@type": "ListItem", position: 3, name: pageTitle, item: canonical },
			],
		});
	return html.replace(
		"</head>",
		`<meta name="robots" content="index,follow,max-image-preview:large">\n<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>\n</head>`,
	);
}

function renderDoc(path, markdown) {
	const seen = new Map();
	let tableNumber = 0;
	let previousDepth = 1;
	const renderer = new marked.Renderer();
	const target = (href, image = false) => {
		if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
		if (href.includes("clio-coder-logo")) return "/assets/logo.webp";
		const [file, hash] = href.split("#");
		const local = posix.normalize(posix.join(posix.dirname(path), file));
		if (docs.has(local)) return `${docUrl(local)}${hash ? `#${hash}` : ""}`;
		const repo = posix.normalize(posix.join("docs", posix.dirname(path), file));
		const base = image
			? `https://raw.githubusercontent.com/iowarp/clio-coder/${sourceRefPath}`
			: `${repository}/blob/${sourceRefPath}`;
		return `${base}/${repo}${hash ? `#${hash}` : ""}`;
	};
	renderer.heading = function ({ tokens, depth }) {
		depth = Math.min(depth, previousDepth + 1);
		previousDepth = depth;
		const text = this.parser.parseInline(tokens);
		const base = text
			.replace(/<[^>]+>/g, "")
			.replace(/&[^;]+;/g, "")
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const duplicate = seen.get(base) ?? 0;
		seen.set(base, duplicate + 1);
		const id = duplicate ? `${base}-${duplicate}` : base;
		// Older reader links omitted underscores; retain those fragment targets.
		const legacy = id.replaceAll("_", "");
		const alias = legacy !== id ? `<span id="${escapeHtml(legacy)}" aria-hidden="true"></span>` : "";
		return `${alias}<h${depth} id="${escapeHtml(id)}">${text}</h${depth}>\n`;
	};
	renderer.link = function ({ href, title, tokens }) {
		if (/^(?:javascript|data|vbscript):/i.test(href)) return this.parser.parseInline(tokens);
		return `<a href="${escapeHtml(target(href))}"${title ? ` title="${escapeHtml(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
	};
	renderer.image = ({ href, title, text }) =>
		`<img src="${escapeHtml(target(href, true))}" alt="${escapeHtml(text)}" loading="lazy"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
	return marked
		.parse(markdown, { gfm: true, renderer })
		.replace(
			/<table>/g,
			() => `<div class="doc-table" role="region" aria-label="Documentation table ${++tableNumber}" tabindex="0"><table>`,
		)
		.replace(/<\/table>/g, "</table></div>")
		.replace(
			/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
			'<div class="diagram"><p class="diagram-label">Diagram source · Mermaid</p><pre><code>$1</code></pre></div>',
		);
}

// Only replace an output directory previously created by this builder.
const marker = join(out, ".clio-coder-site-build");
const existing = await readdir(out).catch((error) => {
	if (error.code === "ENOENT") return [];
	throw error;
});
if (
	existing.length &&
	(!existing.includes(".clio-coder-site-build") || (await readFile(marker, "utf8")) !== `${root}\n`)
) {
	throw new Error("Refusing to replace a nonempty directory that this builder does not own.");
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(marker, `${root}\n`);
for (const dir of ["assets", "css", "js", "content", "cards"])
	await cp(join(root, dir), join(out, dir), { recursive: true });
for (const name of await readdir(root)) {
	if (!name.endsWith(".html") || name === "docs.html") continue;
	const path = name === "index.html" ? "/" : `/${name}`;
	let html = links(shell(await readFile(join(root, name), "utf8"), path));
	if (name === "learn.html") {
		const published = recordings.filter((item) => /^[a-zA-Z0-9_-]{11}$/.test(item.id));
		const films = published.length
			? `<section class="published-recordings" aria-label="Video walkthroughs"><h2>Video walkthroughs</h2>${published.map((item) => `<figure><iframe loading="lazy" src="https://www.youtube-nocookie.com/embed/${item.id}" title="${escapeHtml(item.title)}" allowfullscreen></iframe><figcaption><a href="#${escapeHtml(item.lab)}">${escapeHtml(item.title)}</a></figcaption></figure>`).join("\n")}</section>`
			: "";
		html = html.replace("<!-- clio-coder-recordings -->", films);
	}
	let codeNumber = 0;
	html = html.replace(/<pre>/g, () => `<pre tabindex="0" aria-label="Code example ${++codeNumber}">`);
	if (name !== "404.html") {
		html = metadata(html, path);
		urls.push(path);
	} else if (!html.includes('name="robots"'))
		html = html.replace("</head>", '<meta name="robots" content="noindex">\n</head>');
	await writeFile(join(out, name), html);
}
const startPaths = [
	"README.md",
	"guide/installation-and-lifecycle.md",
	"guide/configuration-and-targets.md",
	"guide/commands-and-modes.md",
	"guide/tool-usage.md",
	"guide/doctor.md",
	"guide/troubleshooting.md",
];
const nav = [
	["Start here", startPaths.map((path) => index.find((item) => item.path === path)).filter(Boolean)],
	["Working with Clio", index.filter((item) => item.path.startsWith("guide/") && !startPaths.includes(item.path))],
	["Architecture", index.filter((item) => item.path.startsWith("architecture/"))],
]
	.map(
		([label, items]) =>
			`<h2>${label}</h2>${items.map((item) => `<a href="${docUrl(item.path)}">${escapeHtml(item.title)}</a>`).join("\n")}`,
	)
	.join("\n");
for (const item of index) {
	const markdown = await readFile(join(root, "content/docs", item.path), "utf8");
	const rendered = renderDoc(item.path, markdown);
	const headings = [...rendered.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
	const tocLinks = headings.map(([, id, text]) => `<a href="#${id}">${text.replace(/<[^>]+>/g, "")}</a>`).join("\n");
	const mobileToc = headings.length
		? `<details class="doc-toc-mobile"><summary>On this page</summary>${tocLinks}</details>`
		: "";
	let html = shell(template, docUrl(item.path))
		.replace(
			/<div class="doc" id="doc">\s*<p>Opening the page…<\/p>\s*<\/div>/,
			`<div class="doc" id="doc" data-doc="${escapeHtml(item.path)}">${mobileToc}${rendered}</div>`,
		)
		.replace(
			/id="doc-snapshot-source"\s+href="[^"]*"/,
			`id="doc-snapshot-source" href="${repository}/tree/${sourceRefPath}/docs" data-source-version="${escapeHtml(sourceVersion)}" data-source-ref="${escapeHtml(sourceRef)}" data-source-commit="${escapeHtml(sourceCommit)}"`,
		)
		.replace(
			'<span id="doc-snapshot-label">declared release source</span>',
			`<span id="doc-snapshot-label">v${escapeHtml(sourceVersion)} at ${escapeHtml(sourceRef)} (${escapeHtml(sourceCommit.slice(0, 12))})</span>`,
		);
	html = html.replace(
		'<div id="doc-toc"></div>',
		headings.length ? `<div id="doc-toc"><h2>On this page</h2>${tocLinks}</div>` : '<div id="doc-toc"></div>',
	);
	html = html.replace(
		'<div id="all-docs"></div>',
		`<div id="all-docs">${nav.replaceAll(`href="${docUrl(item.path)}"`, `href="${docUrl(item.path)}" aria-current="page"`)}</div>`,
	);
	html = html
		.replace('<p id="doc-path">README.md</p>', `<p id="doc-path">${escapeHtml(item.path)}</p>`)
		.replace(
			/id="doc-github"\s+href="[^"]*"/,
			`id="doc-github" href="${repository}/blob/${sourceRefPath}/docs/${item.path}"`,
		);
	html = links(html).replaceAll("/assets/clio-coder-logo-128.webp", "/assets/logo.webp");
	const path = docUrl(item.path);
	let codeNumber = 0;
	html = html.replace(/<pre>/g, () => `<pre tabindex="0" aria-label="Code example ${++codeNumber}">`);
	html = metadata(
		html,
		path,
		`${item.title} — Clio Coder documentation`,
		item.excerpt || `Read the ${item.title} guide for Clio Coder.`,
		"TechArticle",
	);
	await mkdir(dirname(join(out, path)), { recursive: true });
	await writeFile(join(out, path), html);
	urls.push(path);
}
await writeFile(
	join(out, "content/index.json"),
	`${JSON.stringify(
		index.map((item) => ({ ...item, url: docUrl(item.path) })),
		null,
		2,
	)}\n`,
);
await writeFile(
	join(out, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((path) => `  <url><loc>${origin}${escapeHtml(path)}</loc></url>`).join("\n")}\n</urlset>\n`,
);
await cp(join(root, "robots.txt"), join(out, "robots.txt"));
console.log(`Built ${urls.length} indexable pages (${index.length} documentation pages) into ${out}`);
