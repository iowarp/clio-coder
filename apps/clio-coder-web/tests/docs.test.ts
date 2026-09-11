import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../client/render/Markdown.js";
import { Blueprints, DocPage, DocsSearch, DocsTree } from "../contracts/docs.js";
import { harness, json } from "./harness/app.js";
import { scratchHome } from "./harness/scratch-home.js";

test("docs: containment, static methods and types, menu synthesis and topic resolution", async () => {
	const fixture = await scratchHome();
	const html = join(fixture.path, "docs/html");
	await mkdir(html, { recursive: true });
	await mkdir(join(fixture.path, "docs/guide"));
	await writeFile(join(fixture.path, "outside.md"), "secret outside docs");
	await writeFile(
		join(fixture.path, "docs/README.md"),
		"# Fixture\n\n## Begin\n\n| Topic | Link |\n| --- | --- |\n| Guide | [A](guide/a.md) |\n",
	);
	await writeFile(
		join(fixture.path, "docs/guide/a.md"),
		"# A\n\n[Map](../README.md#begin) [Self](#a) [Blueprint](../html/alpha_blueprint.html) [Bad](javascript:bad) [Missing](absent.md)\n",
	);
	await writeFile(join(html, "index.html"), "<h1>Clio docs</h1>\n");
	await writeFile(join(html, "alpha_blueprint.html"), "<h1>Alpha</h1>\n");
	await writeFile(join(html, "Beta.HTML"), "<h1>Beta</h1>\n");
	await writeFile(join(html, "example.css"), "body { color: green; }");
	await writeFile(join(html, "font.woff2"), Buffer.from([1, 2, 3]));
	await symlink(join(fixture.path, "outside.md"), join(html, "escape.html"));
	await symlink(join(fixture.path, "outside.md"), join(fixture.path, "docs/escape.md"));
	let origin = "http://127.0.0.1:0";
	const h = await harness({ fixtureDocsPackageRoot: fixture.path }, { origin: () => origin });
	const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	origin = `http://127.0.0.1:${port}`;
	function raw(path: string, method = "GET") {
		return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>(
			(resolve, reject) => {
				const req = request(
					{ hostname: "127.0.0.1", port, path, method, headers: { Authorization: "Bearer test-token" } },
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk: string) => {
							body += chunk;
						});
						response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
					},
				);
				req.on("error", reject);
				req.end();
			},
		);
	}
	try {
		const tree = JSON.parse((await raw("/api/docs/tree")).body) as { groups: { title: string }[]; pages: unknown[] };
		assert.equal(tree.pages.length, 2);
		assert.deepEqual(
			tree.groups.map((group) => group.title),
			["Begin"],
		);
		const page = JSON.parse((await raw("/api/docs/page?path=guide/a.md")).body) as DocPage;
		assert.equal(page.links["../README.md#begin"], "/docs/README.md#begin");
		assert.equal(page.links["#a"], "/docs/guide/a.md#a");
		assert.equal(page.links["../html/alpha_blueprint.html"], "/docs-html/alpha_blueprint.html");
		assert.deepEqual(page.unavailableLinks, ["javascript:bad", "absent.md"]);
		for (const path of [
			"../outside.md",
			"escape.md",
			"/etc/passwd.md",
			"guide/../../outside.md",
			"guide\\..\\outside.md",
			"\0.md",
		]) {
			const result = await raw(`/api/docs/page?path=${encodeURIComponent(path)}`);
			assert.equal(result.status, 403, path);
			assert.ok(!result.body.includes("secret outside docs"));
		}
		const get = await raw("/docs-html/");
		assert.equal(get.status, 200);
		assert.equal(get.body, "<h1>Clio docs</h1>\n");
		assert.equal(get.headers["content-type"], "text/html; charset=utf-8");
		assert.equal(get.headers["cache-control"], "no-store");
		assert.match(String(get.headers["content-security-policy"]), /sandbox allow-scripts/);
		assert.doesNotMatch(String(get.headers["content-security-policy"]), /allow-same-origin/);
		const head = await raw("/docs-html/index.html?ignored=1", "HEAD");
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
		assert.equal(head.headers["content-length"], String(Buffer.byteLength(get.body)));
		for (const path of [
			"/docs-html/%2e%2e/outside.md",
			"/docs-html/%2e%2e/api/meta",
			"/docs-html/%2e%2e%2foutside.md",
			"/docs-html/%5c..%5coutside.md",
			"/docs-html/%00",
			"/docs-html/escape.html",
		])
			assert.equal((await raw(path)).status, 403, path);
		assert.equal((await raw("/docs-html/%zz")).status, 400);
		assert.equal((await raw("/docs-html/missing.html")).status, 404);
		const post = await raw("/docs-html/index.html", "POST");
		assert.equal(post.status, 405);
		assert.equal(post.headers.allow, "GET, HEAD");
		assert.equal((await raw("/docs-html/example.css")).headers["content-type"], "text/css; charset=utf-8");
		assert.equal((await raw("/docs-html/font.woff2")).headers["content-type"], "font/woff2");
		const menu = JSON.parse((await raw("/api/docs/blueprints")).body) as Blueprints;
		assert.deepEqual(
			menu.items.map((row) => row.topic),
			["alpha", "Beta"],
		);
		for (const path of ["alpha", "ALPHA.html", "beta", "Beta.HTML"])
			assert.equal((await raw(`/docs-html/${path}`)).status, 200, path);
		// An indexed page is re-resolved at read time, including a later symlink replacement.
		await rm(join(fixture.path, "docs/guide/a.md"));
		await symlink(join(fixture.path, "outside.md"), join(fixture.path, "docs/guide/a.md"));
		assert.equal((await raw("/api/docs/page?path=guide/a.md")).status, 403);
	} finally {
		if ("closeAllConnections" in server) server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await h.close();
		await fixture.close();
	}
});

test("docs: absent packaged blueprints and absent docs root are explicit", async () => {
	const fixture = await scratchHome();
	await mkdir(join(fixture.path, "docs"));
	await writeFile(join(fixture.path, "docs/README.md"), "# Packaged reference");
	const h = await harness({ fixtureDocsPackageRoot: fixture.path });
	try {
		assert.deepEqual(await json(await h.request("/api/docs/blueprints"), Blueprints), { available: false, items: [] });
		assert.equal((await h.request("/docs-html/index.html")).status, 404);
		assert.equal((await h.request("/api/docs/tree", { method: "POST" })).status, 405);
		assert.equal((await h.request("/api/docs/page?path=README.txt")).status, 422);
		assert.equal((await h.request("/api/docs/search?q=trace&q=other")).status, 422);
		await rm(join(fixture.path, "docs"), { recursive: true });
		assert.equal((await h.request("/api/docs/page?path=README.md")).status, 404);
	} finally {
		await h.close();
		await fixture.close();
	}
});

test("docs: walk every discovered Markdown page and live internal link; trace ranks in top three", async (t) => {
	const root = fileURLToPath(new URL("../../../docs/", import.meta.url));
	async function scan(path = ""): Promise<string[]> {
		const entries = await readdir(join(root, path), { withFileTypes: true });
		return (
			await Promise.all(
				entries
					.filter((entry) => path || entry.name !== "html")
					.map(async (entry) => {
						const name = path ? `${path}/${entry.name}` : entry.name;
						return entry.isDirectory() ? scan(name) : entry.isFile() && /\.md$/i.test(name) ? [name] : [];
					}),
			)
		).flat();
	}
	const h = await harness();
	try {
		const tree = await json(await h.request("/api/docs/tree"), DocsTree);
		assert.deepEqual(tree.pages.map((row) => row.path).sort(), (await scan()).sort());
		const pages = new Map<string, { page: DocPage; html: string }>();
		for (const row of tree.pages) {
			const response = await h.request(`/api/docs/page?path=${encodeURIComponent(row.path)}`);
			assert.equal(response.status, 200, row.path);
			const page = await json(response, DocPage);
			assert.equal(page.markdown, await readFile(join(root, row.path), "utf8"));
			const html = renderToStaticMarkup(
				createElement(MarkdownContent, {
					source: page.markdown,
					complete: true,
					deferDiagrams: true,
					documentLinks: page.links,
				}),
			);
			assert.ok(html.length > 0);
			assert.doesNotMatch(html, /<script|href="javascript:/i);
			pages.set(row.path, { page, html });
		}
		const blueprints = new Set<string>();
		let links = 0;
		const unavailable: Record<string, string[]> = {};
		for (const [source, { page }] of pages) {
			if (page.unavailableLinks.length) unavailable[source] = page.unavailableLinks;
			for (const destination of Object.values(page.links)) {
				if (!destination?.startsWith("/")) continue;
				links++;
				const url = new URL(destination, "http://127.0.0.1");
				if (url.pathname.startsWith("/docs/")) {
					const target = pages.get(decodeURIComponent(url.pathname.slice(6)));
					assert.ok(target, `${source} -> ${destination}`);
					if (url.hash) assert.ok(target.html.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), destination);
				} else blueprints.add(url.pathname);
			}
		}
		for (const path of blueprints) assert.equal((await h.request(path)).status, 200, path);
		const search = await json(await h.request("/api/docs/search?q=trace"), DocsSearch);
		assert.ok(search.slice(0, 3).some((row) => row.path === "architecture/trace-store.md"));
		assert.deepEqual(await json(await h.request("/api/docs/search?q="), DocsSearch), []);
		t.diagnostic(
			JSON.stringify({
				documents: pages.size,
				liveInternalLinks: links,
				blueprints: blueprints.size,
				unavailableSourceReferences: unavailable,
			}),
		);
	} finally {
		await h.close();
	}
});
