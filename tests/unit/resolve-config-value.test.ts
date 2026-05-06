import { ok, strictEqual, throws } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	clearConfigValueCache,
	expandConfigPath,
	expandConfigValue,
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeaders,
} from "../../src/core/resolve-config-value.js";

describe("core/resolve-config-value", () => {
	it("resolves direct environment variable references before literals", () => {
		const value = resolveConfigValue("CLIO_TOKEN", { env: { CLIO_TOKEN: "secret" } });
		strictEqual(value, "secret");
	});

	it("expands embedded environment variables in literal values", () => {
		strictEqual(expandConfigValue(`Bearer $${"{CLIO_TOKEN}"}`, { env: { CLIO_TOKEN: "secret" } }), "Bearer secret");
		strictEqual(
			resolveConfigValue("https://$CLIO_HOST/v1", { env: { CLIO_HOST: "example.test" } }),
			"https://example.test/v1",
		);
	});

	it("expands home-relative and env-bearing paths against cwd", () => {
		strictEqual(expandConfigPath("~/skills"), join(homedir(), "skills"));
		strictEqual(
			expandConfigPath("$PROJECT_DIR/skills", { cwd: "/tmp/repo", env: { PROJECT_DIR: "local" } }),
			"/tmp/repo/local/skills",
		);
	});

	it("resolves headers through the same value resolver", () => {
		const resolved = resolveHeaders(
			{
				authorization: `Bearer $${"{CLIO_TOKEN}"}`,
				"x-literal": "static",
			},
			{ env: { CLIO_TOKEN: "secret" } },
		);
		strictEqual(resolved?.authorization, "Bearer secret");
		strictEqual(resolved?.["x-literal"], "static");
	});

	it("executes bang-prefixed shell commands and caches the result", () => {
		clearConfigValueCache();
		const command = '!node -e "process.stdout.write(String(Date.now()))"';
		const first = resolveConfigValue(command);
		const second = resolveConfigValue(command);
		ok(first && first.length > 0);
		strictEqual(second, first);
	});

	it("can bypass the command cache for callers that need fresh values", () => {
		const command = '!node -e "process.stdout.write(String(process.hrtime.bigint()))"';
		const first = resolveConfigValueUncached(command);
		const second = resolveConfigValueUncached(command);
		ok(first && second);
		ok(first !== second || first.length > 0);
	});

	it("throws a descriptive error when a command cannot resolve", () => {
		throws(() => resolveConfigValueOrThrow('!node -e "process.exit(7)"', "api key"), /api key/);
	});
});
