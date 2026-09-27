import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenCSS } from "./tokens.mjs";

const root = dirname(fileURLToPath(import.meta.url));
export async function checkPolicy() {
	const rules = JSON.parse(await readFile(join(root, "design-system.json"), "utf8"));
	const errors = [];
	const brand = await readFile(join(root, "css/brand.css"), "utf8");
	if (brand !== (await tokenCSS()))
		errors.push("css/brand.css differs from design-system.json; regenerate it with node site/tokens.mjs");
	for (const file of await readdir(join(root, "css"))) {
		if (!file.endsWith(".css") || file === "brand.css") continue;
		const css = (await readFile(join(root, "css", file), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
		if (/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(css))
			errors.push(`css/${file}: literal colors are forbidden; use sanctioned tokens`);
		for (const motion of css.matchAll(/(?:transition|animation)(?:-(?:duration|delay|timing-function))?\s*:\s*([^;}]+)/g))
			if (/\b(?:\d*\.)?\d+(?:ms|s)\b|cubic-bezier\(|steps\(/.test(motion[1]))
				errors.push(`css/${file}: motion must use the shared duration and easing tokens`);
		for (const match of css.matchAll(
			/(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|(?:fill|stroke)|outline(?:-color)?)\s*:\s*([^;}]+)/g,
		)) {
			if (!/var\(|^(?:transparent|inherit|currentColor|none|0)\b/i.test(match[1].trim()))
				errors.push(`css/${file}: color declaration must use a semantic token: ${match[1].trim()}`);
		}
	}
	for (const file of [
		"index.html",
		"learn.html",
		"partials.html",
		"docs.html",
		"tutorial.html",
		"404.html",
		...(await readdir(join(root, "content/tutorials"))).map((name) => `content/tutorials/${name}`),
	]) {
		const text = await readFile(join(root, file), "utf8");
		if (/\bstyle\s*=|<style\b/i.test(text)) errors.push(`${file}: inline styles are forbidden`);
		const plain = text.replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ");
		for (const phrase of rules.prose.forbidden)
			if (new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(plain))
				errors.push(`${file}: unsanctioned public wording: ${phrase}`);
		const paragraphs = file.endsWith(".md")
			? text
					.replace(/```[\s\S]*?```/g, "")
					.split(/\n\s*\n/)
					.filter((p) => !/^(?:#|\||!\[|>|\d\.|- )/.test(p))
			: [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
		for (const p of paragraphs)
			if (
				p
					.replace(/<[^>]+>/g, " ")
					.trim()
					.split(/\s+/).length > rules.prose.maxMarketingParagraphWords
			)
				errors.push(`${file}: paragraph exceeds ${rules.prose.maxMarketingParagraphWords} words`);
	}
	const docs = JSON.parse(await readFile(join(root, "public-docs.json"), "utf8"));
	if (docs.some((item) => !/^(?:docs\/guide\/[^/]+\.md|README\.md)$/.test(item.source)))
		errors.push("Public docs must be explicit user guides; internal corpora cannot be published");
	if (docs.some((item) => item.summary && !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(item.summary)))
		errors.push("Public summaries must be explicit Markdown files in content/doc-summaries");
	const partials = await readFile(join(root, "partials.html"), "utf8");
	const primary = partials.match(/<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
	if (
		(primary.match(/<a /g) ?? []).length !== 3 ||
		!["Overview", "Docs", "Tutorials"].every((label) => primary.includes(`>${label}</a>`))
	)
		errors.push("Primary navigation must be Overview, Docs, Tutorials");
	if (!partials.includes(rules.copyright)) errors.push("Footer must use the sanctioned public copyright wording");
	const tutorials = JSON.parse(await readFile(join(root, "content/tutorials.json"), "utf8"));
	const slugs = new Set();
	for (const item of tutorials) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug) || slugs.has(item.slug))
			errors.push(`Invalid or duplicate tutorial slug: ${item.slug}`);
		slugs.add(item.slug);
		if (!/^[a-z0-9-]+\.md$/.test(item.source)) errors.push(`Tutorial ${item.slug}: invalid source`);
		if (item.video && !/^[\w-]{11}$/.test(item.video))
			errors.push(`Tutorial ${item.slug}: video must have a real 11-character YouTube ID`);
		for (const key of ["title", "description", "category", "time", "author", "image", "alt"])
			if (!item[key]) errors.push(`Tutorial ${item.slug}: missing ${key}`);
	}
	if (errors.length) throw new Error(`Site policy failed:\n${errors.join("\n")}`);
	console.log("Site policy passed: sanctioned tokens, public copy, attribution, navigation, and content boundaries.");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await checkPolicy();
