#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkPolicy } from "./policy.mjs";
import * as markedModule from "./vendor/marked.min.js";

const marked = markedModule.default ?? globalThis.marked;
const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" }, revision: { type: "string" } } });
if (values.revision && !/^[a-f0-9]{40}$/.test(values.revision))
	throw new Error("Site revision must be a full Git commit.");
const out = resolve(values.out ?? join(root, "public"));
if (out === "/" || out === root || root.startsWith(`${out}/`)) throw new Error("Output must not replace source files.");
await checkPolicy();
const read = (name) => readFile(join(root, name), "utf8");
const product = JSON.parse(await read("product.json"));
const brand = JSON.parse(await read("design-system.json"));
const manifest = JSON.parse(await read("content/docs-manifest.json"));
const index = JSON.parse(await read("content/index.json"));
const catalog = JSON.parse(await read("public-docs.json"));
const tutorials = JSON.parse(await read("content/tutorials.json"));
const redirects = JSON.parse(await read("redirects.json"));
const imageVariants = JSON.parse(await read("image-variants.json"));
for (const [source, item] of Object.entries(imageVariants)) {
	for (const asset of [{ path: source, sha256: item.sha256 }, ...item.variants]) {
		if (!/^assets\/[a-z0-9/.-]+$/.test(asset.path)) throw new Error("Invalid responsive asset path.");
		const bytes = await readFile(join(root, asset.path));
		if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
			throw new Error(`Responsive asset changed; regenerate image variants: ${asset.path}`);
	}
}
for (const [path, target] of Object.entries(redirects)) {
	if (!/^\/[a-z0-9/.-]+\.html$/.test(path) || !/^\/[a-z0-9/.-]*(?:#[a-z0-9_-]+)?$/.test(target))
		throw new Error("Redirects must be static local URLs.");
}
const escapeHtml = (text) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const docUrl = (path) => (path === "README.md" ? "/docs.html" : `/docs/${path.replace(/\.md$/, ".html")}`);
const source = manifest.source;
if (source.version !== product.version) throw new Error("Documentation and site source versions differ.");
if (!/^[a-f0-9]{40}$/.test(source.commit)) throw new Error("Documentation source commit is invalid.");
if (JSON.stringify(index.map((item) => item.path)) !== JSON.stringify(catalog.map((item) => item.path)))
	throw new Error("Documentation index differs from the public allowlist.");
if (manifest.files.length !== catalog.length)
	throw new Error("Documentation manifest differs from the public allowlist.");
const ref = source.ref.split("/").map(encodeURIComponent).join("/");
const repository = product.repository.replace(/\/$/, "");
const sourceMap = new Map(index.map((item) => [item.source, docUrl(item.path)]));
const slug = (text) =>
	text
		.replace(/<[^>]+>/g, "")
		.replace(/&[^;]+;/g, "")
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
const anchors = new Map();
for (const item of index) {
	const tokens = marked.lexer(await read(`content/docs/${item.path}`));
	anchors.set(
		item.source,
		new Set(tokens.filter((token) => token.type === "heading").map((token) => slug(marked.parseInline(token.text)))),
	);
}
const partials = await read("partials.html");
const mast = partials.match(/<header class="mast">[\s\S]*?<\/header>/)[0];
const footer = partials.match(/<footer class="colophon[\s\S]*?<\/footer>/)[0];
const urls = [];

function responsiveImages(html, path) {
	return html.replace(/<img\b[^>]+>/g, (tag) => {
		const source = tag.match(/src="\/([^"]+)"/)?.[1];
		const item = imageVariants[source];
		if (!item) return tag;
		const clio = source === "assets/brand/clio-mark.webp";
		const parent = source === "assets/brand/iowarp-mark.webp";
		const hero = tag.includes('class="hero-capture"');
		const article = path.startsWith("/tutorials/") || path.startsWith("/docs");
		const sizes = clio
			? "36px"
			: parent
				? "(max-width: 600px) 130px, 220px"
				: article
					? "(max-width: 600px) calc(100vw - 40px), (max-width: 850px) calc(100vw - 64px), 760px"
					: hero
						? "(max-width: 600px) calc(100vw - 64px), (max-width: 850px) calc(100vw - 96px), (max-width: 1344px) calc(100vw - 128px), 1216px"
						: "(max-width: 600px) calc(100vw - 40px), (max-width: 850px) calc((100vw - 96px) / 2), (max-width: 1344px) calc((100vw - 128px) / 2), 600px";
		const srcset = [...item.variants, { path: source, width: item.width }]
			.map((v) => `/${v.path} ${v.width}w`)
			.join(", ");
		if (clio) tag = tag.replace(`src="/${source}"`, `src="/${item.variants[1].path}"`);
		if (!/\bwidth=/.test(tag)) tag = tag.replace("<img", `<img width="${item.width}" height="${item.height}"`);
		return tag
			.replace(/\s*\/?>(?=$)/, ` srcset="${srcset}" sizes="${sizes}" decoding="async">`)
			.replace(/ decoding="async"(?=[\s\S]* decoding="async")/, "");
	});
}
function head(path, title, description, type = "WebPage") {
	const url = `${product.origin}${path}`;
	const graph = {
		"@context": "https://schema.org",
		"@graph": [
			{ "@type": "WebSite", "@id": `${product.origin}/#site`, name: "Clio Coder", url: `${product.origin}/` },
			{
				"@type": type,
				"@id": `${url}#page`,
				name: title,
				description,
				url,
				isPartOf: { "@id": `${product.origin}/#site` },
				inLanguage: "en",
			},
		],
	};
	const page = graph["@graph"][1];
	if (type === "TechArticle") {
		page.headline = title.replace(/ — Clio Coder(?: tutorials)?$/, "");
		page.mainEntityOfPage = url;
		page.author = { "@type": "Organization", name: "The Clio team", url: `${product.origin}/#project` };
		page.image = `${product.origin}${tutorials.find((item) => path === `/tutorials/${item.slug}.html`)?.image ?? "/assets/social-card.png"}`;
	}
	if (path !== "/" && path !== "/404.html") {
		const parent = path.startsWith("/docs/")
			? { name: "Docs", path: "/docs.html" }
			: path.startsWith("/tutorials/")
				? { name: "Tutorials", path: "/learn.html" }
				: null;
		const crumbs = [
			{ name: "Clio Coder", path: "/" },
			...(parent ? [parent] : []),
			{ name: title.replace(/ — Clio Coder(?: tutorials)?$/, ""), path },
		];
		graph["@graph"].push({
			"@type": "BreadcrumbList",
			"@id": `${url}#breadcrumbs`,
			itemListElement: crumbs.map((crumb, i) => ({
				"@type": "ListItem",
				position: i + 1,
				name: crumb.name,
				item: `${product.origin}${crumb.path}`,
			})),
		});
		page.breadcrumb = { "@id": `${url}#breadcrumbs` };
	}
	if (path === "/")
		graph["@graph"].push({
			"@type": "SoftwareSourceCode",
			name: "Clio Coder",
			codeRepository: repository,
			programmingLanguage: "TypeScript",
			version: product.version,
			license: `${repository}/blob/main/LICENSE`,
			author: { "@type": "Person", name: "Anthony Kougkas" },
		});
	return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="color-scheme" content="dark light"><meta name="clio-default-theme" content="${escapeHtml(brand.defaultTheme)}"><meta name="theme-color" content="${escapeHtml(brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper])}">
<link rel="canonical" href="${url}"><link rel="icon" href="/assets/responsive/clio-icon-32.png" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="/assets/responsive/clio-icon-180.png" sizes="180x180">
<link rel="preload" href="/assets/fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/fonts/news-normal-500.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/brand.css"><link rel="stylesheet" href="/css/site.css"><script src="/js/theme.js"></script>
<meta property="og:site_name" content="Clio Coder"><meta property="og:type" content="${type === "TechArticle" ? "article" : "website"}"><meta property="og:url" content="${url}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${product.origin}/assets/social-card.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Clio Coder. An open-source coding agent for scientific software.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${product.origin}/assets/social-card.png"><meta name="twitter:image:alt" content="Clio Coder. An open-source coding agent for scientific software.">
<meta name="robots" content="${path === "/404.html" ? "noindex" : "index,follow,max-image-preview:large"}"><script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}
function shell(html, path, title, description, type) {
	const active = path.startsWith("/docs/") ? "/docs.html" : path.startsWith("/tutorials/") ? "/learn.html" : path;
	const header = mast.replace(/href="(\/|\/docs.html|\/learn.html)"/g, (all, href) =>
		href === active ? `${all} aria-current="page"` : all,
	);
	let number = 0;
	const result = html
		.replace("<!-- site-head -->", head(path, title, description, type))
		.replace("<!-- site-header -->", header)
		.replace("<!-- site-footer -->", footer)
		.replace("<!-- version -->", escapeHtml(product.version))
		.replace("<!-- version-source -->", `${repository}/tree/${ref}`)
		.replace(/<pre>/g, () => `<div class="code-block"><pre tabindex="0" aria-label="Code example ${++number}">`)
		.replace(/<\/pre>/g, "</pre></div>")
		.replace(
			/<span aria-hidden="true">([↗→←↓])<\/span>/g,
			(_, arrow) =>
				`<span class="arrow arrow-${{ "↗": "diagonal", "→": "forward", "←": "back", "↓": "down" }[arrow]}" aria-hidden="true">${arrow}</span>`,
		);
	return responsiveImages(
		result.replace(
			/ ([↗→←↓])(?=<\/a>)/g,
			(_, arrow) =>
				` <span class="arrow arrow-${{ "↗": "diagonal", "→": "forward", "←": "back", "↓": "down" }[arrow]}" aria-hidden="true">${arrow}</span>`,
		),
		path,
	);
}
function renderMarkdown(markdown, sourcePath) {
	const ids = new Map();
	const target = (href, image = false) => {
		if (/^(?:https?:|mailto:|\/)/i.test(href)) return href;
		if (href.startsWith("#"))
			return !anchors.has(sourcePath) || anchors.get(sourcePath).has(href.slice(1))
				? href
				: `${repository}/blob/${ref}/${sourcePath}${href}`;
		const [file, hash] = href.split("#");
		const normalized = posix.normalize(posix.join(posix.dirname(sourcePath), file));
		const url = sourceMap.get(normalized);
		if (url && (!hash || anchors.get(normalized)?.has(hash))) return `${url}${hash ? `#${hash}` : ""}`;
		if (image && normalized.startsWith("assets/")) {
			const known = {
				"assets/screenshots/tui-boot.webp": "/assets/tui-boot.webp",
				"assets/screenshots/gui-overview.webp": "/assets/gui-overview.webp",
				"assets/screenshots/gui-conversation.webp": "/assets/gui-conversation.webp",
			};
			if (known[normalized]) return known[normalized];
		}
		return `${repository}/blob/${ref}/${normalized}${hash ? `#${hash}` : ""}`;
	};
	const renderer = new marked.Renderer();
	renderer.heading = function ({ tokens, depth }) {
		const text = this.parser.parseInline(tokens);
		const base = slug(text);
		const count = ids.get(base) ?? 0;
		ids.set(base, count + 1);
		return `<h${depth} id="${escapeHtml(base + (count ? `-${count}` : ""))}">${text}</h${depth}>\n`;
	};
	renderer.link = function ({ href, tokens, title }) {
		if (/^(?:javascript|data|vbscript):/i.test(href)) return this.parser.parseInline(tokens);
		return `<a href="${escapeHtml(target(href))}"${title ? ` title="${escapeHtml(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
	};
	renderer.image = ({ href, text }) =>
		`<img src="${escapeHtml(target(href, true))}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">`;
	let table = 0;
	return marked
		.parse(markdown, { gfm: true, renderer })
		.replace(
			/<table>/g,
			() => `<div class="doc-table" role="region" aria-label="Reference table ${++table}" tabindex="0"><table>`,
		)
		.replace(/<\/table>/g, "</table></div>");
}
async function writePage(path, html, title, description, type) {
	const file = join(out, path === "/" ? "index.html" : path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	const result = shell(html, path, title, description, type);
	if (/<!--\s*(?:site-|doc-|tutorial-|source-|version)/.test(result))
		throw new Error(`Unresolved template slot in ${path}`);
	await writeFile(file, result);
	if (path !== "/404.html") urls.push(path);
}

const marker = ".clio-coder-site-build";
const existing = await readdir(out).catch((error) => {
	if (error.code === "ENOENT") return [];
	throw error;
});
if (existing.length && (!existing.includes(marker) || (await readFile(join(out, marker), "utf8")) !== `${root}\n`))
	throw new Error("Refusing to replace an output directory this builder does not own.");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(join(out, marker), `${root}\n`);
await mkdir(join(out, "assets/brand"), { recursive: true });
await mkdir(join(out, "assets/fonts"), { recursive: true });
for (const name of [
	"plex-sans.woff2",
	"plex-400.woff2",
	"plex-500.woff2",
	"news-normal-500.woff2",
	"news-italic-480.woff2",
	"IBM-Plex-Mono-OFL.txt",
	"IBM-Plex-Sans-OFL.txt",
	"Newsreader-OFL.txt",
])
	await cp(join(root, "assets/fonts", name), join(out, "assets/fonts", name));
await mkdir(join(out, "assets/responsive"), { recursive: true });
for (const path of [
	...Object.values(imageVariants).flatMap((item) => item.variants.map((v) => v.path)),
	"assets/responsive/clio-icon-32.png",
	"assets/responsive/clio-icon-180.png",
])
	await cp(join(root, path), join(out, path));
for (const name of [
	"gui-overview.webp",
	"gui-overview.png",
	"gui-conversation.webp",
	"gui-conversation.png",
	"tui-boot.webp",
	"tui-boot.png",
	"social-card.png",
	"social-card-light.png",
	"social-square.png",
	"social-square-light.png",
])
	await cp(join(root, "assets", name), join(out, "assets", name));
for (const name of ["clio-mark.webp", "clio-mark.png", "iowarp-mark.webp", "iowarp-mark.png"])
	await cp(join(root, "assets/brand", name), join(out, "assets/brand", name));
await mkdir(join(out, "css"));
for (const name of ["brand.css", "site.css"]) await cp(join(root, "css", name), join(out, "css", name));
await mkdir(join(out, "js"));
for (const name of ["theme.js", "site.js", "docs.js", "redirect.js"])
	await cp(join(root, "js", name), join(out, "js", name));
await mkdir(join(out, "content"));
await writeFile(join(out, "content/docs-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writePage(
	"/",
	await read("index.html"),
	"Clio Coder — AI coding for scientific software",
	"An open-source coding agent for scientific software. Work on your desktop or in your terminal, with local and cloud models you choose.",
);
await writePage(
	"/404.html",
	await read("404.html"),
	"Page not found — Clio Coder",
	"Find your way back to the Clio Coder overview, documentation, and tutorials.",
);

const groups = [...new Set(index.map((item) => item.group))];
const template = await read("docs.html");
for (const item of index) {
	const entry = manifest.files.find((file) => file.path === item.path);
	const markdown = await read(`content/docs/${item.path}`);
	if (createHash("sha256").update(markdown).digest("hex") !== entry?.sha256)
		throw new Error(`Documentation hash mismatch: ${item.path}`);
	const rendered = renderMarkdown(markdown, item.source);
	const headings = [...rendered.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
	const toc = headings.map(([, id, text]) => `<a href="#${id}">${text.replace(/<[^>]+>/g, "")}</a>`).join("\n");
	const nav = groups
		.map(
			(group) =>
				`<details class="doc-nav-group"${group === item.group || group === "Start" ? " open" : ""}><summary>${escapeHtml(group)}</summary>${index
					.filter((doc) => doc.group === group)
					.map(
						(doc) =>
							`<a href="${docUrl(doc.path)}"${doc.path === item.path ? ' aria-current="page"' : ""}>${escapeHtml(doc.title)}</a>`,
					)
					.join("\n")}</details>`,
		)
		.join("\n");
	const slots = {
		"doc-nav": nav,
		"doc-title": escapeHtml(item.title),
		"doc-source": `${repository}/blob/${ref}/${item.source}`,
		"doc-path": escapeHtml(item.path),
		"doc-content": `${toc ? `<details class="doc-toc-mobile"><summary>On this page</summary>${toc}</details>` : ""}${rendered}`,
		"doc-toc": toc ? `<h2>On this page</h2>${toc}` : "",
		"source-tree": `${repository}/tree/${ref}`,
		"source-version": escapeHtml(source.version),
		"source-ref": escapeHtml(source.ref),
		"source-commit": source.commit,
		"source-label":
			source.mode === "release" ? `Documentation · v${escapeHtml(source.version)}` : "From the project documentation",
	};
	let html = template;
	for (const [name, value] of Object.entries(slots)) html = html.replaceAll(`<!-- ${name} -->`, value);
	await writePage(docUrl(item.path), html, `${item.title} — Clio Coder docs`, item.excerpt, "TechArticle");
}
const search = index.map(
	({ path, source: _source, sections: _sections, stripDetails: _strip, includeIntro: _intro, ...item }) => ({
		path,
		...item,
		url: docUrl(path),
	}),
);
await writeFile(join(out, "content/index.json"), `${JSON.stringify(search, null, 2)}\n`);

const tutorialTemplate = await read("tutorial.html");
for (const item of tutorials) {
	const markdown = await read(`content/tutorials/${item.source}`);
	let html = tutorialTemplate;
	const slots = {
		"tutorial-title": escapeHtml(item.title),
		"tutorial-category": escapeHtml(item.category),
		"tutorial-time": escapeHtml(item.time),
		"tutorial-image": escapeHtml(item.image),
		"tutorial-alt": escapeHtml(item.alt),
		"tutorial-width": item.width,
		"tutorial-height": item.height,
		"tutorial-author": escapeHtml(item.author),
		"tutorial-content": renderMarkdown(markdown, `site/content/tutorials/${item.source}`),
		"tutorial-video": item.video
			? `<iframe class="video" loading="lazy" src="https://www.youtube-nocookie.com/embed/${item.video}" title="${escapeHtml(item.title)} recording" allowfullscreen></iframe>`
			: "",
	};
	for (const [name, value] of Object.entries(slots)) html = html.replaceAll(`<!-- ${name} -->`, value);
	await writePage(
		`/tutorials/${item.slug}.html`,
		html,
		`${item.title} — Clio Coder tutorials`,
		item.description,
		"TechArticle",
	);
}
const cards = tutorials
	.map(
		(item) =>
			`<a class="tutorial-card" href="/tutorials/${item.slug}.html"><img src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async"><p class="eyebrow">${escapeHtml(item.category)} / ${escapeHtml(item.time)}</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p><span class="text-link">Read the tutorial <span aria-hidden="true">↗</span></span></a>`,
	)
	.join("\n");
await writePage(
	"/learn.html",
	(await read("learn.html")).replace("<!-- tutorial-cards -->", cards),
	"Tutorials — Clio Coder",
	"Practical Clio Coder tutorials and product tours. Start a first session and explore the desktop and terminal interfaces.",
);

for (const [path, target] of Object.entries(redirects)) {
	const file = join(out, path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to Clio Coder</title><meta name="robots" content="noindex"><link rel="canonical" href="${product.origin}${escapeHtml(target)}"><link rel="stylesheet" href="/css/brand.css"><link rel="stylesheet" href="/css/site.css"><script src="/js/redirect.js" defer></script></head><body><main class="page page-intro"><h1>This page has moved.</h1><p><a data-redirect href="${escapeHtml(target)}">Continue to Clio Coder →</a></p></main></body></html>`,
	);
}
await writeFile(
	join(out, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((path) => `  <url><loc>${product.origin}${escapeHtml(path)}</loc></url>`).join("\n")}\n</urlset>\n`,
);
await cp(join(root, "robots.txt"), join(out, "robots.txt"));
console.log(`Built ${urls.length} public pages (${index.length} guides, ${tutorials.length} tutorials).`);

const nginxRedirects = Object.entries(redirects)
	.map(([path, target]) => {
		const url = new URL(target, product.origin);
		return `location = ${path} { return 308 "${url.pathname}$is_args$args${url.hash}"; }`;
	})
	.join("\n");
await writeFile(join(out, ".clio-coder-redirects.conf"), `${nginxRedirects}\n`);

await writeFile(
	join(out, ".clio-coder-revision.conf"),
	values.revision
		? `add_header X-Clio-Site-Revision "${values.revision}" always;\n`
		: "# Local preview has no deployed revision.\n",
);
