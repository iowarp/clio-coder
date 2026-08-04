import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { EVENT_LIMIT, startTraceViewer, ViewerDatabase } from "../server.mjs";

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
			const denied = await fetch(`${viewer.url}/api/runs`, { method: "POST" });
			assert.equal(denied.status, 405);
			const traversal = await fetch(`${viewer.url}/%2e%2e%2f%2e%2e%2fetc/passwd`);
			assert.equal(traversal.status, 403);
		} finally {
			await viewer.close();
		}
	});
});
