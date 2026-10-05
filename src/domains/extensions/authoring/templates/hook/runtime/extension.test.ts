import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

test("__EXTENSION_ID__ hook behavior", async () => {
	const host = await createExtensionTestHost(fileURLToPath(new URL("../", import.meta.url)));
	try {
		assert.equal((await host.command("protect", "paper/draft.md")).text, "Protected paper/draft.md");
		const blocked = await host.hook({
			point: "before_tool",
			tool: "write",
			turnId: null,
			args: { path: "paper/draft.md" },
		});
		assert.deepEqual(blocked.effects, [{ kind: "block_tool", reason: "__EXTENSION_ID__ protects paper/draft.md" }]);
		assert.deepEqual(
			await host.hook({ point: "before_tool", tool: "edit", turnId: null, args: { path: "other.md" } }),
			{},
		);
		assert.deepEqual((await host.store.get<string[]>("protected")).value, ["paper/draft.md"]);
	} finally {
		await host.dispose();
	}
});
