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
	resolveDynamicConfigValue,
	resolveDynamicHeaders,
	resolveHeaders,
	resolveStaticConfigValue,
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

	it("resolves headers through static value resolution", () => {
		const resolved = resolveHeaders(
			{
				authorization: `Bearer $${"{CLIO_TOKEN}"}`,
				"x-literal": "static",
				"x-command": '!node -e "process.stdout.write(String(1))"',
			},
			{ env: { CLIO_TOKEN: "secret" } },
		);
		strictEqual(resolved?.authorization, "Bearer secret");
		strictEqual(resolved?.["x-literal"], "static");
		strictEqual(resolved?.["x-command"], '!node -e "process.stdout.write(String(1))"');
	});

	it("keeps command-backed headers behind explicit dynamic resolution", () => {
		clearConfigValueCache();
		const resolved = resolveDynamicHeaders({
			"x-command": '!node -e "process.stdout.write(String(11))"',
		});
		strictEqual(resolved?.["x-command"], "11");
	});

	it("executes bang-prefixed shell commands and caches the result", () => {
		clearConfigValueCache();
		const command = '!node -e "process.stdout.write(String(Date.now()))"';
		const first = resolveConfigValue(command);
		const second = resolveConfigValue(command);
		ok(first && first.length > 0);
		strictEqual(second, first);
	});

	it("keeps command execution behind an explicit dynamic resolver", () => {
		clearConfigValueCache();
		const command = '!node -e "process.stdout.write(String(42))"';

		strictEqual(resolveStaticConfigValue(command), command);
		strictEqual(resolveDynamicConfigValue(command), "42");
	});

	it("warns when the legacy generic resolver executes a command", () => {
		clearConfigValueCache();
		const warnings: string[] = [];
		const command = '!node -e "process.stdout.write(String(7))"';

		const value = resolveConfigValue(command, {
			onWarning(warning) {
				warnings.push(`${warning.code}:${warning.command}`);
			},
		});

		strictEqual(value, "7");
		strictEqual(warnings.length, 1);
		ok(warnings[0]?.startsWith("dynamic-command-in-generic-resolution:node -e"));
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
