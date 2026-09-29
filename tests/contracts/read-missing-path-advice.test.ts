import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { readTool } from "../../src/tools/read.js";
import { makeScratchHome } from "../harness/scratch-env.js";

// A researcher reads with `read` alone. Its ENOENT advice named code_nav, find and ls, none of
// which its admitted surface let it call, so the advice follows the surface.
test("a missing path points only at locator tools the run may call", async () => {
	const scratch = makeScratchHome("clio-read-missing-advice-");
	try {
		const args = { path: join(scratch.dir, "absent.txt") };
		const message = async (allowedTools?: ReadonlyArray<(typeof ToolNames)[keyof typeof ToolNames]>) => {
			const result = await readTool.run(args, allowedTools === undefined ? undefined : { allowedTools });
			ok(result.kind === "error");
			return result.message;
		};
		match(await message(), /Try: code_nav, find, or ls to locate it\./u);
		match(await message([ToolNames.Read, ToolNames.Ls]), /Try: ls to locate it\./u);
		match(await message([ToolNames.Read, ToolNames.Find, ToolNames.Ls]), /Try: find or ls to locate it\./u);
		const none = await message([ToolNames.Read, ToolNames.Ledger]);
		doesNotMatch(none, /code_nav|find|Try:/u);
		match(none, /No listing tool is available on this run/u);
		strictEqual(none.includes("File not found at"), true);
	} finally {
		scratch.cleanup();
	}
});
