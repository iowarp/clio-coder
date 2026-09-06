import { mock } from "node:test";

const [command, status, pendingText] = process.argv.slice(2);
const pending = Number(pendingText);
const result = { status, pages: 3, pending };
const pages = Array.from({ length: 3 }, (_, index) => ({ status: index < pending ? "pending" : "written" }));
mock.module("../../../src/domains/context/index.js", {
	namedExports: {
		runWikiGenerate: async () => result,
		runContextRefresh: async () => ({ wiki: result }),
		readWikiMeta: () => ({ plan: { pages } }),
	},
});
mock.module("../../../src/cli/wiki-generate.js", {
	namedExports: { modelWikiGenerate: () => () => {}, resolveDocumenterModelId: async () => "fixture" },
});
const { runContextCommand } = await import("../../../src/cli/context.js");
process.exitCode = await runContextCommand(command === "refresh" ? ["refresh", "--wiki"] : ["wiki"]);
