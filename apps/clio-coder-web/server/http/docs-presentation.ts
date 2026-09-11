/**
 * Presentation bridge for handmade documentation blueprints.
 *
 * The blueprints under docs/html are trusted package HTML served inside a
 * sandboxed, opaque-origin iframe (`sandbox="allow-scripts"`, CSP sandbox).
 * `presentBlueprint` injects one stylesheet and one script into that HTML
 * without touching the handmade content:
 *
 * - The stylesheet remaps the old neon/glass theme variables onto the
 *   application's cream (light) and sage (dark) palettes and, only when the
 *   document is embedded, hides the document-level header, footer and
 *   decorative background. Every SVG, code block, table, diagram and copy
 *   button in the content is preserved.
 * - The script applies the validated `?theme=light|dark` query parameter,
 *   accepts `{type:"clio:blueprint-theme", theme}` from the parent window only,
 *   turns local documentation links into parent navigation requests, reports
 *   the content height, and announces readiness with the document title.
 *
 * Child → parent messages (`postMessage` to `"*"`, the parent validates
 * `event.source === iframe.contentWindow`):
 *   {type:"clio:blueprint", event:"ready",    height, title}
 *   {type:"clio:blueprint", event:"resize",   height}
 *   {type:"clio:blueprint", event:"navigate", href}   href is an app route
 *   {type:"clio:blueprint", event:"external", href}   https?: link the child refused to follow
 *
 * Parent → child messages (the child validates `event.source === window.parent`):
 *   {type:"clio:blueprint-theme", theme:"light"|"dark"}
 *
 * No token, cookie or API access crosses this boundary in either direction.
 */

const STYLESHEET = `
:root {
	--bg-dark: #eee8d8;
	--bg-grid: transparent;
	--bg-card: #f5efdf;
	--bg-card-hover: #e2e5d2;
	--border-card: #cdd0ba;
	--border-card-hover: #3c634c;
	--text-main: #2e3e34;
	--text-muted: #596452;
	--text-dim: #75806f;
	--color-cyan: #3c634c;
	--color-cyan-rgb: 60, 99, 76;
	--color-orange: #906321;
	--color-orange-rgb: 144, 99, 33;
	--color-purple: #5c5f8a;
	--color-purple-rgb: 92, 95, 138;
	--color-emerald: #365846;
	--color-emerald-rgb: 54, 88, 70;
	--color-amber: #906321;
	--color-amber-rgb: 144, 99, 33;
	--color-rose: #863b2b;
	--color-rose-rgb: 134, 59, 43;
	--gradient-main: linear-gradient(135deg, #3c634c, #3c634c);
	--shadow-glow: none;
	--glass-blur: none;
	--font-sans: "Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible", system-ui, "Segoe UI", sans-serif;
	--font-serif: "Newsreader Variable", Georgia, "Times New Roman", serif;
	--font-mono: "Commit Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	--clio-ink: #2e3e34;
	--clio-paper: #eee8d8;
	--clio-surface: #f5efdf;
	--clio-inset: #e2e5d2;
	--clio-green: #365846;
	--clio-muted: #596452;
	--clio-line: #cdd0ba;
	--clio-accent: #3c634c;
	--clio-focus: #906321;
	--clio-danger: #863b2b;
	--clio-on-accent: #fbf6e9;
	--clio-code-bg: #15201c;
	--clio-code-bar: #1d2b24;
	--clio-code-line: #3b5146;
	--clio-code-ink: #e2eee5;
	--clio-code-muted: #b9cabd;
	color-scheme: light;
}
:root[data-theme="dark"] {
	--bg-dark: #202a25;
	--bg-card: #28342c;
	--bg-card-hover: #334238;
	--border-card: #4c6051;
	--border-card-hover: #bad7b4;
	--text-main: #e2e6d8;
	--text-muted: #b6c2b2;
	--text-dim: #93a08f;
	--color-cyan: #bad7b4;
	--color-cyan-rgb: 186, 215, 180;
	--color-orange: #e1c58f;
	--color-orange-rgb: 225, 197, 143;
	--color-purple: #c3c2e6;
	--color-purple-rgb: 195, 194, 230;
	--color-emerald: #b7d0b2;
	--color-emerald-rgb: 183, 208, 178;
	--color-amber: #e1c58f;
	--color-amber-rgb: 225, 197, 143;
	--color-rose: #ecc0af;
	--color-rose-rgb: 236, 192, 175;
	--gradient-main: linear-gradient(135deg, #bad7b4, #bad7b4);
	--clio-ink: #e2e6d8;
	--clio-paper: #202a25;
	--clio-surface: #28342c;
	--clio-inset: #334238;
	--clio-green: #b7d0b2;
	--clio-muted: #b6c2b2;
	--clio-line: #4c6051;
	--clio-accent: #bad7b4;
	--clio-focus: #e1c58f;
	--clio-danger: #ecc0af;
	--clio-on-accent: #203325;
	color-scheme: dark;
}
html {
	background: var(--clio-paper);
}
body {
	min-height: 0;
	background-color: var(--clio-paper);
	background-image: none;
	color: var(--clio-ink);
	font-family: var(--font-sans);
}
body::before {
	display: none;
}
::-webkit-scrollbar-track {
	background: transparent;
}
::-webkit-scrollbar-thumb {
	background: var(--clio-line);
}
::-webkit-scrollbar-thumb:hover {
	background: var(--clio-accent);
}
a:focus-visible,
button:focus-visible,
select:focus-visible,
input:focus-visible,
pre:focus-visible {
	outline: 3px solid var(--clio-focus);
	outline-offset: 3px;
}

/* Embedded in the application: the app supplies title, chrome and gutters. */
:root[data-clio-embedded="true"] .container {
	max-width: none;
	padding: 0 0 1rem;
}
:root[data-clio-embedded="true"] .document-header,
:root[data-clio-embedded="true"] .reading-progress,
:root[data-clio-embedded="true"] body > .container > footer,
:root[data-clio-embedded="true"] .sidebar-source,
:root[data-clio-embedded="true"] [data-clio-self-reference="true"] {
	display: none;
}
:root[data-clio-embedded="true"] .page-layout-grid {
	margin-top: 0;
}
:root[data-clio-embedded="true"] .sidebar {
	top: 0.5rem;
	max-height: calc(100vh - 1rem);
}
:root[data-clio-embedded="true"] .skip-link {
	top: 0.5rem;
	left: 0.5rem;
}

/* Sidebar and table of contents */
.toc-container {
	background: var(--clio-surface);
	border-color: var(--clio-line);
	border-radius: 8px;
	backdrop-filter: none;
}
.toc-title {
	color: var(--clio-muted);
	border-bottom-color: var(--clio-line);
}
.reference-sidebar .toc-container::before {
	background: var(--clio-accent);
}
.toc-link {
	color: var(--clio-muted);
}
.toc-link:hover,
.toc-link.active {
	color: var(--clio-accent);
	border-left-color: var(--clio-accent);
}
.sidebar-source {
	background: var(--clio-inset);
	border-color: var(--clio-line);
	color: var(--clio-muted);
}
.sidebar-source:hover {
	border-color: var(--clio-accent);
	color: var(--clio-accent);
}

/* Cards and prose */
.glass-card {
	background: var(--clio-surface);
	border-color: var(--clio-line);
	border-radius: 8px;
	box-shadow: none;
	backdrop-filter: none;
}
.glass-card h2 {
	color: var(--clio-ink);
	border-bottom-color: var(--clio-line);
}
.glass-card h2 svg {
	color: var(--clio-accent);
}
.glass-card p {
	color: var(--clio-ink);
}
.reference-prose {
	border-top: 2px solid var(--clio-accent);
	box-shadow: none;
}
.reference-prose h1,
.reference-prose h2,
.reference-prose h3,
.reference-prose h4,
.reference-prose h5,
.reference-prose h6 {
	color: var(--clio-ink);
	font-family: var(--font-serif);
	font-weight: 500;
	letter-spacing: -0.01em;
}
.reference-prose h2 {
	border-bottom-color: var(--clio-line);
}
.reference-prose h2::before {
	content: none;
}
.reference-prose h4,
.reference-prose h5,
.reference-prose h6 {
	color: var(--clio-green);
	font-family: var(--font-sans);
	font-weight: 700;
}
.heading-anchor {
	color: var(--clio-muted);
}
.reference-prose p,
.reference-prose li,
.reference-prose dd {
	color: var(--clio-ink);
	font-family: var(--font-sans);
	font-size: 1rem;
	line-height: 1.7;
}
.reference-prose li::marker {
	color: var(--clio-accent);
}
.reference-prose a {
	color: var(--clio-accent);
	text-decoration-color: currentColor;
}
.reference-prose a:hover {
	color: var(--clio-green);
}
.reference-prose :not(pre) > code {
	background: var(--clio-inset);
	border-color: var(--clio-line);
	color: var(--clio-ink);
}
pre,
.reference-prose pre {
	background: var(--clio-code-bg);
	border: 1px solid var(--clio-code-line);
	border-left: 3px solid var(--clio-accent);
	color: var(--clio-code-ink);
}
pre code,
.reference-prose pre code {
	color: var(--clio-code-ink);
}
.copy-btn {
	background: var(--clio-code-bar);
	border-color: var(--clio-code-line);
	color: var(--clio-code-muted);
	opacity: 1;
}
.copy-btn:hover {
	background: var(--clio-code-line);
	color: var(--clio-code-ink);
}
.reference-prose blockquote {
	background: var(--clio-inset);
	border-left-color: var(--clio-accent);
}
.reference-prose blockquote::before {
	color: var(--clio-accent);
}
.reference-prose table {
	border-color: var(--clio-line);
	font-family: var(--font-sans);
	font-size: 0.85rem;
}
.reference-prose thead {
	background: var(--clio-inset);
}
.reference-prose th,
.reference-prose td {
	color: var(--clio-ink);
	border-color: var(--clio-line);
}
.reference-prose hr {
	background: var(--clio-line);
}
.reference-prose details {
	background: var(--clio-inset);
	border-color: var(--clio-line);
}
.reference-prose summary {
	color: var(--clio-accent);
}
.reference-prose kbd {
	background: var(--clio-inset);
	border-color: var(--clio-line);
}
.reference-footer-note {
	color: var(--clio-muted);
}

/* Adjacent references, tabs and controls */
.related-nav {
	border-top-color: var(--clio-line);
}
.nav-link-card {
	background: var(--clio-surface);
	border-color: var(--clio-line);
	color: var(--clio-muted);
}
.nav-link-card:hover {
	border-color: var(--clio-accent);
	color: var(--clio-ink);
}
.nav-link-card .nav-label {
	color: var(--clio-muted);
}
.nav-link-card .nav-title {
	color: var(--clio-accent);
}
.tab-btn {
	background: var(--clio-surface);
	border-color: var(--clio-line);
	color: var(--clio-muted);
}
.tab-btn:hover {
	background: var(--clio-inset);
	color: var(--clio-ink);
	border-color: var(--clio-accent);
}
.tab-btn.active {
	background: var(--clio-green);
	color: var(--clio-on-accent);
	box-shadow: none;
}
.back-btn,
.chip,
.version-badge {
	background: var(--clio-inset);
	border-color: var(--clio-line);
	color: var(--clio-muted);
}
select,
input[type="text"],
input[type="number"],
textarea {
	background: var(--clio-surface);
	border-color: var(--clio-line);
	color: var(--clio-ink);
	box-shadow: none;
}
select:focus,
input[type="text"]:focus,
input[type="number"]:focus,
textarea:focus {
	border-color: var(--clio-accent);
	box-shadow: none;
}
input[type="range"] {
	accent-color: var(--clio-accent);
	background: var(--clio-inset);
}
.skip-link {
	background: var(--clio-green);
	color: var(--clio-on-accent);
}

@media (prefers-reduced-motion: reduce) {
	html { scroll-behavior: auto; }
}
@media (max-width: 850px) {
	:root[data-clio-embedded="true"] .reference-prose {
		padding: 1rem;
	}
	/* Narrow layouts already collapse the table of contents; without the source link the sidebar is empty. */
	:root[data-clio-embedded="true"] .reference-sidebar {
		display: none;
	}
}
`;

/**
 * Plain ES2018 so it runs unbundled inside the sandboxed document. It never
 * reads storage or cookies and never calls fetch; `event.source` checks bound
 * both directions of the bridge to the embedding frame.
 */
const SCRIPT = `
(() => {
	"use strict";
	const THEMES = ["light", "dark"];
	const root = document.documentElement;
	const parent = window.parent;
	const embedded = !!parent && parent !== window;
	root.dataset.clioEmbedded = embedded ? "true" : "false";
	const applyTheme = (theme) => {
		if (THEMES.includes(theme)) root.dataset.theme = theme;
	};
	let initial = "light";
	try {
		const requested = new URLSearchParams(location.search).get("theme");
		if (requested && THEMES.includes(requested)) initial = requested;
		else if (!embedded && window.matchMedia("(prefers-color-scheme: dark)").matches) initial = "dark";
	} catch {
		/* Default theme applies. */
	}
	applyTheme(initial);
	const post = (message) => {
		if (embedded) parent.postMessage(Object.assign({ type: "clio:blueprint" }, message), "*");
	};
	window.addEventListener("message", (event) => {
		if (!embedded || event.source !== parent) return;
		const data = event.data;
		if (!data || typeof data !== "object" || data.type !== "clio:blueprint-theme") return;
		applyTheme(data.theme);
	});

	const BLUEPRINT_ROOT = "/docs-html/";
	const GITHUB_DOCS = /^\\/iowarp\\/clio-coder\\/(?:blob|tree)\\/[^/]+\\/docs\\/(.+\\.md)$/i;
	const localTarget = (url) => {
		let path = null;
		if (url.protocol === "https:" && url.host === "github.com") {
			const match = GITHUB_DOCS.exec(url.pathname);
			if (match) path = "/docs/" + match[1];
		} else if (url.protocol === location.protocol && url.host === location.host) path = url.pathname;
		if (path === null) return null;
		if (path.startsWith(BLUEPRINT_ROOT)) {
			const file = path.slice(BLUEPRINT_ROOT.length);
			if (!file || file.includes("/")) return null;
			if (/^index\\.html?$/i.test(file)) return "/docs";
			if (/\\.html?$/i.test(file)) return "/docs/blueprints/" + file + url.hash;
			return null;
		}
		// "../guide/x.md" resolves against "/docs-html/<file>" to "/guide/x.md"; Markdown lives under "/docs/".
		if (/\\.md$/i.test(path) && !path.includes("/../")) return (path.startsWith("/docs/") ? path : "/docs" + path) + url.hash;
		return null;
	};
	// Every activation of a non-fragment link is intercepted, modifier and middle clicks included: the sandbox
	// cannot open tabs, and an unintercepted click would navigate only this frame into an unauthenticated app.
	const followLink = (event, activate) => {
		if (!embedded || event.defaultPrevented) return;
		const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!anchor) return;
		const href = anchor.getAttribute("href") || "";
		if (href.startsWith("#")) return;
		let url;
		try {
			url = new URL(href, location.href);
		} catch {
			event.preventDefault();
			return;
		}
		if (url.href.split("#")[0] === location.href.split("#")[0] && url.hash) return;
		event.preventDefault();
		if (!activate) return;
		const target = localTarget(url);
		if (target !== null) post({ event: "navigate", href: target });
		else if (url.protocol === "https:" || url.protocol === "http:") post({ event: "external", href: url.href });
	};
	document.addEventListener("click", (event) => followLink(event, true));
	document.addEventListener("auxclick", (event) => followLink(event, false));

	let reported = 0;
	let queued = false;
	const measure = () => {
		queued = false;
		const body = document.body;
		const height = Math.ceil(Math.max(root.scrollHeight, body ? body.scrollHeight : 0));
		if (!Number.isFinite(height) || Math.abs(height - reported) <= 1) return;
		reported = height;
		post({ event: "resize", height });
	};
	const scheduleMeasure = () => {
		if (queued) return;
		queued = true;
		window.requestAnimationFrame(measure);
	};
	const scrollToHash = () => {
		if (!location.hash) return;
		let id = location.hash.slice(1);
		try {
			id = decodeURIComponent(id);
		} catch {
			/* Keep the raw fragment. */
		}
		const target = document.getElementById(id);
		if (target) target.scrollIntoView();
	};
	// The lead blockquote that only links a blueprint to itself duplicates the app's reading-view switch.
	const markSelfReference = () => {
		const lead = document.querySelector(".reference-prose > blockquote:first-child");
		if (!lead || lead.querySelector("strong")?.textContent.trim() !== "Visual blueprint:") return;
		const links = lead.querySelectorAll("a[href]");
		if (links.length !== 1) return;
		let url;
		try {
			url = new URL(links[0].getAttribute("href") || "", location.href);
		} catch {
			return;
		}
		if (url.hash || url.search || url.host !== location.host || url.pathname !== location.pathname) return;
		lead.dataset.clioSelfReference = "true";
	};
	const announce = () => {
		if (embedded) markSelfReference();
		const heading = document.querySelector(".document-header h1, main h1, h1");
		const title = ((heading && heading.textContent) || document.title || "").replace(/\\s+/g, " ").trim().slice(0, 200);
		// Inside the app the document's main landmark sits beside the app's own; a name keeps them distinguishable.
		const main = document.querySelector("main");
		if (embedded && main && !main.hasAttribute("aria-label") && !main.hasAttribute("aria-labelledby"))
			main.setAttribute("aria-label", title ? title + " blueprint" : "Blueprint");
		if (typeof ResizeObserver === "function") {
			const observer = new ResizeObserver(scheduleMeasure);
			observer.observe(root);
			if (document.body) observer.observe(document.body);
		} else window.addEventListener("resize", scheduleMeasure);
		const body = document.body;
		reported = Math.ceil(Math.max(root.scrollHeight, body ? body.scrollHeight : 0));
		post({ event: "ready", height: reported, title });
		scrollToHash();
		// Layout can still move while the stylesheet, fonts and images settle; anchor the fragment once more after
		// load, on the next frame. Theme changes never re-anchor, so a reader's position survives them.
		const settled = [
			new Promise((resolve) => {
				if (document.readyState === "complete") resolve();
				else window.addEventListener("load", resolve, { once: true });
			}),
		];
		if (document.fonts && document.fonts.ready) settled.push(document.fonts.ready);
		Promise.all(settled).then(() => {
			scheduleMeasure();
			window.requestAnimationFrame(scrollToHash);
		});
		window.addEventListener("hashchange", scrollToHash);
	};
	// shared.js assigns heading ids on DOMContentLoaded; announce after that pass.
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(announce, 0));
	else setTimeout(announce, 0);
})();
`;

const MARKER = "data-clio-presentation";
const INJECTION = `<style ${MARKER}="style">${STYLESHEET}</style>\n<script ${MARKER}="script">${SCRIPT}</script>\n`;

/**
 * Returns the blueprint HTML with the application presentation injected.
 * The stylesheet lands at the end of `<head>` so it cascades after the
 * handmade `shared.css`; a document without `<head>` receives it before
 * `<body>` content instead. Already presented documents are returned as is.
 */
export function presentBlueprint(html: string): string {
	if (html.includes(`${MARKER}="script"`)) return html;
	const head = /<\/head\s*>/i.exec(html);
	if (head) return `${html.slice(0, head.index)}${INJECTION}${html.slice(head.index)}`;
	const body = /<body[^>]*>/i.exec(html);
	if (body) {
		const at = body.index + body[0].length;
		return `${html.slice(0, at)}\n${INJECTION}${html.slice(at)}`;
	}
	return `${INJECTION}${html}`;
}

/** Message shapes shared by both sides of the bridge; the client mirrors these names. */
export const BLUEPRINT_MESSAGE_TYPE = "clio:blueprint";
export const BLUEPRINT_THEME_MESSAGE_TYPE = "clio:blueprint-theme";
