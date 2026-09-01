import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import {
	createTraceViewerHandler,
	EVENT_LIMIT,
	EVIDENCE_INDEX_FILE,
	RECEIPT_OMITTED_FIELDS,
	readReceiptSidecars,
	startTraceViewer,
	ViewerDatabase,
} from "../server.mjs";

const scratch = mkdtempSync(join(tmpdir(), "clio-trace-viewer-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fixture(version = 1) {
	const path = join(scratch, `trace-${version}-${Math.random().toString(16).slice(2)}.sqlite`);
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','${version}');
    CREATE TABLE runs(run_id TEXT PRIMARY KEY,assignment_id TEXT,request TEXT,status TEXT,agent TEXT,target TEXT,model TEXT,runtime TEXT,node TEXT,started_at TEXT,ended_at TEXT,total_tokens INTEGER,total_cost_usd REAL);
    CREATE TABLE phases(phase_id TEXT PRIMARY KEY,run_id TEXT,seq INTEGER,name TEXT,kind TEXT,owner TEXT,description TEXT,status TEXT,attempt INTEGER,retries INTEGER,error TEXT,started_at TEXT,ended_at TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,input_cost_usd REAL,output_cost_usd REAL,cache_read_cost_usd REAL,cache_write_cost_usd REAL,total_cost_usd REAL,context_tokens INTEGER,context_window INTEGER);
    CREATE TABLE events(event_id TEXT PRIMARY KEY,run_id TEXT,phase_id TEXT,parent_id TEXT,type TEXT,name TEXT,payload_json TEXT,tokens INTEGER,started_at TEXT,ended_at TEXT);
    CREATE TABLE gate_results(id INTEGER PRIMARY KEY,run_id TEXT,phase_id TEXT,attempt INTEGER,gate TEXT,passed INTEGER,violations_json TEXT,checks_json TEXT,created_at TEXT);
    CREATE TABLE envelopes(envelope_id TEXT PRIMARY KEY,run_id TEXT,phase_id TEXT,agent TEXT,output_type TEXT,payload_json TEXT,valid INTEGER,attempt INTEGER,created_at TEXT);
    CREATE TABLE processes(id INTEGER PRIMARY KEY,run_id TEXT,kind TEXT,name TEXT,pid INTEGER,command TEXT,command_digest TEXT,started_at TEXT,ended_at TEXT);
    INSERT INTO runs VALUES('run-1','run-1','task','running','coder','local','gpt','native',NULL,'2026-01-01T00:00:00Z',NULL,3,.01);
    INSERT INTO phases VALUES('run-1','run-1',0,'coder','agent','coder','task','running',0,0,NULL,'2026-01-01T00:00:00Z',NULL,1,2,0,0,1,3,NULL,NULL,NULL,NULL,.01,NULL,NULL);
    INSERT INTO events VALUES('e1','run-1','run-1',NULL,'log','one','{}',1,'2026-01-01T00:00:01Z',NULL);
    INSERT INTO events VALUES('e2','run-1','run-1',NULL,'log','two','{}',2,'2026-01-01T00:00:02Z',NULL);`);
	db.close();
	return path;
}

describe("trace viewer server", () => {
	it("uses a monotonic bounded rowid cursor", () => {
		const reader = new ViewerDatabase(fixture());
		try {
			assert.deepEqual(
				reader.events("run-1", 0, 1).map((row) => row.event_id),
				["e1"],
			);
			assert.deepEqual(
				reader.events("run-1", 1, EVENT_LIMIT).map((row) => row.event_id),
				["e2"],
			);
			assert.equal(reader.runs(10)[0].run_id, "run-1");
		} finally {
			reader.close();
		}
	});

	it("refuses an unknown schema and opens valid databases readonly", () => {
		assert.throws(() => new ViewerDatabase(fixture(99)), /unsupported trace schema version 99/);
		const reader = new ViewerDatabase(fixture());
		try {
			assert.throws(() => reader.db.exec("DELETE FROM runs"), /readonly/);
		} finally {
			reader.close();
		}
	});

	it("binds only to localhost and exposes GET-only JSON", async () => {
		const viewer = await startTraceViewer({ db: fixture(), port: 0 });
		try {
			assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:/);
			const page = await fetch(`${viewer.url}/api/runs/run-1/events?after=0&limit=1`).then((response) => response.json());
			assert.equal(page.cursor, 1);
			assert.equal(page.hasMore, true);
			// The client takes its clock offset from this header, so it has to be
			// there and it has to parse. Turning off sendDate would silently put
			// live spans back on the browser's clock.
			const dated = await fetch(`${viewer.url}/api/runs?limit=1`);
			assert.ok(Number.isFinite(Date.parse(dated.headers.get("date") ?? "")), dated.headers.get("date"));
			const denied = await fetch(`${viewer.url}/api/runs`, { method: "POST" });
			assert.equal(denied.status, 405);
			const traversal = await fetch(`${viewer.url}/%2e%2e%2f%2e%2e%2fetc/passwd`);
			assert.equal(traversal.status, 403);
		} finally {
			await viewer.close();
		}
	});

	it("refuses symlinks that escape either static root", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-trace-static-"));
		const pages = join(root, "public");
		const assets = join(root, "assets");
		mkdirSync(pages);
		mkdirSync(assets);
		writeFileSync(join(pages, "index.html"), "safe page");
		writeFileSync(join(root, "outside.txt"), "outside");
		symlinkSync(join(root, "outside.txt"), join(pages, "escape.html"));
		symlinkSync(join(root, "outside.txt"), join(assets, "escape.webp"));
		const server = createServer(createTraceViewerHandler({}, pages, assets));
		await new Promise((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		try {
			for (const path of ["/escape.html", "/assets/escape.webp"]) {
				const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
				assert.equal(response.status, 403, path);
				assert.deepEqual(await response.json(), { error: "forbidden" });
			}
		} finally {
			await new Promise((resolveClose) => server.close(resolveClose));
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("receipt sidecars", () => {
	function stateDir() {
		const dir = mkdtempSync(join(tmpdir(), "clio-trace-receipts-"));
		return dir;
	}

	it("returns the receipt with omitted fields stripped and the matching evidence row", async () => {
		const dir = stateDir();
		mkdirSync(join(dir, "receipts"));
		writeFileSync(
			join(dir, "receipts", "run-1.json"),
			JSON.stringify({
				outcome: "success",
				costUsd: 0.5,
				output: "assistant transcript should not be here",
				upstreamResponses: [{ big: "blob" }],
				routeDecision: { picked: "coder" },
				briefing: "secret briefing",
				steering: "secret steering",
			}),
		);
		writeFileSync(
			join(dir, EVIDENCE_INDEX_FILE),
			JSON.stringify([
				{ runId: "run-1", evidenceId: "ev-1", findingCount: 2 },
				{ runId: "run-2", evidenceId: "ev-2", findingCount: 9 },
			]),
		);
		const result = await readReceiptSidecars(dir, "run-1");
		assert.equal(result.receipt.outcome, "success");
		assert.equal(result.receipt.costUsd, 0.5);
		for (const field of RECEIPT_OMITTED_FIELDS) assert.equal(field in result.receipt, false);
		assert.deepEqual(result.evidence, { runId: "run-1", evidenceId: "ev-1", findingCount: 2 });
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null halves when the receipts dir and evidence index are absent", async () => {
		const dir = stateDir();
		const result = await readReceiptSidecars(dir, "run-1");
		assert.deepEqual(result, { receipt: null, evidence: null });
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a null receipt for malformed receipt JSON", async () => {
		const dir = stateDir();
		mkdirSync(join(dir, "receipts"));
		writeFileSync(join(dir, "receipts", "run-1.json"), "{not valid json");
		const result = await readReceiptSidecars(dir, "run-1");
		assert.equal(result.receipt, null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a null receipt when the receipt file is a JSON array, not an object", async () => {
		const dir = stateDir();
		mkdirSync(join(dir, "receipts"));
		writeFileSync(join(dir, "receipts", "run-1.json"), "[1,2,3]");
		const result = await readReceiptSidecars(dir, "run-1");
		assert.equal(result.receipt, null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a null evidence half for malformed or non-array evidence index", async () => {
		const dir = stateDir();
		writeFileSync(join(dir, EVIDENCE_INDEX_FILE), "{not valid json");
		assert.equal((await readReceiptSidecars(dir, "run-1")).evidence, null);
		writeFileSync(join(dir, EVIDENCE_INDEX_FILE), JSON.stringify({ runId: "run-1" }));
		assert.equal((await readReceiptSidecars(dir, "run-1")).evidence, null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns a null evidence half when no row matches the runId", async () => {
		const dir = stateDir();
		writeFileSync(join(dir, EVIDENCE_INDEX_FILE), JSON.stringify([{ runId: "some-other-run" }]));
		const result = await readReceiptSidecars(dir, "run-1");
		assert.equal(result.evidence, null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("refuses runIds that could escape the receipts directory", async () => {
		const dir = stateDir();
		mkdirSync(join(dir, "receipts"));
		writeFileSync(join(dir, "receipts", "run-1.json"), JSON.stringify({ outcome: "success" }));
		for (const runId of ["a/b", "..", "../run-1", "..%2fetc%2fpasswd", "a\\b", ""]) {
			const result = await readReceiptSidecars(dir, runId);
			assert.equal(result.receipt, null, `runId ${JSON.stringify(runId)} should not resolve a receipt`);
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("serves the receipt endpoint over HTTP and degrades path-traversal runIds to a safe response, never a 5xx", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-trace-http-"));
		const dbPath = join(dir, "trace.sqlite");
		const db = new DatabaseSync(dbPath);
		db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO meta VALUES('schema_version','1');
      CREATE TABLE runs(run_id TEXT PRIMARY KEY,assignment_id TEXT,request TEXT,status TEXT,agent TEXT,target TEXT,model TEXT,runtime TEXT,node TEXT,started_at TEXT,ended_at TEXT,total_tokens INTEGER,total_cost_usd REAL);
      CREATE TABLE phases(phase_id TEXT PRIMARY KEY,run_id TEXT,seq INTEGER,name TEXT,kind TEXT,owner TEXT,description TEXT,status TEXT,attempt INTEGER,retries INTEGER,error TEXT,started_at TEXT,ended_at TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,input_cost_usd REAL,output_cost_usd REAL,cache_read_cost_usd REAL,cache_write_cost_usd REAL,total_cost_usd REAL,context_tokens INTEGER,context_window INTEGER);
      CREATE TABLE events(event_id TEXT PRIMARY KEY,run_id TEXT,phase_id TEXT,parent_id TEXT,type TEXT,name TEXT,payload_json TEXT,tokens INTEGER,started_at TEXT,ended_at TEXT);
      CREATE TABLE gate_results(id INTEGER PRIMARY KEY,run_id TEXT,phase_id TEXT,attempt INTEGER,gate TEXT,passed INTEGER,violations_json TEXT,checks_json TEXT,created_at TEXT);
      CREATE TABLE envelopes(envelope_id TEXT PRIMARY KEY,run_id TEXT,phase_id TEXT,agent TEXT,output_type TEXT,payload_json TEXT,valid INTEGER,attempt INTEGER,created_at TEXT);
      CREATE TABLE processes(id INTEGER PRIMARY KEY,run_id TEXT,kind TEXT,name TEXT,pid INTEGER,command TEXT,command_digest TEXT,started_at TEXT,ended_at TEXT);
      INSERT INTO runs VALUES('run-1','run-1','task','running','coder','local','gpt','native',NULL,'2026-01-01T00:00:00Z',NULL,3,.01);`);
		db.close();
		mkdirSync(join(dir, "receipts", "a"), { recursive: true });
		writeFileSync(join(dir, "receipts", "run-1.json"), JSON.stringify({ outcome: "success" }));
		// A readable file one directory below receipts/. A runId carrying a separator
		// would reach it if the guard ever stopped refusing separators, so this is the
		// file the traversal assertion below proves is never served.
		writeFileSync(join(dir, "receipts", "a", "b.json"), JSON.stringify({ outcome: "escaped" }));
		const viewer = await startTraceViewer({ db: dbPath, port: 0 });
		try {
			const happy = await fetch(`${viewer.url}/api/runs/run-1/receipt`).then((response) => response.json());
			assert.equal(happy.receipt.outcome, "success");
			assert.equal(happy.evidence, null);

			const traversal1 = await fetch(`${viewer.url}/api/runs/${encodeURIComponent("a/b")}/receipt`);
			assert.equal(traversal1.status, 200);
			assert.deepEqual(await traversal1.json(), { receipt: null, evidence: null });

			// A backslash survives URL normalization and carries no ".." segment, so it
			// reaches readReceiptFile and is refused by the separator check there.
			const traversal2 = await fetch(`${viewer.url}/api/runs/${encodeURIComponent("a\\b")}/receipt`);
			assert.equal(traversal2.status, 200);
			assert.deepEqual(await traversal2.json(), { receipt: null, evidence: null });

			// A bare ".." segment is collapsed by the URL parser before the request is
			// sent, so the only way to put one on the wire is inside a longer segment,
			// where the handler's own guard refuses it outright.
			const traversal3 = await fetch(`${viewer.url}/api/runs/%2e%2e%2fetc%2fpasswd/receipt`);
			assert.equal(traversal3.status, 403);
			assert.deepEqual(await traversal3.json(), { error: "forbidden" });
		} finally {
			await viewer.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
