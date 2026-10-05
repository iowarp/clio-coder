import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createExtensionTestHost } from "@iowarp/clio-coder/extensions/testing";

test("__EXTENSION_ID__ status behavior", async () => {
	const host = await createExtensionTestHost(fileURLToPath(new URL("../", import.meta.url)));
	try {
		assert.equal((await host.command("status")).text, "__EXTENSION_ID__: 0 ticks");
		const first = await host.tick();
		assert.equal(first?.status?.text, "__EXTENSION_ID__ · 1 ticks");
		assert.equal(first?.band?.t, "kv");
		await host.advance(10000);
		assert.equal((await host.state.get<number>("ticks")).value, 3);
		assert.equal(host.now, 10000);
	} finally {
		await host.dispose();
	}
});
