import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface CheckoutSnapshot {
	root: string;
	paths: ReadonlyMap<string, string>;
}

/** Git-visible file state. This measures a checkout delta; concurrent edits cannot be attributed to one peer. */
export function snapshotCheckout(cwd: string): CheckoutSnapshot | null {
	let root: string;
	let status: Buffer;
	try {
		root = realpathSync(
			execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			})
				.toString("utf8")
				.trim(),
		);
		status = execFileSync(
			"git",
			["-C", root, "-c", "status.renames=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
			{
				timeout: 15_000,
				maxBuffer: 16 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch {
		return null;
	}
	const paths = new Map<string, string>();
	for (const item of status.toString("utf8").split("\0")) {
		if (item.length < 4) continue;
		const name = item.slice(3);
		const hash = createHash("sha256").update(item.slice(0, 2));
		try {
			const candidate = join(root, name);
			const stat = lstatSync(candidate);
			hash.update(String(stat.mode));
			if (stat.isSymbolicLink()) hash.update(readlinkSync(candidate));
			else if (stat.isFile()) {
				const descriptor = openSync(candidate, "r");
				try {
					const buffer = Buffer.allocUnsafe(64 * 1024);
					for (;;) {
						const count = readSync(descriptor, buffer, 0, buffer.length, null);
						if (count === 0) break;
						hash.update(buffer.subarray(0, count));
					}
				} finally {
					closeSync(descriptor);
				}
			}
		} catch {
			hash.update("missing-or-unreadable");
		}
		paths.set(name, hash.digest("hex"));
	}
	return { root, paths };
}

export function changedCheckoutPaths(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
	if (before.root !== after.root) return [];
	return [...new Set([...before.paths.keys(), ...after.paths.keys()])]
		.filter((name) => before.paths.get(name) !== after.paths.get(name))
		.sort();
}
