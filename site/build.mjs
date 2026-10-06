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
const { values } = parseArgs({
	options: { out: { type: "string" }, revision: { type: "string" }, review: { type: "boolean", default: false } },
});
// A review build adds the unregistered manuscripts in content/drafts. It must
// name its own output so drafts can never enter the public directory.
if (values.review && !values.out) throw new Error("A review build needs --out; drafts never enter site/public.");
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
const captures = JSON.parse(await read("content/captures.json")).captures;
const guideDiagrams = JSON.parse(await read("content/guide-diagrams.json")).diagrams;
const tutorials = JSON.parse(await read("content/tutorials.json"));
if (values.review)
	for (const item of JSON.parse(await read("content/drafts/review-catalog.json")).articles)
		tutorials.push({ ...item, draft: true });
const experimental = JSON.parse(await read("content/experimental.json"));
const collections = [
	{ id: "tutorials", label: "Tutorials", listing: "/learn.html", items: tutorials },
	{ id: "experimental", label: "Experimental", listing: "/experimental.html", items: experimental },
];
const articles = collections.flatMap((collection) =>
	collection.items.map((item) => ({
		...item,
		collection,
		url: `/${collection.id}/${item.slug}.html`,
		folder: item.draft ? "content/drafts" : `content/${collection.id}`,
	})),
);
for (const [id, item] of Object.entries(captures)) {
	for (const key of ["image", "original", "alt", "caption", "label", "interface", "version", "capturedAt", "source"])
		if (!item[key]) throw new Error(`Capture ${id} is missing ${key}.`);
	if (!/^assets\/[a-z0-9/.-]+\.webp$/.test(item.image) || !/^assets\/[a-z0-9/.-]+\.png$/.test(item.original))
		throw new Error(`Capture ${id} must name a WebP image and its PNG original under assets/.`);
	await readFile(join(root, item.image));
	await readFile(join(root, item.original));
}
for (const item of articles) {
	if (item.cover && !captures[item.cover]) throw new Error(`Tutorial ${item.slug} names an unknown cover capture.`);
	if (item.cover)
		Object.assign(item, {
			image: `/${captures[item.cover].image}`,
			width: captures[item.cover].width,
			height: captures[item.cover].height,
			alt: captures[item.cover].alt,
		});
}
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
// linkRef points reader-facing source links at a public ref while the pinned
// documentation commit is not published yet; the manifest keeps the real pin.
const ref = (product.linkRef ?? source.ref).split("/").map(encodeURIComponent).join("/");
const repository = product.repository.replace(/\/$/, "");
const sourceMap = new Map([
	...index.map((item) => [item.source, docUrl(item.path)]),
	...articles.map((item) => [`site/${item.folder}/${item.source}`, item.url]),
]);
const slug = (text) =>
	text
		.replace(/<[^>]+>/g, "")
		.replace(/&[^;]+;/g, "")
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
const anchors = new Map();
for (const item of [
	...index.map((item) => ({ source: item.source, file: `content/docs/${item.path}` })),
	...articles.map((item) => ({ source: `site/${item.folder}/${item.source}`, file: `${item.folder}/${item.source}` })),
]) {
	const tokens = marked.lexer(await read(item.file));
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
		const guide = articles.some((item) => item.url === path);
		const article = guide || path.startsWith("/docs");
		const sizes = clio
			? tag.includes('class="scene-mark"')
				? "160px"
				: "36px"
			: parent
				? "(max-width: 600px) 130px, 220px"
				: guide
					? "(max-width: 600px) calc(100vw - 40px), (max-width: 1100px) calc(100vw - 64px), 1000px"
					: article
						? "(max-width: 600px) calc(100vw - 40px), (max-width: 850px) calc(100vw - 64px), 760px"
						: path === "/"
							? "(max-width: 600px) calc(100vw - 64px), (max-width: 824px) calc(100vw - 88px), (max-width: 1000px) 736px, (max-height: 650px) 736px, (max-width: 1100px) calc((94vw - 64px) * 0.623 - 24px), (max-width: 1344px) calc((94vw - 96px) * 0.623 - 24px), 700px"
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
// GitHub Pages sends no custom headers, so the policy nginx used to send rides
// in a meta tag. frame-ancestors is not honored there and cannot be restored.
const contentSecurityPolicy =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'none'";
function head(path, title, description, type = "WebPage") {
	const url = `${product.origin}${path}`;
	const article = articles.find((item) => item.url === path);
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
	if (type === "Article" || type === "TechArticle") {
		page.headline = title.replace(/ — Clio Coder(?: tutorials| experimental| docs)?$/, "");
		page.mainEntityOfPage = url;
		page.author = {
			"@type": article?.author === "The Clio team" || !article ? "Organization" : "Person",
			name: article?.author ?? "The Clio team",
			url: `${product.origin}/#project`,
		};
		page.image = `${product.origin}${article?.image ?? "/assets/social-card.png"}`;
	}
	if (path !== "/" && path !== "/404.html") {
		const parent = path.startsWith("/docs/")
			? { name: "Docs", path: "/docs.html" }
			: article
				? { name: article.collection.label, path: article.collection.listing }
				: null;
		const crumbs = [
			{ name: "Clio Coder", path: "/" },
			...(parent ? [parent] : []),
			{ name: title.replace(/ — Clio Coder(?: tutorials| experimental| docs)?$/, ""), path },
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
	if (path === "/") {
		graph["@graph"].push({
			"@type": "SoftwareSourceCode",
			name: "Clio Coder",
			codeRepository: repository,
			programmingLanguage: "TypeScript",
			version: product.version,
			license: `${repository}/blob/main/LICENSE`,
			author: { "@type": "Person", name: "Anthony Kougkas" },
		});
		graph["@graph"].push({
			"@type": "SoftwareApplication",
			"@id": `${url}#application`,
			name: product.name,
			url,
			description,
			applicationCategory: "DeveloperApplication",
			operatingSystem: "Linux, macOS, Windows",
			softwareVersion: product.publishedVersion,
			downloadUrl: "https://www.npmjs.com/package/@iowarp/clio-coder",
			license: `${repository}/blob/main/LICENSE`,
			image: `${product.origin}/assets/social-card.png`,
		});
	}

	return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="color-scheme" content="dark light"><meta name="clio-default-theme" content="${escapeHtml(brand.defaultTheme)}"><meta name="theme-color" content="${escapeHtml(brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper])}">
<link rel="canonical" href="${url}"><link rel="alternate" hreflang="en" href="${url}"><link rel="alternate" hreflang="x-default" href="${url}"><link rel="manifest" href="/site.webmanifest"><link rel="icon" href="/assets/responsive/clio-icon-32.png" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="/assets/responsive/clio-icon-180.png" sizes="180x180">
<link rel="preload" href="/assets/fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/fonts/news-normal-500.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/brand.css"><link rel="stylesheet" href="/css/site.css"><script src="/js/theme.js"></script>
<meta property="og:locale" content="en_US"><meta property="og:site_name" content="Clio Coder"><meta property="og:type" content="${type === "Article" || type === "TechArticle" ? "article" : "website"}"><meta property="og:url" content="${url}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${product.origin}/assets/social-card.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Clio Coder. An open-source coding agent for scientific software.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${product.origin}/assets/social-card.png"><meta name="twitter:image:alt" content="Clio Coder. An open-source coding agent for scientific software.">
<meta name="robots" content="${path === "/404.html" ? "noindex" : "index,follow,max-image-preview:large"}"><script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}
function shell(html, path, title, description, type) {
	const active = path.startsWith("/docs/")
		? "/docs.html"
		: (articles.find((item) => item.url === path)?.collection.listing ?? path);
	const header = mast.replace(/href="(\/|\/docs.html|\/learn.html|\/experimental.html)"/g, (all, href) =>
		href === active ? `${all} aria-current="page"` : all,
	);
	let number = 0;
	const result = html
		.replace("<!-- site-head -->", head(path, title, description, type))
		.replace("<!-- site-header -->", header)
		.replace("<!-- site-footer -->", footer)
		.replaceAll("<!-- version -->", escapeHtml(product.version))
		.replaceAll("<!-- published-version -->", escapeHtml(product.publishedVersion))
		.replace("<!-- version-source -->", `${repository}/tree/${ref}`)
		.replaceAll("<!-- source-blob -->", `${repository}/blob/${ref}`)
		.replace(
			/<pre(?: data-label="([^"]*)")?>/g,
			(_, label) =>
				`<div class="code-block">${label ? `<p class="code-label eyebrow">${label}</p>` : ""}<pre tabindex="0" aria-label="Code example ${++number}">`,
		)
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
// Guide directives: a line `::: name arguments` opens a block and `:::`
// closes it. The body is Markdown. Directives compose the product's existing
// vocabulary (eyebrows, copper step numbers, rules, captures) into a guide.
function directives(markdown, render) {
	const lines = markdown.split("\n");
	let html = "";
	let buffer = [];
	const flush = () => {
		if (buffer.join("").trim()) html += render(buffer.join("\n"));
		buffer = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const open = lines[i].match(/^:::\s*([a-z]+)(?:\s+(.*))?$/);
		if (!open) {
			buffer.push(lines[i]);
			continue;
		}
		flush();
		const inner = [];
		for (i++; i < lines.length && lines[i].trim() !== ":::"; i++) inner.push(lines[i]);
		if (i >= lines.length) throw new Error(`Unclosed guide directive: ${open[1]}`);
		html += directive(open[1], (open[2] ?? "").trim(), inner.join("\n"), render);
	}
	flush();
	return html;
}
function captureFigure(id, { frame = false, index = 0 } = {}) {
	const item = captures[id];
	if (!item) throw new Error(`Unknown capture: ${id}`);
	const image = `<a class="capture-frame" href="/${item.original}"><img src="/${item.image}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async"></a>`;
	const source = `<span class="tag">${escapeHtml(item.interface)} · v${escapeHtml(item.version)}</span>`;
	if (frame)
		return `<li class="guide-frame" id="frame-${escapeHtml(id)}" data-label="${escapeHtml(item.label)}">${image}<p class="caption"><span class="step-number">${String(index + 1).padStart(2, "0")}</span> ${escapeHtml(item.caption)} ${source}</p></li>`;
	return `<figure class="guide-capture">${image}<figcaption class="caption">${escapeHtml(item.caption)} ${source}</figcaption></figure>`;
}
function guideDiagram(id) {
	const item = guideDiagrams[id];
	if (!item) throw new Error(`Unknown guide diagram: ${id}`);
	const nodes = item.stages
		.map(
			(stage) =>
				`<li class="guide-node">${stage.via ? `<p class="guide-via">${escapeHtml(stage.via)}</p>` : ""}${stage.place ? `<p class="eyebrow">${escapeHtml(stage.place)}</p>` : ""}<h3 class="guide-node-label">${escapeHtml(stage.label)}</h3>${stage.body ? `<p>${escapeHtml(stage.body)}</p>` : ""}</li>`,
		)
		.join("");
	return `<figure class="guide-diagram guide-diagram-${escapeHtml(item.type)}"><p class="eyebrow"><span class="chapter">${escapeHtml(item.title)}</span></p><ol class="guide-flow">${nodes}</ol><figcaption class="caption">${escapeHtml(item.caption)}</figcaption></figure>`;
}
function directive(name, args, inner, render) {
	const plain = (text) =>
		text
			.replace(/[*_`>]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	switch (name) {
		case "needs":
			return `<section class="guide-needs">${render(`## ${args || "Before you start"}\n\n${inner}`)}</section>`;
		case "steps": {
			const steps = render(inner)
				.split(/(?=<h3 )/)
				.filter((part) => part.trim());
			return `<ol class="guide-steps">${steps.map((step, index) => `<li class="guide-step"><span class="step-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><div>${step}</div></li>`).join("")}</ol>`;
		}
		case "prompt":
			return `<figure class="guide-prompt"><figcaption class="eyebrow"><span class="chapter">${escapeHtml(args || "Ask Clio")}</span></figcaption><blockquote>${render(inner)}</blockquote><button type="button" class="copy" data-copy="${escapeHtml(plain(inner))}" aria-label="Copy the request">Copy</button></figure>`;
		case "result":
			return `<section class="guide-result"><p class="eyebrow"><span class="chapter">${escapeHtml(args || "What you should see")}</span></p>${render(inner)}</section>`;
		case "limits":
			return `<section class="guide-limits"><p class="eyebrow"><span class="chapter">${escapeHtml(args || "Boundaries")}</span></p>${render(inner)}</section>`;
		case "note":
			return `<aside class="guide-note"><p class="eyebrow">${escapeHtml(args || "Note")}</p>${render(inner)}</aside>`;
		case "capture": {
			const ids = args.split(/\s+/).filter(Boolean);
			if (ids.length === 1) return captureFigure(ids[0]);
			const caption = inner.trim()
				? `<figcaption class="caption">${render(inner).replace(/<\/?p>/g, "")}</figcaption>`
				: "";
			return `<figure class="guide-sequence" data-sequence><ol class="guide-frames">${ids.map((id, index) => captureFigure(id, { frame: true, index })).join("")}</ol>${caption}</figure>`;
		}
		case "diagram":
			return guideDiagram(args);
		case "tabs": {
			// Each `### Label` section becomes a tab panel. The heading stays in the
			// panel, so the Markdown and the no-script page read as plain sections.
			const panels = render(inner)
				.split(/(?=<h3 )/)
				.filter((part) => part.trim());
			return `<div class="tab-set" data-tabs="${escapeHtml(args || "Options")}">${panels
				.map((panel) => {
					const [, id, label] = panel.match(/^<h3 id="([^"]+)">([\s\S]*?)<\/h3>/) ?? [];
					if (!id) throw new Error("Each tab in a tabs directive starts with a ### heading");
					const text = label.replace(/<[^>]+>/g, "");
					const windows = /PowerShell|CMD/.test(text) ? ' data-tab-platform="windows"' : "";
					return `<div class="tab-panel" id="tab-${id}" data-tab="${escapeHtml(text)}"${windows}>${panel.replace("<h3 ", '<h3 class="tab-label" ')}</div>`;
				})
				.join("")}</div>`;
		}
		case "compare":
			return `<div class="guide-compare">${render(inner)}</div>`;
		case "next":
			return `<nav class="guide-next" aria-label="${escapeHtml(args || "Next steps")}">${render(inner).replace(/<\/a><\/li>/g, ' <span aria-hidden="true">→</span></a></li>')}</nav>`;
		default:
			throw new Error(`Unknown guide directive: ${name}`);
	}
}
function renderMarkdown(markdown, sourcePath, guide = false) {
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
	renderer.code = ({ text, lang }) => {
		const [language, ...rest] = (lang ?? "").split(/\s+/);
		const title = rest.join(" ").match(/^title=(.+)$/)?.[1];
		const label =
			title ??
			{ sh: "Shell", bash: "Shell", powershell: "PowerShell", bat: "CMD", yaml: "YAML", json: "JSON", text: "" }[
				language
			] ??
			"";
		return `<pre${label ? ` data-label="${escapeHtml(label)}"` : ""}><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}</code></pre>\n`;
	};
	let table = 0;
	const render = (text) => marked.parse(text, { gfm: true, renderer });
	const body = guide ? directives(markdown, render) : render(markdown);
	return body
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
	"assets/responsive/clio-icon-192.png",
	"assets/responsive/clio-icon-512.png",
])
	await cp(join(root, path), join(out, path));
for (const name of [
	"temperature-calibration.zip",
	"social-card.png",
	"social-card-light.png",
	"social-square.png",
	"social-square-light.png",
])
	await cp(join(root, "assets", name), join(out, "assets", name));
for (const item of Object.values(captures))
	for (const path of [item.image, item.original]) {
		await mkdir(dirname(join(out, path)), { recursive: true });
		await cp(join(root, path), join(out, path));
	}
for (const name of ["clio-mark.webp", "clio-mark.png", "iowarp-mark.webp", "iowarp-mark.png"])
	await cp(join(root, "assets/brand", name), join(out, "assets/brand", name));
await mkdir(join(out, "assets/animations"), { recursive: true });
for (const asset of JSON.parse(await read("animation-assets.json"))) {
	for (const path of [asset.video, asset.lightVideo, asset.poster]) {
		if (!/^assets\/animations\/[a-z-]+\.(?:mp4|webp)$/.test(path))
			throw new Error("Animation assets must name a selected derivative.");
		await cp(join(root, path), join(out, path));
	}
}
await mkdir(join(out, "css"));
for (const name of ["brand.css", "site.css", "landing.css"]) await cp(join(root, "css", name), join(out, "css", name));
await mkdir(join(out, "js"));
for (const name of ["theme.js", "site.js", "docs.js", "redirect.js", "landing.js"])
	await cp(join(root, "js", name), join(out, "js", name));
await mkdir(join(out, "content"));
await writeFile(join(out, "content/docs-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writePage(
	"/",
	await read("index.html"),
	"Clio Coder — an open-source coding agent for scientific software",
	"Clio Coder reads, edits, and runs checks in your repository with local or cloud models you choose, from the terminal or a local desktop app in alpha. Built for scientific software and everyday engineering.",
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
	const rendered = renderMarkdown(markdown, item.source, true);
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
		"source-label": item.summary
			? `Guide to v${escapeHtml(source.version)}`
			: source.mode === "release"
				? `Documentation · v${escapeHtml(source.version)}`
				: "From the project documentation",
	};
	let html = template;
	for (const [name, value] of Object.entries(slots)) html = html.replaceAll(`<!-- ${name} -->`, value);
	await writePage(docUrl(item.path), html, `${item.title} — Clio Coder docs`, item.excerpt, "TechArticle");
}
const search = index.map(
	({
		path,
		source: _source,
		sections: _sections,
		stripDetails: _strip,
		includeIntro: _intro,
		summary: _summary,
		...item
	}) => ({
		path,
		...item,
		url: docUrl(path),
	}),
);
await writeFile(join(out, "content/index.json"), `${JSON.stringify(search, null, 2)}\n`);

const tutorialTemplate = await read("tutorial.html");
for (const item of articles) {
	const folder = item.folder;
	const markdown = await read(`${folder}/${item.source}`);
	const content = renderMarkdown(markdown, `site/${folder}/${item.source}`, true);
	const headings = [...content.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
	const toc = headings.map(([, id, text]) => `<a href="#${id}">${text.replace(/<[^>]+>/g, "")}</a>`).join("\n");
	const facts = [
		["Written for", `v${item.versionScope ?? product.version}`],
		[
			"Works in",
			(item.interfaces ?? (item.collection.id === "experimental" ? ["Terminal"] : ["Terminal", "Desktop alpha"])).join(
				" · ",
			),
		],
		["Basis", item.basis ?? "Documented workflow"],
	]
		.map(([label, value]) => `<div><dt class="eyebrow">${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
		.join("");
	const cover = item.cover
		? captureFigure(item.cover)
				.replace('class="guide-capture"', 'class="guide-capture guide-cover"')
				.replace(' loading="lazy"', ' fetchpriority="high"')
		: item.image
			? `<img class="cover" src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" />`
			: "";
	let html = tutorialTemplate
		.replace("<!-- collection-url -->", item.collection.listing)
		.replace("<!-- collection-label -->", item.collection.label.toLowerCase());
	const slots = {
		"tutorial-description": escapeHtml(item.description),
		"tutorial-facts": facts,
		"tutorial-cover": cover,
		"tutorial-toc": toc ? `<h2>On this page</h2>${toc}` : "",
		"tutorial-toc-mobile": toc ? `<details class="doc-toc-mobile"><summary>On this page</summary>${toc}</details>` : "",
		"tutorial-status": item.draft
			? `<p class="guide-review"><span class="status-dot"></span>Draft for review · not in the published catalog</p>`
			: item.status
				? `<p class="guide-review">${escapeHtml(item.status)}</p>`
				: "",
		"tutorial-title": escapeHtml(item.title),
		"tutorial-category": escapeHtml(item.category),
		"tutorial-time": escapeHtml(item.time),
		"tutorial-image": escapeHtml(item.image),
		"tutorial-alt": escapeHtml(item.alt),
		"tutorial-width": item.width,
		"tutorial-height": item.height,
		"tutorial-author": escapeHtml(item.author),
		"tutorial-content": content,
		"tutorial-video": item.video
			? `<iframe class="video" loading="lazy" src="https://www.youtube-nocookie.com/embed/${item.video}" title="${escapeHtml(item.title)} recording" allowfullscreen></iframe>`
			: "",
	};
	for (const [name, value] of Object.entries(slots)) html = html.replaceAll(`<!-- ${name} -->`, value);
	await writePage(
		item.url,
		html,
		`${item.title} — Clio Coder ${item.collection.label.toLowerCase()}`,
		item.description,
		"Article",
	);
}
for (const collection of collections) {
	const cards = articles
		.filter((item) => item.collection === collection)
		.map(
			(item) =>
				`<a class="tutorial-card" href="${item.url}">${item.image ? `<img src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async">` : ""}<p class="eyebrow">${escapeHtml(item.category)} / ${escapeHtml(item.time)}</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p>${item.status ? `<p class="caption"><span class="chapter">${escapeHtml(item.status)}</span></p>` : ""}<span class="text-link">Read ${collection.id === "tutorials" ? "the tutorial" : "the article"} <span aria-hidden="true">↗</span></span></a>`,
		)
		.join("\n");
	await writePage(
		collection.listing,
		(await read(collection.listing.slice(1))).replace("<!-- tutorial-cards -->", cards),
		`${collection.label} — Clio Coder`,
		collection.id === "tutorials"
			? "Practical Clio Coder tutorials and product tours. Start a first session and explore the desktop and terminal interfaces."
			: "Explore experimental Clio Coder workflows, their setup, and their current limits before trying them in your project.",
	);
}

for (const [path, target] of Object.entries(redirects)) {
	const file = join(out, path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to Clio Coder</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=${escapeHtml(target)}"><link rel="canonical" href="${product.origin}${escapeHtml(target)}"><link rel="stylesheet" href="/css/brand.css"><link rel="stylesheet" href="/css/site.css"><script src="/js/redirect.js" defer></script></head><body><main class="page page-intro"><h1>This page has moved.</h1><p><a data-redirect href="${escapeHtml(target)}">Continue to Clio Coder →</a></p></main></body></html>`,
	);
}
await writeFile(
	join(out, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((path) => `  <url><loc>${product.origin}${escapeHtml(path)}</loc></url>`).join("\n")}\n</urlset>\n`,
);
await cp(join(root, "robots.txt"), join(out, "robots.txt"));
console.log(
	`Built ${urls.length} public pages (${index.length} guides, ${tutorials.length} tutorials, ${experimental.length} experimental articles).`,
);

// Stable bootstraps follow released assets even while the rest of the site awaits a redeploy.
// Deploy snapshots carry these inputs inside the site's Docker build context.
const installerRoot = (await readdir(root)).includes("scripts") ? join(root, "scripts") : join(root, "..", "scripts");
for (const name of ["install.sh", "install.ps1", "install.cmd"])
	await cp(join(installerRoot, ...(name === "install.cmd" ? [] : ["installer-bootstrap"]), name), join(out, name));
await writeFile(join(out, "CNAME"), `${new URL(product.origin).hostname}\n`);
await writeFile(join(out, ".nojekyll"), "");
await writeFile(
	join(out, "version.json"),
	`${JSON.stringify({ site: product.version, publishedVersion: product.publishedVersion, docsCommit: source.commit, revision: values.revision ?? null }, null, 2)}\n`,
);
// Blade-only until its retirement: nginx consumes these, GitHub Pages ignores dotfiles.
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

await writeFile(
	join(out, "site.webmanifest"),
	`${JSON.stringify(
		{
			id: "/",
			name: product.name,
			short_name: product.name,
			lang: "en",
			start_url: "/",
			scope: "/",
			display: "browser",
			background_color: brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper],
			theme_color: brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper],
			icons: [192, 512].map((size) => ({
				src: `/assets/responsive/clio-icon-${size}.png`,
				sizes: `${size}x${size}`,
				type: "image/png",
				purpose: "any",
			})),
		},
		null,
		2,
	)}\n`,
);
