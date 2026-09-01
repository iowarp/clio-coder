import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const TRACE_SCHEMA_VERSION = 1;
export const EVENT_LIMIT = 500;
export const EVIDENCE_INDEX_FILE = "evidence-index.json";
/**
 * Receipt fields the viewer never renders: assistant transcripts, upstream
 * response bodies, the full route decision, and briefing/steering prose. The
 * receipt panel shows provenance, not transcripts, so dropping them keeps the
 * response bounded without hiding anything the page would have displayed.
 */
export const RECEIPT_OMITTED_FIELDS = ["output", "upstreamResponses", "routeDecision", "briefing", "steering"];
const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const assetRoot = resolve(root, "..", "..", "assets");

export class ViewerDatabase {
	constructor(path) {
		this.path = resolve(path);
		this.db = new DatabaseSync(this.path, { readOnly: true });
		this.db.exec("PRAGMA busy_timeout=5000");
		const version = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
		if (Number(version?.value) !== TRACE_SCHEMA_VERSION) {
			this.db.close();
			throw new Error(`unsupported trace schema version ${version?.value ?? "missing"}; expected ${TRACE_SCHEMA_VERSION}`);
		}
		const mode = this.db.prepare("PRAGMA journal_mode").get();
		if (String(mode?.journal_mode).toLowerCase() !== "wal") {
			this.db.close();
			throw new Error(`trace database journal mode is ${mode?.journal_mode ?? "unknown"}; expected WAL`);
		}
	}

	close() {
		this.db.close();
	}

	runs(limit = 50) {
		return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(clamp(limit, 1, 500));
	}

	run(runId) {
		return this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) ?? null;
	}

	phases(runId) {
		return this.db.prepare("SELECT * FROM phases WHERE run_id=? ORDER BY seq, phase_id").all(runId);
	}

	events(runId, after = 0, limit = EVENT_LIMIT) {
		return this.db
			.prepare(`SELECT rowid, event_id, run_id, phase_id, parent_id, type, name,
      payload_json, tokens, started_at, ended_at FROM events
      WHERE run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`)
			.all(runId, Math.max(0, Math.trunc(after)), clamp(limit, 1, EVENT_LIMIT));
	}

	gates(runId) {
		return this.db.prepare("SELECT * FROM gate_results WHERE run_id=? ORDER BY phase_id, attempt, id").all(runId);
	}

	envelopes(runId) {
		return this.db.prepare("SELECT * FROM envelopes WHERE run_id=? ORDER BY created_at, envelope_id").all(runId);
	}

	processes(runId) {
		return this.db.prepare("SELECT * FROM processes WHERE run_id=? ORDER BY ended_at IS NOT NULL, id").all(runId);
	}
}

export function createTraceViewerHandler(database, staticRoot = publicRoot, assetsRoot = assetRoot) {
	return async (request, response) => {
		try {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return json(response, 405, { error: "method not allowed" }, request.method === "HEAD");
			}
			const rawPath = (request.url ?? "/").split("?", 1)[0] ?? "/";
			let decodedPath;
			try {
				decodedPath = decodeURIComponent(rawPath);
			} catch {
				return json(response, 400, { error: "invalid path" }, request.method === "HEAD");
			}
			if (decodedPath.split(/[\\/]/).includes("..")) {
				return json(response, 403, { error: "forbidden" }, request.method === "HEAD");
			}
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/api/health")
				return json(response, 200, { ok: true, schemaVersion: TRACE_SCHEMA_VERSION }, request.method === "HEAD");
			if (url.pathname === "/api/runs") {
				return json(response, 200, { runs: database.runs(numberParam(url, "limit", 50)) }, request.method === "HEAD");
			}
			const match = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(phases|events|gates|envelopes|processes|receipt))?$/);
			if (match) {
				const runId = decodeURIComponent(match[1]);
				const resource = match[2];
				if (!resource) {
					const run = database.run(runId);
					return run
						? json(response, 200, { run }, request.method === "HEAD")
						: json(response, 404, { error: "run not found" }, request.method === "HEAD");
				}
				if (resource === "phases")
					return json(response, 200, { phases: database.phases(runId) }, request.method === "HEAD");
				if (resource === "gates") return json(response, 200, { gates: database.gates(runId) }, request.method === "HEAD");
				if (resource === "envelopes")
					return json(response, 200, { envelopes: database.envelopes(runId) }, request.method === "HEAD");
				if (resource === "processes")
					return json(response, 200, { processes: database.processes(runId) }, request.method === "HEAD");
				if (resource === "receipt")
					return json(response, 200, await readReceiptSidecars(dirname(database.path), runId), request.method === "HEAD");
				const after = numberParam(url, "after", 0);
				const limit = clamp(numberParam(url, "limit", EVENT_LIMIT), 1, EVENT_LIMIT);
				const events = database.events(runId, after, limit);
				const cursor = events.reduce((highest, event) => Math.max(highest, Number(event.rowid)), after);
				return json(response, 200, { events, cursor, hasMore: events.length === limit }, request.method === "HEAD");
			}
			if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "not found" }, request.method === "HEAD");
			if (url.pathname.startsWith("/assets/")) {
				return serveStatic(url.pathname.slice("/assets".length), response, request.method === "HEAD", assetsRoot, false);
			}
			return serveStatic(url.pathname, response, request.method === "HEAD", staticRoot);
		} catch (error) {
			return json(
				response,
				500,
				{ error: error instanceof Error ? error.message : String(error) },
				request.method === "HEAD",
			);
		}
	};
}

export async function startTraceViewer({ db, port = 0 }) {
	const database = new ViewerDatabase(db);
	const server = createServer(createTraceViewerHandler(database));
	try {
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", resolveListen);
		});
	} catch (error) {
		database.close();
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("trace viewer did not obtain a TCP address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
			database.close();
		},
	};
}

/**
 * Sealed receipt plus evidence sidecar row for one run, both optional.
 *
 * The trace database is the only thing the viewer is guaranteed to have: a
 * mirror copied off a node, or a bare db with no `receipts/` directory beside
 * it, must still render. So every failure here is a `null` half, never a 5xx.
 */
export async function readReceiptSidecars(stateDir, runId) {
	return { receipt: await readReceiptFile(stateDir, runId), evidence: await readEvidenceRow(stateDir, runId) };
}

async function readReceiptFile(stateDir, runId) {
	if (runId.length === 0 || /[\\/]/.test(runId) || runId.includes("..")) return null;
	const receipts = resolve(stateDir, "receipts");
	const candidate = resolve(receipts, `${runId}.json`);
	if (dirname(candidate) !== receipts) return null;
	const receipt = await readJsonFile(candidate);
	if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return null;
	const bounded = { ...receipt };
	for (const field of RECEIPT_OMITTED_FIELDS) delete bounded[field];
	return bounded;
}

async function readEvidenceRow(stateDir, runId) {
	const index = await readJsonFile(resolve(stateDir, EVIDENCE_INDEX_FILE));
	if (!Array.isArray(index)) return null;
	return index.find((row) => row !== null && typeof row === "object" && row.runId === runId) ?? null;
}

async function readJsonFile(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

async function serveStatic(pathname, response, head, staticRoot, indexFallback = true) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return json(response, 400, { error: "invalid path" }, head);
	}
	const relativePath = decoded === "/" ? "index.html" : normalize(decoded).replace(/^[/\\]+/, "");
	const root = await realpath(resolve(staticRoot));
	const candidate = resolve(root, relativePath);
	if (!isWithin(candidate, root)) {
		return json(response, 403, { error: "forbidden" }, head);
	}
	let file;
	try {
		file = await realpath(candidate);
		if (!isWithin(file, root)) return json(response, 403, { error: "forbidden" }, head);
		if (!(await stat(file)).isFile()) throw new Error("not a file");
	} catch {
		if (!indexFallback) return json(response, 404, { error: "not found" }, head);
		try {
			file = await realpath(join(root, "index.html"));
			if (!isWithin(file, root) || !(await stat(file)).isFile()) {
				return json(response, 403, { error: "forbidden" }, head);
			}
		} catch {
			return json(response, 404, { error: "not found" }, head);
		}
	}
	response.statusCode = 200;
	response.setHeader("content-type", contentType(extname(file)));
	response.setHeader("cache-control", "no-store");
	if (head) return response.end();
	const stream = createReadStream(file);
	stream.on("error", (error) => {
		if (!response.headersSent) return json(response, 500, { error: error.message });
		response.destroy(error);
	});
	stream.pipe(response);
}

function isWithin(child, parent) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !/^([A-Za-z]:)?[/\\]/.test(rel));
}

function json(response, status, value, head = false) {
	const body = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.setHeader("content-length", Buffer.byteLength(body));
	response.end(head ? undefined : body);
}

function numberParam(url, key, fallback) {
	const raw = url.searchParams.get(key);
	if (raw === null) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function contentType(extension) {
	if (extension === ".js") return "text/javascript; charset=utf-8";
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".svg") return "image/svg+xml";
	if (extension === ".webp") return "image/webp";
	if (extension === ".png") return "image/png";
	return "text/html; charset=utf-8";
}

async function main() {
	const args = process.argv.slice(2);
	const dbIndex = args.indexOf("--db");
	const portIndex = args.indexOf("--port");
	const db = dbIndex >= 0 ? args[dbIndex + 1] : process.env.CLIO_CODER_TRACE_DB;
	if (!db) throw new Error("usage: node server.mjs --db PATH [--port N]");
	const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4600;
	const viewer = await startTraceViewer({ db, port });
	process.stdout.write(`Trace viewer: ${viewer.url}\n`);
	const stop = () => void viewer.close().then(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
