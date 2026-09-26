import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getRuntimeRegistry } from "../../src/domains/providers/index.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { createQuotaService } from "../../src/domains/quota/service.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("BT-006 local cost appears only for configured local runtime targets", async () => {
	const env = await isolateClioEnv();
	try {
		registerBuiltinRuntimes(getRuntimeRegistry());
		mkdirSync(join(env.dir, "config"), { recursive: true });
		const configure = (runtime: string) =>
			writeFileSync(
				join(env.dir, "config/settings.yaml"),
				`version: 2\ntargets:\n  - id: test\n    runtime: ${runtime}\n`,
			);
		configure("openrouter");
		const cloud = createQuotaService({ providers: [] });
		deepStrictEqual(cloud.peek(), []);
		deepStrictEqual(await cloud.read(), []);
		configure("ollama");
		const local = createQuotaService({ providers: [] });
		strictEqual(local.peek().length, 1);
		strictEqual((await local.read())[0]?.providerId, "local");
		deepStrictEqual(createQuotaService({ providers: [], includeLocal: false }).peek(), []);
	} finally {
		env.restore();
	}
});
