/**
 * Contracts for scripts/install.sh, the curl-able npm bootstrap installer.
 *
 * Every run gets a scratch HOME and a PATH whose first entry holds a fake
 * `node` and a fake `npm`; nothing here reaches the network or the real npm
 * prefix. The fake npm records its argv and stdin, then lays down the same
 * layout real npm produces for `npm install -g --prefix <p>`: the package under
 * `<p>/lib/node_modules/@iowarp/clio-coder` and a relative symlink at
 * `<p>/bin/clio-coder`. The fake CLI it installs answers `--version`, `--help`,
 * and `upgrade --post-install` from fixtures, so the test steers what the
 * installer believes about the installed version.
 */
import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "install.sh");
const SYSTEM_PATH = "/usr/bin:/bin";

const FAKE_NODE = `#!/usr/bin/env bash
[[ "\${1:-}" == "--version" ]] && { printf 'v%s\\n' "\${FAKE_NODE_VERSION:-24.20.0}"; exit 0; }
exit 0
`;

const FAKE_CLI = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_CLI_LOG"
case "\${1:-}" in
	--version) printf 'Clio Coder %s\\n' "$FAKE_CLI_VERSION" ;;
	--help) cat "$FAKE_CLI_HELP_FILE" ;;
	web) [[ "\${2:-}" == "--help" ]] && cat "$FAKE_CLI_WEB_HELP_FILE" ;;
	upgrade) [[ -n "\${FAKE_CLI_UPGRADE_FAIL:-}" ]] && { echo "upgrade failed" >&2; exit 1; }; echo "post-install checks complete" ;;
esac
exit 0
`;

const FAKE_NPM = `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo 11.0.0; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
cat > "$FAKE_NPM_STDIN"
if [[ -n "\${FAKE_NPM_FAIL:-}" ]]; then
	echo "npm error code EACCES" >&2
	echo "npm error syscall mkdir" >&2
	exit 243
fi
prefix=""
while [[ $# -gt 0 ]]; do
	if [[ "$1" == "--prefix" ]]; then prefix="$2"; shift; fi
	shift
done
pkg="$prefix/lib/node_modules/@iowarp/clio-coder/dist/cli"
mkdir -p "$pkg" "$prefix/bin"
cp "$FAKE_CLI_SOURCE" "$pkg/index.js"
chmod +x "$pkg/index.js"
# Real npm refreshes a bin link it owns and refuses any other file with EEXIST.
if [[ -L "$prefix/bin/clio-coder" && "$(readlink "$prefix/bin/clio-coder")" == ../lib/node_modules/@iowarp/clio-coder/* ]]; then
	rm "$prefix/bin/clio-coder"
elif [[ -e "$prefix/bin/clio-coder" || -L "$prefix/bin/clio-coder" ]]; then
	echo "npm error EEXIST: file already exists" >&2
	exit 1
fi
ln -s ../lib/node_modules/@iowarp/clio-coder/dist/cli/index.js "$prefix/bin/clio-coder"
echo "added 1 package"
`;

const HELP_WITHOUT_WEB = `Usage:
  clio-coder                      start interactive repository chat
  clio-coder doctor [--fix]       diagnose state; --fix creates or repairs it
  clio-coder upgrade              upgrade Clio Coder and run pending migrations
`;

const HELP_WITH_WEB = `${HELP_WITHOUT_WEB}  clio-coder web [--open]         serve the local browser app
`;
/** What `clio-coder web --help` prints; the background subcommand lives here, not in the root help. */
const WEB_HELP_WITH_BACKGROUND = `Usage:
  clio-coder web [--open] [--port <0-65535>]
  clio-coder web background install [--open] [--port <1-65535>]
`;

interface Scratch {
	root: string;
	home: string;
	fakeBin: string;
	npmLog: string;
	npmStdin: string;
	cliLog: string;
	helpFile: string;
	webHelpFile: string;
	cleanup: () => void;
}

function scratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-install-script-"));
	const home = join(root, "home");
	const fakeBin = join(root, "fakebin");
	mkdirSync(home, { recursive: true });
	mkdirSync(fakeBin, { recursive: true });
	for (const [name, body] of [
		["node", FAKE_NODE],
		["npm", FAKE_NPM],
	] as const) {
		writeFileSync(join(fakeBin, name), body, { mode: 0o755 });
	}
	const cliSource = join(root, "fake-cli.sh");
	writeFileSync(cliSource, FAKE_CLI, { mode: 0o755 });
	const helpFile = join(root, "help.txt");
	writeFileSync(helpFile, HELP_WITHOUT_WEB, "utf8");
	const webHelpFile = join(root, "web-help.txt");
	writeFileSync(webHelpFile, "Usage:\n  clio-coder web [--open]\n", "utf8");
	return {
		root,
		home,
		fakeBin,
		npmLog: join(root, "npm.log"),
		npmStdin: join(root, "npm.stdin"),
		cliLog: join(root, "cli.log"),
		helpFile,
		webHelpFile,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

interface RunOptions {
	env?: Record<string, string>;
	path?: string;
	stdin?: string;
	/** Feed the script over stdin as `curl | bash -s --` does. */
	piped?: boolean;
}

function run(s: Scratch, args: string[], options: RunOptions = {}) {
	const env: Record<string, string> = {
		HOME: s.home,
		PATH: options.path ?? `${s.fakeBin}:${SYSTEM_PATH}`,
		LANG: "C",
		FAKE_NPM_LOG: s.npmLog,
		FAKE_NPM_STDIN: s.npmStdin,
		FAKE_CLI_SOURCE: join(s.root, "fake-cli.sh"),
		FAKE_CLI_LOG: s.cliLog,
		FAKE_CLI_VERSION: "0.4.7",
		FAKE_CLI_HELP_FILE: s.helpFile,
		FAKE_CLI_WEB_HELP_FILE: s.webHelpFile,
		...options.env,
	};
	const result = options.piped
		? spawnSync("bash", ["-s", "--", ...args], { env, input: readFileSync(SCRIPT, "utf8"), encoding: "utf8" })
		: spawnSync("bash", [SCRIPT, ...args], { env, input: options.stdin ?? "", encoding: "utf8" });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr, all: result.stdout + result.stderr };
}

const npmCalls = (s: Scratch): string[] =>
	existsSync(s.npmLog) ? readFileSync(s.npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
const cliCalls = (s: Scratch): string[] =>
	existsSync(s.cliLog) ? readFileSync(s.cliLog, "utf8").trim().split("\n").filter(Boolean) : [];

describe("contracts/install-script", () => {
	it("pins the same Node floor as package.json engines.node", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines?: { node?: string } };
		const floor = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(pkg.engines?.node ?? "")?.[1];
		ok(floor, "package.json engines.node must be a >=X.Y.Z range");
		match(readFileSync(SCRIPT, "utf8"), new RegExp(`^NODE_MIN="${floor.replaceAll(".", "\\.")}"$`, "mu"));
	});

	it("keeps the body inside main() so a truncated download runs nothing", () => {
		const text = readFileSync(SCRIPT, "utf8");
		match(text, /\nmain "\$@"\n$/u, "main is the last line");
		strictEqual(text.indexOf("\nmain() {"), text.lastIndexOf("\nmain() {"));
	});

	it("prints usage and exits 0 for --help without touching node or npm", () => {
		const s = scratch();
		try {
			const r = run(s, ["--help"], { path: SYSTEM_PATH });
			strictEqual(r.code, 0, r.all);
			match(r.stdout, /--prefix <dir>/u);
			match(r.stdout, /npm uninstall -g --prefix <dir> @iowarp\/clio-coder/u);
		} finally {
			s.cleanup();
		}
	});

	it("names the Node floor and nodejs.org when node is missing, too old, or npm is absent", () => {
		const s = scratch();
		try {
			const missing = run(s, ["--dry-run"], { path: SYSTEM_PATH });
			strictEqual(missing.code, 1);
			match(missing.stderr, /Node\.js was not found on PATH.*22\.19\.0.*nodejs\.org/u);

			const old = run(s, ["--dry-run"], { env: { FAKE_NODE_VERSION: "20.19.5" } });
			strictEqual(old.code, 1);
			match(old.stderr, /Node v20\.19\.5 is too old; Clio Coder needs >=22\.19\.0/u);

			const patchBelow = run(s, ["--dry-run"], { env: { FAKE_NODE_VERSION: "22.18.9" } });
			strictEqual(patchBelow.code, 1, "22.18.9 < 22.19.0 must fail on the minor component");

			const exact = run(s, ["--dry-run"], { env: { FAKE_NODE_VERSION: "22.19.0" } });
			strictEqual(exact.code, 0, exact.all);

			rmSync(join(s.fakeBin, "npm"));
			const noNpm = run(s, ["--dry-run"]);
			strictEqual(noNpm.code, 1);
			match(noNpm.stderr, /npm was not found on PATH/u);
			strictEqual(npmCalls(s).length, 0);
		} finally {
			s.cleanup();
		}
	});

	it("dry run prints the exact npm command and changes nothing", () => {
		const s = scratch();
		try {
			const prefix = join(s.home, ".local");
			const r = run(s, ["--dry-run", "--omit-optional"]);
			strictEqual(r.code, 0, r.all);
			match(
				r.stdout,
				new RegExp(`would run: npm install -g --prefix ${prefix} --omit=optional @iowarp/clio-coder@latest`, "u"),
			);
			match(r.stdout, /would then run: .*clio-coder upgrade --post-install/u);
			ok(!existsSync(prefix), "a dry run creates no prefix");
			strictEqual(npmCalls(s).length, 0, "a dry run never invokes npm");
			match(r.stderr, /\.local\/bin is not on PATH/u);
			match(r.stderr, new RegExp(`export PATH=${prefix}/bin:"\\$PATH"`, "u"));
		} finally {
			s.cleanup();
		}
	});

	it("rejects version specs that could reach a different package or a shell", () => {
		const s = scratch();
		try {
			const bad = [
				"latest; id",
				"npm:evil@1.0.0",
				"../evil",
				">=0.4.0",
				"file:/tmp/x",
				"0.4",
				"Latest",
				"latest\nnext",
				"$(id)",
				"",
			];
			for (const spec of bad) {
				const r = run(s, ["--dry-run", "--version", spec]);
				strictEqual(r.code, 1, `spec ${JSON.stringify(spec)} must be refused:\n${r.all}`);
				match(r.stderr, /invalid --version/u);
			}
			strictEqual(npmCalls(s).length, 0);
		} finally {
			s.cleanup();
		}
	});

	it("accepts latest, dist-tags, exact versions, prereleases, and a v-prefixed tag", () => {
		const s = scratch();
		try {
			const cases: Array<[string, string]> = [
				["latest", "latest"],
				["next", "next"],
				["0.4.7", "0.4.7"],
				["v0.4.7", "0.4.7"],
				["0.5.0-rc.1", "0.5.0-rc.1"],
			];
			for (const [given, expected] of cases) {
				const r = run(s, ["--dry-run", `--version=${given}`]);
				strictEqual(r.code, 0, r.all);
				match(r.stdout, new RegExp(`@iowarp/clio-coder@${expected.replaceAll(".", "\\.")}$`, "mu"));
			}
			const fromEnv = run(s, ["--dry-run"], { env: { CLIO_CODER_VERSION: "v0.4.6" } });
			match(fromEnv.stdout, /@iowarp\/clio-coder@0\.4\.6$/mu);
		} finally {
			s.cleanup();
		}
	});

	it("installs into $HOME/.local, prints the launcher path, runs post-install, and promises no web command the CLI lacks", () => {
		const s = scratch();
		try {
			const r = run(s, []);
			strictEqual(r.code, 0, r.all);
			const launcher = join(s.home, ".local", "bin", "clio-coder");
			strictEqual(npmCalls(s).length, 1);
			strictEqual(npmCalls(s)[0], `install -g --prefix ${join(s.home, ".local")} @iowarp/clio-coder@latest`);
			ok(lstatSync(launcher).isSymbolicLink());
			match(r.stdout, /ok: Clio Coder 0\.4\.7/u);
			match(r.stdout, new RegExp(`^Installed: ${launcher}$`, "mu"));
			match(r.stdout, new RegExp(`^  ${launcher} --version$`, "mu"));
			match(r.stdout, /Terminal \(interactive TUI\):\n {2}clio-coder$/mu);
			match(r.stdout, /clio-coder configure$/mu);
			doesNotMatch(r.stdout, /clio-coder web --open/u, "0.4.7 has no web command");
			doesNotMatch(r.stdout, /web background install/u);
			match(r.stdout, /this version has no 'clio-coder web' command/iu);
			ok(
				cliCalls(s).includes("upgrade --post-install"),
				`post-install ran through the launcher:\n${cliCalls(s).join("\n")}`,
			);
			doesNotMatch(
				cliCalls(s).join("\n"),
				/doctor --fix/u,
				"the npm lifecycle is upgrade --post-install, not doctor --fix",
			);
			doesNotMatch(cliCalls(s).join("\n"), /web/u, "the installer never touches a web command the CLI lacks");
		} finally {
			s.cleanup();
		}
	});

	it("offers web --open when the installed help lists it, and the Linux background step only when listed", () => {
		const s = scratch();
		try {
			writeFileSync(s.helpFile, HELP_WITH_WEB, "utf8");
			writeFileSync(s.webHelpFile, WEB_HELP_WITH_BACKGROUND, "utf8");
			const r = run(s, ["--prefix", join(s.home, "clio")]);
			strictEqual(r.code, 0, r.all);
			match(r.stdout, /^ {2}clio-coder web --open$/mu);
			strictEqual(
				cliCalls(s)
					.filter((call) => call.startsWith("web"))
					.join("\n"),
				"web --help",
				"the installer reads web --help and never starts the app",
			);
			if (process.platform === "linux") match(r.stdout, /^ {2}clio-coder web background install --open$/mu);
			else doesNotMatch(r.stdout, /background install/u);
			doesNotMatch(r.stdout, /this version has no 'clio-coder web' command/iu);

			const s2 = scratch();
			try {
				writeFileSync(s2.helpFile, `${HELP_WITHOUT_WEB}  clio-coder web [--open]  serve the app\n`, "utf8");
				const r2 = run(s2, []);
				strictEqual(r2.code, 0, r2.all);
				match(r2.stdout, /clio-coder web --open/u);
				doesNotMatch(r2.stdout, /background install/u, "a web command without a background subcommand promises none");
			} finally {
				s2.cleanup();
			}
		} finally {
			s.cleanup();
		}
	});

	it("refuses a foreign clio-coder symlink unless --force, and never replaces a regular file", () => {
		const s = scratch();
		try {
			const prefix = join(s.home, ".local");
			const binDir = join(prefix, "bin");
			mkdirSync(binDir, { recursive: true });
			const checkout = join(s.root, "checkout", "dist", "cli", "index.js");
			mkdirSync(join(s.root, "checkout", "dist", "cli"), { recursive: true });
			writeFileSync(checkout, "#!/usr/bin/env bash\necho source\n", { mode: 0o755 });
			const launcher = join(binDir, "clio-coder");
			symlinkSync(checkout, launcher);

			const refused = run(s, []);
			strictEqual(refused.code, 1);
			match(refused.stderr, new RegExp(`refusing to replace ${launcher}; it points to ${checkout}`, "u"));
			match(refused.stderr, /--force/u);
			strictEqual(readlinkSync(launcher), checkout, "the foreign launcher is untouched");
			strictEqual(npmCalls(s).length, 0);

			const dry = run(s, ["--dry-run", "--force"]);
			strictEqual(dry.code, 0, dry.all);
			strictEqual(readlinkSync(launcher), checkout, "a forced dry run still removes nothing");

			const failed = run(s, ["--force"], { env: { FAKE_NPM_FAIL: "1" } });
			strictEqual(failed.code, 1);
			strictEqual(readlinkSync(launcher), checkout, "failed npm install restores the original launcher");

			const forced = run(s, ["--force"]);
			strictEqual(forced.code, 0, forced.all);
			match(forced.stderr, /replacing clio-coder symlink that points outside this install/u);
			match(readlinkSync(launcher), /lib\/node_modules\/@iowarp\/clio-coder/u);

			const again = run(s, []);
			strictEqual(again.code, 0, `an install-owned launcher is refreshed without --force:\n${again.all}`);
			match(again.stdout, /belongs to this npm prefix/u);
			strictEqual(npmCalls(s).length, 3);

			rmSync(launcher);
			writeFileSync(launcher, "#!/bin/sh\necho mine\n", { mode: 0o755 });
			const file = run(s, ["--force"]);
			strictEqual(file.code, 1);
			match(file.stderr, /refusing to overwrite the non-symlink file/u);
			strictEqual(readFileSync(launcher, "utf8"), "#!/bin/sh\necho mine\n");
			strictEqual(npmCalls(s).length, 3);
		} finally {
			s.cleanup();
		}
	});

	it("handles a prefix with spaces, a tilde, and a symlinked HOME", () => {
		const s = scratch();
		try {
			const realHome = join(s.root, "real home dir");
			mkdirSync(realHome, { recursive: true });
			const linkedHome = join(s.root, "linked-home");
			symlinkSync(realHome, linkedHome);
			const r = run(s, ["--prefix", "~/my tools/clio"], {
				env: { HOME: linkedHome, PATH: `${join(linkedHome, "my tools", "clio", "bin")}:${s.fakeBin}:${SYSTEM_PATH}` },
			});
			strictEqual(r.code, 0, r.all);
			// The prefix is reported as the operator spelled it (through the HOME
			// symlink); the file must exist behind it.
			const launcher = join(linkedHome, "my tools", "clio", "bin", "clio-coder");
			ok(
				existsSync(join(realpathSync(linkedHome), "my tools", "clio", "bin", "clio-coder")),
				`launcher at ${launcher}:\n${r.all}`,
			);
			strictEqual(npmCalls(s)[0], `install -g --prefix ${join(linkedHome, "my tools", "clio")} @iowarp/clio-coder@latest`);
			match(r.stdout, new RegExp(`^Installed: ${launcher}$`, "mu"));
			match(r.stdout, /bin is on PATH/u, "the symlinked PATH entry resolves to the installed bin dir");
			doesNotMatch(r.stderr, /is not on PATH/u);
		} finally {
			s.cleanup();
		}
	});

	it("warns when another clio-coder earlier on PATH shadows the new launcher", () => {
		const s = scratch();
		try {
			const other = join(s.root, "other-bin");
			mkdirSync(other, { recursive: true });
			writeFileSync(join(other, "clio-coder"), "#!/bin/sh\necho old\n", { mode: 0o755 });
			const prefix = join(s.home, ".local");
			const r = run(s, [], { path: `${other}:${join(prefix, "bin")}:${s.fakeBin}:${SYSTEM_PATH}` });
			strictEqual(r.code, 0, r.all);
			match(r.stderr, new RegExp(`another clio-coder is on your PATH at ${join(other, "clio-coder")}`, "u"));
			match(r.stderr, /hash -r/u);

			const s2 = scratch();
			try {
				const p2 = join(s2.home, ".local");
				const r2 = run(s2, [], { path: `${join(p2, "bin")}:${s2.fakeBin}:${SYSTEM_PATH}` });
				strictEqual(r2.code, 0, r2.all);
				doesNotMatch(r2.stderr, /another clio-coder/u, "the launcher finding itself is not a shadow");
			} finally {
				s2.cleanup();
			}
		} finally {
			s.cleanup();
		}
	});

	it("reports an npm failure with prefix guidance and runs no post-install step", () => {
		const s = scratch();
		try {
			const r = run(s, [], { env: { FAKE_NPM_FAIL: "1" } });
			strictEqual(r.code, 1);
			match(r.stderr, /EACCES/u, "npm's own output is passed through");
			match(r.stderr, /npm install failed for @iowarp\/clio-coder@latest/u);
			match(r.stderr, /never uses sudo; choose a user-writable --prefix/u);
			strictEqual(cliCalls(s).length, 0);
			doesNotMatch(r.stdout, /Installed:/u);
		} finally {
			s.cleanup();
		}
	});

	it("refuses an unwritable prefix before calling npm", () => {
		const s = scratch();
		try {
			const locked = join(s.root, "locked");
			mkdirSync(locked, { mode: 0o555 });
			const r = run(s, ["--prefix", join(locked, "clio")]);
			if (r.code === 0) {
				// Running as root (or on a filesystem that ignores mode bits) makes
				// the directory writable; the check has nothing to refuse there.
				ok(process.getuid?.() === 0, r.all);
				return;
			}
			strictEqual(r.code, 1);
			match(r.stderr, new RegExp(`${locked} is not writable`, "u"));
			strictEqual(npmCalls(s).length, 0);
		} finally {
			s.cleanup();
		}
	});

	it("keeps the script off npm's stdin when piped through bash -s, and still finishes", () => {
		const s = scratch();
		try {
			const r = run(s, ["--version", "v0.4.7"], { piped: true });
			strictEqual(r.code, 0, r.all);
			strictEqual(readFileSync(s.npmStdin, "utf8"), "", "npm must see EOF, not the rest of the installer");
			match(r.stdout, /Installed: /u, "the part of the script after npm still ran");
			strictEqual(npmCalls(s)[0], `install -g --prefix ${join(s.home, ".local")} @iowarp/clio-coder@0.4.7`);
		} finally {
			s.cleanup();
		}
	});

	it("treats a failing post-install as a warning that names the repair command, not as a failed install", () => {
		const s = scratch();
		try {
			const r = run(s, [], { env: { FAKE_CLI_UPGRADE_FAIL: "1" } });
			strictEqual(r.code, 0, r.all);
			match(r.stderr, /post-install checks did not finish; the package is installed\. Run: .*clio-coder doctor --fix/u);
			match(r.stdout, /Installed: /u);
		} finally {
			s.cleanup();
		}
	});
});
