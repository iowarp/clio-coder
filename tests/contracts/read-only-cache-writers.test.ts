import { deepEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Read-only mode leaves Clio's cache as it found it (DOG-001, review-a3-4/5): first-use assets and their failure
// records, the shared semantic index, Copilot's disposable session records and MCP catalogs. Each scoped case runs
// against a home with no cache root and checks that the root is still absent; one control case then shows the same
// writers do persist outside the mode. The last section enters the mode for good while work started outside it is
// still pending, so every write site must check the mode after its last await, and each such check has its own
// case. Entering the mode for good is one-way, so that section comes last.
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
const { readCodewiki, writeCodewiki } = await import("../../src/domains/context/codewiki/artifact.js");
const { buildCodewiki } = await import("../../src/domains/context/codewiki/indexer.js");
const { missingGrammarNote } = await import("../../src/domains/context/codewiki/fetched-grammars.js");
const { SemanticIndex } = await import("../../src/domains/semantic/service.js");
const { sourceHash } = await import("../../src/domains/semantic/storage.js");
const { createSemanticBackgroundRefresh } = await import("../../src/domains/semantic-app/background.js");
const { DEFAULT_SETTINGS } = await import("../../src/core/defaults.js");
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

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const pinned = (name: string, path: string) => ({
	label: name,
	url: `${origin}/${path}`,
	sha256: sha256(bytes),
	path: join(cache, "assets", name),
});
const loadOptions = { timeoutMs: 5_000, retryAfterMs: 60_000 };
const profile = { id: "fixture", dimensions: 2, profileIdentity: sourceHash("fixture"), identity: { fixture: true } };
type Embed = NonNullable<ConstructorParameters<typeof SemanticIndex>[0]["embed"]>;
const vectors: Embed = async (inputs) => ({ profileKey: profile.profileIdentity, vectors: inputs.map(() => [1, 0]) });
const semanticIndex = (projectId = "project-a", embed: Embed = vectors) =>
	new SemanticIndex({ projectId, profile, embed });
function record(id: string, projectId = "project-a") {
	return {
		id,
		sourceId: id,
		kind: "code" as const,
		projectId,
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

/** Route this thread's fetch through `answer`, recording each URL; returns the restore. */
function stubFetch(answer: (url: string) => Response | Promise<Response>, calls: string[] = []): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push(url);
		return answer(url);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

/** One regular file of an npm package tarball (ustar, under `package/`). */
function tarFile(name: string, body: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(`package/${name}`, 0);
	header.write("0000644\0", 100);
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("0", 156);
	header.write("ustar\0", 257);
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const readerTarball = gzipSync(
	Buffer.concat([tarFile("index.js", Buffer.from("export default 1;\n")), Buffer.alloc(1024)]),
);
const fixtureReader = {
	formats: "fixture data",
	main: { name: "fixture-reader", version: "1.0.0", sha256: sha256(readerTarball) },
	entry: "index.js",
	deps: [],
	fallback: "a plain read",
};

/** Every entry below `root`: files by content, directories by mtime, links by target. */
function snapshot(root: string): Record<string, string> {
	const entries: Record<string, string> = {};
	const walk = (dir: string): void => {
		entries[relative(root, dir) || "."] = `d:${lstatSync(dir, { bigint: true }).mtimeNs}`;
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const info = lstatSync(path);
			if (info.isSymbolicLink()) entries[relative(root, path)] = `l:${readlinkSync(path)}`;
			else if (info.isDirectory()) walk(path);
			else entries[relative(root, path)] = `f:${sha256(readFileSync(path))}`;
		}
	};
	if (existsSync(root)) walk(root);
	return entries;
}
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((key) => before[key] !== after[key])
		.sort();
}

describe("read-only cache writers", () => {
	it("a pinned asset download serves the caller, and neither it nor a failure record is cached", async () => {
		await withReadOnlyMode(async () => {
			deepEqual(await loadPinnedAsset(pinned("ok.bin", "asset"), loadOptions), bytes);
			await rejects(loadPinnedAsset(pinned("gone.bin", "missing"), loadOptions), /HTTP 404/);
		});
		ok(!existsSync(cache));
	});

	it("a scientific reader not yet unpacked is refused before any download or extraction", async () => {
		const calls: string[] = [];
		const restore = stubFetch(() => new Response(null, { status: 404 }), calls);
		try {
			await withReadOnlyMode(async () => {
				await rejects(
					ensureScientificReader(SCIENTIFIC_READERS.parquet),
					(error: unknown) => error instanceof ReaderUnavailableError && /read-only mode/.test(error.message),
				);
			});
		} finally {
			restore();
		}
		deepEqual(calls, []);
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
			// The file says it was indexed without its grammar, across the worker boundary.
			deepEqual(
				built.codewiki.files.map((file) => [file.path, file.grammarMissing]),
				[["a.rb", true]],
			);
			match(missingGrammarNote(built.codewiki.files) ?? "", /^Ruby symbols come from line patterns/);
			// And says so after the artifact is written and read back.
			writeCodewiki(project, built.codewiki);
			deepEqual(
				readCodewiki(project)?.files.map((file) => file.grammarMissing),
				[true],
			);
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
		ok(connects > before, "the worker tried the grammar download");
		ok(!existsSync(cache));
	});

	it("a grammar fetched in read-only mode parses its files and is not reported missing, though never cached", async () => {
		const project = join(home, "ruby-parsed");
		mkdirSync(project);
		writeFileSync(join(project, "b.rb"), "class Two\n  def two\n    2\n  end\nend\n");
		const grammar = readFileSync(
			new URL("../../node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm", import.meta.url),
		);
		const calls: string[] = [];
		const restore = stubFetch(
			(url) => (url.endsWith("/tree-sitter-ruby.wasm") ? new Response(grammar) : new Response(null, { status: 404 })),
			calls,
		);
		try {
			const built = await withReadOnlyMode(() => buildCodewiki({ cwd: project, language: "unknown" }));
			deepEqual(
				built.files.map((file) => [file.path, file.grammarMissing]),
				[["b.rb", false]],
			);
			ok(built.symbols.some((symbol) => symbol.name === "Two"));
			equal(missingGrammarNote(built.files), undefined);
			// The record that the grammar loaded survives the artifact, so it is not mistaken for an older map.
			writeCodewiki(project, built);
			const files = readCodewiki(project)?.files ?? [];
			deepEqual(
				files.map((file) => file.grammarMissing),
				[false],
			);
			equal(missingGrammarNote(files), undefined);
		} finally {
			restore();
		}
		ok(
			calls.some((url) => url.endsWith("/tree-sitter-ruby.wasm")),
			"the grammar came from the network",
		);
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

	it("semantic storage refuses a checkpoint and a generation commit itself", () => {
		const { storage } = semanticIndex();
		const generation = {
			version: 1,
			projectId: "project-a",
			profileKey: profile.profileIdentity,
			profile,
			generation: "0123abcd",
			createdAt: new Date(0).toISOString(),
			records: [],
			vectors: {},
			tombstones: [],
		} as unknown as Parameters<typeof storage.commit>[0];
		withReadOnlyMode(() => {
			throws(() => storage.write("checkpoint.json", { pending: [] }), /read-only mode/);
			throws(() => storage.commit(generation), /read-only mode/);
		});
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
			await rejects(fs.writeFile(join(state, "late.txt"), "x"), /was closed/);

			// As on disk, a session directory that existed and was removed is not recreated, by any facade.
			const removed = createCopilotSessionFs("removed-session");
			await removed.writeFile(join(state, "a.txt"), "x");
			await removed.rm(state, true, true);
			await rejects(removed.writeFile(join(state, "late.txt"), "x"), /was removed/);
			await rejects(createCopilotSessionFs("removed-session").mkdir(state, true), /was removed/);
			await removeCopilotSessionRecords("removed-session");
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

	it("outside the mode the same writers persist, and the mode keeps the records they left", async () => {
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
		withReadOnlyMode(() => removeCopilotSessionRecordsSync("writable-session"));
		ok(existsSync(note), "a read-only process deletes no session records it did not keep in memory");
		await removeCopilotSessionRecords("writable-session");
		ok(!existsSync(note));
		const index = semanticIndex();
		equal((await index.refresh([record("a")])).complete, true);
		const stale = join(index.storage.directory, "generation-0123abcd.json");
		writeFileSync(stale, "{}");
		withReadOnlyMode(() => throws(() => index.storage.pruneGenerations(null), /read-only mode/));
		ok(existsSync(stale), "read-only mode prunes no generation");
	});

	describe("a process in the mode for good, entered while writable work is pending", () => {
		const state = copilotSessionFsConfig().sessionStatePath;
		const sessions = join(cache, "copilot-sdk", "sessions");
		const deadPid = 2 ** 22 + 1; // Above every platform's pid range, so no process holds it.
		const holder = (pid: number) => `${JSON.stringify({ host: hostname(), pid })}\n`;
		let retained: ReturnType<typeof createCopilotSessionFs>;
		let waitingDir: string;
		let suspendedDir: string;
		let entered: Record<string, string>;
		let settled: Record<string, string>;
		let outcomes: PromiseSettledResult<unknown>[];
		const [waiting, suspended, reader, cleanDir, cleanLink] = [0, 1, 2, 3, 4];

		before(async () => {
			// A disk session provider opened, written and still held when the mode begins.
			retained = createCopilotSessionFs("retained-session");
			await retained.mkdir(join(state, "logs"), true);
			await retained.writeFile(join(state, "events.jsonl"), "{}\n");
			// Records a cleanup will be asked to remove: a session directory, and a link where one belongs.
			await createCopilotSessionFs("cleanup-dir").writeFile(join(state, "note.txt"), "state");
			mkdirSync(join(home, "elsewhere"));
			symlinkSync(join(home, "elsewhere"), join(sessions, "cleanup-link"));

			// Project-b's refresh holds its lock, has charged its checkpoint, and waits on embedding.
			let embedding!: () => void;
			const embedStarted = new Promise<void>((resolve) => {
				embedding = resolve;
			});
			let releaseEmbed!: () => void;
			const embedHeld = new Promise<void>((resolve) => {
				releaseEmbed = resolve;
			});
			const suspendedIndex = semanticIndex("project-b", async (inputs, options) => {
				embedding();
				await embedHeld;
				return vectors(inputs, options);
			});
			suspendedDir = suspendedIndex.storage.directory;
			const refreshing = suspendedIndex.refresh([record("x", "project-b")]);
			await embedStarted;

			// A first-use reader whose tarball download is in flight.
			let fetching!: () => void;
			const fetchStarted = new Promise<void>((resolve) => {
				fetching = resolve;
			});
			let answer!: (response: Response) => void;
			const response = new Promise<Response>((resolve) => {
				answer = resolve;
			});
			const restore = stubFetch(() => {
				fetching();
				return response;
			});
			const unpacking = ensureScientificReader(fixtureReader);
			await fetchStarted;

			// Another process holds project-a's index lock, so this refresh waits for it (within its 1 s budget).
			const waitingIndex = semanticIndex();
			waitingDir = waitingIndex.storage.directory;
			const lock = join(waitingDir, "manifest.json.lock");
			writeFileSync(lock, holder(process.pid));
			const contending = waitingIndex.refresh([record("b")]);
			await new Promise((resolve) => setTimeout(resolve, 50));

			// One synchronous step: both cleanups pass their entry check, the mode begins, the lock holder exits
			// leaving its lock for a waiter to reclaim, and the suspended embedding and download complete.
			const removingDir = removeCopilotSessionRecords("cleanup-dir");
			const removingLink = removeCopilotSessionRecords("cleanup-link");
			enterReadOnlyMode();
			writeFileSync(lock, holder(deadPid));
			entered = snapshot(cache);
			releaseEmbed();
			answer(new Response(readerTarball));
			outcomes = await Promise.allSettled([contending, refreshing, unpacking, removingDir, removingLink]);
			restore();
			settled = snapshot(cache);
		});

		function refusal(index: number): unknown {
			const outcome = outcomes[index];
			if (outcome?.status !== "rejected") throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
			return outcome.reason;
		}
		const within = (dir: string) => (key: string) => {
			const path = join(cache, key);
			return path === dir || path.startsWith(`${dir}/`);
		};

		it("a refresh waiting for the index lock refuses without reclaiming or taking it", () => {
			match(String(refusal(waiting)), /read-only mode/);
			deepEqual(changed(entered, settled).filter(within(waitingDir)), []);
		});

		it("a refresh suspended in embedding writes no checkpoint, generation or manifest", () => {
			match(String(refusal(suspended)), /read-only mode/);
			// Only the lock it took while writable goes: released, as any holder must.
			const lock = relative(cache, join(suspendedDir, "manifest.json.lock"));
			deepEqual(changed(entered, settled).filter(within(suspendedDir)), [relative(cache, suspendedDir), lock]);
			equal(settled[lock], undefined);
		});

		it("a reader download that completes in the mode is not unpacked", () => {
			const error = refusal(reader);
			ok(error instanceof ReaderUnavailableError && /read-only mode/.test(error.message), String(error));
			ok(!existsSync(join(cache, "data-readers")));
		});

		it("cleanup that began outside the mode removes neither a session directory nor a link", () => {
			equal(outcomes[cleanDir]?.status, "fulfilled");
			equal(outcomes[cleanLink]?.status, "fulfilled");
			ok(existsSync(join(sessions, "cleanup-dir", "note.txt")));
			ok(lstatSync(join(sessions, "cleanup-link")).isSymbolicLink());
		});

		it("nothing else in the cache changed", () => {
			deepEqual(
				changed(entered, settled).filter((key) => !within(suspendedDir)(key)),
				[],
			);
		});

		it("a session provider opened before the mode refuses each mutation of its directory", async () => {
			const refusals: Array<[string, () => Promise<void>]> = [
				["a parent directory", () => retained.writeFile(join(state, "deep", "new.txt"), "x")],
				["a file write", () => retained.appendFile(join(state, "events.jsonl"), "{}\n")],
				["a directory", () => retained.mkdir(join(state, "more"), false)],
				["a removal", () => retained.rm(join(state, "events.jsonl"), false, false)],
				["a rename", () => retained.rename(join(state, "events.jsonl"), join(state, "moved.jsonl"))],
			];
			for (const [what, mutate] of refusals) {
				const before = snapshot(cache);
				await rejects(mutate(), { code: "EROFS" }, what);
				deepEqual(changed(before, snapshot(cache)), [], what);
			}
			equal(await retained.readFile(join(state, "events.jsonl")), "{}\n");
		});

		it("a pinned asset download is served and its failure record kept", async () => {
			const asset = pinned("again.bin", "asset");
			writeFileSync(`${asset.path}.unavailable.json`, expiredFailure);
			deepEqual(await loadPinnedAsset(asset, loadOptions), bytes);
			ok(!existsSync(asset.path));
			equal(readFileSync(`${asset.path}.unavailable.json`, "utf8"), expiredFailure);
		});

		it("a session provider opened before the mode does not recreate a removed cache root", async () => {
			rmSync(cache, { recursive: true });
			resetXdgCache();
			await rejects(retained.writeFile(join(state, "late.txt"), "x"), { code: "EROFS" });
			ok(!existsSync(cache));
		});
	});
});
