#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
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
const research = JSON.parse(await read("content/research.json"));
const paths = JSON.parse(await read("content/paths.json")).paths;
const collections = [
	{
		id: "tutorials",
		label: "Tutorials",
		listing: "/learn.html",
		items: tutorials,
		title: "Tutorials for local models, HPC, and agents · CLIO Coder",
		description:
			"Practical CLIO Coder tutorials and product tours. Start a first session and explore the desktop and terminal interfaces.",
	},
	{
		id: "research",
		label: "Research",
		listing: "/research.html",
		items: research,
		title: "Research: open questions on coding agents · CLIO Coder",
		description:
			"Open research questions in CLIO Coder: what is measured so far, a first experiment for each, and how students and outside researchers can join.",
	},
];
const articles = collections.flatMap((collection) =>
	collection.items.map((item) => ({
		...item,
		collection,
		url: `/${collection.id}/${item.slug}.html`,
		folder: item.draft ? "content/drafts" : `content/${collection.id}`,
	})),
);
// Each article names the guides it puts into practice; every guide page lists
// those articles at its end, so a guide links back to its worked examples.
const related = new Map();
for (const item of articles)
	for (const path of item.guides ?? []) {
		if (!index.some((doc) => doc.path === path)) throw new Error(`Article ${item.slug} names an unknown guide: ${path}`);
		related.set(path, [...(related.get(path) ?? []), item]);
	}
// Learning paths order published tutorials for one kind of reader each.
for (const path of paths) {
	for (const key of ["id", "label", "title", "summary"])
		if (!path[key]) throw new Error(`Learning path ${path.id ?? "?"} is missing ${key}.`);
	if (!/^path-[a-z]+$/.test(path.id)) throw new Error(`Learning path id ${path.id} must look like path-name.`);
	if (!(path.steps?.length >= 3 && path.steps.length <= 5))
		throw new Error(`Learning path ${path.id} needs three to five steps.`);
	for (const slug of path.steps)
		if (!tutorials.some((item) => item.slug === slug && !item.draft))
			throw new Error(`Learning path ${path.id} names an unpublished tutorial: ${slug}`);
}
for (const [id, item] of Object.entries(captures)) {
	for (const key of ["image", "original", "alt", "caption", "label", "interface", "version", "capturedAt", "source"])
		if (!item[key]) throw new Error(`Capture ${id} is missing ${key}.`);
	if (!/^assets\/[a-z0-9/.-]+\.webp$/.test(item.image) || !/^assets\/[a-z0-9/.-]+\.png$/.test(item.original))
		throw new Error(`Capture ${id} must name a WebP image and its PNG original under assets/.`);
	await readFile(join(root, item.image));
	await readFile(join(root, item.original));
	// A recorded capture: the still above is its poster, rendered from the cast at `posterAt`.
	if (item.cast) {
		if (
			!/^assets\/casts\/[a-z0-9-]+\.cast$/.test(item.cast) ||
			!/^assets\/casts\/[a-z0-9-]+\.txt$/.test(item.transcript ?? "") ||
			![item.cols, item.rows, item.duration, item.posterAt].every((n) => Number.isFinite(n) && n >= 0)
		)
			throw new Error(`Capture ${id} names a cast without its transcript, size, duration, or poster time.`);
		await readFile(join(root, item.cast));
		item.transcriptText = (await readFile(join(root, item.transcript), "utf8")).trimEnd();
	}
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
const social = JSON.parse(await read("social-images.json"));
for (const [id, item] of Object.entries(social.images)) {
	if (!captures[id] || item.source !== captures[id].original || !/^assets\/social\/[a-z0-9-]+\.png$/.test(item.path))
		throw new Error(`Social preview ${id} must be generated from its capture; run python3 site/image-variants.py.`);
	if (
		createHash("sha256")
			.update(await readFile(join(root, item.path)))
			.digest("hex") !== item.sha256
	)
		throw new Error(`Social preview changed; regenerate image variants: ${item.path}`);
}
for (const item of articles)
	if (item.cover && !social.images[item.cover])
		throw new Error(`Article ${item.slug} has no social preview; run python3 site/image-variants.py --social.`);
if (!social.images[social.default]) throw new Error("The default social preview is missing.");
// Sitemap lastmod and article dateModified come from the last commit that
// touched a page's sources. Without Git history (a deploy snapshot) they are omitted.
// product.json counts only when its version changes, the one field page text shows.
const productVersion = ["-G", '"version":', "--", "product.json"];
function lastModified(files) {
	const plain = files.filter((file) => file !== "product.json");
	const queries = [
		...(plain.length ? [["--", ...plain]] : []),
		...(files.includes("product.json") ? [productVersion] : []),
	];
	try {
		const dates = queries
			.map((query) =>
				execFileSync("git", ["log", "-1", "--format=%cI", ...query], {
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim(),
			)
			.filter(Boolean);
		return dates.length ? dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
	} catch {
		return null;
	}
}
// The first commit that added any of a page's sources at its public path. Older
// drafts elsewhere were not published, so renames are not followed.
function firstPublished(files) {
	try {
		const dates = execFileSync("git", ["log", "--diff-filter=A", "--format=%cI", "--", ...files], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\n")
			.filter(Boolean);
		return dates.length ? dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
	} catch {
		return null;
	}
}
// The visible date is the commit's own calendar day, so no time zone shifts it.
function updatedOn(lastmod) {
	const [year, month, day] = lastmod.slice(0, 10).split("-").map(Number);
	const label = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
	return `<time datetime="${lastmod}">${label}</time>`;
}
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
// Pages that embed a recording; only they get the player, its stylesheet, and its policy.
const castPages = [];

function responsiveImages(html, path) {
	return html.replace(/<img\b[^>]+>/g, (tag) => {
		const source = tag.match(/src="\/([^"]+)"/)?.[1];
		const item = imageVariants[source];
		if (!item) return tag;
		const clio = source === "assets/brand/clio-mark.webp";
		const parent = source === "assets/brand/iowarp-mark.webp";
		const guide = articles.some((item) => item.url === path);
		const article = guide || path.startsWith("/docs");
		// Brand marks render at .brand img sizes; listing cards subtract the 1rem
		// padding and 1px border around each card image from the column width.
		const sizes = clio
			? tag.includes('class="scene-mark"')
				? "160px"
				: "(max-width: 600px) 27px, 32px"
			: parent
				? "(max-width: 600px) 130px, 220px"
				: guide
					? "(max-width: 600px) calc(100vw - 40px), (max-width: 1100px) calc(100vw - 64px), 1000px"
					: article
						? "(max-width: 600px) calc(100vw - 40px), (max-width: 850px) calc(100vw - 64px), 760px"
						: path === "/"
							? "(max-width: 600px) calc(100vw - 64px), (max-width: 824px) calc(100vw - 88px), (max-width: 1000px) 736px, (max-height: 650px) 736px, (max-width: 1100px) calc((94vw - 64px) * 0.623 - 24px), (max-width: 1344px) calc((94vw - 96px) * 0.623 - 24px), 700px"
							: "(max-width: 600px) calc(100vw - 74px), (max-width: 1100px) calc(50vw - 90px), (max-width: 1344px) calc(50vw - 106px), 566px";
		const srcset = [...item.variants, { path: source, width: item.width }]
			.map((v) => `/${v.path} ${v.width}w`)
			.join(", ");
		if (clio) tag = tag.replace(`src="/${source}"`, `src="/${item.variants.find((v) => v.width === 64).path}"`);
		if (!/\bwidth=/.test(tag)) tag = tag.replace("<img", `<img width="${item.width}" height="${item.height}"`);
		return tag
			.replace(/\s*\/?>(?=$)/, ` srcset="${srcset}" sizes="${sizes}" decoding="async">`)
			.replace(/ decoding="async"(?=[\s\S]* decoding="async")/, "");
	});
}
// The theme must apply before first paint, and an external script would block
// rendering for a round trip. It is inlined and allowed by its exact hash.
const themeScript = (await read("js/theme.js")).trim();
const themeHash = `'sha256-${createHash("sha256").update(themeScript).digest("base64")}'`;
// GitHub Pages sends no custom headers, so the policy nginx used to send rides
// in a meta tag. frame-ancestors is not honored there and cannot be restored.
const contentSecurityPolicy = `default-src 'self'; script-src 'self' ${themeHash} https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'none'`;
// The terminal player compiles WebAssembly, which only pages embedding a recording allow.
const castContentSecurityPolicy = contentSecurityPolicy.replace(
	"script-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
);
// Whitespace and comment removal only; strings are copied untouched, and spaces
// around operators such as + and - stay, so calc() and selectors keep meaning.
function minifyCss(css) {
	let result = "";
	let text = "";
	const flush = () => {
		result += text
			.replace(/\s+/g, " ")
			.replace(/ ?([{};,>]) ?/g, "$1")
			.replace(/: /g, ":")
			.replace(/;}/g, "}");
		text = "";
	};
	for (let i = 0; i < css.length; ) {
		if (css.startsWith("/*", i)) {
			const end = css.indexOf("*/", i + 2);
			i = end < 0 ? css.length : end + 2;
			text += " ";
		} else if (css[i] === '"' || css[i] === "'") {
			let end = i + 1;
			while (end < css.length && css[end] !== css[i]) end += css[end] === "\\" ? 2 : 1;
			flush();
			result += css.slice(i, end + 1);
			i = end + 1;
		} else text += css[i++];
	}
	flush();
	return `${result.trim()}\n`;
}
const titleSuffix = / · CLIO Coder(?: docs)?$/;
const organization = {
	"@type": "Organization",
	"@id": "https://iowarp.ai/#organization",
	name: "IOWarp",
	alternateName: "iowarp.ai",
	url: "https://iowarp.ai/",
	logo: { "@type": "ImageObject", url: `${product.origin}/assets/brand/iowarp-mark.png` },
	sameAs: ["https://github.com/iowarp"],
};
const plainText = (html) =>
	html
		.replace(/<[^>]+>/g, "")
		.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name])
		.replace(/\s+/g, " ")
		.trim();
// The overview's question list is a real FAQ; its structured data is read from the same HTML.
const faq = [
	...((await read("index.html")).match(/<div class="faq-items">([\s\S]*?)<\/div><\/div>/)?.[1] ?? "").matchAll(
		/<details><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
	),
].map(([, question, answer]) => ({
	"@type": "Question",
	name: plainText(question),
	acceptedAnswer: { "@type": "Answer", text: plainText(answer) },
}));
if (faq.length < 3) throw new Error("The overview FAQ was not found; structured FAQ data would be empty.");
function head(
	path,
	title,
	description,
	type = "WebPage",
	{ lastmod = null, published = null, preview = social.default, cast = false } = {},
) {
	const url = `${product.origin}${path}`;
	const article = articles.find((item) => item.url === path);
	const image = social.images[preview];
	const imageUrl = `${product.origin}/${image.path}`;
	// The shared preview card is named for the product; article covers keep their own description.
	const imageAlt = preview === social.default ? product.name : captures[preview].alt;
	const graph = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${product.origin}/#site`,
				name: "CLIO Coder",
				url: `${product.origin}/`,
				description: product.description,
				inLanguage: "en",
				publisher: { "@id": organization["@id"] },
				copyrightHolder: { "@id": organization["@id"] },
				copyrightYear: 2026,
			},
			{
				"@type": type,
				"@id": `${url}#page`,
				name: title,
				description,
				url,
				isPartOf: { "@id": `${product.origin}/#site` },
				inLanguage: "en",
				primaryImageOfPage: { "@type": "ImageObject", url: imageUrl, width: image.width, height: image.height },
				...(published ? { datePublished: published } : {}),
				...(lastmod ? { dateModified: lastmod } : {}),
			},
			organization,
		],
	};
	const page = graph["@graph"][1];
	if (type === "Article" || type === "TechArticle") {
		page.headline = title.replace(titleSuffix, "");
		page.mainEntityOfPage = url;
		page.author = {
			"@type": !article || /\bteam$/i.test(article.author) ? "Organization" : "Person",
			name: article?.author ?? "The CLIO Coder team",
			url: `${product.origin}/#project`,
		};
		page.publisher = { "@id": organization["@id"] };
		page.image = [imageUrl, ...(article?.image ? [`${product.origin}${article.image}`] : [])];
		page.about = { "@id": `${product.origin}/#application` };
	}
	if (path !== "/" && path !== "/404.html") {
		const parent = path.startsWith("/docs/")
			? { name: "Docs", path: "/docs.html" }
			: article
				? { name: article.collection.label, path: article.collection.listing }
				: null;
		const crumbs = [
			{ name: "CLIO Coder", path: "/" },
			...(parent ? [parent] : []),
			{ name: title.replace(titleSuffix, ""), path },
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
			name: "CLIO Coder",
			codeRepository: repository,
			programmingLanguage: "TypeScript",
			version: product.version,
			license: `${repository}/blob/main/LICENSE`,
			author: { "@type": "Person", name: "Anthony Kougkas" },
			publisher: { "@id": organization["@id"] },
			targetProduct: { "@id": `${url}#application` },
		});
		graph["@graph"].push({
			"@type": "SoftwareApplication",
			"@id": `${url}#application`,
			name: product.name,
			url,
			description: product.description,
			applicationCategory: "DeveloperApplication",
			applicationSubCategory: "Coding agent",
			operatingSystem: "Linux, macOS, Windows",
			softwareVersion: product.publishedVersion,
			downloadUrl: "https://www.npmjs.com/package/@iowarp/clio-coder",
			installUrl: `${url}#start`,
			softwareHelp: { "@type": "CreativeWork", url: `${product.origin}/docs.html` },
			license: `${repository}/blob/main/LICENSE`,
			isAccessibleForFree: true,
			publisher: { "@id": organization["@id"] },
			image: imageUrl,
			screenshot: ["gui-task", "tui-verify"].map((id) => ({
				"@type": "ImageObject",
				url: `${product.origin}/${captures[id].original}`,
				caption: captures[id].alt,
			})),
		});
		graph["@graph"].push({ "@type": "FAQPage", "@id": `${url}#questions`, mainEntity: faq });
	}

	return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${cast ? castContentSecurityPolicy : contentSecurityPolicy}"><meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="color-scheme" content="dark light"><meta name="clio-default-theme" content="${escapeHtml(brand.defaultTheme)}"><meta name="theme-color" content="${escapeHtml(brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper])}">
<link rel="canonical" href="${url}"><link rel="manifest" href="/site.webmanifest"><link rel="icon" href="/assets/responsive/clio-icon-32.png" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="/assets/responsive/clio-icon-180.png" sizes="180x180">
<link rel="preload" href="/assets/fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/fonts/news-normal-500.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css"><script>${themeScript}</script>${cast ? `<script src="/js/cast.js" data-player-src="/assets/player/asciinema-player.min.js" data-player-css="/assets/player/asciinema-player.css" data-cast-css="/css/cast.css" defer></script>` : ""}
<meta property="og:locale" content="en_US"><meta property="og:site_name" content="${escapeHtml(product.name)}"><meta property="og:type" content="${type === "Article" || type === "TechArticle" ? "article" : "website"}"><meta property="og:url" content="${url}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${imageUrl}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}"><meta property="og:image:alt" content="${escapeHtml(imageAlt)}">${published && type !== "WebPage" ? `<meta property="article:published_time" content="${published}">` : ""}${lastmod && type !== "WebPage" ? `<meta property="article:modified_time" content="${lastmod}">` : ""}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${imageUrl}"><meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">
<meta name="robots" content="${path === "/404.html" ? "noindex" : "index,follow,max-image-preview:large,max-snippet:-1"}"><script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}
function shell(html, path, title, description, type, options) {
	const active = path.startsWith("/docs/")
		? "/docs.html"
		: (articles.find((item) => item.url === path)?.collection.listing ?? path);
	const header = mast.replace(/href="(\/|\/docs.html|\/learn.html|\/research.html)"/g, (all, href) =>
		href === active ? `${all} aria-current="page"` : all,
	);
	let number = 0;
	const result = html
		.replace("<!-- site-head -->", head(path, title, description, type, options))
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
// The code fence open after `line`, given the fence open before it, so
// directive syntax shown inside a code example stays literal.
function fence(line, open) {
	const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
	if (!marker) return open;
	if (!open) return marker;
	return marker[0] === open[0] && marker.length >= open.length && line.trim() === marker ? null : open;
}
// The lines of the directive opened at `start`, up to its own closing `:::`.
// A block such as steps may contain a nested directive, usually a capture.
function directiveBody(lines, start) {
	const inner = [];
	for (let i = start + 1, depth = 0, code = null; i < lines.length; i++) {
		if (!code && /^:::\s*[a-z]+/.test(lines[i])) depth++;
		else if (!code && lines[i].trim() === ":::" && depth-- === 0) break;
		code = fence(lines[i], code);
		inner.push(lines[i]);
	}
	return inner;
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
	for (let i = 0, code = null; i < lines.length; i++) {
		const open = !code && lines[i].match(/^:::\s*([a-z]+)(?:\s+(.*))?$/);
		if (!open) {
			code = fence(lines[i], code);
			buffer.push(lines[i]);
			continue;
		}
		flush();
		const inner = directiveBody(lines, i);
		i += inner.length + 1;
		if (i >= lines.length) throw new Error(`Unclosed guide directive: ${open[1]}`);
		html += directive(open[1], (open[2] ?? "").trim(), inner.join("\n"), (text) => directives(text, render));
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
	if (item.cast) {
		// The still, the download, and the transcript work without scripts; js/cast.js
		// adds a Play button that loads the player only when pressed.
		const length = castLength(item.duration);
		return `<figure class="guide-capture" data-cast="/${item.cast}" data-cast-cols="${item.cols}" data-cast-rows="${item.rows}" data-cast-poster="${item.posterAt}" data-cast-length="${length}">${image}<figcaption class="caption">${escapeHtml(item.caption)} ${source} <a class="cast-download" href="/${item.cast}" download>Recording · ${length}</a></figcaption><details class="cast-transcript"><summary>Transcript</summary><pre class="cast-transcript-text" tabindex="0" aria-label="Transcript of the recording">${escapeHtml(item.transcriptText)}</pre></details></figure>`;
	}
	return `<figure class="guide-capture">${image}<figcaption class="caption">${escapeHtml(item.caption)} ${source}</figcaption></figure>`;
}
function castLength(seconds) {
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
			return `<figure class="guide-prompt"><figcaption class="eyebrow"><span class="chapter">${escapeHtml(args || "Ask CLIO Coder")}</span></figcaption><blockquote>${render(inner)}</blockquote><button type="button" class="copy" data-copy="${escapeHtml(plain(inner))}" aria-label="Copy the request">Copy</button></figure>`;
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
// Resolves a Markdown link in a public source to its page on this site or, for
// anything not published here, to the pinned repository file.
function linkTarget(href, sourcePath, image = false) {
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
		};
		if (known[normalized]) return known[normalized];
	}
	return `${repository}/blob/${ref}/${normalized}${hash ? `#${hash}` : ""}`;
}
function renderMarkdown(markdown, sourcePath, guide = false) {
	const ids = new Map();
	const target = (href, image = false) => linkTarget(href, sourcePath, image);
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
// A guide's excerpt is short; its first sentence of body text makes the search
// snippet say what the page covers, without running far past what a result shows.
// An explicit catalog description replaces that when the pair reads poorly.
function docDescription(item, markdown) {
	if (item.description) return item.description;
	const paragraph = marked
		.lexer(markdown)
		.find((token) => token.type === "paragraph" && token.text.trim() !== item.excerpt);
	const sentence = paragraph ? plainText(marked.parseInline(paragraph.text)).match(/^.+?[.!?](?=\s|$)/)?.[0] : null;
	const echo = item.excerpt.toLowerCase().replace(/\.$/, "").split(" ").slice(-4).join(" ");
	return sentence && !sentence.toLowerCase().includes(echo) && item.excerpt.length + sentence.length < 200
		? `${item.excerpt} ${sentence}`
		: item.excerpt;
}
async function writePage(path, html, title, description, type, { sources = [], preview } = {}) {
	const file = join(out, path === "/" ? "index.html" : path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	const lastmod = sources.length ? lastModified(sources) : null;
	const first = lastmod && type !== "WebPage" ? firstPublished(sources.filter((file) => file !== "product.json")) : null;
	const published =
		first && Date.parse(first) <= Date.parse(lastmod) ? first : lastmod && type !== "WebPage" ? lastmod : null;
	const dated = html
		.replace(
			"<!-- updated-fact -->",
			lastmod ? `<div><dt class="eyebrow">Updated</dt><dd>${updatedOn(lastmod)}</dd></div>` : "",
		)
		.replace("<!-- updated-line -->", lastmod ? `<span>Updated ${updatedOn(lastmod)}</span>` : "");
	const cast = /<figure class="guide-capture[^"]*" data-cast="/.test(dated);
	if (cast) castPages.push(path);
	const result = shell(dated, path, title, description, type, {
		lastmod,
		published,
		cast,
		...(preview ? { preview } : {}),
	});
	if (/<!--\s*(?:site-|doc-|tutorial-|source-|version)/.test(result))
		throw new Error(`Unresolved template slot in ${path}`);
	await writeFile(file, result);
	if (path !== "/404.html") urls.push({ path, lastmod });
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
await mkdir(join(out, "assets/social"), { recursive: true });
for (const item of Object.values(social.images)) await cp(join(root, item.path), join(out, item.path));
for (const item of Object.values(captures))
	for (const path of [item.image, item.original, ...(item.cast ? [item.cast] : [])]) {
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
// One render-blocking stylesheet: the generated tokens, then the site styles, in
// the order the two separate files cascaded.
await writeFile(join(out, "css/site.css"), minifyCss(`${await read("css/brand.css")}\n${await read("css/site.css")}`));
await writeFile(join(out, "css/landing.css"), minifyCss(await read("css/landing.css")));
await mkdir(join(out, "js"));
for (const name of ["site.js", "docs.js", "redirect.js", "landing.js"])
	await cp(join(root, "js", name), join(out, "js", name));
await mkdir(join(out, "content"));
await writeFile(join(out, "content/docs-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writePage(
	"/",
	await read("index.html"),
	"CLIO Coder · The meta-harness for scientific software",
	product.description,
	"WebPage",
	{ sources: ["index.html", "product.json"] },
);
await writePage(
	"/404.html",
	await read("404.html"),
	"Page not found · CLIO Coder",
	"Find your way back to the CLIO Coder overview, documentation, and tutorials.",
);

const groups = [...new Set(index.map((item) => item.group))];
const template = await read("docs.html");
for (const item of index) {
	const entry = manifest.files.find((file) => file.path === item.path);
	const markdown = await read(`content/docs/${item.path}`);
	if (createHash("sha256").update(markdown).digest("hex") !== entry?.sha256)
		throw new Error(`Documentation hash mismatch: ${item.path}`);
	const examples = (related.get(item.path) ?? []).filter((article) => !article.draft);
	const kinds = [...new Set(examples.map((article) => article.collection.label.toLowerCase()))].join(" and ");
	const relatedBlock = examples.length
		? `\n\n## Related ${kinds}\n\n::: next Related ${kinds}\n${examples.map((article) => `- [${article.title}](${article.url})`).join("\n")}\n:::\n`
		: "";
	const rendered = renderMarkdown(markdown + relatedBlock, item.source, true);
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
	await writePage(
		docUrl(item.path),
		html,
		`${item.title} · CLIO Coder docs`,
		docDescription(item, markdown),
		"TechArticle",
		{
			sources: [`content/docs/${item.path}`, item.summary ? `content/doc-summaries/${item.summary}` : `../${item.source}`],
		},
	);
}
const search = index.map(
	({
		path,
		source: _source,
		sections: _sections,
		stripDetails: _strip,
		includeIntro: _intro,
		summary: _summary,
		description: _description,
		...item
	}) => ({
		path,
		...item,
		url: docUrl(path),
	}),
);
await writeFile(join(out, "content/index.json"), `${JSON.stringify(search, null, 2)}\n`);

// The files behind what a reader sees in the article body, so lastmod moves
// when its text, a caption or diagram it shows, or the version it was written
// for changes. Templates and registries are left out: adding a page to a
// registry or restyling the chrome is not a change to every other article.
function articleSources(item, markdown) {
	return [
		`${item.folder}/${item.source}`,
		...(item.cover || /^:::\s*capture/m.test(markdown) ? ["content/captures.json"] : []),
		...(/^:::\s*diagram/m.test(markdown) ? ["content/guide-diagrams.json"] : []),
		...(item.versionScope ? [] : ["product.json"]),
	];
}
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
			(item.interfaces ?? (item.collection.id === "research" ? ["Terminal"] : ["Terminal", "Desktop alpha"])).join(" · "),
		],
		["Basis", item.basis ?? "Documented workflow"],
	]
		.map(([label, value]) => `<div><dt class="eyebrow">${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
		.join("")
		.concat("<!-- updated-fact -->");
	const cover = item.cover
		? captureFigure(item.cover)
				.replace('class="guide-capture"', 'class="guide-capture guide-cover"')
				.replace(' loading="lazy"', ' fetchpriority="high"')
		: item.image
			? `<img class="cover" src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" />`
			: "";
	// One row per learning path this tutorial is a step of, from paths.json.
	const pathRows =
		item.collection.id === "tutorials"
			? paths
					.filter((path) => path.steps.includes(item.slug))
					.map((path) => {
						const step = path.steps.indexOf(item.slug);
						const link = (slug, label) => {
							const target = articles.find((article) => article.collection === item.collection && article.slug === slug);
							return `<span>${label}: <a href="${target.url}">${escapeHtml(target.title)}</a></span>`;
						};
						return `<li><a class="path-strip-path" href="${item.collection.listing}#${path.id}">${escapeHtml(path.label)} · step ${step + 1} of ${path.steps.length}</a>${step > 0 ? link(path.steps[step - 1], "Previous") : ""}${step < path.steps.length - 1 ? link(path.steps[step + 1], "Next") : `<span>Last step, <a href="${item.collection.listing}#learning-paths">back to the paths</a></span>`}</li>`;
					})
			: [];
	const pathStrip = pathRows.length
		? `<nav class="path-strip" aria-label="Learning path"><ul>${pathRows.join("")}</ul></nav>`
		: "";
	let html = tutorialTemplate
		.replace("<!-- collection-url -->", item.collection.listing)
		.replace("<!-- collection-label -->", item.collection.label.toLowerCase());
	const slots = {
		"tutorial-description": escapeHtml(item.description),
		"tutorial-path": pathStrip,
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
		item.title.includes("CLIO Coder") ? item.title : `${item.title} · CLIO Coder`,
		item.description,
		"Article",
		{ sources: articleSources(item, markdown), ...(item.cover ? { preview: item.cover } : {}) },
	);
}
for (const collection of collections) {
	const cards = articles
		.filter((item) => item.collection === collection)
		.map(
			// The first card image is the listing's largest above-the-fold content.
			(item, position) =>
				`<a class="tutorial-card" href="${item.url}">${item.image ? `<img src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}"${position === 0 ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">` : ""}<p class="eyebrow">${escapeHtml(item.category)} / ${escapeHtml(item.time)}</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p>${item.status ? `<p class="caption"><span class="chapter">${escapeHtml(item.status)}</span></p>` : ""}<span class="text-link">Read ${collection.id === "tutorials" ? "the tutorial" : "the article"} <span aria-hidden="true">↗</span></span></a>`,
		)
		.join("\n");
	const learningPaths =
		collection.id === "tutorials"
			? `<div class="learning-paths" id="learning-paths">${paths
					.map((path, number) => {
						const steps = path.steps
							.map((slug, step) => {
								const item = articles.find((article) => article.collection === collection && article.slug === slug);
								return `<li><span class="step-number">${String(step + 1).padStart(2, "0")}</span><a href="${item.url}">${escapeHtml(item.title)}</a><span class="caption">${escapeHtml(item.time)}</span></li>`;
							})
							.join("");
						return `<section class="learning-path" id="${path.id}" aria-labelledby="${path.id}-title"><p class="eyebrow"><span class="chapter">Path ${number + 1} /</span> ${escapeHtml(path.label)}</p><div><h2 id="${path.id}-title">${escapeHtml(path.title)}</h2><p>${escapeHtml(path.summary)}</p><ol>${steps}</ol></div></section>`;
					})
					.join("\n")}</div><p class="eyebrow tutorial-catalog-label">All tutorials</p>`
			: "";
	await writePage(
		collection.listing,
		(await read(collection.listing.slice(1)))
			.replace("<!-- learning-paths -->", learningPaths)
			.replace("<!-- tutorial-cards -->", cards),
		collection.title,
		collection.description,
		"WebPage",
		{
			sources: [
				collection.listing.slice(1),
				`content/${collection.id}.json`,
				...(learningPaths ? ["content/paths.json"] : []),
			],
		},
	);
}

for (const [path, target] of Object.entries(redirects)) {
	const file = join(out, path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to CLIO Coder</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=${escapeHtml(target)}"><link rel="canonical" href="${product.origin}${escapeHtml(target)}"><link rel="stylesheet" href="/css/site.css"><script src="/js/redirect.js" defer></script></head><body><main class="page page-intro"><h1>This page has moved.</h1><p><a data-redirect href="${escapeHtml(target)}">Continue to CLIO Coder →</a></p></main></body></html>`,
	);
}
await writeFile(
	join(out, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(({ path, lastmod }) => `  <url><loc>${product.origin}${escapeHtml(path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`,
);
await cp(join(root, "robots.txt"), join(out, "robots.txt"));

// llms.txt (llmstxt.org) indexes the public pages for language models, and
// llms-full.txt carries their Markdown sources with links resolved to this site.
// Both are generated from the same records as the pages and contain no dates.
const absolute = (href) => (href.startsWith("/") ? `${product.origin}${href}` : href);
function plainDirectives(markdown) {
	const lines = markdown.split("\n");
	const result = [];
	for (let i = 0, code = null; i < lines.length; i++) {
		const open = !code && lines[i].match(/^:::\s*([a-z]+)(?:\s+(.*))?$/);
		if (!open) {
			code = fence(lines[i], code);
			result.push(lines[i]);
			continue;
		}
		const inner = directiveBody(lines, i);
		i += inner.length + 1;
		const [name, args] = [open[1], (open[2] ?? "").trim()];
		const body = plainDirectives(inner.join("\n")).trim();
		const labelled = (label) => `**${args || label}**${body ? `\n\n${body}` : ""}`;
		const block = {
			needs: () => `## ${args || "Before you start"}\n\n${body}`,
			prompt: () => `**${args || "Ask CLIO Coder"}**\n\n${body.replace(/^/gm, "> ")}`,
			result: () => labelled("What you should see"),
			limits: () => labelled("Boundaries"),
			note: () => labelled("Note"),
			next: () => labelled("Next steps"),
			capture: () =>
				[
					...args
						.split(/\s+/)
						.filter(Boolean)
						.map((id) =>
							[
								`![${captures[id].alt}](/${captures[id].image})\n\n*${captures[id].caption}*`,
								...(captures[id].cast
									? [
											`[Recording (asciicast)](/${captures[id].cast}), ${castLength(captures[id].duration)}. Transcript:\n\n\`\`\`text\n${captures[id].transcriptText}\n\`\`\``,
										]
									: []),
							].join("\n\n"),
						),
					...(body ? [body] : []),
				].join("\n\n"),
			diagram: () => {
				const item = guideDiagrams[args];
				const stages = item.stages.map(
					(stage, n) =>
						`${n + 1}. ${stage.label}${stage.place ? ` (${stage.place})` : ""}${stage.body ? `: ${stage.body}` : ""}${stage.via ? ` Moves from the previous stage: ${stage.via}.` : ""}`,
				);
				return `**${item.title}**\n\n${stages.join("\n")}\n\n*${item.caption}*`;
			},
		}[name];
		result.push("", block ? block() : body, "");
	}
	return result.join("\n").replace(/\n{3,}/g, "\n\n");
}
// Applies `transform` to the Markdown outside code fences, leaving examples as written.
function outsideCode(markdown, transform) {
	const parts = [];
	let prose = [];
	let code = null;
	const flush = () => {
		if (prose.length) parts.push(transform(prose.join("\n")));
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const next = fence(line, code);
		if (code || next) {
			flush();
			parts.push(line);
		} else prose.push(line);
		code = next;
	}
	flush();
	return parts.join("\n");
}
function llmMarkdown(markdown, sourcePath, pageUrl) {
	return outsideCode(plainDirectives(markdown), (part) =>
		part
			.replaceAll("<!-- source-blob -->", `${repository}/blob/${ref}`)
			.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "[$2]($1)")
			.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, bang, label, href, title) => {
				const resolved = linkTarget(href, sourcePath, Boolean(bang));
				return `${bang}[${label}](${resolved.startsWith("#") ? `${pageUrl}${resolved}` : absolute(resolved)}${title})`;
			}),
	).trim();
}
const published = articles.filter((item) => !item.draft);
const llmsSummary = `# CLIO Coder

> ${product.description}

CLIO Coder reads, edits, and runs checks in your repository. It records what passed, what failed, and what was never checked. Connect a local model server, an institutional endpoint, a subscription, or a cloud API, and switch models with one command. The installer needs no root and works on HPC login nodes.

- Install on macOS, Linux, or WSL: \`curl -fsSL ${product.origin}/install.sh | sh\`
- Install with npm (Node.js 22.19 or newer): \`npm install -g @iowarp/clio-coder\`
- Connect a model in a project: \`clio-coder configure\`; then run \`clio-coder\` for the terminal or \`clio-coder gui --open\` for the desktop alpha.
- Current release: v${product.publishedVersion}. Source: ${repository}. License: Apache 2.0.`;
const llmsLink = (title, url, note) => `- [${title}](${absolute(url)})${note ? `: ${note}` : ""}`;
await writeFile(
	join(out, "llms.txt"),
	`${[
		llmsSummary,
		...groups.map(
			(group) =>
				`## ${group}\n\n${index
					.filter((doc) => doc.group === group)
					.map((doc) => llmsLink(doc.title, docUrl(doc.path), doc.excerpt))
					.join("\n")}`,
		),
		...collections.map(
			(collection) =>
				`## ${collection.label}\n\n${published
					.filter((item) => item.collection === collection)
					.map((item) => llmsLink(item.title, item.url, item.description))
					.join("\n")}`,
		),
		`## Optional\n\n${[
			llmsLink("Full text", "/llms-full.txt", "every guide, tutorial, and research page above as Markdown in one file"),
			llmsLink("Overview", "/", "capabilities, models, installation, and common questions"),
			llmsLink("Source repository", repository, "code, issues, and the full upstream guides"),
			llmsLink("npm package", "https://www.npmjs.com/package/@iowarp/clio-coder"),
			llmsLink("License", `${repository}/blob/main/LICENSE`, "Apache 2.0"),
		].join("\n")}`,
	].join("\n\n")}\n`,
);
const fullSections = [];
for (const item of index) {
	const url = absolute(docUrl(item.path));
	fullSections.push({ url, text: llmMarkdown(await read(`content/docs/${item.path}`), item.source, url) });
}
for (const item of published) {
	const url = absolute(item.url);
	const markdown = llmMarkdown(await read(`${item.folder}/${item.source}`), `site/${item.folder}/${item.source}`, url);
	fullSections.push({ url, text: `# ${item.title}\n\n> ${item.description}\n\n${markdown}` });
}
const llmsFull = `${llmsSummary}

This file holds the public CLIO Coder guides (documentation for v${source.version}), tutorials, and research pages as Markdown. Each section names the page it comes from.

${fullSections.map(({ url, text }) => `---\n\nSource: ${url}\n\n${text}`).join("\n\n")}
`;
await writeFile(join(out, "llms-full.txt"), llmsFull);
console.log(
	`Built ${urls.length} public pages (${index.length} guides, ${tutorials.length} tutorials, ${research.length} research pages); llms-full.txt is ${Buffer.byteLength(llmsFull)} bytes.`,
);

// Stable bootstraps follow released assets even while the rest of the site awaits a redeploy.
// Deploy snapshots carry these inputs inside the site's Docker build context.
const installerRoot = (await readdir(root)).includes("scripts") ? join(root, "scripts") : join(root, "..", "scripts");
for (const name of ["install.sh", "install.ps1", "install.cmd"])
	await cp(join(installerRoot, ...(name === "install.cmd" ? [] : ["installer-bootstrap"]), name), join(out, name));
if (castPages.length) {
	await mkdir(join(out, "assets/player"), { recursive: true });
	for (const [from, to] of [
		["vendor/asciinema-player/asciinema-player.min.js", "asciinema-player.min.js"],
		["vendor/asciinema-player/asciinema-player.css", "asciinema-player.css"],
		["vendor/asciinema-player/LICENSE", "asciinema-player-LICENSE.txt"],
		["vendor/cast-symbols/cast-symbols.woff2", "cast-symbols.woff2"],
		["vendor/cast-symbols/LICENSE", "cast-symbols-LICENSE.txt"],
	])
		await cp(join(root, from), join(out, "assets/player", to));
	await writeFile(join(out, "css/cast.css"), minifyCss(await read("css/cast.css")));
	await cp(join(root, "js/cast.js"), join(out, "js/cast.js"));
}
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
	// The blade's policy must allow the inlined theme script by the same hash.
	`add_header Content-Security-Policy "${contentSecurityPolicy}" always;\n${
		values.revision
			? `add_header X-Clio-Site-Revision "${values.revision}" always;\n`
			: "# Local preview has no deployed revision.\n"
	}`,
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

// Every built reference to a stylesheet, script, font, image, or video carries a
// short hash of the file's bytes, so a deploy changes the URL of anything that
// changed and no visitor pairs new pages with a stale cached asset.
const outputFiles = (await readdir(out, { recursive: true })).map((file) => file.split(sep).join("/"));
const assetHashes = new Map();
async function hashAssets(pattern) {
	for (const file of outputFiles.filter((name) => pattern.test(name)))
		assetHashes.set(
			`/${file}`,
			createHash("sha256")
				.update(await readFile(join(out, file)))
				.digest("hex")
				.slice(0, 10),
		);
}
const versioned = (url, base = "/") => {
	const hash = assetHashes.get(new URL(url, `${product.origin}${base}`).pathname);
	return hash ? `${url}?v=${hash}` : url;
};
await hashAssets(/\.(?:woff2|png|webp|jpe?g|svg|ico|mp4|cast)$/);
for (const file of outputFiles.filter((name) => name.endsWith(".css")))
	await writeFile(
		join(out, file),
		(await readFile(join(out, file), "utf8")).replace(
			/url\((["']?)([^"')?#:]+)\1\)/g,
			(_, quote, url) => `url(${quote}${versioned(url, `/${file}`)}${quote})`,
		),
	);
await hashAssets(/\.(?:css|js)$/);
for (const file of outputFiles.filter((name) => name.endsWith(".html")))
	await writeFile(
		join(out, file),
		(await readFile(join(out, file), "utf8"))
			.replace(
				/(\s(?:href|src|poster|data-src|data-light-src|data-cast|data-player-src|data-player-css|data-cast-css)=")(\/[^"?#]*)"/g,
				(_, attr, url) => `${attr}${versioned(url)}"`,
			)
			.replace(
				/(\ssrcset=")([^"]+)"/g,
				(_, attr, list) =>
					`${attr}${list
						.split(/,\s*/)
						.map((candidate) => candidate.replace(/^\/\S+/, (url) => versioned(url)))
						.join(", ")}"`,
			),
	);
