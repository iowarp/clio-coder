/**
 * Contracts for scripts/install.sh, the curl-able installer that brings its
 * own Node. Only --dry-run runs here: it stops before any download or write,
 * so nothing reaches the network or a real home.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "install.sh");

function run(args: string[], env: Record<string, string> = {}) {
	const home = mkdtempSync(join(tmpdir(), "clio-coder-install-script-"));
	try {
		const result = spawnSync("sh", [SCRIPT, ...args], {
			env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C", ...env },
			input: "",
			encoding: "utf8",
		});
		return {
			code: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			created: existsSync(join(home, ".local")),
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("contracts/install-script", () => {
	it("pins the same Node floor as package.json engines.node", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } };
		const floor = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(pkg.engines?.node ?? "")?.[1];
		ok(floor, "package.json engines.node must be a >=X.Y.Z range");
		match(readFileSync(SCRIPT, "utf8"), new RegExp(`^NODE_MIN="${floor.replaceAll(".", "\\.")}"$`, "mu"));
	});

	it("keeps the body inside main() so a truncated download runs nothing", () => {
		const text = readFileSync(SCRIPT, "utf8");
		match(text, /\n\{ main "\$@"; \}\n$/u, "main runs from a brace group on the last line");
		strictEqual(text.indexOf("\nmain() {"), text.lastIndexOf("\nmain() {"));
	});

	it("fails closed when a checkable Node signature is missing or does not verify", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-install-sig-"));
		try {
			const mirror = join(root, "mirror");
			const release = join(mirror, "v24.11.1");
			mkdirSync(release, { recursive: true });
			const tarball = "node-v24.11.1-linux-x64.tar.gz";
			writeFileSync(join(release, tarball), "not a node tarball");
			const sum = createHash("sha256").update("not a node tarball").digest("hex");
			writeFileSync(join(release, "SHASUMS256.txt"), `${sum}  ${tarball}\n`);
			// A gpgv that knows no key: it never reports VALIDSIG.
			const bin = join(root, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "gpgv"),
				"#!/bin/sh\necho '[GNUPG:] ERRSIG 0 1 8 00 0 9'\necho 'gpgv: Can not check signature: No public key' >&2\n",
			);
			chmodSync(join(bin, "gpgv"), 0o755);
			writeFileSync(join(root, "pubring.kbx"), "");
			const install = (env: Record<string, string> = {}) =>
				run(["--version", "v0.6.0", "--node-version", "24.11.1"], {
					PATH: `${bin}:/usr/bin:/bin`,
					TMPDIR: root,
					CLIO_CODER_NODE_MIRROR: `file://${mirror}`,
					CLIO_CODER_NODE_BUILD: "linux-x64",
					CLIO_CODER_NODE_KEYRING: join(root, "pubring.kbx"),
					...env,
				});
			const missing = install();
			strictEqual(missing.code, 1, missing.stderr);
			match(missing.stderr, /no SHASUMS256\.txt\.asc signature.*refusing to install/u);
			writeFileSync(join(release, "SHASUMS256.txt.asc"), "signature");
			const unknown = install();
			strictEqual(unknown.code, 1, unknown.stderr);
			match(unknown.stderr, /did not verify with gpgv.*refusing to install/u);
			// The explicit opt-out installs on the checksum alone; the junk tarball then fails to unpack.
			const optOut = install({ CLIO_CODER_REQUIRE_SIGNATURE: "0" });
			match(`${optOut.stdout}${optOut.stderr}`, /checksum verified for node-v24\.11\.1-linux-x64\.tar\.gz/u);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects version specs that could reach a different package or a shell", () => {
		for (const spec of ["latest; id", "npm:evil@1.0.0", "../evil", ">=0.4.0", "file:/x", "0.4", "Latest", "$(id)"]) {
			const r = run(["--dry-run", "--version", spec]);
			strictEqual(r.code, 1, `spec ${JSON.stringify(spec)} must be refused:\n${r.stderr}`);
			match(r.stderr, /invalid --version/u);
		}
	});

	it("rejects malformed local Node release names before creating directories", () => {
		for (const version of ["24.", "24..1", "24.1", "24.1.2.3"]) {
			const r = run(["--dry-run", "--node-tarball", `/unused/node-v${version}-linux-x64.tar.xz`]);
			strictEqual(r.code, 1, r.stderr);
			match(r.stderr, /must keep its release file name/);
			ok(!r.created);
		}
		strictEqual(run(["--dry-run", "--node-tarball", "/unused/node-v24.11.1-linux-x64.tar.xz"]).code, 0);
	});

	it("dry run names the plan and writes nothing", () => {
		const r = run(["--dry-run", "--version", "v0.6.0"]);
		strictEqual(r.code, 0, r.stderr);
		match(r.stdout, /package: +@iowarp\/clio-coder@0\.6\.0$/mu);
		match(r.stdout, /would install the newest Node v24\.x/u);
		match(r.stdout, /dry run complete/u);
		ok(!r.created, "a dry run creates nothing under HOME");
	});
	it("accepts background opt-out and refuses pre-0.6.0 installs without writes", () => {
		const r = run(["--dry-run", "--version", "0.6.0", "--no-auto-update", "--no-modify-path"]);
		strictEqual(r.code, 0, r.stderr);
		match(r.stdout, /@iowarp\/clio-coder@0\.6\.0/u);
		const old = run(["--dry-run", "--version", "0.5.9"]);
		strictEqual(old.code, 1);
		match(old.stderr, /requires 0\.6\.0 or newer/u);
		ok(!old.created);
		ok(!r.created);
	});

	it("rollback without an owned installation fails without creating an install", () => {
		const r = run(["--rollback"]);
		strictEqual(r.code, 1);
		match(r.stderr, /no installer manifest/u);
		ok(!r.created);
	});
});
