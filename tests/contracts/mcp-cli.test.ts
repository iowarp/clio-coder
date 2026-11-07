import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { mcpCommandOutput } from "../../src/cli/mcp.js";
import {
	MCP_PROJECT_CONFIG_RELATIVE_PATH,
	MCP_TRUST_FILENAME,
	MCP_USER_CONFIG_FILENAME,
} from "../../src/domains/gateway/mcp/index.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;

it("lists, trusts, detects stale declarations, untrusts and returns error exits", () => {
	const scratch = makeScratchHome("clio-mcp-cli-");
	const project = join(scratch.dir, "project");
	const config = join(scratch.dir, "config");
	const projectConfig = join(project, MCP_PROJECT_CONFIG_RELATIVE_PATH);
	mkdirSync(dirname(projectConfig), { recursive: true });
	mkdirSync(config, { recursive: true });
	const declaration = "version: 1\nservers:\n  - id: files\n    command: node\n    args: [server.mjs]\n";
	writeFileSync(projectConfig, declaration);
	writeFileSync(join(config, MCP_USER_CONFIG_FILENAME), "version: 1\nservers:\n  - id: personal\n    command: node\n");
	const run = (...args: string[]) => mcpCommandOutput(args, { cwd: project, configDir: config });
	const cli = (...args: string[]) =>
		spawnSync(process.execPath, [CLI, "mcp", ...args], {
			cwd: project,
			env: { ...process.env, ...scratch.env },
			encoding: "utf8",
		});
	try {
		let result = run("list");
		strictEqual(result.code, 0, result.text);
		match(result.text, /files scope=project command=\["node","server.mjs"\] cwd=.*trust=untrusted.*actionClass=unknown/);
		match(result.text, /personal scope=user.*trust=trusted/);
		result = run("trust", "files", "--action-class", "read");
		strictEqual(result.code, 0, result.text);
		const trusted = result.data;
		ok(
			trusted && typeof trusted === "object" && "ok" in trusted && "record" in trusted && "toolActionClasses" in trusted,
		);
		// The trust result names the declaration's per-tool classes (8858c4deb); this one declares none.
		deepStrictEqual(Object.keys(trusted).sort(), ["entry", "ok", "record", "toolActionClasses"]);
		deepStrictEqual(trusted.toolActionClasses, {});
		strictEqual(trusted.ok, true);
		const record = trusted.record;
		ok(record && typeof record === "object" && "actionClass" in record && "digest" in record);
		deepStrictEqual(Object.keys(record).sort(), ["actionClass", "digest", "id", "projectRoot", "trustedAt"]);
		strictEqual(record.actionClass, "read");
		ok(typeof record.digest === "string");
		match(record.digest, /^[a-f0-9]{64}$/);
		result = run("list");
		const listed = result.data;
		ok(listed && typeof listed === "object" && "servers" in listed && Array.isArray(listed.servers));
		deepStrictEqual(Object.keys(listed).sort(), ["diagnostics", "servers", "trustDiagnostics"]);
		const files: unknown = listed.servers.find((s: { id: string }) => s.id === "files");
		ok(files && typeof files === "object" && "trust" in files);
		const trust = files.trust;
		ok(trust && typeof trust === "object" && "status" in trust);
		strictEqual(trust.status, "trusted");
		const listedCli = cli("list", "--json");
		strictEqual(listedCli.status, 0, listedCli.stderr);
		deepStrictEqual(JSON.parse(listedCli.stdout), JSON.parse(JSON.stringify(listed)));
		const missingCli = cli("trust", "missing");
		strictEqual(missingCli.status, 1);
		strictEqual(missingCli.stderr.trim().split("\n").length, 1);
		const bogusCli = cli("bogus", "--json");
		strictEqual(bogusCli.status, 2);
		deepStrictEqual(JSON.parse(bogusCli.stdout), run("bogus").data);
		writeFileSync(projectConfig, declaration.replace("server.mjs", "changed.mjs"));
		match(run("list").text, /trust=stale.*changed/);
		result = run("untrust", "files");
		strictEqual(result.code, 0, result.text);
		match(result.text, /record removed/);
		match(run("list").text, /trust=untrusted/);
		result = run("untrust", "files");
		deepStrictEqual(result.data, { ok: true, removed: false });
		strictEqual(run("trust", "files").code, 0);
		result = run("untrust", "files");
		deepStrictEqual(result.data, { ok: true, removed: true });
		result = run("trust", "missing");
		strictEqual(result.code, 1);
		deepStrictEqual(result.data, { ok: false, message: "no declared MCP server with id 'missing'" });
		result = run("bogus");
		strictEqual(result.code, 2);
		ok(result.data && typeof result.data === "object" && "ok" in result.data);
		deepStrictEqual(Object.keys(result.data).sort(), ["message", "ok"]);
		strictEqual(result.data.ok, false);
		for (const args of [
			["trust", "missing"],
			["untrust", "missing"],
			["trust", "personal"],
			["untrust", "personal"],
			["trust", "files", "--action-class", "invalid"],
		]) {
			result = run(...args);
			ok(result.code !== 0);
			strictEqual(result.text.trim().split("\n").length, 1);
		}
		writeFileSync(join(config, MCP_TRUST_FILENAME), "{broken");
		for (const command of ["trust", "untrust"]) {
			result = run(command, "files");
			strictEqual(result.code, 1);
			match(result.text, /trust state is unusable/);
			strictEqual(result.text.trim().split("\n").length, 1);
		}
		result = run("list");
		strictEqual(result.code, 1);
		match(result.text, /invalid JSON/);
		writeFileSync(projectConfig, "version: 99\n");
		result = run("list");
		strictEqual(result.code, 1);
		ok(
			result.data &&
				typeof result.data === "object" &&
				"diagnostics" in result.data &&
				Array.isArray(result.data.diagnostics) &&
				result.data.diagnostics.length > 0,
		);
	} finally {
		scratch.cleanup();
	}
});

it("prints the hashed real path of a symlinked entry and marks one bound by path only", () => {
	const scratch = makeScratchHome("clio-mcp-cli-entry-");
	const project = join(scratch.dir, "project");
	const config = join(scratch.dir, "config");
	const projectConfig = join(project, MCP_PROJECT_CONFIG_RELATIVE_PATH);
	mkdirSync(dirname(projectConfig), { recursive: true });
	mkdirSync(join(project, "lib"));
	mkdirSync(config);
	const outside = join(scratch.dir, "outside.mjs");
	writeFileSync(outside, "console.log('outside');\n");
	writeFileSync(join(project, "lib", "real.mjs"), "console.log('real');\n");
	symlinkSync(join(project, "lib", "real.mjs"), join(project, "server.mjs"));
	symlinkSync(outside, join(project, "out.mjs"));
	writeFileSync(
		projectConfig,
		"version: 1\nservers:\n  - id: files\n    command: node\n    args: [server.mjs, out.mjs]\n",
	);
	try {
		const label = `entry=server.mjs -> lib/real.mjs, out.mjs -> ${outside} (path only)`;
		const trusted = mcpCommandOutput(["trust", "files"], { cwd: project, configDir: config });
		strictEqual(trusted.code, 0, trusted.text);
		ok(trusted.text.includes(label), trusted.text);
		const listed = mcpCommandOutput(["list"], { cwd: project, configDir: config });
		ok(listed.text.includes(label), listed.text);
	} finally {
		scratch.cleanup();
	}
});

it("rejects excessive ULP contracts and explains skipped numeric authoring proposals", async () => {
	const { parseValidationContractText } = await import("../../src/domains/safety/validation-contract.js");
	const { MAX_ULP_TOLERANCE } = await import("../../src/tools/verify/numeric.js");
	const { discoverVerifierAuthoring } = await import("../../src/tools/verify/authoring.js");
	const contract = (tolerance: unknown) =>
		JSON.stringify({ version: 1, artifacts: [{ path: "result.json", numerical_tolerances: tolerance }] });
	strictEqual(parseValidationContractText(contract({ ulp: MAX_ULP_TOLERANCE }), "validation.yaml").ok, true);
	const invalid = parseValidationContractText(contract({ ulp: MAX_ULP_TOLERANCE + 1 }), "validation.yaml");
	strictEqual(invalid.ok, false);
	if (!invalid.ok) ok(invalid.reason.includes(`no greater than ${MAX_ULP_TOLERANCE}`));
	const scratch = makeScratchHome("clio-authoring-tolerance-");
	try {
		writeFileSync(join(scratch.dir, "validation.yaml"), contract({}));
		const discovery = discoverVerifierAuthoring(scratch.dir);
		ok(discovery.ok);
		deepStrictEqual(discovery.numericProposals, []);
		ok(
			discovery.diagnostics.some(
				(line) => line.includes('artifact "result.json" numeric proposal skipped:') && line.includes("tolerance"),
			),
		);
	} finally {
		scratch.cleanup();
	}
});

// #382, ported from ikourkouta-svg's fix/verifiers-validate-discovery (5c9778b7).
function verifierCatalog(id: string): string {
	return [
		"version: 2",
		"checks:",
		`  - id: ${id}`,
		"    description: Scratch check.",
		'    command: ["node", "--version"]',
		'    cwd: "."',
		"    timeoutMs: 60000",
		'    tags: ["scratch"]',
		"",
	].join("\n");
}

function validateProject(files: Record<string, string>) {
	const scratch = makeScratchHome("clio-verifiers-validate-");
	const project = join(scratch.dir, "project");
	mkdirSync(project, { recursive: true });
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(dirname(join(project, relative)), { recursive: true });
		writeFileSync(join(project, relative), text);
	}
	try {
		return spawnSync(process.execPath, [CLI, "verifiers", "validate"], {
			cwd: project,
			env: { ...process.env, ...scratch.env },
			encoding: "utf8",
		});
	} finally {
		scratch.cleanup();
	}
}

it("fails verifiers validate when a catalog id collides with a package script and blocks discovery", () => {
	const scripts = JSON.stringify({ name: "scratch", scripts: { typecheck: "tsc --noEmit" } });
	const blocked = validateProject({
		"package.json": scripts,
		".clio-coder/verifiers.yaml": verifierCatalog("typecheck"),
	});
	strictEqual(blocked.status, 1, `validate accepted a catalog that blocks discovery:\n${blocked.stdout}`);
	match(blocked.stderr, /check discovery is blocked: duplicate declared check id 'typecheck'/);
	match(blocked.stderr, /package\.json \([^)]*package\.json\) and project-catalog \([^)]*verifiers\.yaml\)/);
	strictEqual(blocked.stdout, "");

	const clean = validateProject({
		"package.json": scripts,
		".clio-coder/verifiers.yaml": verifierCatalog("gate-typecheck"),
	});
	strictEqual(clean.status, 0, clean.stderr);
	match(clean.stdout, /accepted \.clio-coder\/verifiers\.yaml \(1 check\)/);

	const missing = validateProject({ "package.json": scripts });
	strictEqual(missing.status, 0, missing.stderr);
	match(missing.stdout, /No \.clio-coder\/verifiers\.yaml exists/);

	const malformed = validateProject({ ".clio-coder/verifiers.yaml": "version: 2\nchecks: not-a-list\n" });
	strictEqual(malformed.status, 1);
	match(malformed.stderr, /production catalog parser rejected/);
});

it("refreshes trusted MCP catalogs and lists annotation-derived tool classes", () => {
	const scratch = makeScratchHome("clio-mcp-cli-refresh-");
	try {
		const project = join(scratch.dir, "project");
		mkdirSync(join(project, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		const marker = join(scratch.dir, "untrusted-launched");
		writeFileSync(
			join(scratch.dir, "config", "mcp.yaml"),
			`version: 1\nservers:\n  - id: fake\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(resolve("tests/fixtures/mcp-fake-server.mjs"))}]\n    toolActionClasses: {echo: read}\n`,
		);
		writeFileSync(
			join(project, ".clio-coder", "mcp.yaml"),
			`version: 1\nservers:\n  - id: untrusted\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`)}]\n`,
		);
		const run = (args: string[]) =>
			spawnSync(process.execPath, [CLI, "mcp", ...args], {
				cwd: project,
				env: { ...process.env, ...scratch.env },
				encoding: "utf8",
				timeout: 10000,
			});
		const refreshed = run(["list", "--refresh", "--json"]);
		strictEqual(refreshed.status, 0, refreshed.stderr);
		const data = JSON.parse(refreshed.stdout);
		const fake = data.servers.find((server: { id: string }) => server.id === "fake");
		strictEqual(fake.tools.find((tool: { name: string }) => tool.name === "sleep").actionClass, "read");
		strictEqual(fake.tools.find((tool: { name: string }) => tool.name === "fail").actionClass, "destructive");
		strictEqual(existsSync(marker), false);
		const cached = run(["list"]);
		strictEqual(cached.status, 0);
		match(cached.stdout, /mcp_fake__sleep actionClass=read/u);
		match(cached.stdout, /mcp_fake__fail actionClass=destructive/u);
	} finally {
		scratch.cleanup();
	}
});

it("tests one trusted server through the gateway's client and never launches an untrusted one", () => {
	const scratch = makeScratchHome("clio-mcp-cli-test-");
	try {
		const project = join(scratch.dir, "project");
		mkdirSync(join(project, ".clio-coder"), { recursive: true });
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		const marker = join(scratch.dir, "untrusted-launched");
		writeFileSync(
			join(scratch.dir, "config", "mcp.yaml"),
			`version: 1\nservers:\n  - id: fake\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(resolve("tests/fixtures/mcp-fake-server.mjs"))}]\n    toolActionClasses: {echo: read}\n`,
		);
		writeFileSync(
			join(project, ".clio-coder", "mcp.yaml"),
			`version: 1\nservers:\n  - id: untrusted\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`)}]\n`,
		);
		const run = (args: string[]) =>
			spawnSync(process.execPath, [CLI, "mcp", ...args], {
				cwd: project,
				env: { ...process.env, ...scratch.env },
				encoding: "utf8",
				timeout: 10000,
			});
		const refused = run(["test", "untrusted", "--json"]);
		strictEqual(refused.status, 1);
		match(JSON.parse(refused.stdout).message, /never launched until trusted: clio-coder mcp trust untrusted/u);
		strictEqual(existsSync(marker), false);
		const tested = run(["test", "fake", "--call", "echo", "--args", '{"text":"hi"}', "--json"]);
		strictEqual(tested.status, 0, tested.stderr);
		const data = JSON.parse(tested.stdout);
		strictEqual(data.ok, true);
		strictEqual(data.protocolVersion, "2025-06-18");
		deepStrictEqual(data.serverInfo, { name: "fake", version: "1.0" });
		deepStrictEqual(
			data.tools.find((tool: { name: string }) => tool.name === "sleep"),
			{ name: "sleep", capability: "mcp_fake__sleep", actionClass: "read", serverHint: "read-only" },
		);
		deepStrictEqual(
			data.calls.map(({ tool, isError, text }: { tool: string; isError: boolean; text: string }) => ({
				tool,
				isError,
				text,
			})),
			[{ tool: "echo", isError: false, text: '{"text":"hi"}' }],
		);
	} finally {
		scratch.cleanup();
	}
});

it("admits each mcp test call as a session does and never sends a confirm-gated one", () => {
	const scratch = makeScratchHome("clio-mcp-cli-test-admission-");
	try {
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		const marker = join(scratch.dir, "tools-call-received");
		// A minimal Slurm server that records any tools/call it receives.
		const server = [
			"const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
			"require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
			"  const m = JSON.parse(line);",
			"  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'slurm', version: '1' } } });",
			"  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'slurm_submit', inputSchema: { type: 'object' } }] } });",
			`  else if (m.method === 'tools/call') { require('fs').writeFileSync(${JSON.stringify(marker)}, 'called'); send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'submitted' }] } }); }`,
			"});",
		].join("\n");
		// Classed read, slurm_submit runs on no class rule; only the Slurm
		// confirmation rule, which binds on every surface, can refuse it.
		writeFileSync(
			join(scratch.dir, "config", "mcp.yaml"),
			`version: 1\nservers:\n  - id: slurm\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", ${JSON.stringify(server)}]\n    toolActionClasses: {slurm_submit: read}\n`,
		);
		const result = spawnSync(
			process.execPath,
			[CLI, "mcp", "test", "slurm", "--call", "slurm_submit", "--call", "unlisted", "--json"],
			{ cwd: project, env: { ...process.env, ...scratch.env }, encoding: "utf8", timeout: 10000 },
		);
		strictEqual(result.status, 1, result.stderr);
		const data = JSON.parse(result.stdout);
		strictEqual(data.protocolVersion, "2025-06-18");
		deepStrictEqual(
			data.calls.map(({ tool, isError, refused }: { tool: string; isError: boolean; refused?: boolean }) => ({
				tool,
				isError,
				refused,
			})),
			[
				{ tool: "slurm_submit", isError: true, refused: true },
				{ tool: "unlisted", isError: true, refused: true },
			],
		);
		deepStrictEqual(
			{ layer: data.calls[0].denial.layer, actionClass: data.calls[0].denial.actionClass },
			{ layer: "operator_approval", actionClass: "read" },
		);
		strictEqual(existsSync(marker), false, "the server never received a tools/call");
	} finally {
		scratch.cleanup();
	}
});

it("records a JSON-RPC error answer as that call's error and runs the later calls", () => {
	const scratch = makeScratchHome("clio-mcp-cli-test-rpc-error-");
	try {
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		mkdirSync(join(scratch.dir, "config"), { recursive: true });
		const server = [
			"const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
			"require('readline').createInterface({ input: process.stdin }).on('line', (line) => {",
			"  const m = JSON.parse(line);",
			"  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rpc', version: '1' } } });",
			"  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'strict', inputSchema: { type: 'object' } }, { name: 'echo', inputSchema: { type: 'object' } }] } });",
			"  else if (m.method === 'tools/call' && m.params.name === 'strict') send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'invalid params' } });",
			"  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echoed' }] } });",
			"});",
		].join("\n");
		writeFileSync(
			join(scratch.dir, "config", "mcp.yaml"),
			`version: 1\nservers:\n  - id: rpc\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", ${JSON.stringify(server)}]\n    toolActionClasses: {strict: read, echo: read}\n`,
		);
		const result = spawnSync(
			process.execPath,
			[CLI, "mcp", "test", "rpc", "--call", "strict", "--call", "echo", "--json"],
			{ cwd: project, env: { ...process.env, ...scratch.env }, encoding: "utf8", timeout: 10000 },
		);
		strictEqual(result.status, 1, result.stderr);
		const calls = JSON.parse(result.stdout).calls;
		deepStrictEqual(
			calls.map(({ tool, isError, error }: { tool: string; isError?: boolean; error?: string }) => ({
				tool,
				isError,
				error,
			})),
			[
				{ tool: "strict", isError: true, error: undefined },
				{ tool: "echo", isError: false, error: undefined },
			],
		);
		match(calls[0].text, /invalid params/u);
	} finally {
		scratch.cleanup();
	}
});
