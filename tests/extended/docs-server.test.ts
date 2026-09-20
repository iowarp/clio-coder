import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { docsTopicRoute, runDocsCommand } from "../../src/cli/docs.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";

const pages = [
	"README.md",
	"architecture/safety-model.md",
	"guide/configuration-and-targets.md",
	"guide/setup.md",
	"process/setup.md",
	"guide/Space name.md",
];

describe("contracts/docs canonical navigation", () => {
	it("opens the app map or the canonical Markdown page from a topic", () => {
		strictEqual(docsTopicRoute(undefined, pages), "/docs");
		for (const topic of [
			"safety",
			"SAFETY",
			"safety-model",
			"architecture/safety-model.md",
			"docs/architecture/safety-model.md",
		])
			strictEqual(docsTopicRoute(topic, pages), "/docs/architecture/safety-model.md", topic);
		strictEqual(docsTopicRoute("configuration", pages), "/docs/guide/configuration-and-targets.md");
	});
	it("supports canonical document names and escaped paths", () => {
		strictEqual(docsTopicRoute("safety-model", pages), "/docs/architecture/safety-model.md");
		strictEqual(docsTopicRoute("safety_blueprint.html", pages), undefined);
		strictEqual(docsTopicRoute("Space name", pages), "/docs/guide/Space%20name.md");
	});
	it("requires a full path for ambiguous basenames and refuses unknown or external destinations", () => {
		for (const topic of [
			"",
			"setup",
			"unknown",
			"../secret",
			"/docs",
			"//example.com",
			"https://example.com",
			"safety#token=evil",
			"safety?x=1",
			"safety\\x",
			"\0",
		])
			strictEqual(docsTopicRoute(topic, pages), undefined, topic);
		strictEqual(docsTopicRoute("process/setup", pages), "/docs/process/setup.md");
	});
	it("says documentation pages need the graphical application and names the shipped Markdown", async () => {
		const captured: string[] = [];
		const stderr = process.stderr.write.bind(process.stderr);
		const stdout = process.stdout.write.bind(process.stdout);
		const capture = ((chunk: string) => {
			captured.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		process.stderr.write = capture;
		process.stdout.write = capture;
		try {
			for (const args of [[], ["safety"], ["--unexpected"], ["safety", "configuration"], ["../outside", "--no-open"]]) {
				strictEqual(await runDocsCommand(args), 2, args.join(" "));
			}
			strictEqual(captured.length, 5, "each invocation reports once");
			for (const line of captured) {
				ok(line.includes("not part of this release"), line);
				ok(line.includes(join(resolvePackageRoot(), "docs")), line);
			}
			captured.length = 0;
			strictEqual(await runDocsCommand(["--help"]), 0);
		} finally {
			process.stderr.write = stderr;
			process.stdout.write = stdout;
		}
		strictEqual(captured.length, 1, "--help prints its usage");
	});
});
