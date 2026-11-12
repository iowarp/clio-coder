/**
 * Contracts for scripts/install.sh, the curl-able installer that brings its
 * own Node. Only --dry-run runs here: it stops before any download or write,
 * so nothing reaches the network or a real home.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

	it("fails closed only on a definitive Node signature failure", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-install-sig-"));
		try {
			const mirror = join(root, "mirror");
			const release = join(mirror, "v24.11.1");
			mkdirSync(release, { recursive: true });
			const tarball = "node-v24.11.1-linux-x64.tar.gz";
			writeFileSync(join(release, tarball), "not a node tarball");
			const sum = createHash("sha256").update("not a node tarball").digest("hex");
			writeFileSync(join(release, "SHASUMS256.txt"), `${sum}  ${tarball}\n`);
			// A gpgv whose status and stderr come from FAKE_GPG: bad, nokey or toolerror.
			const bin = join(root, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "gpgv"),
				[
					"#!/bin/sh",
					'case "$FAKE_GPG" in',
					"bad) echo '[GNUPG:] BADSIG 0 node' ;;",
					"nokey) echo '[GNUPG:] ERRSIG 0 1 8 00 0 9'; echo '[GNUPG:] NO_PUBKEY 0'; echo 'gpgv: Can not check signature: No public key' >&2 ;;",
					"toolerror) echo '[GNUPG:] NO_PUBKEY 0'; echo 'gpgv: keyblock resource `pubring.kbx: invalid keyring' >&2 ;;",
					"esac",
					"",
				].join("\n"),
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
			const checksummed = /checksum verified for node-v24\.11\.1-linux-x64\.tar\.gz/u;
			// A custom mirror without a signature keeps the checksum-only warning.
			const unsigned = install();
			match(unsigned.stderr, /no SHASUMS256\.txt\.asc signature at file:/u);
			match(`${unsigned.stdout}${unsigned.stderr}`, checksummed);
			writeFileSync(join(release, "SHASUMS256.txt.asc"), "signature");
			const toolError = install({ FAKE_GPG: "toolerror" });
			match(toolError.stderr, /could not check the SHASUMS256\.txt signature/u);
			match(`${toolError.stdout}${toolError.stderr}`, checksummed);
			const bad = install({ FAKE_GPG: "bad" });
			strictEqual(bad.code, 1, bad.stderr);
			match(bad.stderr, /signature on SHASUMS256\.txt is BAD/u);
			const unknown = install({ FAKE_GPG: "nokey" });
			strictEqual(unknown.code, 1, unknown.stderr);
			match(unknown.stderr, /outside the Node\.js release keyring; refusing to install/u);
			// The explicit opt-out installs on the checksum alone.
			match(
				`${install({ FAKE_GPG: "nokey", CLIO_CODER_REQUIRE_SIGNATURE: "0" }).stderr}`,
				/CLIO_CODER_REQUIRE_SIGNATURE=0/u,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a nodejs.org signature file that holds no valid signature, keeping the old-gpg warning", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-install-nodata-"));
		try {
			const release = join(root, "dist", "v24.11.1");
			mkdirSync(release, { recursive: true });
			const tarball = "node-v24.11.1-linux-x64.tar.gz";
			writeFileSync(join(release, tarball), "not a node tarball");
			const sum = createHash("sha256").update("not a node tarball").digest("hex");
			writeFileSync(join(release, "SHASUMS256.txt"), `${sum}  ${tarball}\n`);
			writeFileSync(join(release, "SHASUMS256.txt.asc"), "not a signature");
			const bin = join(root, "bin");
			mkdirSync(bin);
			// A curl that serves https://nodejs.org/dist from the release directory above, so the signature is official.
			writeFileSync(
				join(bin, "curl"),
				[
					"#!/bin/sh",
					'out=""; url=""',
					'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --proto|--retry|--connect-timeout) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
					'case "$url" in https://nodejs.org/dist/*) f="$FAKE_DIST/$(printf %s "$url" | cut -c25-)"; [ -f "$f" ] && cp "$f" "$out" && exit 0 ;; esac',
					"exit 22",
					"",
				].join("\n"),
			);
			// gpgv's output for junk (NODATA, a CRC and packet error) and for a gpgv that cannot read the .kbx keyring.
			writeFileSync(
				join(bin, "gpgv"),
				[
					"#!/bin/sh",
					'case "$FAKE_GPG" in',
					"nodata) echo '[GNUPG:] NODATA 3'; echo \"gpgv: [don't know]: invalid packet (ctb=66)\" >&2; echo 'gpgv: no signature found' >&2 ;;",
					"toolerror) echo '[GNUPG:] NO_PUBKEY 0'; echo 'gpgv: keyblock resource `pubring.kbx: invalid keyring' >&2 ;;",
					"esac",
					"",
				].join("\n"),
			);
			chmodSync(join(bin, "curl"), 0o755);
			chmodSync(join(bin, "gpgv"), 0o755);
			writeFileSync(join(root, "pubring.kbx"), "");
			const install = (env: Record<string, string>) =>
				run(["--version", "v0.6.0", "--node-version", "24.11.1"], {
					PATH: `${bin}:/usr/bin:/bin`,
					TMPDIR: root,
					FAKE_DIST: join(root, "dist"),
					CLIO_CODER_NODE_BUILD: "linux-x64",
					CLIO_CODER_NODE_KEYRING: join(root, "pubring.kbx"),
					...env,
				});
			const junk = install({ FAKE_GPG: "nodata" });
			strictEqual(junk.code, 1, junk.stderr);
			match(junk.stderr, /nodejs\.org served is not a signature gpgv could verify .*refusing to install/u);
			ok(!/checksum verified/u.test(`${junk.stdout}${junk.stderr}`), junk.stderr);
			const oldTool = install({ FAKE_GPG: "toolerror" });
			match(oldTool.stderr, /could not check the SHASUMS256\.txt signature/u);
			match(`${oldTool.stdout}${oldTool.stderr}`, /checksum verified for node-v24\.11\.1-linux-x64\.tar\.gz/u);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves the channel without a project .npmrc and refuses a channel older than the active install", {
		skip:
			process.platform === "win32" || !existsSync(join(dirname(process.execPath), "..", "lib", "node_modules", "npm")),
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-coder-install-npmrc-"));
		const requests: string[] = [];
		// One loopback registry per source, each answering the packument with its own latest.
		const registry = (name: string, latest: string) =>
			new Promise<{ server: Server; url: string }>((resolve) => {
				const server = createServer((req, res) => {
					requests.push(`${name} ${req.url}`);
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							name: "@iowarp/clio-coder",
							"dist-tags": { latest },
							versions: { [latest]: { name: "@iowarp/clio-coder", version: latest } },
						}),
					);
				});
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					resolve({ server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/` });
				});
			});
		const project = await registry("project", "0.6.0");
		const user = await registry("user", "0.8.0");
		try {
			const build = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
			const installRoot = join(root, "install");
			const runtime = join(installRoot, "runtime", `node-v${process.versions.node}-${build}`);
			mkdirSync(join(runtime, "bin"), { recursive: true });
			mkdirSync(join(runtime, "lib", "node_modules"), { recursive: true });
			symlinkSync(process.execPath, join(runtime, "bin", "node"));
			symlinkSync(
				join(dirname(process.execPath), "..", "lib", "node_modules", "npm"),
				join(runtime, "lib", "node_modules", "npm"),
			);
			writeFileSync(join(installRoot, ".installer-owner"), "");
			const home = join(root, "home");
			const repo = join(root, "repo");
			const bin = join(root, "bin");
			for (const dir of [home, repo, bin, join(root, "launchers")]) mkdirSync(dir);
			writeFileSync(join(repo, ".npmrc"), `registry=${project.url}\n@iowarp:registry=${project.url}\n`);
			writeFileSync(join(home, ".npmrc"), `registry=${user.url}\n`);
			writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 22\n");
			chmodSync(join(bin, "curl"), 0o755);
			const install = () =>
				new Promise<string>((resolve) => {
					const child = spawn(
						"sh",
						[
							SCRIPT,
							"--node-version",
							process.versions.node,
							"--install-dir",
							installRoot,
							"--bin-dir",
							join(root, "launchers"),
							"--no-post-install",
						],
						{
							cwd: repo,
							env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: "C", TMPDIR: root, CLIO_CODER_NODE_BUILD: build },
							stdio: ["ignore", "pipe", "pipe"],
						},
					);
					let output = "";
					child.stdout.on("data", (chunk) => {
						output += chunk;
					});
					child.stderr.on("data", (chunk) => {
						output += chunk;
					});
					child.on("close", () => resolve(output));
				});
			const fresh = await install();
			match(fresh, /resolved latest to 0\.8\.0/u, fresh);
			ok(!requests.some((line) => line.startsWith("project")), requests.join("\n"));
			const active = join(installRoot, "versions", "0.9.0");
			mkdirSync(join(active, "lib", "node_modules", "@iowarp", "clio-coder"), { recursive: true });
			writeFileSync(
				join(active, "lib", "node_modules", "@iowarp", "clio-coder", "package.json"),
				'{"name":"@iowarp/clio-coder","version":"0.9.0"}',
			);
			writeFileSync(join(installRoot, "install.json"), `{\n  "current": "${active}"\n}\n`);
			const older = await install();
			match(older, /latest channel resolved to 0\.8\.0, older than the active 0\.9\.0/u, older);
			ok(!/installing @iowarp/u.test(older), older);
		} finally {
			project.server.close();
			user.server.close();
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
