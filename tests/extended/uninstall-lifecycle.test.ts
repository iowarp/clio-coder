import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runGuiCommand } from "../../src/cli/gui.js";
import { installRootFinding } from "../../src/cli/doctor-state-size.js";
import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { inactiveInstallerRecord, inspectInstallation } from "../../src/domains/lifecycle/install-method.js";
import { installRootHolders } from "../../src/domains/lifecycle/install-plan.js";
import { createLifecycleHome, type LifecycleHome, runInHome, writeLiveSession } from "../harness/lifecycle-home.js";

const home = () => createLifecycleHome("clio-coder-test-uninstall-");

/** The launcher path uninstall resolves, from CLIO_CODER_BIN_DIR. */
const launcherPath = (temp: LifecycleHome): string => join(temp.binDir, "clio-coder");

describe("contracts/uninstall-lifecycle", () => {
	it("stops for an open session on any install method, even with --force", async () => {
		const temp = home();
		try {
			writeLiveSession(temp, { host: "other-node", pid: 4242 });
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(code, 1);
			match(stdout, /20261102-open-session \(tui, pid 4242 on other-node, \/work\/project\)/u);
			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.stateDir, "home.json")));
		} finally {
			temp.cleanup();
		}
	});

	// A checkout that has not been built has no application bundle, so there is no launcher to install;
	// tests/extended/uninstall-without-gui.test.ts covers that case.
	it("previews and removes the packaged web desktop entry before deleting state", {
		skip:
			process.platform !== "linux"
				? "the desktop launcher is Linux-only"
				: !existsSync(join(resolvePackageRoot(), "dist/gui/server.js")) &&
					"the graphical application has not been built in this checkout",
	}, async () => {
		const temp = home();
		try {
			const prefix = join(temp.root, ".local/share");
			const entry = join(prefix, "applications/io.iowarp.ClioCoder.desktop");
			strictEqual((await runInHome(temp, () => runGuiCommand(["launcher", "install", "--prefix", prefix]))).code, 0);
			const preview = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			strictEqual(preview.code, 0);
			match(preview.stdout, /Desktop launcher/);
			ok(existsSync(entry));
			const real = await runInHome(temp, () => runUninstallCommand(["--force", "--keep-config", "--keep-data"]));
			strictEqual(real.code, 0);
			ok(!existsSync(entry));
			ok(!existsSync(`${entry}.owner.json`));
			ok(!existsSync(temp.stateDir));
			ok(existsSync(temp.configDir));
			ok(existsSync(temp.dataDir));
		} finally {
			temp.cleanup();
		}
	});

	it("inventories the four roots with sizes, and lists no child of a root it deletes whole", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			strictEqual(code, 0);

			match(stdout, /Installation method: /u);
			match(stdout, /The following will be removed:/u);
			match(stdout, /✓ Data: .*\(11 B\)/u, "sizes come from the disk, not from a constant");
			match(stdout, /✓ Cache: .*\(10 B\)/u);
			match(stdout, /✓ Config: /u);
			match(stdout, /✓ State: /u);

			// `state/audit` and `state/sessions` live inside the State row. Listing
			// them again double-counted the bytes and promised per-child results
			// that one recursive delete never produces.
			ok(!/^\s+[✓–] Logs:/mu.test(stdout), `logs must not be a row of its own:\n${stdout}`);
			ok(!/^\s+[✓–] Sessions:/mu.test(stdout), `sessions must not be a row of its own:\n${stdout}`);

			match(stdout, /Dry run: no changes made/u);
			ok(!/Removed /u.test(stdout), `a dry run reports no completed work:\n${stdout}`);

			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.dataDir, "records.json")));
			ok(existsSync(join(temp.stateDir, "home.json")));
		} finally {
			temp.cleanup();
		}
	});

	it("marks a shell startup file that mentions clio-coder as kept, never as removed", async () => {
		const temp = home();
		try {
			writeFileSync(join(temp.root, ".bashrc"), 'export PATH="$HOME/.local/bin:$PATH" # clio-coder\n', "utf8");
			const { stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));

			// Uninstall never edits a login file, so a ✓ beside one claimed work it
			// does not do. The row is informational.
			match(stdout, /– Shell config: .*\.bashrc.*edit it by hand/u);
			ok(!/✓ Shell/u.test(stdout), `a shell row must never be marked for removal:\n${stdout}`);

			ok(readFileSync(join(temp.root, ".bashrc"), "utf8").includes("clio-coder"), "reported, not rewritten");
		} finally {
			temp.cleanup();
		}
	});

	it("omits the shell row entirely when no startup file mentions clio-coder", async () => {
		const temp = home();
		try {
			const { stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			ok(!/Shell config/u.test(stdout), `nothing found means nothing listed:\n${stdout}`);
		} finally {
			temp.cleanup();
		}
	});

	it("honors --keep-config and --keep-data on the listing and on disk", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () =>
				runUninstallCommand(["--force", "--keep-config", "--keep-data"]),
			);
			strictEqual(code, 0);

			match(stdout, /– Config: .*\(kept by --keep-config\)/u);
			match(stdout, /– Data: .*\(kept by --keep-data\)/u);
			match(stdout, /✓ Removed Cache/u);
			match(stdout, /✓ Removed State/u);
			ok(!/Removed Config|Removed Data/u.test(stdout), `kept roots owe no result line:\n${stdout}`);

			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.dataDir, "records.json")));
			ok(!existsSync(join(temp.stateDir, "home.json")));
			ok(!existsSync(join(temp.cacheDir, "derived.bin")));
		} finally {
			temp.cleanup();
		}
	});

	it("keeps a launcher that points at another installation and says why", async () => {
		const temp = home();
		try {
			const foreign = join(temp.root, "other-install", "dist", "cli", "index.js");
			mkdirSync(join(temp.root, "other-install", "dist", "cli"), { recursive: true });
			writeFileSync(foreign, "// another clio\n", "utf8");
			symlinkSync(foreign, launcherPath(temp));

			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(code, 0);

			// Uninstall unlinks only a symlink into *this* installation. The
			// previous code reported "Removed Binary launcher" from the request alone,
			// over a launcher the classifier had already decided to keep.
			ok(!/Removed launcher/u.test(stdout), `a foreign launcher is not removed:\n${stdout}`);
			match(stdout, /– Launcher: .*not this installation/u);
			ok(existsSync(launcherPath(temp)), "the foreign launcher is still on disk");
			strictEqual(lstatSync(launcherPath(temp)).isSymbolicLink(), true);
		} finally {
			temp.cleanup();
		}
	});

	it("removes this installation's launcher unless --keep-binary keeps it", async () => {
		const kept = home();
		const removed = home();
		try {
			const entry = join(resolvePackageRoot(), "dist", "cli", "index.js");
			for (const temp of [kept, removed]) symlinkSync(entry, launcherPath(temp));
			const keeping = await runInHome(kept, () => runUninstallCommand(["--force", "--keep-binary"]));
			strictEqual(keeping.code, 0);
			match(keeping.stdout, /– Launcher: .*kept by --keep-binary/u);
			strictEqual(lstatSync(launcherPath(kept)).isSymbolicLink(), true);

			const removing = await runInHome(removed, () => runUninstallCommand(["--force"]));
			strictEqual(removing.code, 0);
			match(removing.stdout, /Removed launcher/u);
			strictEqual(existsSync(launcherPath(removed)), false);
		} finally {
			kept.cleanup();
			removed.cleanup();
		}
	});

	it("removes an installer root this binary does not run from, unless --keep-binary keeps it", async () => {
		for (const keep of [true, false]) {
			const temp = home();
			try {
				const root = join(temp.root, ".local", "share", "clio-coder-install");
				const current = join(root, "versions", "0.6.2");
				const node = join(root, "runtime", "node-v24", "bin", "node");
				mkdirSync(current, { recursive: true });
				mkdirSync(join(node, ".."), { recursive: true });
				writeFileSync(
					join(root, "install.json"),
					JSON.stringify({ schema: 2, kind: "clio-coder-installer", current, node, launcher: launcherPath(temp) }),
					"utf8",
				);
				writeFileSync(join(root, "operator-note.txt"), "not ours\n", "utf8");
				const { code, stdout } = await runInHome(temp, () =>
					runUninstallCommand(keep ? ["--force", "--keep-binary"] : ["--force"]),
				);
				strictEqual(code, 0);
				if (keep) {
					match(stdout, /– Inactive install: .*kept by --keep-binary/u);
					ok(existsSync(current));
				} else {
					match(stdout, /✓ Inactive install: /u);
					match(stdout, /Removed the inactive install/u);
					ok(!existsSync(join(root, "versions")));
					ok(!existsSync(join(root, "runtime")));
					ok(existsSync(join(root, "operator-note.txt")), "only what the installer created goes");
				}
			} finally {
				temp.cleanup();
			}
		}
	});

	it("removes only inactive installer roots and their own launcher with --inactive", async () => {
		const temp = home();
		try {
			const root = join(temp.root, ".local", "share", "clio-coder-install");
			const current = join(root, "versions", "0.6.2");
			mkdirSync(current, { recursive: true });
			writeFileSync(
				join(root, "install.json"),
				JSON.stringify({
					schema: 2,
					kind: "clio-coder-installer",
					current,
					node: join(root, "runtime", "node-v24", "bin", "node"),
					launcher: launcherPath(temp),
				}),
				"utf8",
			);
			writeFileSync(join(root, "operator-note.txt"), "not ours\n", "utf8");
			writeFileSync(launcherPath(temp), `#!/bin/sh\n# clio-coder-installer launcher\nexec "${current}/bin/x"\n`, "utf8");
			strictEqual(
				(await runInHome(temp, () => runUninstallCommand(["--inactive", "--keep-data"]))).code,
				2,
				"--inactive already keeps the homes",
			);

			const holder = join(root, ".active");
			mkdirSync(holder);
			writeFileSync(join(holder, "1.json"), JSON.stringify({ pid: 1 }), "utf8");
			const held = await runInHome(temp, () => runUninstallCommand(["--inactive", "--force"]));
			strictEqual(held.code, 1, held.stdout);
			match(held.stdout, /pid 1 \(launched from it\) holds /u);
			ok(existsSync(current));
			rmSync(holder, { recursive: true });

			// A stopped graphical service still starts from the root, so --inactive refuses until it moves.
			const units = join(temp.root, ".config", "systemd", "user");
			mkdirSync(units, { recursive: true });
			const unit = join(units, "clio-coder-gui-0123456789ab.service");
			writeFileSync(unit, `[Service]\nExecStart="${join(current, "lib/node_modules/@iowarp/clio-coder/x.js")}"\n`);
			const background = join(temp.stateDir, "gui", "background");
			mkdirSync(background, { recursive: true });
			writeFileSync(join(background, "server.json"), JSON.stringify({ packageRoot: join(current, "lib") }));
			const stranded = await runInHome(temp, () => runUninstallCommand(["--inactive", "--force"]));
			strictEqual(stranded.code, 1, stranded.stdout);
			match(stranded.stdout, /clio-coder-gui-0123456789ab\.service starts it from\s+there/u);
			match(stranded.stdout, /server\.json starts it from there/u);
			match(stranded.stdout, /clio-coder gui background install --handover/u);
			ok(existsSync(current));
			rmSync(unit);
			rmSync(background, { recursive: true });

			const preview = await runInHome(temp, () => runUninstallCommand(["--inactive", "--dry-run"]));
			strictEqual(preview.code, 0);
			match(preview.stdout, /Inactive install: /u);
			match(preview.stdout, /Its launcher: /u);
			ok(existsSync(current));

			const { code } = await runInHome(temp, () => runUninstallCommand(["--inactive", "--force"]));
			strictEqual(code, 0);
			ok(!existsSync(join(root, "versions")));
			ok(!existsSync(join(root, "install.json")));
			ok(!existsSync(launcherPath(temp)));
			ok(existsSync(join(root, "operator-note.txt")), "only what the installer created goes");
			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.stateDir, "home.json")));
			ok(existsSync(temp.dataDir));
		} finally {
			temp.cleanup();
		}
	});

	it("stops a private pane host, removes the marked PATH block, and closes with what was kept", {
		skip: process.platform === "win32" && "private hosts and install.sh PATH blocks are POSIX",
	}, async () => {
		for (const keepBinary of [false, true]) {
			const temp = home();
			const methods: string[] = [];
			const socketPath = join(temp.root, "h.sock");
			const server = createServer((socket) => {
				let pending = "";
				socket.on("data", (chunk) => {
					pending += chunk.toString();
					if (!pending.includes("\n")) return;
					const request = JSON.parse(pending.trim());
					methods.push(request.method);
					const result = request.method === "ping" ? { version: "fixture", protocol: 21 } : {};
					socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
					if (request.method === "server.stop") server.close();
				});
			});
			try {
				await new Promise<void>((done) => server.listen(socketPath, done));
				mkdirSync(join(temp.stateDir, "mux", "abc"), { recursive: true });
				writeFileSync(join(temp.stateDir, "mux", "abc", "socket-path"), `${socketPath}\n`);
				const rc = join(temp.root, ".bashrc");
				const own = `alias c=clio-coder\n\n# added by clio-coder install.sh\nexport PATH="${temp.binDir}:$PATH"\n`;
				writeFileSync(rc, own);

				// The test reporter flushes asynchronously; capture would swallow its pending lines.
				await new Promise((done) => setTimeout(done, 50));
				const preview = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
				match(preview.stdout, /Pane host: .*h\.sock/u);
				match(preview.stdout, keepBinary ? /PATH block: / : /✓ PATH block: ~\/\.bashrc/u);
				match(preview.stdout, /Shell config: ~\/\.bashrc .*lines 1;/u, "the operator's own line is only reported");
				strictEqual(readFileSync(rc, "utf8"), own);

				const real = await runInHome(temp, () =>
					runUninstallCommand(keepBinary ? ["--force", "--keep-binary"] : ["--force"]),
				);
				strictEqual(real.code, 0, real.stdout);
				ok(methods.includes("server.stop"), "the host is asked to stop before its binary goes");
				match(real.stdout, /Stopped the pane host at /u);
				strictEqual(readFileSync(rc, "utf8"), keepBinary ? own : "alias c=clio-coder\n");
				match(real.stdout, /Removed:\n(?:.*\n)*?.*Pane host: /u);
				match(real.stdout, /Kept, and why:\n(?:.*\n)*?.*Shell config: ~\/\.bashrc/u);
				if (keepBinary) match(real.stdout, /PATH block: ~\/\.bashrc \(kept with the launcher\)/u);
			} finally {
				if (server.listening) await new Promise<void>((done) => server.close(() => done()));
				temp.cleanup();
			}
		}
	});

	it("edits a symlinked startup file at its target and keeps every other byte and its mode", {
		skip: process.platform === "win32" && "install.sh PATH blocks are POSIX",
	}, async () => {
		const temp = home();
		try {
			const target = join(temp.root, "dotfiles", "bashrc");
			mkdirSync(join(temp.root, "dotfiles"));
			const before = Buffer.concat([
				Buffer.from("# caf"),
				Buffer.from([0xe9, 0xff, 0x0d]),
				Buffer.from(`\n\n# added by clio-coder install.sh\nexport PATH="${temp.binDir}:$PATH"\n`),
			]);
			writeFileSync(target, before, { mode: 0o640 });
			chmodSync(target, 0o640);
			const rc = join(temp.root, ".bashrc");
			symlinkSync(target, rc);

			const real = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(real.code, 0, real.stdout);
			match(real.stdout, /Removed the PATH block from ~\/\.bashrc/u);
			ok(lstatSync(rc).isSymbolicLink(), "the link stays a link");
			deepStrictEqual(readFileSync(target), Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9, 0xff, 0x0d, 0x0a])]));
			strictEqual(statSync(target).mode & 0o777, 0o640);
			deepStrictEqual(readdirSync(join(temp.root, "dotfiles")), ["bashrc"], "no temporary file is left");
		} finally {
			temp.cleanup();
		}
	});

	it("keeps the PATH block while other programs share the launcher's directory", {
		skip: process.platform === "win32" && "install.sh PATH blocks are POSIX",
	}, async () => {
		const temp = home();
		try {
			mkdirSync(temp.binDir, { recursive: true });
			writeFileSync(join(temp.binDir, "pipx-tool"), "#!/bin/sh\n");
			const rc = join(temp.root, ".bashrc");
			const own = `\n# added by clio-coder install.sh\nexport PATH="${temp.binDir}:$PATH"\n`;
			writeFileSync(rc, own);

			const preview = await runInHome(temp, () => runUninstallCommand(["--dry-run"]));
			match(preview.stdout, /PATH block: ~\/\.bashrc \(other programs in .* rely on it\)/u);
			const real = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(real.code, 0, real.stdout);
			strictEqual(readFileSync(rc, "utf8"), own);
			match(real.stdout, /Kept, and why:\n(?:.*\n)*?.*PATH block: ~\/\.bashrc \(other programs in .* rely on it\)/u);
		} finally {
			temp.cleanup();
		}
	});

	it("keeps a launcher that is a real file rather than a symlink", async () => {
		const temp = home();
		try {
			writeFileSync(launcherPath(temp), "#!/bin/sh\n", "utf8");
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(code, 0);
			match(stdout, /– Launcher: .*not a symlink/u);
			ok(existsSync(launcherPath(temp)));
		} finally {
			temp.cleanup();
		}
	});

	it("names the removal command only when a launcher is actually there", async () => {
		const withLauncher = home();
		const withoutLauncher = home();
		try {
			writeFileSync(launcherPath(withLauncher), "#!/bin/sh\n", "utf8");
			const present = await runInHome(withLauncher, () => runUninstallCommand(["--dry-run"]));
			match(present.stdout, /(finish removing|remove) the launcher/u);

			// An absent launcher used to get the same "to finish removing the
			// binary, run: rm <path>" line, over a path the listing had just
			// reported as absent.
			const absent = await runInHome(withoutLauncher, () => runUninstallCommand(["--dry-run"]));
			match(absent.stdout, /– Launcher: .*\(absent\)/u);
			ok(!/the launcher/u.test(absent.stdout), `no launcher, no removal advice:\n${absent.stdout}`);
		} finally {
			withLauncher.cleanup();
			withoutLauncher.cleanup();
		}
	});

	it("prints the same launcher guidance on the dry run as on the real run", async () => {
		const preview = home();
		const real = home();
		try {
			writeFileSync(launcherPath(preview), "#!/bin/sh\n", "utf8");
			writeFileSync(launcherPath(real), "#!/bin/sh\n", "utf8");
			const previewed = await runInHome(preview, () => runUninstallCommand(["--dry-run"]));
			const executed = await runInHome(real, () => runUninstallCommand(["--force"]));

			// The old dry run appended a twenty-line "Binary removal guidance"
			// block that the real run never printed, so the preview was not the
			// run's own listing.
			const advice = /(finish removing|remove) the launcher/u;
			match(previewed.stdout, advice);
			match(executed.stdout, advice);
			ok(!/Binary removal guidance|npm prefix bin:|PATH lookup:/u.test(previewed.stdout));
		} finally {
			preview.cleanup();
			real.cleanup();
		}
	});

	it("refuses without a terminal and without --force, on stderr alone", async () => {
		const temp = home();
		const savedIsTty = process.stdin.isTTY;
		process.stdin.isTTY = false;
		try {
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand([]));
			strictEqual(code, 2);
			strictEqual(stdout, "", "a refusal must leave stdout clean for the caller parsing it");
			ok(existsSync(join(temp.configDir, "settings.yaml")), "nothing is removed on the refusal path");
		} finally {
			process.stdin.isTTY = savedIsTty;
			temp.cleanup();
		}
	});

	it("refuses overlapping ownership roots before previewing or deleting", async () => {
		const temp = home();
		try {
			temp.env.CLIO_CODER_DATA_DIR = temp.configDir;
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--force"]));
			strictEqual(code, 2);
			strictEqual(stdout, "");
			ok(existsSync(join(temp.configDir, "settings.yaml")));
			ok(existsSync(join(temp.stateDir, "home.json")));
		} finally {
			temp.cleanup();
		}
	});

	it("emits one JSON document naming every root with its status", async () => {
		const temp = home();
		try {
			const { code, stdout } = await runInHome(temp, () => runUninstallCommand(["--dry-run", "--json", "--keep-config"]));
			strictEqual(code, 0);

			const parsed = JSON.parse(stdout) as {
				command: string;
				method?: string;
				items: Array<{ label: string; path: string; status: string }>;
			};
			strictEqual(parsed.command, "uninstall");
			const byLabel = new Map(parsed.items.map((item) => [item.label, item]));
			strictEqual(byLabel.get("Config")?.status, "keep");
			strictEqual(byLabel.get("Config")?.path, temp.configDir);
			strictEqual(byLabel.get("Data")?.status, "remove");
			strictEqual(byLabel.get("State")?.path, temp.stateDir);
			strictEqual(byLabel.get("Launcher")?.status, "absent");
		} finally {
			temp.cleanup();
		}
	});

	it("treats the running installer root as active when a symlink leads to it", async () => {
		const temp = home();
		try {
			const real = join(temp.root, "real-share");
			const link = join(temp.root, "link-share");
			mkdirSync(real, { recursive: true });
			symlinkSync(real, link);
			// install.sh records the logical paths it was given; the running entry resolves to the real ones.
			const root = join(link, "clio-coder-install");
			const current = join(root, "versions", "0.6.2");
			const pkg = join(real, "clio-coder-install", "versions", "0.6.2", "lib", "node_modules", "@iowarp", "clio-coder");
			mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
			writeFileSync(join(pkg, "dist", "cli", "index.js"), "");
			writeFileSync(join(pkg, "package.json"), '{"name":"@iowarp/clio-coder","version":"0.6.2"}');
			writeFileSync(
				join(root, "install.json"),
				JSON.stringify({
					schema: 2,
					kind: "clio-coder-installer",
					current,
					node: join(root, "runtime", "node-v24", "bin", "node"),
					launcher: launcherPath(temp),
				}),
			);
			const running = inspectInstallation(
				join(current, "lib", "node_modules", "@iowarp", "clio-coder", "dist", "cli", "index.js"),
			);
			strictEqual(running.kind, "installer");
			// Even a caller that missed the manifest never calls the root it runs from inactive.
			temp.env.CLIO_CODER_INSTALL_DIR = root;
			const { installer: _installer, ...withoutManifest } = running;
			const missed = { ...withoutManifest, kind: "npm" as const };
			const { code, stdout } = await runInHome(temp, async () => {
				strictEqual(inactiveInstallerRecord(missed), null);
				strictEqual(installRootFinding(missed), null);
				return 0;
			});
			strictEqual(code, 0, stdout);
		} finally {
			temp.cleanup();
		}
	});

	it("finds a session recorded by the resolved path of a root named through a symlink", () => {
		const temp = home();
		try {
			const real = join(temp.root, "real-root");
			const link = join(temp.root, "link-root");
			mkdirSync(join(real, "versions", "0.6.2"), { recursive: true });
			symlinkSync(real, link);
			mkdirSync(join(temp.stateDir, "running-builds"), { recursive: true });
			writeFileSync(
				join(temp.stateDir, "running-builds", "4242.json"),
				JSON.stringify({ pid: 4242, host: "other-host", surface: "gui", root: join(real, "versions", "0.6.2") }),
			);
			ok(installRootHolders(link, temp.stateDir).some((holder) => holder.startsWith("pid 4242@other-host")));
		} finally {
			temp.cleanup();
		}
	});
});
