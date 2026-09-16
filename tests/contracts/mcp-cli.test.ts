import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import {
	MCP_PROJECT_CONFIG_RELATIVE_PATH,
	MCP_TRUST_FILENAME,
	MCP_USER_CONFIG_FILENAME,
} from "../../src/domains/gateway/mcp/index.js";
import { makeScratchHome } from "../harness/scratch-env.js";

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
	const module = resolve("src/cli/mcp.ts");
	const tsx = import.meta.resolve("tsx");
	const run = (...args: string[]) =>
		spawnSync(
			process.execPath,
			[
				"--import",
				tsx,
				"--input-type=module",
				"-e",
				`import { runMcpCommand } from ${JSON.stringify(module)}; process.exitCode = runMcpCommand(${JSON.stringify(args)});`,
			],
			{ cwd: project, env: { ...process.env, ...scratch.env }, encoding: "utf8" },
		);
	try {
		let result = run("list");
		strictEqual(result.status, 0, result.stderr);
		match(
			result.stdout,
			/files scope=project command=\["node","server.mjs"\] cwd=.*trust=untrusted.*actionClass=unknown/,
		);
		match(result.stdout, /personal scope=user.*trust=trusted/);
		result = run("trust", "files", "--action-class", "read", "--json");
		strictEqual(result.status, 0, result.stderr);
		const trusted = JSON.parse(result.stdout);
		deepStrictEqual(Object.keys(trusted).sort(), ["ok", "record"]);
		strictEqual(trusted.ok, true);
		const record = trusted.record;
		deepStrictEqual(Object.keys(record).sort(), ["actionClass", "digest", "id", "projectRoot", "trustedAt"]);
		strictEqual(record.actionClass, "read");
		match(record.digest, /^[a-f0-9]{64}$/);
		result = run("list", "--json");
		deepStrictEqual(Object.keys(JSON.parse(result.stdout)).sort(), ["diagnostics", "servers", "trustDiagnostics"]);
		strictEqual(JSON.parse(result.stdout).servers.find((s: { id: string }) => s.id === "files").trust.status, "trusted");
		writeFileSync(projectConfig, declaration.replace("server.mjs", "changed.mjs"));
		match(run("list").stdout, /trust=stale.*changed/);
		result = run("untrust", "files");
		strictEqual(result.status, 0, result.stderr);
		match(result.stdout, /record removed/);
		match(run("list").stdout, /trust=untrusted/);
		result = run("untrust", "files", "--json");
		deepStrictEqual(JSON.parse(result.stdout), { ok: true, removed: false });
		strictEqual(run("trust", "files").status, 0);
		result = run("untrust", "files", "--json");
		deepStrictEqual(JSON.parse(result.stdout), { ok: true, removed: true });
		result = run("trust", "missing", "--json");
		strictEqual(result.status, 1);
		deepStrictEqual(JSON.parse(result.stdout), { ok: false, message: "no declared MCP server with id 'missing'" });
		result = run("bogus", "--json");
		strictEqual(result.status, 2);
		deepStrictEqual(Object.keys(JSON.parse(result.stdout)).sort(), ["message", "ok"]);
		strictEqual(JSON.parse(result.stdout).ok, false);
		const help = run("--help").stdout;
		for (const shape of [
			"list: {servers: [...], diagnostics: [...], trustDiagnostics: [...]}",
			"trust: {ok: true, record: {projectRoot, id, digest, actionClass, trustedAt}}",
			"untrust: {ok: true, removed: boolean}",
			"errors: {ok: false, message: string}",
			"0 success; 1 operational failure; 2 invalid usage",
		])
			ok(help.includes(shape));
		for (const args of [
			["trust", "missing"],
			["untrust", "missing"],
			["trust", "personal"],
			["untrust", "personal"],
			["trust", "files", "--action-class", "invalid"],
		]) {
			result = run(...args);
			ok(result.status !== 0);
			strictEqual(result.stderr.trim().split("\n").length, 1);
		}
		writeFileSync(join(config, MCP_TRUST_FILENAME), "{broken");
		for (const command of ["trust", "untrust"]) {
			result = run(command, "files");
			strictEqual(result.status, 1);
			match(result.stderr, /trust state is unusable/);
			strictEqual(result.stderr.trim().split("\n").length, 1);
		}
		result = run("list");
		strictEqual(result.status, 1);
		match(result.stdout, /invalid JSON/);
		writeFileSync(projectConfig, "version: 99\n");
		result = run("list", "--json");
		strictEqual(result.status, 1);
		ok(JSON.parse(result.stdout).diagnostics.length > 0);
	} finally {
		scratch.cleanup();
	}
});

it("documents numeric combination and non-finite policies in verifier help", () => {
	const scratch = makeScratchHome("clio-verifier-help-");
	try {
		const module = resolve("src/cli/verifiers.ts");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				"--input-type=module",
				"-e",
				`import { runVerifiersCommand } from ${JSON.stringify(module)}; process.exitCode = await runVerifiersCommand(["--help"]);`,
			],
			{ cwd: scratch.dir, env: { ...process.env, ...scratch.env }, encoding: "utf8" },
		);
		strictEqual(result.status, 0, result.stderr);
		match(result.stdout, /--tolerance.*relative.*absolute.*ulp.*combine.*all\|any.*nonFinite.*fail\|match/);
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
