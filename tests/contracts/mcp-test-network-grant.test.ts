/**
 * Text `clio-coder mcp test <id>` output never named the worker network grant;
 * only --json carried it. The headline now spells it the way `mcp list` does.
 */
import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { mcpTestHeadline } from "../../src/cli/mcp.js";

const info = {
	protocolVersion: "2025-06-18",
	serverInfo: { name: "echo", version: "1.0.0" },
	capabilities: {},
	instructions: null,
};

it("names the network grant and its source in the text mcp test headline", () => {
	strictEqual(
		mcpTestHeadline("echo", info, 1, { network: true, networkSource: "trust" }),
		"echo: protocol 2025-06-18, server echo 1.0.0, 1 tools, network=true (trust record)",
	);
	strictEqual(
		mcpTestHeadline("echo", info, 1, { network: true, networkSource: "declaration" }),
		"echo: protocol 2025-06-18, server echo 1.0.0, 1 tools, network=true (user declaration)",
	);
	strictEqual(
		mcpTestHeadline("echo", info, 0, { network: false }),
		"echo: protocol 2025-06-18, server echo 1.0.0, 0 tools, network=false",
	);
});
