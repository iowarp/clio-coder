import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyChange } from "../../src/harness/classifier.js";

const REPO = "/repo";

function classify(rel: string) {
	return classifyChange(join(REPO, rel), REPO);
}

describe("classifyChange", () => {
	it("hot: src/tools/read.ts", () => strictEqual(classify("src/tools/read.ts").class, "hot"));
	it("hot: src/tools/edit.ts", () => strictEqual(classify("src/tools/edit.ts").class, "hot"));
	it("restart: src/tools/registry.ts", () => strictEqual(classify("src/tools/registry.ts").class, "restart"));
	it("restart: src/tools/bootstrap.ts", () => strictEqual(classify("src/tools/bootstrap.ts").class, "restart"));
	it("restart: src/tools/truncate-utf8.ts", () => strictEqual(classify("src/tools/truncate-utf8.ts").class, "restart"));
	it("restart: src/engine/agent.ts", () => strictEqual(classify("src/engine/agent.ts").class, "restart"));
	it("restart: src/core/config.ts", () => strictEqual(classify("src/core/config.ts").class, "restart"));
	it("restart: src/domains/session/extension.ts", () =>
		strictEqual(classify("src/domains/session/extension.ts").class, "restart"));
	it("restart: src/domains/providers/runtimes/local.ts", () =>
		strictEqual(classify("src/domains/providers/runtimes/local.ts").class, "restart"));
	it("worker-next-dispatch: src/worker/entry.ts", () =>
		strictEqual(classify("src/worker/entry.ts").class, "worker-next-dispatch"));
	it("restart: src/entry/orchestrator.ts", () => strictEqual(classify("src/entry/orchestrator.ts").class, "restart"));
	it("restart: src/cli/clio.ts", () => strictEqual(classify("src/cli/clio.ts").class, "restart"));
	it("restart: src/interactive/overlays/model-selector.ts", () =>
		strictEqual(classify("src/interactive/overlays/model-selector.ts").class, "restart"));
	it("restart: src/harness/classifier.ts (self)", () =>
		strictEqual(classify("src/harness/classifier.ts").class, "restart"));
	it("ignore: tests/unit/foo.test.ts", () => strictEqual(classify("tests/unit/foo.test.ts").class, "ignore"));
	it("ignore: docs/README.md", () => strictEqual(classify("docs/README.md").class, "ignore"));
	it("ignore: src/tools/README.md", () => strictEqual(classify("src/tools/README.md").class, "ignore"));
	it("restart: package.json", () => strictEqual(classify("package.json").class, "restart"));
	it("restart: tsconfig.json", () => strictEqual(classify("tsconfig.json").class, "restart"));
	it("restart: tsup.config.ts", () => strictEqual(classify("tsup.config.ts").class, "restart"));
	it("ignore: dist/cli/index.js", () => strictEqual(classify("dist/cli/index.js").class, "ignore"));
	it("ignore: node_modules/foo/index.js", () => strictEqual(classify("node_modules/foo/index.js").class, "ignore"));
	it("ignore: absolute path outside repo", () => {
		strictEqual(classifyChange("/tmp/other/file.ts", REPO).class, "ignore");
	});
	it("ignore: .github/workflows/ci.yml", () => strictEqual(classify(".github/workflows/ci.yml").class, "ignore"));
	it("returns a non-empty reason for every classified cohort", () => {
		const paths = [
			"src/tools/read.ts", // hot
			"src/tools/registry.ts", // restart (tool exclusion)
			"src/tools/README.md", // ignore (markdown)
			"src/engine/agent.ts", // restart (engine)
			"src/core/config.ts", // restart (core)
			"src/domains/session/extension.ts", // restart (domain)
			"src/worker/entry.ts", // worker-next-dispatch
			"src/interactive/overlays/model.ts", // restart (interactive)
			"src/entry/orchestrator.ts", // restart (entry)
			"src/cli/clio.ts", // restart (cli)
			"src/harness/classifier.ts", // restart (harness self)
			"src/unknown-subtree/foo.ts", // restart (unknown src)
			"tests/unit/foo.test.ts", // ignore (tests)
			"docs/README.md", // ignore (docs)
			"package.json", // restart (root config)
			"dist/cli/index.js", // ignore (dist)
			"node_modules/foo/index.js", // ignore (node_modules)
			".git/HEAD", // ignore (.git)
			".github/workflows/ci.yml", // ignore (.github)
		];
		for (const p of paths) {
			const result = classify(p);
			strictEqual(typeof result.reason, "string", `reason not a string for ${p}`);
			deepStrictEqual(result.reason.length > 0, true, `empty reason for ${p}`);
		}
	});
});
