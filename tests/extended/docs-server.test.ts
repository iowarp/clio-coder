import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { docsTopicRoute, runDocsCommand } from "../../src/cli/docs.js";

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
	it("rejects invalid command input before a server or browser starts", async () => {
		strictEqual(await runDocsCommand(["--unexpected"]), 2);
		strictEqual(await runDocsCommand(["safety", "configuration"]), 2);
		strictEqual(await runDocsCommand(["../outside", "--no-open"]), 2);
	});
});
