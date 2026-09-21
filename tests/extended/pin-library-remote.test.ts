/**
 * `pnpm library:pin` rebuilds `library/registry.yaml` purely from a scan of
 * local directories under `library/`, so a "blessed" remote package (a row
 * whose `sourceUrl` is a GitHub tree URL) would be silently dropped on the
 * next pin run unless it is explicitly re-fetched and merged back in.
 *
 * These tests exercise `scripts/pin-library-remote.ts` directly, with the
 * network-facing `fetchPluginSource` dependency injected, so the lane never
 * depends on real network access.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import {
	isBlessedRemoteRow,
	type RegistryRow,
	readBlessedRemoteRows,
	refreshBlessedRemoteRow,
} from "../../scripts/pin-library-remote.js";
import type { PluginSource } from "../../src/domains/plugins/catalog.js";
import { validateLibraryPackage } from "../../src/domains/resources/library-validation.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "clio-coder-pin-library-remote-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A minimal valid plugin package directory, the same shape local library packages use. */
function bundle(name = "wtfp", version = "0.7.3"): string {
	const location = path.join(root, "fetched", name);
	mkdirSync(location, { recursive: true });
	writeFileSync(
		path.join(location, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version,
			description: "wtf-p plugin fixture",
		}),
	);
	return location;
}

const remoteRow: RegistryRow = {
	kind: "plugin",
	name: "wtfp",
	description: "wtf-p plugin (blessed remote package; pinned by digest).",
	version: "0.7.3",
	sourceUrl: "https://github.com/akougkas/wtf-p/tree/v0.7.3/vendors/plugin",
	sha256: "5a4209bed7c4926dc884c5b04bb66ce5ed61083e1b718045cf720f295cc2f3b5",
};

describe("blessed remote library packages", () => {
	it("identifies a GitHub tree sourceUrl as a blessed remote row and a local path as not", () => {
		ok(isBlessedRemoteRow(remoteRow));
		ok(!isBlessedRemoteRow({ ...remoteRow, sourceUrl: "plugins/materio" }));
		ok(!isBlessedRemoteRow({ ...remoteRow, sourceUrl: "https://other.example/plugin.zip" }));
	});

	it("reads blessed remote rows back out of a registry.yaml, ignoring local rows", () => {
		const registryPath = path.join(root, "registry.yaml");
		writeFileSync(
			registryPath,
			stringify({
				entries: [remoteRow, { ...remoteRow, name: "materio", sourceUrl: "plugins/materio" }],
			}),
		);
		const rows = readBlessedRemoteRows(registryPath);
		deepStrictEqual(
			rows.map((row) => row.name),
			["wtfp"],
		);
	});

	it("preserves the pinned identity when a fetched package has been renamed", () => {
		const fetchedRoot = bundle("materio");
		let cleaned = false;
		const result = refreshBlessedRemoteRow(remoteRow, {
			fetchPluginSource: () => ({
				root: fetchedRoot,
				cleanup: () => {
					cleaned = true;
				},
			}),
			validateLibraryPackage,
		});
		equal(result.refreshed, false);
		deepStrictEqual(result.row, remoteRow);
		ok(result.warning?.includes("does not match pinned identity"));
		ok(cleaned);
	});

	it("survives a pin run: a successful fetch regenerates the row from the fetched manifest and recomputes its digest", () => {
		const fetchedRoot = bundle();
		const result = refreshBlessedRemoteRow(remoteRow, {
			fetchPluginSource: (source): PluginSource => {
				equal(source, remoteRow.sourceUrl);
				return { root: fetchedRoot, cleanup: () => {} };
			},
			validateLibraryPackage,
		});
		ok(result.refreshed);
		equal(result.warning, undefined);
		equal(result.row.name, "wtfp");
		equal(result.row.version, "0.7.3");
		equal(result.row.sourceUrl, remoteRow.sourceUrl);
		// The sha256 is recomputed from the fetched source, not copied from the input row.
		equal(result.row.sha256, validateLibraryPackage(fetchedRoot).contentDigest);
		ok(typeof result.row.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.row.sha256));
	});

	it("preserves an unreachable remote row unchanged with a warning instead of failing the pin", () => {
		const result = refreshBlessedRemoteRow(remoteRow, {
			fetchPluginSource: () => {
				throw new Error("network unreachable");
			},
			validateLibraryPackage,
		});
		equal(result.refreshed, false);
		ok(result.warning?.includes("wtfp"));
		ok(result.warning?.includes("network unreachable"));
		deepStrictEqual(result.row, remoteRow);
	});

	it("preserves the row unchanged and warns when the fetched tree fails package validation", () => {
		const emptyRoot = path.join(root, "empty");
		mkdirSync(emptyRoot, { recursive: true });
		const cleanupCalls: boolean[] = [];
		const result = refreshBlessedRemoteRow(remoteRow, {
			fetchPluginSource: () => ({
				root: emptyRoot,
				cleanup: () => cleanupCalls.push(true),
			}),
			validateLibraryPackage,
		});
		equal(result.refreshed, false);
		ok(result.warning);
		deepStrictEqual(result.row, remoteRow);
		// Cleanup runs even on failure: a fetched temp directory is never leaked.
		deepStrictEqual(cleanupCalls, [true]);
	});

	it("always calls cleanup on a successful fetch too", () => {
		const fetchedRoot = bundle();
		const cleanupCalls: boolean[] = [];
		refreshBlessedRemoteRow(remoteRow, {
			fetchPluginSource: () => ({
				root: fetchedRoot,
				cleanup: () => cleanupCalls.push(true),
			}),
			validateLibraryPackage,
		});
		deepStrictEqual(cleanupCalls, [true]);
	});
});
