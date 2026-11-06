import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Read-only mode leaves Clio's cache as it found it (DOG-001, review-a3-4): first-use assets and their failure
// records, the shared semantic index, Copilot's disposable session records and MCP catalogs. Each case runs in
// a read-only scope against a home with no cache root and checks that the root is still absent; one control
// case then shows the same writers do persist outside the mode. Entering the mode for good is one-way, so the
// last case is the only one that does.
const home = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-read-only-writers-")));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
const cache = join(home, "cache");
const { resetXdgCache } = await import("../../src/core/xdg.js");
resetXdgCache();
const { enterReadOnlyMode, withReadOnlyMode } = await import("../../src/core/read-only-mode.js");
const { loadPinnedAsset } = await import("../../src/core/pinned-asset.js");
const { ensureScientificReader, ReaderUnavailableError, SCIENTIFIC_READERS } = await import(
	"../../src/tools/data/reader-assets.js"
);
const { buildCodewikiCandidate } = await import("../../src/domains/context/codewiki/coordinator.js");
const { SemanticIndex } = await import("../../src/domains/semantic/service.js");
const { sourceHash } = await import("../../src/domains/semantic/storage.js");
const { createSemanticBackgroundRefresh } = await import("../../src/domains/semantic-app/background.js");
const { DEFAULT_SETTINGS } = await import("../../src/core/defaults.js");
const { withStateFileLock } = await import("../../src/core/state-file-lock.js");
const { copilotSessionFsConfig, createCopilotSessionFs, removeCopilotSessionRecords, removeCopilotSessionRecordsSync } =
	await import("../../src/engine/copilot/session-fs.js");
const { readMcpServerCatalog, writeMcpServerCatalog } = await import("../../src/domains/gateway/mcp/metadata-cache.js");

const bytes = Buffer.from("pinned asset bytes\n");
let connects = 0;
const server = createServer((request, response) => {
	if (request.url === "/asset") response.end(bytes);
	else response.writeHead(404).end();
});
// As a proxy it refuses every tunnel: an offline host, answered in milliseconds.
server.on("connect", (_request, socket) => {
	connects += 1;
	socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
	server.close();
	rmSync(home, { recursive: true, force: true });
});

const pinned = (name: string, path: string) => ({
	label: name,
	url: `${origin}/${path}`,
	sha256: createHash("sha256").update(bytes).digest("hex"),
	path: join(cache, "assets", name),
});
const loadOptions = { timeoutMs: 5_000, retryAfterMs: 60_000 };
const profile = { id: "fixture", dimensions: 2, profileIdentity: sourceHash("fixture"), identity: { fixture: true } };
const semanticIndex = () =>
	new SemanticIndex({
		projectId: "project-a",
		profile,
		embed: async (inputs) => ({ profileKey: profile.profileIdentity, vectors: inputs.map(() => [1, 0]) }),
	});
function record(id: string) {
	return {
		id,
		sourceId: id,
		kind: "code" as const,
		projectId: "project-a",
		scope: "project" as const,
		visibility: "project" as const,
		path: `${id}.ts`,
		contentHash: sourceHash(id),
		extractionVersion: "v1",
		text: id,
		input: { kind: "text" as const, text: id },
		location: { line: 1 },
		mediaType: "text/plain",
	};
}
const expiredFailure = `${JSON.stringify({ failedAt: 0, reason: "offline" })}\n`;
const mcpIdentity = {
	projectRoot: home,
	scope: "project" as const,
	declarationPath: join(home, ".mcp.json"),
	serverId: "fixture",
	digest: "fixture-digest",
	cwd: home,
};
const mcpListing = {
	tools: [{ name: "echo", title: null, description: "Echo", inputSchema: { type: "object" }, annotations: null }],
	truncated: false,
};

describe("read-only cache writers", () => {
	it("a pinned asset download serves the caller, and neither it nor a failure record is cached", async () => {
		await withReadOnlyMode(async () => {
			deepEqual(await loadPinnedAsset(pinned("ok.bin", "asset"), loadOptions), bytes);
			await rejects(loadPinnedAsset(pinned("gone.bin", "missing"), loadOptions), /HTTP 404/);
		});
		ok(!existsSync(cache));
	});

	it("a scientific reader not yet unpacked is refused before any download or extraction", async () => {
		await withReadOnlyMode(async () => {
			await rejects(
				ensureScientificReader(SCIENTIFIC_READERS.parquet),
				(error: unknown) => error instanceof ReaderUnavailableError && /read-only mode/.test(error.message),
			);
		});
		ok(!existsSync(cache));
	});

	it("a codewiki build worker inherits the mode: a grammar it cannot fetch leaves no failure record", async () => {
		const project = join(home, "ruby-project");
		mkdirSync(project);
		writeFileSync(join(project, "a.rb"), "def one\n  1\nend\n");
		// A worker thread reads these when it starts, so its grammar fetch goes through the refusing proxy.
		const proxyEnv = ["NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const;
		const saved = proxyEnv.map((name) => [name, process.env[name]] as const);
		Object.assign(process.env, {
			NODE_USE_ENV_PROXY: "1",
			HTTPS_PROXY: origin,
			https_proxy: origin,
			NO_PROXY: "",
			no_proxy: "",
		});
		const before = connects;
		try {
			const built = await withReadOnlyMode(() => buildCodewikiCandidate(project, "unknown"));
			ok(built.codewiki.files.some((file) => file.path === "a.rb"));
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
		ok(connects > before, "the worker tried the grammar download");
		ok(!existsSync(cache));
	});

	it("opening a semantic index creates no cache root, and neither a refresh nor background refresh runs", async (t) => {
		const index = semanticIndex();
		await withReadOnlyMode(() => rejects(index.refresh([]), /read-only mode/));
		let consulted = 0;
		const background = createSemanticBackgroundRefresh(() => {
			consulted += 1;
			return DEFAULT_SETTINGS;
		});
		t.after(() => background.stop());
		withReadOnlyMode(() => background.schedule(home));
		equal(consulted, 0, "read-only mode schedules nothing");
		ok(!existsSync(cache));
	});

	it("Copilot session state lives in memory, workspace writes stay refused, and closing drops it", async () => {
		const workspaceFile = join(home, "copilot-wrote.txt");
		writeFileSync(join(home, "notes.txt"), "workspace\n");
		await withReadOnlyMode(async () => {
			const state = copilotSessionFsConfig().sessionStatePath;
			const fs = createCopilotSessionFs("read-only-session");
			equal(await fs.exists(state), false);
			await fs.mkdir(join(state, "logs"), true);
			await fs.appendFile(join(state, "events.jsonl"), "{}\n");
			await fs.appendFile(join(state, "events.jsonl"), "{}\n");
			equal(await fs.readFile(join(state, "events.jsonl")), "{}\n{}\n");
			await fs.rename(join(state, "events.jsonl"), join(state, "logs", "events.jsonl"));
			deepEqual(await fs.readdirWithTypes(state), [{ name: "logs", type: "directory" }]);
			equal((await fs.stat(join(state, "logs", "events.jsonl"))).size, 6);
			await rejects(fs.rm(join(state, "logs"), false, false), { code: "EISDIR" });
			await rejects(fs.readFile(join(state, "absent")), { code: "ENOENT" });
			await rejects(fs.writeFile(workspaceFile, "x"), /Clio does not let the Copilot runtime change/);
			equal(await fs.readFile(join(home, "notes.txt")), "workspace\n", "the workspace reads as itself");
			await removeCopilotSessionRecords("read-only-session");
			removeCopilotSessionRecordsSync("never-opened-session");
			await rejects(fs.writeFile(join(state, "late.txt"), "x"), /was closed/);
		});
		ok(!existsSync(workspaceFile));
		ok(!existsSync(cache));
	});

	it("an MCP catalog read creates no cache root, and a refresh records nothing", async () => {
		equal(readMcpServerCatalog(mcpIdentity), null);
		await withReadOnlyMode(async () => {
			equal(writeMcpServerCatalog(mcpIdentity, mcpListing), false);
		});
		ok(!existsSync(cache));
	});

	it("outside the mode the same writers persist", async () => {
		const asset = pinned("ok.bin", "asset");
		mkdirSync(join(cache, "assets"), { recursive: true });
		writeFileSync(`${asset.path}.unavailable.json`, expiredFailure);
		deepEqual(await loadPinnedAsset(asset, loadOptions), bytes);
		deepEqual(readFileSync(asset.path), bytes);
		ok(!existsSync(`${asset.path}.unavailable.json`), "a download clears the failure record");
		ok(writeMcpServerCatalog(mcpIdentity, mcpListing));
		equal(readMcpServerCatalog(mcpIdentity)?.tools[0]?.name, "echo");
		const fs = createCopilotSessionFs("writable-session");
		await fs.writeFile(join(copilotSessionFsConfig().sessionStatePath, "note.txt"), "state");
		const note = join(cache, "copilot-sdk", "sessions", "writable-session", "note.txt");
		ok(existsSync(note));
		await withReadOnlyMode(() => removeCopilotSessionRecords("writable-session"));
		ok(existsSync(note), "a read-only process deletes no session records it did not keep in memory");
		await removeCopilotSessionRecords("writable-session");
		ok(!existsSync(note));
		equal((await semanticIndex().refresh([record("a")])).complete, true);
	});

	it("a process in the mode for good refuses a refresh already waiting for the index lock and keeps a failure record", async () => {
		const index = semanticIndex();
		const manifest = join(index.storage.directory, "manifest.json");
		const committed = readFileSync(manifest, "utf8");
		let waiting: Promise<unknown> | undefined;
		await withStateFileLock(manifest, async () => {
			// Started outside the mode, so it passes the check before the lock and waits for it.
			waiting = index.refresh([record("b")]);
			await new Promise((resolve) => setTimeout(resolve, 50));
			enterReadOnlyMode();
		});
		ok(waiting);
		await rejects(waiting, /read-only mode/);
		equal(readFileSync(manifest, "utf8"), committed, "no generation is committed");

		const asset = pinned("again.bin", "asset");
		writeFileSync(`${asset.path}.unavailable.json`, expiredFailure);
		deepEqual(await loadPinnedAsset(asset, loadOptions), bytes);
		ok(!existsSync(asset.path));
		equal(readFileSync(`${asset.path}.unavailable.json`, "utf8"), expiredFailure);
	});
});
