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
const blueprints = [
	{ topic: "safety", file: "safety_blueprint.html", documentPath: "architecture/safety-model.md" },
	{ topic: "configuration", file: "configuration_blueprint.html", documentPath: "guide/configuration-and-targets.md" },
	{ topic: "visual_only", file: "visual_only_blueprint.html" },
];

describe("contracts/docs canonical navigation", () => {
	it("opens the app map or the canonical Markdown page from a paired topic", () => {
		strictEqual(docsTopicRoute(undefined, pages, blueprints), "/docs");
		for (const topic of [
			"safety",
			"SAFETY",
			"safety_blueprint",
			"safety_blueprint.html",
			"safety-model",
			"architecture/safety-model.md",
			"docs/architecture/safety-model.md",
		])
			strictEqual(docsTopicRoute(topic, pages, blueprints), "/docs/architecture/safety-model.md", topic);
		strictEqual(docsTopicRoute("configuration", pages, blueprints), "/docs/guide/configuration-and-targets.md");
	});
	it("supports Markdown without blueprints and unpaired visual content inside the app", () => {
		strictEqual(docsTopicRoute("safety-model", pages, []), "/docs/architecture/safety-model.md");
		strictEqual(docsTopicRoute("visual-only", pages, blueprints), "/docs/blueprints/visual_only_blueprint.html");
		strictEqual(docsTopicRoute("Space name", pages, blueprints), "/docs/guide/Space%20name.md");
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
			strictEqual(docsTopicRoute(topic, pages, blueprints), undefined, topic);
		strictEqual(docsTopicRoute("process/setup", pages, blueprints), "/docs/process/setup.md");
	});
	it("rejects invalid command input before a server or browser starts", async () => {
		strictEqual(await runDocsCommand(["--unexpected"]), 2);
		strictEqual(await runDocsCommand(["safety", "configuration"]), 2);
		strictEqual(await runDocsCommand(["../outside", "--no-open"]), 2);
	});
});
