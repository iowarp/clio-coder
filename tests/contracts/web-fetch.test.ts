import { ok, strictEqual } from "node:assert";
import test from "node:test";
import { extractWebFetchContent } from "../../src/tools/web-fetch.js";

test("web_fetch extracts main HTML content as markdown and drops boilerplate", () => {
	const html = `<!doctype html>
<html>
<head>
<title>Example Docs</title>
<meta name="description" content="Useful docs page">
<link rel="canonical" href="/docs/page">
<style>.ad{display:none}</style><script>window.noise = true</script>
</head>
<body>
<nav><a href="/home">Home</a></nav>
<main>
<h1>Install &amp; Run</h1>
<p>Use <a href="/cli">the CLI</a> for setup.</p>
<pre><code>npm install clio</code></pre>
<ul><li>Fast</li><li>Token efficient</li></ul>
</main>
<footer>copyright</footer>
</body></html>`;

	const extracted = extractWebFetchContent(html, "text/html; charset=utf-8", "https://example.com/base", "auto");

	strictEqual(extracted.format, "markdown");
	strictEqual(extracted.title, "Example Docs");
	strictEqual(extracted.description, "Useful docs page");
	strictEqual(extracted.canonical, "https://example.com/docs/page");
	ok(extracted.content.includes("# Install & Run"));
	ok(extracted.content.includes("[the CLI](https://example.com/cli)"));
	ok(extracted.content.includes("```\nnpm install clio\n```"));
	ok(!extracted.content.includes("window.noise"));
	ok(!extracted.content.includes("display:none"));
});

test("web_fetch keeps non-html responses as text", () => {
	const extracted = extractWebFetchContent('{"ok":true}', "application/json", "https://example.com/api", "auto");
	strictEqual(extracted.format, "text");
	strictEqual(extracted.content, '{"ok":true}');
});
