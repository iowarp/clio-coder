import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

type FileBaseline = Map<string, { hash: string; bytes: number }>;
const baselines = new Map<string, FileBaseline>();

/** Held by the harness process so a runner cannot rewrite its own baseline. */
export function recordPatchBaseline(cwd: string): void {
	baselines.set(resolve(cwd), snapshotFiles(cwd));
}

export function forgetPatchBaseline(cwd: string): void {
	baselines.delete(resolve(cwd));
}

function snapshotFiles(cwd: string): FileBaseline {
	const files: FileBaseline = new Map();
	function walk(dir: string, prefix: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(dir, entry.name);
			const relative = prefix + entry.name;
			if (entry.isDirectory()) walk(path, `${relative}/`);
			else if (entry.isFile() || entry.isSymbolicLink()) {
				const bytes = entry.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
				files.set(relative, {
					hash: createHash("sha256")
						.update(entry.isSymbolicLink() ? "link:" : "file:")
						.update(bytes)
						.digest("hex"),
					bytes: bytes.length,
				});
			}
		}
	}
	walk(cwd, "");
	return files;
}

export interface PatchMetrics {
	bytes: number;
	filesChanged: number;
	testFilesModified: number;
}

export function collectPatchMetrics(cwd: string): PatchMetrics | null {
	const baseline = baselines.get(resolve(cwd));
	if (baseline !== undefined) {
		const current = snapshotFiles(cwd);
		const changed = [...new Set([...baseline.keys(), ...current.keys()])].filter(
			(path) => baseline.get(path)?.hash !== current.get(path)?.hash,
		);
		return {
			// For hash baselines this is changed file content bytes, including deleted
			// content, rather than a textual Git diff (which cannot represent all files).
			bytes: changed.reduce((sum, path) => sum + (current.get(path)?.bytes ?? baseline.get(path)?.bytes ?? 0), 0),
			filesChanged: changed.length,
			testFilesModified: changed.filter((file) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(file))
				.length,
		};
	}

	const diff = spawnSync("git", ["diff", "--", "."], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	if (diff.status !== 0 || typeof diff.stdout !== "string") return null;
	const text = diff.stdout;
	const files = text
		.split(/\r?\n/)
		.filter((line) => line.startsWith("diff --git "))
		.map((line) => line.split(" b/")[1] ?? "");
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		filesChanged: files.length,
		testFilesModified: files.filter((file) => /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./.test(file))
			.length,
	};
}
