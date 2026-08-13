/**
 * `clio uninstall` printed "PATH lookup" and "local source bin" on adjacent
 * lines and left the reader to notice they were different paths. They are
 * different installations when they differ, and the operator who has just been
 * told "removed Clio Coder state" types `clio` next and reaches the other one,
 * which still works and still has its own state.
 *
 * The comparison resolves symlinks first: the PATH entry is normally a link
 * into this checkout, and comparing a link to its own target would report two
 * installations where there is one.
 */
import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { otherClioOnPath } from "../../src/cli/uninstall.js";

describe("contracts/uninstall path divergence", () => {
	let root: string;
	let entry: string;
	let linkPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clio-uninstall-path-"));
		mkdirSync(join(root, "checkout", "dist", "cli"), { recursive: true });
		entry = join(root, "checkout", "dist", "cli", "index.js");
		writeFileSync(entry, "", "utf8");
		mkdirSync(join(root, "bin"), { recursive: true });
		linkPath = join(root, "bin", "clio");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("says nothing when PATH finds the very launcher this uninstall touched", () => {
		symlinkSync(entry, linkPath);
		strictEqual(otherClioOnPath(linkPath, linkPath), null);
	});

	// The common shape: /usr/local/bin/clio is a symlink to ~/.local/bin/clio,
	// which is a symlink to this checkout. Two paths, one installation.
	it("says nothing when two paths resolve to the same installation", () => {
		symlinkSync(entry, linkPath);
		const alias = join(root, "bin", "clio-alias");
		symlinkSync(linkPath, alias);
		strictEqual(otherClioOnPath(alias, linkPath), null);
	});

	it("names the survivor when PATH finds a different installation", () => {
		symlinkSync(entry, linkPath);
		mkdirSync(join(root, "other", "dist", "cli"), { recursive: true });
		const otherEntry = join(root, "other", "dist", "cli", "index.js");
		writeFileSync(otherEntry, "", "utf8");
		const otherLink = join(root, "bin", "clio-other");
		symlinkSync(otherEntry, otherLink);

		strictEqual(otherClioOnPath(otherLink, linkPath), otherLink);
	});

	it("names a dangling PATH entry, which is still not this installation", () => {
		symlinkSync(entry, linkPath);
		const broken = join(root, "bin", "clio-broken");
		symlinkSync(join(root, "gone", "dist", "cli", "index.js"), broken);

		strictEqual(otherClioOnPath(broken, linkPath), broken, "a broken clio on PATH is still what the shell will run");
	});

	it("says nothing when PATH finds no clio at all", () => {
		strictEqual(otherClioOnPath(null, linkPath), null);
	});
});
