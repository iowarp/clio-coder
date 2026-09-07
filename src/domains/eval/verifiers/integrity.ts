import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class EvalGraderIntegrityError extends Error {}

/** Explicit dependencies avoid guessing executable paths from arbitrary shell commands. */
export async function protectGraderFiles(cwd: string, files: readonly string[]): Promise<() => Promise<void>> {
	const paths = files.map((file) => {
		const path = resolve(cwd, file);
		const rel = relative(cwd, path);
		if (isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`))
			throw new EvalGraderIntegrityError(`grader dependency escapes workspace: ${file}`);
		return path;
	});
	const fingerprint = async (path: string) => {
		// Do not follow a replacement symlink to content chosen outside the fixture.
		let current = path;
		while (current !== resolve(cwd)) {
			if ((await lstat(current)).isSymbolicLink())
				throw new EvalGraderIntegrityError(`grader dependency is a symlink: ${path}`);
			current = resolve(current, "..");
		}
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	};
	const hashes = await Promise.all(paths.map(fingerprint));
	return async () => {
		for (const [index, path] of paths.entries()) {
			try {
				if ((await fingerprint(path)) === hashes[index]) continue;
			} catch {
				/* Missing, unreadable, and replaced dependencies all invalidate grading. */
			}
			throw new EvalGraderIntegrityError(`grader dependency changed during trial: ${relative(cwd, path)}`);
		}
	};
}
