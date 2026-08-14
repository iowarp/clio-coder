import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-006 / BUG-012: `share inspect --json` used to serialize only plan.archive
// and drop plan.diagnostics, so a missing archive produced only `null` and a
// structurally valid but unsafe archive looked like a clean inspection while the
// process exited 1. The payload is now `{ archive, diagnostics }`, matching the
// machine-readable shape `share import --dry-run --json` already emits.

describe("contracts/share-cli inspect --json", () => {
	const scratch = makeScratchHome("clio-share-cli-");
	after(() => scratch.cleanup());

	// BUG-006: a missing archive is a real failure and must carry a diagnostic.
	it("surfaces a diagnostic for a missing archive instead of bare null", async () => {
		const result = await runCli(["share", "inspect", join(scratch.dir, "nope"), "--json"], { env: scratch.env });
		strictEqual(result.code, 1, `stderr=${result.stderr}`);
		strictEqual(result.stderr, "");
		const payload = JSON.parse(result.stdout);
		strictEqual(payload.archive, null);
		match(JSON.stringify(payload.diagnostics), /could not be read|ENOENT/);
	});

	// BUG-012: a valid-but-unsafe archive must expose the unsafe-path diagnostic
	// rather than looking like a successful inspection.
	it("surfaces the unsafe-path diagnostic for a structurally valid archive", async () => {
		const archivePath = join(scratch.dir, "unsafe.clio-coder-share.json");
		const archive = {
			kind: "clio-share-archive",
			formatVersion: 1,
			manifest: { format: "clio.share.v1", clioVersion: "0.2.7", createdAt: "2026-07-01T00:00:00.000Z" },
			files: [
				{
					archivePath: "project/escape",
					relativePath: "../escape",
					scope: "project",
					type: "skill",
					sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
					encoding: "base64",
					data: "",
				},
			],
		};
		writeFileSync(archivePath, `${JSON.stringify(archive, null, 2)}\n`);
		const result = await runCli(["share", "inspect", archivePath, "--json"], { env: scratch.env });
		strictEqual(result.code, 1, `stderr=${result.stderr}`);
		strictEqual(result.stderr, "");
		const payload = JSON.parse(result.stdout);
		ok(payload.archive, "expected the archive to be serialized");
		match(JSON.stringify(payload.diagnostics), /relativePath is not safe/);
	});

	// A clean archive inspects with an empty diagnostics array; the success shape
	// still carries the archive.
	it("returns the archive with no diagnostics for a valid archive", async () => {
		const archivePath = join(scratch.dir, "ok.clio-coder-share.json");
		const exported = await runCli(["share", "export", "--out", archivePath], { env: scratch.env });
		strictEqual(exported.code, 0, `stderr=${exported.stderr}`);
		const result = await runCli(["share", "inspect", archivePath, "--json"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const payload = JSON.parse(result.stdout);
		ok(payload.archive, "expected the archive to be serialized");
		deepStrictEqual(payload.diagnostics, []);
	});
});
