#!/usr/bin/env node

/**
 * Compare the herdr pin with upstream's latest release.
 *
 * herdr ships several releases a month and Clio pins one of them by checksum,
 * so following upstream is a deliberate step and this script is that step's
 * evidence. It downloads every asset of the latest release, hashes the bytes
 * that crossed the network, and reads `herdr api schema --json` from the asset
 * for the running platform to say whether any wire method Clio sends is gone.
 * It prints the values `src/domains/toolchain/registry.ts` needs and edits
 * nothing: moving a pin is a reviewed change, not a side effect of a check.
 *
 * Exit 0 when the pin is current or the newer release keeps every method;
 * exit 1 when a method Clio sends is missing from it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentToolPlatform, findPinnedTool } from "../src/domains/toolchain/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES = "https://api.github.com/repos/herdrdev/herdr/releases/latest";

/** The asset name upstream publishes for each registry platform. */
const ASSETS: Readonly<Record<string, string>> = {
	"linux-x64": "herdr-linux-x86_64",
	"linux-arm64": "herdr-linux-aarch64",
	"darwin-x64": "herdr-macos-x86_64",
	"darwin-arm64": "herdr-macos-aarch64",
	"win32-x64": "herdr-windows-x86_64.zip",
};

/** Every `method: "..."` string the socket client sends, read from its source. */
function sentMethods(): string[] {
	const source = readFileSync(join(ROOT, "src/domains/mux/socket-client.ts"), "utf8");
	const methods = new Set<string>();
	for (const match of source.matchAll(/(?:call|callObject)\(\s*"([a-z_]+(?:\.[a-z_]+)*)"/gu)) {
		if (match[1] !== undefined) methods.add(match[1]);
	}
	if (source.includes('"events.subscribe"')) methods.add("events.subscribe");
	return [...methods].sort();
}

async function fetchBytes(url: string): Promise<Buffer> {
	const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "clio-coder-herdr-pin" } });
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
	return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<number> {
	const entry = findPinnedTool("herdr");
	if (entry === null) throw new Error("the registry has no herdr entry");
	const release = JSON.parse((await fetchBytes(RELEASES)).toString("utf8")) as { tag_name: string };
	const latest = release.tag_name.replace(/^v/u, "");
	process.stdout.write(`pinned ${entry.version}, latest ${latest}\n`);
	if (latest === entry.version) {
		process.stdout.write("the pin is current\n");
		return 0;
	}

	const work = mkdtempSync(join(tmpdir(), "herdr-pin-"));
	try {
		const base = `https://github.com/herdrdev/herdr/releases/download/v${latest}`;
		const platform = currentToolPlatform();
		let localBinary: string | null = null;
		process.stdout.write(`\nsha256 for ${latest}:\n`);
		for (const [key, asset] of Object.entries(ASSETS)) {
			const bytes = await fetchBytes(`${base}/${asset}`);
			process.stdout.write(`  ${key.padEnd(13)} ${createHash("sha256").update(bytes).digest("hex")}  ${asset}\n`);
			if (key === platform && !asset.endsWith(".zip")) {
				localBinary = join(work, asset);
				writeFileSync(localBinary, bytes);
				chmodSync(localBinary, 0o755);
			}
		}
		const license = await fetchBytes(`https://raw.githubusercontent.com/herdrdev/herdr/v${latest}/LICENSE`);
		process.stdout.write(`  ${"LICENSE".padEnd(13)} ${createHash("sha256").update(license).digest("hex")}\n`);

		if (localBinary === null) {
			process.stdout.write(`\nno runnable asset for ${platform ?? "this platform"}; the wire schema was not checked\n`);
			return 0;
		}
		const schema = spawnSync(localBinary, ["api", "schema", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		if (schema.status !== 0) throw new Error(`herdr api schema failed: ${schema.stderr}`);
		const protocol = (JSON.parse(schema.stdout) as { protocol?: number }).protocol;
		const missing = sentMethods().filter((method) => !schema.stdout.includes(`"${method}"`));
		process.stdout.write(`\nprotocol ${protocol ?? "unknown"}; Clio sends ${sentMethods().length} methods\n`);
		if (missing.length > 0) {
			process.stdout.write(`missing from ${latest}: ${missing.join(", ")}\n`);
			return 1;
		}
		process.stdout.write(`every method Clio sends exists in ${latest}\n`);
		return 0;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`herdr-pin: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	},
);
