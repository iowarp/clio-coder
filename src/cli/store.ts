import { constants as fsConstants } from "node:fs";
import { copyFile, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { hashFile, observeFileHash } from "../core/run-records.js";
import { safeResourceWriteAsync } from "../core/safe-resource-write.js";
import {
	recordsTag,
	storeProjectDir,
	storeProjectKey,
	storeProjectRoot,
	storeRoot,
	validateBlobName,
	validateTagName,
} from "../core/store-paths.js";
import { openStoreBackend, type StoreBackend, type StoreBlobStat, StoreRefusal } from "../domains/store/index.js";
import { buildPutRecord } from "../domains/store/provenance.js";
import {
	appendRecord,
	currentState,
	driftOf,
	readBlobHistory,
	type StoreRecord,
	summarizeRecords,
} from "../domains/store/records.js";
import { formatColumns, printError } from "./shared.js";

const HELP = `clio-coder store <command>

The store visible from the current directory: this project's tags and blobs,
the same from the main checkout and every task worktree of it.

Commands:
  clio-coder store tags [--json]
  clio-coder store ls <tag> [pattern] [--json]
  clio-coder store stat <tag>:<blob> [--json]
  clio-coder store history <tag>:<blob> [--json]
  clio-coder store verify <tag> [pattern] [--hash-large] [--json]
  clio-coder store put <tag> <file> [--blob <name>] [--note <text>] [--json]
  clio-coder store get <tag>:<blob> [--to <path>] [--json]
  clio-coder store rm-tag <tag> --yes [--json]
  clio-coder store adopt [<projectKey>] [--json]
  clio-coder store where [--json]

pattern is a regular expression matched against the whole blob name.
verify compares each recorded blob's size and mtime with its record, and its
sha256 when the record holds one; --hash-large also hashes blobs whose record
omitted the hash and records the digest as a note. Exit 1 unless every blob is ok.
put creates the tag (class input) when it does not exist.
rm-tag without --yes deletes nothing and prints what it would delete.
adopt without a key lists store directories whose project root no longer
exists; with a key it moves that store to this project, refusing when this
project already has one.
Exit codes: 0 success; 1 operational failure or verify not ok; 2 invalid usage.
`;

const PAGE = 1000;

class UsageError extends Error {}

function bytesLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

function checkTagArg(tag: string | undefined): string {
	if (tag === undefined) throw new UsageError("missing <tag>");
	const problem = validateTagName(tag);
	if (problem !== null) throw new UsageError(problem);
	return tag;
}

function parseRef(ref: string | undefined): { tag: string; blob: string } {
	if (ref === undefined) throw new UsageError("missing <tag>:<blob>");
	const colon = ref.indexOf(":");
	if (colon <= 0 || colon === ref.length - 1) throw new UsageError(`expected <tag>:<blob>, got '${ref}'`);
	const tag = checkTagArg(ref.slice(0, colon));
	const blob = ref.slice(colon + 1);
	const problem = validateBlobName(blob);
	if (problem !== null) throw new UsageError(problem);
	return { tag, blob };
}

async function requireTag(backend: StoreBackend, tag: string): Promise<void> {
	if (!(await backend.tagExists(tag))) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
}

async function allBlobs(backend: StoreBackend, tag: string, pattern?: string): Promise<string[]> {
	const names: string[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const page = await backend.listBlobs(tag, { ...(pattern !== undefined ? { pattern } : {}), offset, limit: PAGE });
		names.push(...page.names);
		if (!page.hasMore) return names;
	}
}

/** Blob names that have at least one record, read from the records tag's names alone. */
async function recordedBlobNames(backend: StoreBackend, tag: string): Promise<Set<string>> {
	const names = new Set<string>();
	if (!(await backend.tagExists(recordsTag(tag)))) return names;
	for (const name of await allBlobs(backend, recordsTag(tag))) {
		const match = /^(.+)#\d{8}$/u.exec(name);
		if (match?.[1] !== undefined) names.add(match[1]);
	}
	return names;
}

async function tagTotals(backend: StoreBackend, tag: string): Promise<{ blobs: number; bytes: number }> {
	let bytes = 0;
	const names = await allBlobs(backend, tag);
	for (const name of names) bytes += (await backend.statBlob(tag, name))?.bytes ?? 0;
	return { blobs: names.length, bytes };
}

export async function storeTags(cwd: string) {
	const backend = await openStoreBackend(cwd);
	const tags = [];
	for (const tag of await backend.listTags()) {
		if (validateTagName(tag) !== null) continue;
		const xattrs = await backend.getTagXattrs(tag);
		tags.push({
			tag,
			class: xattrs["clio.class"] ?? null,
			description: xattrs["clio.description"] ?? null,
			...(await tagTotals(backend, tag)),
		});
	}
	return { tags, backend: await backend.facts() };
}

async function storeList(cwd: string, tag: string, pattern?: string) {
	const backend = await openStoreBackend(cwd);
	await requireTag(backend, tag);
	const names = await allBlobs(backend, tag, pattern);
	const summary = await summarizeRecords(backend, tag, names);
	const blobs = [];
	for (const name of names) {
		const info = await backend.statBlob(tag, name);
		blobs.push({
			blob: name,
			bytes: info?.bytes ?? null,
			modified: info === null ? null : new Date(info.modifiedMs).toISOString(),
			recorded: summary.get(name)?.recorded ?? null,
		});
	}
	return { tag, blobs };
}

/** The store tool's `stat` shape, plus the blob's path: the operator may open it. */
async function storeStat(cwd: string, tag: string, blob: string) {
	const backend = await openStoreBackend(cwd);
	const info = await backend.statBlob(tag, blob);
	const state = currentState((await readBlobHistory(backend, tag, blob)).records);
	const put = state.put;
	if (info === null && put === null) {
		const removed = state.removed ? "; it was removed and its records remain" : "";
		throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store${removed}.`);
	}
	const facts = await backend.facts();
	return {
		ref: `${tag}:${blob}`,
		path: info === null ? null : (await backend.getBlobAsPath(tag, blob)).path,
		bytes: info?.bytes ?? null,
		modified: info === null ? null : new Date(info.modifiedMs).toISOString(),
		drift: driftOf(put, info),
		identity: put?.identity ?? null,
		generatedBy: put?.generatedBy ?? "no producing run on record",
		used: put?.used ?? [],
		producedBy: put?.producedBy ?? null,
		notes: state.notes.map((record) => ({
			at: record.at,
			...(record.note !== undefined ? { note: record.note } : {}),
			...(record.used !== undefined ? { used: record.used } : {}),
		})),
		receipt: put?.receipt ?? null,
		...(state.removed ? { removed: true } : {}),
		backend: {
			kind: facts.kind,
			tier: null,
			reason: facts.tiers === false ? "this backend has no storage tiers" : "tier placement is not reported yet",
		},
	};
}

async function storeHistory(cwd: string, tag: string, blob: string) {
	const backend = await openStoreBackend(cwd);
	const { records, skipped } = await readBlobHistory(backend, tag, blob);
	return { ref: `${tag}:${blob}`, records, skipped };
}

type VerifyStatus = "ok" | "changed" | "missing" | "unrecorded";

export interface VerifyResult {
	tag: string;
	counts: Record<VerifyStatus, number>;
	blobs: Array<{ blob: string; status: VerifyStatus; hashed: boolean; recordedHash?: string }>;
	interrupted: boolean;
}

/**
 * Compare every blob the tag holds or its records name with its latest `put`
 * record: size and mtime, then sha256 when the record holds one. A blob whose
 * last record is a `remove` and whose bytes are gone is not reported.
 */
export async function storeVerify(
	cwd: string,
	tag: string,
	options: { pattern?: string; hashLarge?: boolean; signal?: AbortSignal } = {},
): Promise<VerifyResult> {
	const backend = await openStoreBackend(cwd);
	await requireTag(backend, tag);
	const present = await allBlobs(backend, tag, options.pattern);
	const matcher = options.pattern !== undefined ? new RegExp(`^(?:${options.pattern})$`) : null;
	const recorded = [...(await recordedBlobNames(backend, tag))].filter((name) => matcher?.test(name) ?? true);
	const names = [...new Set([...present, ...recorded])].sort();
	const result: VerifyResult = {
		tag,
		counts: { ok: 0, changed: 0, missing: 0, unrecorded: 0 },
		blobs: [],
		interrupted: false,
	};
	for (const blob of names) {
		if (options.signal?.aborted) {
			result.interrupted = true;
			break;
		}
		const info = await backend.statBlob(tag, blob);
		const { put } = currentState((await readBlobHistory(backend, tag, blob)).records);
		const drift = driftOf(put, info);
		if (drift === "none" && info === null) continue;
		let status: VerifyStatus = drift === "none" ? "ok" : drift;
		let hashed = false;
		let recordedHash: string | undefined;
		if (status === "ok" && info !== null && put !== null) {
			const expected = put.identity?.sha256 ?? null;
			if (expected !== null || options.hashLarge === true) {
				const blobPath = (await backend.getBlobAsPath(tag, blob, options.signal)).path;
				let digest: string;
				try {
					digest = await hashFile(blobPath, options.signal !== undefined ? { signal: options.signal } : {});
				} catch (error) {
					if (options.signal?.aborted) {
						result.interrupted = true;
						break;
					}
					throw error;
				}
				hashed = true;
				if (expected !== null) {
					if (digest !== expected) status = "changed";
				} else {
					await appendRecord(backend, {
						kind: "note",
						tag,
						blob,
						identity: { bytes: info.bytes, modifiedMs: info.modifiedMs, sha256: digest },
						producedBy: { actor: "main" },
						note: `sha256 ${digest} (clio-coder store verify --hash-large)`,
					});
					recordedHash = digest;
				}
			}
		}
		result.counts[status] += 1;
		result.blobs.push({ blob, status, hashed, ...(recordedHash !== undefined ? { recordedHash } : {}) });
	}
	return result;
}

export async function storePut(
	cwd: string,
	tag: string,
	file: string,
	options: { blob?: string; note?: string; signal?: AbortSignal } = {},
) {
	const sourceAbs = path.resolve(cwd, file);
	const blob = options.blob ?? path.basename(sourceAbs);
	const problem = validateBlobName(blob);
	if (problem !== null) throw new UsageError(problem);
	const backend = await openStoreBackend(cwd);
	const { created } = await backend.getOrCreateTag(tag);
	if (created) {
		await backend.setTagXattr(tag, "clio.description", "");
		await backend.setTagXattr(tag, "clio.class", "input");
		await backend.setTagXattr(tag, "clio.createdAt", new Date().toISOString());
	}
	const replaced = (await backend.statBlob(tag, blob)) !== null;
	const stored: StoreBlobStat = await backend.putBlobFromFile(tag, blob, sourceAbs, options.signal);
	const { path: blobPath } = await backend.getBlobAsPath(tag, blob, options.signal);
	const hash = await observeFileHash(blobPath, stored.bytes, options.signal);
	const body = await buildPutRecord({
		backend,
		cwd,
		tag,
		blob,
		sourceAbs,
		stat: stored,
		hash,
		receipt: { backend: backend.kind, key: blobPath, version: stored.version },
		actor: "main",
		...(options.note !== undefined ? { note: options.note } : {}),
	});
	try {
		await appendRecord(backend, body);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new StoreRefusal("io", `${tag}:${blob} is stored but unrecorded (stat shows drift unrecorded): ${reason}`);
	}
	return { ...(await storeStat(cwd, tag, blob)), createdTag: created, replaced, source: { path: sourceAbs } };
}

async function storeGet(cwd: string, tag: string, blob: string, to?: string) {
	const backend = await openStoreBackend(cwd);
	const got = await backend.getBlobAsPath(tag, blob);
	if (to === undefined) return { ref: `${tag}:${blob}`, path: got.path, copied: got.copied };
	const target = path.resolve(cwd, to);
	try {
		await copyFile(got.path, target, fsConstants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new StoreRefusal("exists", `${target} already exists; choose another --to path.`);
		}
		throw error;
	}
	return { ref: `${tag}:${blob}`, path: target, copied: true };
}

export async function storeRemoveTag(cwd: string, tag: string, yes: boolean) {
	const backend = await openStoreBackend(cwd);
	const hasTag = await backend.tagExists(tag);
	const hasRecords = await backend.tagExists(recordsTag(tag));
	if (!hasTag && !hasRecords) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
	const totals = hasTag ? await tagTotals(backend, tag) : { blobs: 0, bytes: 0 };
	if (yes) {
		await backend.delTag(recordsTag(tag));
		await backend.delTag(tag);
	}
	return { tag, ...totals, records: hasRecords, deleted: yes };
}

interface StoreDirInfo {
	key: string;
	dir: string;
	root: string | null;
}

async function storeProjectDirs(): Promise<StoreDirInfo[]> {
	const projects = path.join(storeRoot(), "projects");
	let keys: string[];
	try {
		keys = await readdir(projects);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: StoreDirInfo[] = [];
	for (const key of keys.sort()) {
		const dir = path.join(projects, key);
		let root: string | null = null;
		try {
			const parsed = JSON.parse(await readFile(path.join(dir, "project.json"), "utf8")) as { root?: unknown };
			if (typeof parsed.root === "string") root = parsed.root;
		} catch {
			// No readable project.json: the directory's project is unknown, so it is not offered for adoption.
		}
		out.push({ key, dir, root });
	}
	return out;
}

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/** Bare: store directories whose recorded project root is gone. With a key: move that store to this project. */
export async function storeAdopt(cwd: string, key?: string) {
	const root = storeProjectRoot(cwd);
	const target = storeProjectDir(cwd);
	const currentKey = storeProjectKey(root);
	if (key === undefined) {
		const orphans = [];
		for (const entry of await storeProjectDirs()) {
			if (entry.key === currentKey || entry.root === null) continue;
			if (!(await exists(entry.root))) orphans.push({ key: entry.key, root: entry.root, dir: entry.dir });
		}
		return { adopted: false as const, project: { key: currentKey, root }, orphans };
	}
	if (!/^[0-9a-f]{16}$/u.test(key)) throw new UsageError(`'${key}' is not a store project key (16 hex digits)`);
	if (key === currentKey) throw new StoreRefusal("exists", `${key} is already this project's store.`);
	const source = path.join(storeRoot(), "projects", key);
	const entry = (await storeProjectDirs()).find((candidate) => candidate.key === key);
	if (entry === undefined)
		throw new StoreRefusal("not-found", `No store directory for key ${key} under ${storeRoot()}.`);
	if (await exists(target)) {
		throw new StoreRefusal(
			"exists",
			`This project already has a store at ${target}; adopting ${key} would overwrite it. Remove or move it first.`,
		);
	}
	await rename(source, target);
	// The moved store now belongs to this root; without the rewrite it would be offered for adoption again.
	await safeResourceWriteAsync(
		path.join(target, "project.json"),
		`${JSON.stringify({ v: 1, root, createdAt: new Date().toISOString(), adoptedFrom: { key, root: entry.root } })}\n`,
	);
	return {
		adopted: true as const,
		from: { key, root: entry.root, dir: source },
		to: { key: currentKey, root, dir: target },
	};
}

export function storeWhere(cwd: string) {
	const root = storeProjectRoot(cwd);
	return {
		storeRoot: storeRoot(),
		projectRoot: root,
		projectKey: storeProjectKey(root),
		projectDir: storeProjectDir(cwd),
	};
}

interface ParsedArgs {
	positional: string[];
	json: boolean;
	yes: boolean;
	hashLarge: boolean;
	values: Map<string, string>;
}

const VALUE_FLAGS = new Set(["--blob", "--note", "--to"]);
const BOOL_FLAGS = new Set(["--json", "--yes", "--hash-large"]);

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const parsed: ParsedArgs = { positional: [], json: false, yes: false, hashLarge: false, values: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (VALUE_FLAGS.has(arg)) {
			const value = argv[i + 1];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			parsed.values.set(arg.slice(2), value);
			i++;
		} else if (BOOL_FLAGS.has(arg)) {
			if (arg === "--json") parsed.json = true;
			else if (arg === "--yes") parsed.yes = true;
			else parsed.hashLarge = true;
		} else if (arg.startsWith("-") && arg.length > 1) {
			throw new UsageError(`unknown option ${arg}`);
		} else {
			parsed.positional.push(arg);
		}
	}
	return parsed;
}

function modifiedLabel(iso: string | null): string {
	return iso === null ? "-" : iso.replace("T", " ").replace(/\.\d+Z$/u, "Z");
}

function recordLine(record: StoreRecord): string {
	const parts = [String(record.seq).padStart(4), record.at, record.kind];
	if (record.identity !== undefined) {
		parts.push(
			bytesLabel(record.identity.bytes),
			record.identity.sha256 ?? `sha256 omitted (${record.identity.hashOmitted ?? "none"})`,
		);
	}
	if (record.generatedBy !== undefined) parts.push(`run ${record.generatedBy.runId}`);
	if (record.source !== undefined) parts.push(`from ${record.source.path}`);
	if (record.note !== undefined) parts.push(`note: ${record.note}`);
	return parts.join("  ");
}

type Output = { code: number; data: unknown; text: string };

async function execute(sub: string, args: ParsedArgs, cwd: string, signal: AbortSignal): Promise<Output> {
	const [first, second] = args.positional.slice(1);
	switch (sub) {
		case "tags": {
			const data = await storeTags(cwd);
			const rows = data.tags.map((t) => [
				t.tag,
				t.class ?? "-",
				String(t.blobs),
				bytesLabel(t.bytes),
				t.description ?? "",
			]);
			const free = data.backend.freeBytes === null ? "unknown" : bytesLabel(data.backend.freeBytes);
			const text = [
				data.tags.length === 0
					? "No tags in this project's store."
					: formatColumns([["TAG", "CLASS", "BLOBS", "BYTES", "DESCRIPTION"], ...rows]).trimEnd(),
				`backend: ${data.backend.kind} (${data.backend.mapping}); tiers ${data.backend.tiers === false ? "none" : "yes"}; multi-node ${data.backend.multiNode}; durable ${data.backend.durable}; conditional put ${data.backend.conditionalPut}; blob versions ${data.backend.blobVersions}; free ${free}`,
			].join("\n");
			return { code: 0, data, text };
		}
		case "ls": {
			const data = await storeList(cwd, checkTagArg(first), second);
			const rows = data.blobs.map((b) => [
				b.blob,
				b.bytes === null ? "-" : bytesLabel(b.bytes),
				modifiedLabel(b.modified),
				b.recorded === null ? "unknown" : b.recorded ? "yes" : "no",
			]);
			const text =
				data.blobs.length === 0
					? `No blobs in ${data.tag}.`
					: formatColumns([["BLOB", "BYTES", "MODIFIED", "RECORDED"], ...rows]).trimEnd();
			return { code: 0, data, text };
		}
		case "stat": {
			const { tag, blob } = parseRef(first);
			const data = await storeStat(cwd, tag, blob);
			const lines = [
				`ref       ${data.ref}`,
				`path      ${data.path ?? "-"}`,
				`bytes     ${data.bytes ?? "-"}`,
				`modified  ${modifiedLabel(data.modified)}`,
				`drift     ${data.drift}`,
				`sha256    ${data.identity?.sha256 ?? (data.identity?.hashOmitted ? `omitted (${data.identity.hashOmitted})` : "-")}`,
				`generated ${typeof data.generatedBy === "string" ? data.generatedBy : `run ${data.generatedBy.runId} (${data.generatedBy.script.path}, ${data.generatedBy.outcome})`}`,
				...data.used.map((u) => `used      ${u.tag !== undefined ? `${u.tag}:${u.blob}` : (u.path ?? "?")}`),
				...data.notes.map((n) => `note      ${n.at} ${n.note ?? ""}`.trimEnd()),
				`backend   ${data.backend.kind}`,
			];
			return { code: 0, data, text: lines.join("\n") };
		}
		case "history": {
			const { tag, blob } = parseRef(first);
			const data = await storeHistory(cwd, tag, blob);
			const lines = data.records.length === 0 ? [`No records for ${data.ref}.`] : data.records.map(recordLine);
			if (data.skipped > 0) lines.push(`${data.skipped} unreadable record(s) skipped`);
			return { code: 0, data, text: lines.join("\n") };
		}
		case "verify": {
			const data = await storeVerify(cwd, checkTagArg(first), {
				...(second !== undefined ? { pattern: second } : {}),
				hashLarge: args.hashLarge,
				signal,
			});
			const lines = (["ok", "changed", "missing", "unrecorded"] as const).map((status) => {
				const names = data.blobs.filter((b) => b.status === status).map((b) => b.blob);
				return `${status.padEnd(10)} ${data.counts[status]}${status !== "ok" && names.length > 0 ? `  ${names.join(", ")}` : ""}`;
			});
			for (const b of data.blobs)
				if (b.recordedHash !== undefined) lines.push(`hashed     ${b.blob} sha256 ${b.recordedHash}`);
			if (data.interrupted) lines.push("interrupted: blobs after the last one listed were not checked");
			const allOk = !data.interrupted && data.blobs.every((b) => b.status === "ok");
			return { code: allOk ? 0 : 1, data, text: lines.join("\n") };
		}
		case "put": {
			const tag = checkTagArg(first);
			if (second === undefined) throw new UsageError("missing <file>");
			const blobName = args.values.get("blob");
			const note = args.values.get("note");
			const data = await storePut(cwd, tag, second, {
				...(blobName !== undefined ? { blob: blobName } : {}),
				...(note !== undefined ? { note } : {}),
				signal,
			});
			const verb = data.replaced ? "replaced" : "stored";
			return { code: 0, data, text: `${verb} ${data.ref} (${bytesLabel(data.bytes ?? 0)}) from ${data.source.path}` };
		}
		case "get": {
			const { tag, blob } = parseRef(first);
			const data = await storeGet(cwd, tag, blob, args.values.get("to"));
			return { code: 0, data, text: data.path };
		}
		case "rm-tag": {
			const data = await storeRemoveTag(cwd, checkTagArg(first), args.yes);
			const what = `tag ${data.tag}: ${data.blobs} blob(s), ${bytesLabel(data.bytes)}${data.records ? ", and its records" : ""}`;
			if (!data.deleted) return { code: 1, data, text: `Would delete ${what}. Nothing deleted; rerun with --yes.` };
			return { code: 0, data, text: `Deleted ${what}.` };
		}
		case "adopt": {
			const data = await storeAdopt(cwd, first);
			if (!data.adopted) {
				const lines =
					data.orphans.length === 0
						? ["No store directory has a missing project root."]
						: [
								"Store directories whose project root no longer exists:",
								formatColumns([["KEY", "OLD ROOT"], ...data.orphans.map((o) => [o.key, o.root])]).trimEnd(),
								`Adopt one into ${data.project.root} with: clio-coder store adopt <key>`,
							];
				return { code: 0, data, text: lines.join("\n") };
			}
			const text = [
				`from ${data.from.key}  ${data.from.root ?? "(unknown root)"}`,
				`to   ${data.to.key}  ${data.to.root}`,
				`Moved ${data.from.dir} to ${data.to.dir}.`,
			].join("\n");
			return { code: 0, data, text };
		}
		case "where": {
			const data = storeWhere(cwd);
			const text = [
				`store root   ${data.storeRoot}`,
				`project root ${data.projectRoot}`,
				`project key  ${data.projectKey}`,
				`project dir  ${data.projectDir}`,
			].join("\n");
			return { code: 0, data, text };
		}
		default:
			throw new UsageError(`unknown store command '${sub}'`);
	}
}

export async function runStoreCommand(argv: ReadonlyArray<string>): Promise<number> {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return argv.length === 0 ? 2 : 0;
	}
	const json = argv.includes("--json");
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	try {
		const args = parseArgs(argv);
		const result = await execute(args.positional[0] ?? "", args, process.cwd(), controller.signal);
		process.stdout.write(json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.text}\n`);
		return controller.signal.aborted ? 130 : result.code;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = error instanceof UsageError ? 2 : 1;
		if (json) {
			const reason = error instanceof StoreRefusal ? { reason: error.reason } : {};
			process.stdout.write(`${JSON.stringify({ ok: false, message, ...reason }, null, 2)}\n`);
		} else {
			printError(`store: ${message}`);
			if (code === 2) process.stderr.write("  run 'clio-coder store --help' for usage\n");
		}
		return code;
	} finally {
		process.removeListener("SIGINT", interrupt);
	}
}
