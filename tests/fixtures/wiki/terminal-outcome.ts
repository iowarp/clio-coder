import assert from "node:assert/strict";
import { mock } from "node:test";

const [command, status, pendingText] = process.argv.slice(2);
const pending = Number(pendingText);
const result = { status, pages: 3, pending };
const pages = Array.from({ length: 3 }, (_, index) => ({
	path: `page-${index}.md`,
	status: index < pending ? "pending" : "written",
	attempts: index < pending ? 3 : 1,
	...(index < pending ? { lastFailure: { phase: "writer", detail: "fixture fetch failed" } } : {}),
}));
mock.module("../../../src/domains/context/index.js", {
	namedExports: {
		runWikiGenerate: async (input: { retryPending?: boolean }) => {
			assert.equal(input.retryPending === true, command === "retry");
			return result;
		},
		runContextRefresh: async () => ({ wiki: result }),
		readWikiMeta: () => ({ plan: { pages } }),
	},
});
mock.module("../../../src/cli/wiki-generate.js", {
	namedExports: { modelWikiGenerate: () => () => {}, resolveDocumenterModelId: async () => "fixture" },
});
const { runContextCommand } = await import("../../../src/cli/context.js");
process.exitCode = await runContextCommand(
	command === "refresh" ? ["refresh", "--wiki"] : command === "retry" ? ["wiki", "--retry-pending"] : ["wiki"],
);
