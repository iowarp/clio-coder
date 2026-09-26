import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { navigation } from "../client/design/navigation.js";
import { PUBLIC_GUIDES, PUBLIC_HELP, publicHelpUrl } from "../client/interaction/public-help.js";
import { harness } from "./harness/app.js";

(globalThis as { React?: typeof React }).React = React;
register(
	`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`,
);
const { HelpReferenceBody } = await import("../client/interaction/HelpDialog.js");

test("Help projects only the canonical public allowlist and never forwards private launch data", async () => {
	const catalog = JSON.parse(await readFile(new URL("../../../site/public-docs.json", import.meta.url), "utf8")) as {
		path: string;
	}[];
	assert.deepEqual(
		PUBLIC_GUIDES.map((name) => `guide/${name}.md`).sort(),
		catalog
			.map((page) => page.path)
			.filter((path) => path !== "README.md")
			.sort(),
	);
	assert.equal(publicHelpUrl("/docs/guide/tool-usage.md"), "https://coder.iowarp.ai/docs/guide/tool-usage.html");
	for (const path of [
		"/docs",
		"/docs/architecture/safety-model.md",
		"/docs/guide/missing.md",
		"/docs/guide/tool-usage.md?token=private",
		"/docs/guide/tool-usage.md#token=private",
		"/docs/../credentials",
		"/docs/guide/%74ool-usage.md",
	])
		assert.equal(publicHelpUrl(path), PUBLIC_HELP, path);
	assert.ok(navigation.every((entry) => entry.path !== ("/docs" as string)));
});

test("Help identifies installed offline retrieval without adding a reader", () => {
	const html = renderToStaticMarkup(<HelpReferenceBody bundledDocsPath="/installed/clio/docs" />);
	assert.match(html, /href="https:\/\/coder\.iowarp\.ai\/docs\.html"/u);
	assert.match(html, /rel="noopener noreferrer"/u);
	assert.match(html, /referrerPolicy="no-referrer"/iu);
	assert.match(html, /\/installed\/clio\/docs/u);
	assert.match(html, /clio_docs/u);
	assert.doesNotMatch(html, /iframe|\/api\/docs|#token=/u);
});

test("the former native reader API no longer serves Markdown, search, or navigation", async (t) => {
	const h = await harness();
	t.after(h.close);
	for (const path of ["/api/docs/tree", "/api/docs/page?path=guide/tool-usage.md", "/api/docs/search?q=tool"])
		assert.equal((await h.request(path)).status, 404, path);
	const meta = await (await h.request("/api/meta")).json();
	assert.match(meta.bundledDocsPath, /[/\\]docs$/u);
});
