import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PLUGIN_SCHEMA, readPluginManifest } from "../../src/domains/plugins/discovery.js";
import type { PluginCandidate } from "../../src/domains/plugins/types.js";
import { verifiedPluginCandidate } from "../../src/domains/plugins/verified-tree.js";

// A listing skips re-hashing a plugin tree only while every entry keeps its identity. These hold the cases that
// must fall back to the full hash: content rewritten with its old mtime put back, an entry added, removed or
// renamed, and a link pointed elsewhere.

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The settle window is measured on this clock, so a tree made a moment ago counts as still. */
const LATER = () => Date.now() + 60_000;

/** Long enough for the file system's timestamp to move between a write and the write that follows it. */
const tick = () => new Promise((settle) => setTimeout(settle, 60));

function tree(): string {
	const root = join(realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-verified-tree-"))), "fixture");
	scratch.push(root);
	mkdirSync(join(root, "skills", "one"), { recursive: true });
	writeFileSync(join(root, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: first\n---\nbody A\n");
	writeFileSync(join(root, "skills", "target-a.md"), "a\n");
	writeFileSync(join(root, "skills", "target-b.md"), "b\n");
	symlinkSync("target-a.md", join(root, "skills", "link.md"));
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({
			$schema: PLUGIN_SCHEMA,
			name: "fixture",
			version: "1.0.0",
			description: "Verified tree fixture",
			extensions: { "ai.iowarp.clio": { manifestVersion: 1, resources: { skills: "skills" } } },
		}),
	);
	return root;
}

function reader(): { read: (root: string) => PluginCandidate; count: () => number } {
	let reads = 0;
	return {
		read: (root) => {
			reads += 1;
			return readPluginManifest(root);
		},
		count: () => reads,
	};
}

describe("verified plugin tree", () => {
	it("hashes once, then vouches for an unchanged tree by identity", async () => {
		const root = tree();
		await tick();
		const { read, count } = reader();
		const first = verifiedPluginCandidate(root, read, LATER());
		ok(first.valid, first.diagnostics.map((item) => item.message).join("; "));
		const second = verifiedPluginCandidate(root, read, LATER());
		strictEqual(count(), 1);
		strictEqual(second.contentDigest, first.contentDigest);
	});

	it("never vouches for a tree that changed a moment ago", () => {
		const root = tree();
		const { read, count } = reader();
		verifiedPluginCandidate(root, read);
		verifiedPluginCandidate(root, read);
		strictEqual(count(), 2);
	});

	it("hashes again when content is rewritten and its mtime put back", async () => {
		const root = tree();
		const file = join(root, "skills", "one", "SKILL.md");
		// A whole second, so putting it back is exact to the nanosecond.
		const pinned = 1_700_000_000;
		utimesSync(file, pinned, pinned);
		await tick();
		const { read, count } = reader();
		const first = verifiedPluginCandidate(root, read, LATER());
		const before = statSync(file, { bigint: true });
		await tick();
		// Same length, same inode, same mtime: only the change time and the bytes differ.
		writeFileSync(file, "---\nname: one\ndescription: first\n---\nbody B\n");
		utimesSync(file, pinned, pinned);
		const restored = statSync(file, { bigint: true });
		strictEqual(restored.size, before.size);
		strictEqual(restored.mtimeNs, before.mtimeNs);
		strictEqual(restored.ino, before.ino);
		notStrictEqual(restored.ctimeNs, before.ctimeNs);
		const second = verifiedPluginCandidate(root, read, LATER());
		strictEqual(count(), 2);
		notStrictEqual(second.contentDigest, first.contentDigest);
	});

	it("hashes again when an entry is added, renamed or removed", async () => {
		const root = tree();
		await tick();
		const { read, count } = reader();
		const digests = [verifiedPluginCandidate(root, read, LATER()).contentDigest];
		const steps = [
			() => writeFileSync(join(root, "skills", "added.md"), "new\n"),
			() => renameSync(join(root, "skills", "added.md"), join(root, "skills", "renamed.md")),
			() => rmSync(join(root, "skills", "renamed.md")),
		];
		for (const [index, step] of steps.entries()) {
			await tick();
			step();
			digests.push(verifiedPluginCandidate(root, read, LATER()).contentDigest);
			strictEqual(count(), index + 2);
		}
		notStrictEqual(digests[1], digests[0]);
		notStrictEqual(digests[2], digests[1]);
		strictEqual(digests[3], digests[0]);
	});

	it("hashes again when a link is pointed at another file", async () => {
		const root = tree();
		await tick();
		const { read, count } = reader();
		const first = verifiedPluginCandidate(root, read, LATER());
		await tick();
		rmSync(join(root, "skills", "link.md"));
		symlinkSync("target-b.md", join(root, "skills", "link.md"));
		const second = verifiedPluginCandidate(root, read, LATER());
		strictEqual(count(), 2);
		notStrictEqual(second.contentDigest, first.contentDigest);
	});
});
