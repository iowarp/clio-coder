import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	loadMcpServerConfig,
	MCP_CONFIG_CAPS,
	MCP_TRUST_CAPS,
	mcpConfigPaths,
	mcpServerDigest,
	mcpTrustPath,
	parseMcpConfigText,
	readMcpTrustState,
	resolveMcpServers,
	trustMcpServer,
	untrustMcpServer,
} from "../../src/domains/gateway/mcp/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const roots: string[] = [];

function scratch(): { project: string; configDir: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-mcp-config-")));
	roots.push(root);
	const project = join(root, "project");
	const configDir = join(root, "config");
	mkdirSync(join(project, ".clio-coder"), { recursive: true });
	mkdirSync(join(project, "tools"), { recursive: true });
	mkdirSync(configDir, { recursive: true });
	return { project, configDir };
}

function writeProjectConfig(project: string, text: string): void {
	writeFileSync(join(project, ".clio-coder", "mcp.yaml"), text);
}

function writeUserConfig(configDir: string, text: string): void {
	writeFileSync(join(configDir, "mcp.yaml"), text);
}

const PROJECT_CONFIG = [
	"version: 1",
	"servers:",
	"  - id: files",
	"    command: node",
	"    args: [server.mjs, --stdio]",
	"    cwd: tools",
	"    env:",
	"      LOG_LEVEL: info",
	"    timeoutMs: 5000",
	"",
].join("\n");

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mcp server configuration", () => {
	it("parses a strict project declaration and derives a stable digest", () => {
		const { project } = scratch();
		const result = parseMcpConfigText(PROJECT_CONFIG, { scope: "project", path: "p.yaml", root: project });
		deepStrictEqual(result.diagnostics, []);
		strictEqual(result.servers.length, 1);
		const server = result.servers[0];
		ok(server);
		strictEqual(server.id, "files");
		strictEqual(server.scope, "project");
		strictEqual(server.command, "node");
		deepStrictEqual(server.args, ["server.mjs", "--stdio"]);
		strictEqual(server.cwd, join(project, "tools"));
		strictEqual(server.cwdRoot, project);
		deepStrictEqual(server.env, { LOG_LEVEL: "info" });
		strictEqual(server.timeoutMs, 5000);
		strictEqual(
			server.digest,
			mcpServerDigest({
				id: "files",
				command: "node",
				args: ["server.mjs", "--stdio"],
				cwd: "tools",
				env: { LOG_LEVEL: "info" },
				timeoutMs: 5000,
			}),
		);
		const reordered = mcpServerDigest({
			id: "files",
			command: "node",
			args: ["server.mjs", "--stdio"],
			cwd: "tools",
			env: { LOG_LEVEL: "info" },
			timeoutMs: 5000,
		});
		strictEqual(reordered, server.digest);
		ok(
			server.digest !==
				mcpServerDigest({ id: "files", command: "node", args: ["server.mjs"], cwd: "tools", env: {}, timeoutMs: 5000 }),
		);
	});

	it("defaults omitted fields and roots a project server without cwd at the repository", () => {
		const { project } = scratch();
		const result = parseMcpConfigText("version: 1\nservers:\n  - id: a\n    command: srv\n", {
			scope: "project",
			path: "p.yaml",
			root: project,
		});
		deepStrictEqual(result.diagnostics, []);
		const server = result.servers[0];
		ok(server);
		deepStrictEqual(server.args, []);
		deepStrictEqual(server.env, {});
		strictEqual(server.timeoutMs, null);
		strictEqual(server.cwd, project);
		strictEqual(server.cwdRoot, project);
	});

	it("names every schema violation and contributes no server for it", () => {
		const { project } = scratch();
		const cases: Array<[string, RegExp]> = [
			["version: 1\nservers: []\nextra: 1\n", /root has unknown field\(s\): extra/],
			["servers: []\n", /root\.version is required/],
			["version: 2\nservers: []\n", /unsupported version 2/],
			["version: 1\n", /root\.servers is required/],
			["version: 1\nservers: {}\n", /root\.servers must be an array/],
			[
				`version: 1\nservers:\n${Array.from({ length: MCP_CONFIG_CAPS.servers + 1 }, (_, i) => `  - id: s${i}\n    command: x\n`).join("")}`,
				/exceeds the 32-server cap/,
			],
			["version: 1\nservers:\n  - id: Bad\n    command: x\n", /servers\[0\]\.id must match/],
			[`version: 1\nservers:\n  - id: ${"a".repeat(33)}\n    command: x\n`, /exceeds the 32-character cap/],
			["version: 1\nservers:\n  - command: x\n", /servers\[0\]\.id is required/],
			["version: 1\nservers:\n  - id: a\n", /servers\[0\]\.command is required/],
			["version: 1\nservers:\n  - id: a\n    command: node server.mjs\n", /one executable token/],
			["version: 1\nservers:\n  - id: a\n    command: bash\n", /may not invoke shell executable 'bash'/],
			["version: 1\nservers:\n  - id: a\n    command: /bin/bash\n", /may not invoke shell executable '\/bin\/bash'/],
			[
				"version: 1\nservers:\n  - id: a\n    command: ./server\n",
				/must be an executable name resolved on PATH or an absolute path; relative path '\.\/server' is not allowed/,
			],
			[
				"version: 1\nservers:\n  - id: a\n    command: ../outside/server\n",
				/relative path '\.\.\/outside\/server' is not allowed/,
			],
			["version: 1\nservers:\n  - id: a\n    command: bin/server\n", /relative path 'bin\/server' is not allowed/],
			["version: 1\nservers:\n  - id: a\n    command: ~/bin/server\n", /relative path '~\/bin\/server' is not allowed/],
			["version: 1\nservers:\n  - id: a\n    command: x\n    args: [1]\n", /servers\[0\]\.args\[0\] must be a string/],
			["version: 1\nservers:\n  - id: a\n    command: x\n    args: x\n", /servers\[0\]\.args must be an array/],
			[
				"version: 1\nservers:\n  - id: a\n    command: x\n    env:\n      lower: v\n",
				/servers\[0\]\.env\.lower is not a valid environment variable name/,
			],
			[
				"version: 1\nservers:\n  - id: a\n    command: x\n    env:\n      KEY: 1\n",
				/servers\[0\]\.env\.KEY must be a string/,
			],
			["version: 1\nservers:\n  - id: a\n    command: x\n    timeoutMs: 0\n", /timeoutMs must be a positive integer/],
			["version: 1\nservers:\n  - id: a\n    command: x\n    timeoutMs: 1000000\n", /timeoutMs exceeds the 900000ms cap/],
			[
				"version: 1\nservers:\n  - id: a\n    command: x\n  - id: a\n    command: y\n",
				/servers\[1\]\.id duplicates 'a' from servers\[0\]\.id/,
			],
			["version: 1\nservers:\n  - id: a\n    command: x\n    cwd: /tmp\n", /must be repository-relative; absolute cwd/],
			["version: 1\nservers:\n  - id: a\n    command: x\n    cwd: ../outside\n", /escapes its root/],
			["version: 1\nservers:\n  - id: a\n    command: x\n    cwd: missing\n", /cannot be resolved as a directory/],
			["version: 1\nservers:\n  - id: a\n    command: x\n    nope: 1\n", /servers\[0\] has unknown field\(s\): nope/],
			["version: 1\nservers:\n  - id: a\n    command: x\n  - id: a\n    command: x\n    cwd: [\n", /invalid YAML/],
			[`version: 1\nservers: []\n# ${"x".repeat(MCP_CONFIG_CAPS.fileBytes)}\n`, /exceeds the 262144-byte cap/],
		];
		for (const [text, expected] of cases) {
			const result = parseMcpConfigText(text, { scope: "project", path: "p.yaml", root: project });
			deepStrictEqual(result.servers, [], text.slice(0, 80));
			strictEqual(result.diagnostics.length, 1, text.slice(0, 80));
			match(result.diagnostics[0]?.message ?? "", expected, text.slice(0, 80));
			strictEqual(result.diagnostics[0]?.path, "p.yaml");
		}
	});

	it("accepts an executable as a PATH basename or an absolute path only", () => {
		const { project } = scratch();
		const absolute = process.execPath;
		const result = parseMcpConfigText(
			`version: 1\nservers:\n  - id: a\n    command: node\n  - id: b\n    command: ${absolute}\n`,
			{ scope: "project", path: "p.yaml", root: project },
		);
		deepStrictEqual(result.diagnostics, []);
		deepStrictEqual(
			result.servers.map((server) => server.command),
			["node", absolute],
		);
	});

	it("reads config files through a bounded read and refuses one over the cap on disk", () => {
		const { project, configDir } = scratch();
		writeUserConfig(configDir, `version: 1\nservers: []\n# ${"x".repeat(MCP_CONFIG_CAPS.fileBytes)}\n`);
		writeProjectConfig(project, PROJECT_CONFIG);
		const loaded = loadMcpServerConfig({ cwd: project, configDir });
		deepStrictEqual(
			loaded.servers.map((server) => server.id),
			["files"],
		);
		strictEqual(loaded.diagnostics.length, 1);
		strictEqual(loaded.diagnostics[0]?.scope, "user");
		match(loaded.diagnostics[0]?.message ?? "", /file exceeds the 262144-byte cap/);
		rmSync(join(configDir, "mcp.yaml"));
		mkdirSync(join(configDir, "mcp.yaml"));
		match(loadMcpServerConfig({ cwd: project, configDir }).diagnostics[0]?.message ?? "", /must be a regular file/);
	});

	it("resolves user-scope cwd values as absolute or config-relative directories", () => {
		const { project, configDir } = scratch();
		mkdirSync(join(configDir, "servers"));
		const absolute = parseMcpConfigText(`version: 1\nservers:\n  - id: a\n    command: x\n    cwd: ${project}\n`, {
			scope: "user",
			path: "u.yaml",
			root: configDir,
		});
		deepStrictEqual(absolute.diagnostics, []);
		strictEqual(absolute.servers[0]?.cwd, project);
		strictEqual(absolute.servers[0]?.cwdRoot, project);
		const relative = parseMcpConfigText("version: 1\nservers:\n  - id: a\n    command: x\n    cwd: servers\n", {
			scope: "user",
			path: "u.yaml",
			root: configDir,
		});
		deepStrictEqual(relative.diagnostics, []);
		strictEqual(relative.servers[0]?.cwd, join(configDir, "servers"));
		strictEqual(relative.servers[0]?.cwdRoot, configDir);
		const escaping = parseMcpConfigText("version: 1\nservers:\n  - id: a\n    command: x\n    cwd: ../project\n", {
			scope: "user",
			path: "u.yaml",
			root: configDir,
		});
		match(escaping.diagnostics[0]?.message ?? "", /escapes its root/);
		const omitted = parseMcpConfigText("version: 1\nservers:\n  - id: a\n    command: x\n", {
			scope: "user",
			path: "u.yaml",
			root: configDir,
		});
		strictEqual(omitted.servers[0]?.cwd, configDir);
	});

	it("loads both scopes, lets the user declaration shadow a project id, and fails a malformed file closed", () => {
		const { project, configDir } = scratch();
		writeUserConfig(
			configDir,
			"version: 1\nservers:\n  - id: files\n    command: user-files\n  - id: docs\n    command: docs\n",
		);
		writeProjectConfig(project, PROJECT_CONFIG);
		const loaded = loadMcpServerConfig({ cwd: project, configDir });
		deepStrictEqual(
			loaded.servers.map((server) => [server.id, server.scope, server.command]),
			[
				["files", "user", "user-files"],
				["docs", "user", "docs"],
			],
		);
		strictEqual(loaded.diagnostics.length, 1);
		match(loaded.diagnostics[0]?.message ?? "", /server 'files' is shadowed by the user declaration/);
		strictEqual(loaded.diagnostics[0]?.scope, "project");
		deepStrictEqual(mcpConfigPaths({ cwd: project, configDir }), {
			user: join(configDir, "mcp.yaml"),
			project: join(project, ".clio-coder", "mcp.yaml"),
		});
		writeProjectConfig(project, "version: 1\nservers:\n  - id: broken\n    command: a b\n");
		const partial = loadMcpServerConfig({ cwd: project, configDir });
		deepStrictEqual(
			partial.servers.map((server) => server.id),
			["files", "docs"],
		);
		match(partial.diagnostics[0]?.message ?? "", /one executable token/);
		rmSync(join(configDir, "mcp.yaml"));
		deepStrictEqual(loadMcpServerConfig({ cwd: project, configDir }).servers, []);
	});
});

describe("mcp server trust", () => {
	it("requires an explicit record for a project server and binds it to the declaration digest", () => {
		const { project, configDir } = scratch();
		writeProjectConfig(project, PROJECT_CONFIG);
		writeUserConfig(configDir, "version: 1\nservers:\n  - id: mine\n    command: mine\n");
		const before = resolveMcpServers({ cwd: project, configDir });
		deepStrictEqual(before.trustDiagnostics, []);
		const user = before.servers.find((server) => server.id === "mine");
		deepStrictEqual(user?.trust, { status: "trusted", actionClass: "unknown" });
		const files = before.servers.find((server) => server.id === "files");
		strictEqual(files?.trust.status, "untrusted");
		match(files?.trust.status === "untrusted" ? files.trust.reason : "", /clio-coder mcp trust files/);

		const trusted = trustMcpServer({ cwd: project, configDir, id: "files", actionClass: "read", now: () => new Date(0) });
		ok(trusted.ok, trusted.ok ? "" : trusted.message);
		deepStrictEqual(trusted.record, {
			projectRoot: project,
			id: "files",
			digest: files?.digest,
			actionClass: "read",
			trustedAt: "1970-01-01T00:00:00.000Z",
		});
		const trustFile = mcpTrustPath(configDir);
		strictEqual(statSync(trustFile).mode & 0o777, 0o600);
		deepStrictEqual(
			readdirSync(configDir).filter((entry) => entry.includes(".tmp-")),
			[],
			"safeResourceWrite leaves no temp file behind",
		);
		const written = JSON.parse(readFileSync(trustFile, "utf8")) as { version: number; records: unknown[] };
		strictEqual(written.version, 1);
		strictEqual(written.records.length, 1);
		const after = resolveMcpServers({ cwd: project, configDir }).servers.find((server) => server.id === "files");
		deepStrictEqual(after?.trust, { status: "trusted", actionClass: "read" });

		writeProjectConfig(project, PROJECT_CONFIG.replace("--stdio", "--stdio-v2"));
		const stale = resolveMcpServers({ cwd: project, configDir }).servers.find((server) => server.id === "files");
		strictEqual(stale?.trust.status, "stale");
		match(
			stale?.trust.status === "stale" ? stale.trust.reason : "",
			/changed \(command, args, env, cwd, or timeout\) since it was trusted/,
		);

		const retrusted = trustMcpServer({ cwd: project, configDir, id: "files" });
		ok(retrusted.ok);
		strictEqual(retrusted.record.actionClass, "unknown");
		const again = resolveMcpServers({ cwd: project, configDir }).servers.find((server) => server.id === "files");
		deepStrictEqual(again?.trust, { status: "trusted", actionClass: "unknown" });
		strictEqual(readMcpTrustState(configDir).state.records.length, 1, "re-trusting replaces the record");

		const removed = untrustMcpServer({ cwd: project, configDir, id: "files" });
		deepStrictEqual(removed, { ok: true, removed: true });
		deepStrictEqual(untrustMcpServer({ cwd: project, configDir, id: "files" }), { ok: true, removed: false });
		strictEqual(
			resolveMcpServers({ cwd: project, configDir }).servers.find((server) => server.id === "files")?.trust.status,
			"untrusted",
		);
	});

	it("refuses trust for unknown ids, user-scope ids, invalid classes, and a corrupt trust file", () => {
		const { project, configDir } = scratch();
		writeProjectConfig(project, PROJECT_CONFIG);
		writeUserConfig(configDir, "version: 1\nservers:\n  - id: mine\n    command: mine\n");
		const unknown = trustMcpServer({ cwd: project, configDir, id: "nope" });
		ok(!unknown.ok);
		match(unknown.ok ? "" : unknown.message, /no declared MCP server with id 'nope'/);
		const user = trustMcpServer({ cwd: project, configDir, id: "mine" });
		ok(!user.ok);
		match(user.ok ? "" : user.message, /user-scope declaration; it is trusted by authorship/);
		const badClass = trustMcpServer({ cwd: project, configDir, id: "files", actionClass: "root" as never });
		ok(!badClass.ok);
		match(badClass.ok ? "" : badClass.message, /actionClass must be one of read, execute, unknown/);
		writeProjectConfig(project, "version: 1\nservers:\n  - id: files\n    command: a b\n");
		const broken = trustMcpServer({ cwd: project, configDir, id: "files" });
		ok(!broken.ok);
		match(broken.ok ? "" : broken.message, /config diagnostics: .*one executable token/);
		writeProjectConfig(project, PROJECT_CONFIG);
		writeFileSync(mcpTrustPath(configDir), "{not json");
		const read = readMcpTrustState(configDir);
		deepStrictEqual(read.state.records, []);
		match(read.diagnostics[0] ?? "", /invalid JSON/);
		const refused = trustMcpServer({ cwd: project, configDir, id: "files" });
		ok(!refused.ok);
		match(refused.ok ? "" : refused.message, /trust state is unusable/);
		strictEqual(readFileSync(mcpTrustPath(configDir), "utf8"), "{not json", "a corrupt file is never overwritten");
		const untrust = untrustMcpServer({ cwd: project, configDir, id: "files" });
		ok(!untrust.ok);
		writeFileSync(
			mcpTrustPath(configDir),
			JSON.stringify({
				version: 1,
				records: [{ projectRoot: project, id: "files", digest: "x", actionClass: "sudo", trustedAt: "now" }],
			}),
		);
		match(readMcpTrustState(configDir).diagnostics[0] ?? "", /actionClass must be one of/);
		const resolved = resolveMcpServers({ cwd: project, configDir });
		strictEqual(resolved.trustDiagnostics.length, 1);
		strictEqual(resolved.servers.find((server) => server.id === "files")?.trust.status, "untrusted");
	});

	it("refuses an oversized or over-populated trust file without rewriting it", () => {
		const { project, configDir } = scratch();
		writeProjectConfig(project, PROJECT_CONFIG);
		const trustFile = mcpTrustPath(configDir);
		// Valid JSON padded past the byte cap: only a bounded read refuses it, a parse would accept it.
		const padded = `${JSON.stringify({ version: 1, records: [] })}${" ".repeat(MCP_TRUST_CAPS.fileBytes)}\n`;
		writeFileSync(trustFile, padded);
		const oversized = readMcpTrustState(configDir);
		deepStrictEqual(oversized.state.records, []);
		match(oversized.diagnostics[0] ?? "", /file exceeds the 1048576-byte cap/);
		const refused = trustMcpServer({ cwd: project, configDir, id: "files" });
		ok(!refused.ok);
		match(refused.ok ? "" : refused.message, /trust state is unusable/);
		ok(!untrustMcpServer({ cwd: project, configDir, id: "files" }).ok);
		strictEqual(readFileSync(trustFile, "utf8"), padded, "an oversized file is never rewritten");
		const resolved = resolveMcpServers({ cwd: project, configDir });
		strictEqual(resolved.trustDiagnostics.length, 1);
		match(resolved.trustDiagnostics[0] ?? "", /exceeds the 1048576-byte cap/);
		strictEqual(resolved.servers.find((server) => server.id === "files")?.trust.status, "untrusted");

		const record = (id: string) => ({ projectRoot: project, id, digest: "d", actionClass: "read", trustedAt: "t" });
		const tooMany = JSON.stringify({
			version: 1,
			records: Array.from({ length: MCP_TRUST_CAPS.records + 1 }, (_, index) => record(`s${index}`)),
		});
		writeFileSync(trustFile, tooMany);
		match(readMcpTrustState(configDir).diagnostics[0] ?? "", /exceeds the 256-record cap/);
		ok(!trustMcpServer({ cwd: project, configDir, id: "files" }).ok);
		strictEqual(readFileSync(trustFile, "utf8"), tooMany, "an over-populated file is never rewritten");

		// A file exactly at the record cap reads fine, and trusting one more server is refused before the write.
		const full = JSON.stringify({
			version: 1,
			records: Array.from({ length: MCP_TRUST_CAPS.records }, (_, index) => record(`s${index}`)),
		});
		writeFileSync(trustFile, full);
		strictEqual(readMcpTrustState(configDir).state.records.length, MCP_TRUST_CAPS.records);
		const overflow = trustMcpServer({ cwd: project, configDir, id: "files" });
		ok(!overflow.ok);
		match(overflow.ok ? "" : overflow.message, /would exceed the 256-record cap/);
		strictEqual(readFileSync(trustFile, "utf8"), full);
		deepStrictEqual(untrustMcpServer({ cwd: project, configDir, id: "s0" }), { ok: true, removed: true });
		strictEqual(readMcpTrustState(configDir).state.records.length, MCP_TRUST_CAPS.records - 1);
		ok(trustMcpServer({ cwd: project, configDir, id: "files" }).ok);
	});

	it("keeps trust records per project root", () => {
		const { project, configDir } = scratch();
		const other = join(project, "..", "other");
		mkdirSync(join(other, ".clio-coder"), { recursive: true });
		mkdirSync(join(other, "tools"));
		writeProjectConfig(project, PROJECT_CONFIG);
		writeProjectConfig(other, PROJECT_CONFIG);
		ok(trustMcpServer({ cwd: project, configDir, id: "files" }).ok);
		strictEqual(resolveMcpServers({ cwd: project, configDir }).servers[0]?.trust.status, "trusted");
		strictEqual(resolveMcpServers({ cwd: other, configDir }).servers[0]?.trust.status, "untrusted");
		ok(trustMcpServer({ cwd: other, configDir, id: "files" }).ok);
		strictEqual(readMcpTrustState(configDir).state.records.length, 2);
	});

	it("resolves the default trust and config paths under the Clio config directory", async () => {
		let env: IsolatedClioEnv | null = null;
		try {
			env = await isolateClioEnv("clio-coder-mcp-paths-");
			const configDir = process.env.CLIO_CODER_CONFIG_DIR ?? "";
			ok(configDir.length > 0);
			strictEqual(mcpTrustPath(), join(configDir, "mcp-trust.json"));
			const { project } = scratch();
			strictEqual(mcpConfigPaths({ cwd: project }).user, join(configDir, "mcp.yaml"));
			deepStrictEqual(resolveMcpServers({ cwd: project }).servers, []);
			ok(!existsSync(mcpTrustPath()));
		} finally {
			env?.restore();
		}
	});
});
