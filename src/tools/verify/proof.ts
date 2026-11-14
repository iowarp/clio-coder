import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { type DeclaredProof, DeclaredProofSchema, type ObservedProof } from "../../core/hoare.js";

const CATALOG = ".clio-coder/verifiers.yaml";
const FILE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 16 * FILE_BYTES;

function relativeFile(value: string): boolean {
	return (
		!path.posix.isAbsolute(value) &&
		!path.win32.isAbsolute(value) &&
		!value.includes("\\") &&
		!value.includes("\0") &&
		!value.includes(":") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

export function parseDeclaredProof(value: unknown): DeclaredProof | Error {
	if (!Value.Check(DeclaredProofSchema, value)) {
		return new Error("proof requires status (mechanized, modeled or refuted), 1..128 goals and 1..64 input paths");
	}
	if (new Set(value.goals.map((goal) => goal.id)).size !== value.goals.length)
		return new Error("proof goals must have unique ids");
	if (value.inputs.some((input) => !relativeFile(input)))
		return new Error("proof inputs must be repository-relative files");
	for (const goal of value.goals) {
		const file = goal.target.slice(0, goal.target.lastIndexOf(":"));
		if (!relativeFile(file) || !value.inputs.includes(file))
			return new Error(`proof target ${goal.target} must name a source file in proof.inputs`);
	}
	return value;
}

/** Bounded, nonblocking reads; no symlink component may replace a declared proof input. */
export function captureProofSnapshot(
	root: string,
	inputs: ReadonlyArray<string>,
	expectedCatalogDigest?: string,
): string {
	const physicalRoot = realpathSync(root);
	const digest = createHash("sha256");
	let remaining = TOTAL_BYTES;
	for (const file of [...new Set([CATALOG, ...inputs])].sort()) {
		if (!relativeFile(file)) throw new Error(`invalid proof input: ${file}`);
		let current = physicalRoot;
		for (const component of file.split("/")) {
			current = path.join(current, component);
			if (lstatSync(current).isSymbolicLink()) throw new Error(`proof input is a symbolic link: ${file}`);
		}
		const fd = openSync(current, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = fstatSync(fd);
			const cap = Math.min(FILE_BYTES, remaining);
			if (!stat.isFile() || stat.size > cap)
				throw new Error(`proof input is not a regular file within byte limits: ${file}`);
			const bytes = Buffer.alloc(cap + 1);
			let size = 0;
			while (size <= cap) {
				const read = readSync(fd, bytes, size, bytes.length - size, null);
				if (read === 0) break;
				size += read;
			}
			if (size > cap) throw new Error(`proof input exceeded byte limits: ${file}`);
			remaining -= size;
			const contentDigest = createHash("sha256").update(bytes.subarray(0, size)).digest("hex");
			if (file === CATALOG && expectedCatalogDigest !== undefined && contentDigest !== expectedCatalogDigest)
				throw new Error("proof catalog changed after check resolution");
			digest.update(JSON.stringify([file, contentDigest]));
		} finally {
			closeSync(fd);
		}
	}
	return digest.digest("hex");
}

/** Tool-result evidence is host-authored; the report cannot supply this record. */
export function readObservedProof(value: unknown, check: string, toolCallId: string): ObservedProof | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const proof = parseDeclaredProof(record.proof);
	if (
		record.check !== check ||
		proof instanceof Error ||
		typeof record.snapshot !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.snapshot)
	)
		return null;
	return { check, toolCallId, proof, snapshot: record.snapshot };
}
