import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreHost } from "../../src/domains/store/core-host/supervisor.js";

/**
 * A clio-core host over an in-memory file system. A put reads its source,
 * yields so other puts interleave, then publishes and answers with what it
 * streamed, as the Python host does. `readDrift` makes a read return one byte
 * more than the blob's stat: the blob changed while it was being read.
 */
export function memoryHost(options: { readDrift?: boolean } = {}): CoreHost {
	const tags = new Map<string, Record<string, string>>();
	const files = new Map<string, { data: Buffer; modifiedMs: number }>();
	const records = new Map<string, Buffer>();
	let clock = 1_000;
	const key = (args: { tag: string; blob: string }) => `${args.tag}\0${args.blob}`;
	const ops: Record<string, (args: never) => unknown> = {
		facts: () => ({
			kind: "clio-core",
			mapping: "",
			tiers: [{ name: "ram", score: 1, freeBytes: null }],
			multiNode: false,
			durable: true,
			conditionalPut: "if-absent-and-version",
			blobVersions: false,
			freeBytes: null,
		}),
		getOrCreateTag: (args: { tag: string }) => {
			if (tags.has(args.tag)) return { created: false };
			tags.set(args.tag, {});
			return { created: true };
		},
		tagExists: (args: { tag: string }) => ({ exists: tags.has(args.tag) }),
		setTagXattr: (args: { tag: string; key: string; value: string }) => {
			(tags.get(args.tag) ?? {})[args.key] = args.value;
			return {};
		},
		getTagXattrs: (args: { tag: string }) => ({ xattrs: { ...tags.get(args.tag) } }),
		statBlob: (args: { tag: string; blob: string; records: boolean }) => {
			if (args.records) {
				const data = records.get(key(args));
				return { stat: data === undefined ? null : { bytes: data.length, modifiedMs: 0, version: null } };
			}
			const file = files.get(key(args));
			return { stat: file === undefined ? null : { bytes: file.data.length, modifiedMs: file.modifiedMs, version: null } };
		},
		putBlobFromFile: async (args: { tag: string; blob: string; source: string }) => {
			const data = await readFile(args.source);
			await new Promise((resolve) => setImmediate(resolve));
			const modifiedMs = clock++;
			files.set(key(args), { data, modifiedMs });
			await new Promise((resolve) => setImmediate(resolve));
			return {
				bytes: data.length,
				modifiedMs,
				version: null,
				sha256: createHash("sha256").update(data).digest("hex"),
			};
		},
		getBlobAsPath: async (args: { tag: string; blob: string; destDir: string }) => {
			const file = files.get(key(args));
			if (file === undefined) throw new Error(`no blob ${args.blob}`);
			const target = join(args.destDir, "data");
			await writeFile(target, options.readDrift === true ? Buffer.concat([file.data, Buffer.from("!")]) : file.data);
			return { path: target, copied: true };
		},
		putRecordIfAbsent: (args: { tag: string; blob: string; data: string }) => {
			if (records.has(key(args))) return { outcome: "exists" };
			records.set(key(args), Buffer.from(args.data, "base64"));
			return { outcome: "written" };
		},
		getRecord: (args: { tag: string; blob: string }) => {
			const data = records.get(key(args));
			return { data: data === undefined ? null : data.toString("base64") };
		},
		delBlob: (args: { tag: string; blob: string; records: boolean }) => ({
			deleted: (args.records ? records : files).delete(key(args)),
		}),
		listBlobs: (args: { tag: string; records: boolean; offset: number; limit: number }) => {
			const source = args.records ? records : files;
			const names = [...source.keys()]
				.filter((name) => name.startsWith(`${args.tag}\0`))
				.map((name) => name.slice(args.tag.length + 1))
				.sort();
			return {
				names: names.slice(args.offset, args.offset + args.limit),
				hasMore: names.length > args.offset + args.limit,
			};
		},
	};
	return {
		state: "ready",
		hello: null,
		call: async (op: string, args: unknown) => {
			const fn = ops[op];
			if (fn === undefined) throw new Error(`unexpected host op ${op}`);
			return fn(args as never);
		},
		stderrTail: () => "",
		close: async () => {},
	} as unknown as CoreHost;
}
