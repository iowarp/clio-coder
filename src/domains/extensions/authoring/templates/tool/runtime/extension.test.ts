import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

test("__EXTENSION_ID__ tool behavior", async () => {
	const host = await createExtensionTestHost(fileURLToPath(new URL("../", import.meta.url)));
	try {
		assert.deepEqual(await host.tool("describe", { name: "Ada" }), { text: "Hello, Ada.", data: { name: "Ada" } });
		assert.equal((await host.tool("describe", {})).isError, true);
	} finally {
		await host.dispose();
	}
});
