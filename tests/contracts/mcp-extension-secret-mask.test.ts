import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { mcpCommandOutput } from "../../src/cli/mcp.js";
import { MCP_USER_CONFIG_FILENAME } from "../../src/domains/gateway/mcp/index.js";
import { makeScratchHome } from "../harness/scratch-env.js";

it("mcp list never displays an mcp.yaml env token value", () => {
	const scratch = makeScratchHome("clio-mcp-secret-mask-");
	const project = join(scratch.dir, "project");
	const config = join(scratch.dir, "config");
	mkdirSync(project, { recursive: true });
	mkdirSync(config, { recursive: true });
	const token = "ghp_maskme0123456789abcdefABCDEF0123456789";
	writeFileSync(
		join(config, MCP_USER_CONFIG_FILENAME),
		`version: 1\nservers:\n  - id: personal\n    command: node\n    env:\n      GITHUB_TOKEN: ${token}\n      PLAIN_SETTING: also-hidden-value\n`,
	);
	try {
		const result = mcpCommandOutput(["list"], { cwd: project, configDir: config });
		strictEqual(result.code, 0, result.text);
		const shown = `${result.text}\n${JSON.stringify(result.data)}`;
		ok(!shown.includes(token), "the env token value is displayed");
		ok(!shown.includes("also-hidden-value"), "an env value is displayed");
		ok(shown.includes("GITHUB_TOKEN"), "the env key names stay visible");
	} finally {
		scratch.cleanup();
	}
});
