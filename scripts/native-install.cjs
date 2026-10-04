"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
const os = require("node:os");
const MARK = "# clio-coder-installer launcher";

function atomic(file, text, mode = 0o600) {
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, text, { mode });
		// Windows FlushFileBuffers needs a writable handle; a read-only one fails with EPERM.
		const fd = fs.openSync(temp, process.platform === "win32" ? "r+" : "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

function inside(root, file) {
	if (typeof file !== "string" || !path.isAbsolute(file)) return false;
	const rel = path.relative(root, file);
	return (
		path.isAbsolute(file) && rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)
	);
}

function record(root) {
	const file = path.join(root, "install.json");
	if (!fs.existsSync(file)) return null;
	let value;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`Invalid installer manifest JSON: ${file}`);
	}
	if (
		!value ||
		typeof value !== "object" ||
		["node", "current", "launcher"].some((name) => typeof value[name] !== "string" || !path.isAbsolute(value[name]))
	)
		throw new Error(`Incomplete installer manifest: ${file}; expected absolute node, current and launcher paths`);
	if (![1, 2].includes(value.schema)) throw new Error(`Unsupported installer schema in ${file}`);
	if (
		value.kind !== "clio-coder-installer" ||
		!inside(path.join(root, "versions"), value.current) ||
		!inside(path.join(root, "runtime"), value.node)
	)
		throw new Error(`Invalid installer ownership: ${file}`);
	if (value.desktopManager && !inside(path.join(root, "versions"), value.desktopManager))
		throw new Error("Desktop manager is outside owned versions");
	if (value.previous && !inside(path.join(root, "versions"), value.previous))
		throw new Error("Previous package is outside owned versions");
	for (const name of ["previousNode", "launcherNode"])
		if (value[name] && !inside(path.join(root, "runtime"), value[name]))
			throw new Error(`${name} is outside owned runtime`);
	return value;
}

function entry(prefix) {
	return path.join(prefix, "lib", "node_modules", "@iowarp", "clio-coder", "dist", "cli", "index.js");
}

function packageVersion(prefix) {
	try {
		const file = path.join(prefix, "lib", "node_modules", "@iowarp", "clio-coder", "package.json");
		return String(JSON.parse(fs.readFileSync(file, "utf8")).version || "");
	} catch {
		// A prefix without readable metadata is still named by its path in messages.
		return "";
	}
}

function checkCandidate(node, prefix, postInstall, echo = true) {
	for (const args of [[entry(prefix), "--version"], ...(postInstall ? [[entry(prefix), "doctor", "--json"]] : [])]) {
		const result = spawnSync(node, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
		if (
			(result.status !== 0 && !(args[1] === "doctor" && result.status === 1)) ||
			(args[1] === "--version" && !result.stdout.trim())
		)
			throw new Error(
				`Candidate check failed (${result.status}): ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
			);
		if (args[1] === "doctor") {
			let report;
			try {
				report = JSON.parse(result.stdout);
			} catch {
				throw new Error(
					`Candidate doctor did not return its JSON report:\n${(result.stdout || result.stderr || "").trim().slice(0, 2000)}`,
				);
			}
			const integrity = new Set([
				"engine runtime",
				"installation files",
				"directory layout",
				"config dir",
				"data dir",
				"state dir",
				"cache dir",
				"settings.yaml",
			]);
			const failures = report.findings.filter((finding) => {
				const initializable = /^(config|data|state|cache) dir$/.test(finding.name) || finding.name === "settings.yaml";
				const missing = initializable && /(?:^missing| missing) \(run /u.test(finding.detail);
				return !finding.ok && integrity.has(finding.name) && !missing;
			});
			if (failures.length) throw new Error(failures.map((finding) => `${finding.name}: ${finding.detail}`).join("\n"));
		} else if (echo) process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	}
}

function check(node, prefix, postInstall, echo = true) {
	try {
		checkCandidate(node, prefix, postInstall, echo);
	} catch (error) {
		// Older candidates can embed destructive reset advice in validation errors.
		const detail = (error instanceof Error ? error.message : String(error)).replace(
			/clio-coder reset[^`\r\n]*/g,
			"clio-coder doctor --fix",
		);
		const quote = (value) =>
			process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
		const repair = `${process.platform === "win32" ? "& " : ""}${quote(node)} ${quote(entry(prefix))} doctor --fix`;
		throw new Error(
			`${detail}\nThe previous installation remains active, and it may predate this repair. Run the new version's own repair, then retry the installer: ${repair}`,
		);
	}
}

// Collection requires a complete local process inventory. Unknown platforms, permissions or
// receipts retain everything. Keep current and rollback unconditionally, and ordinary versions
// for at least seven days. Refused candidates can be reclaimed sooner, but may run doctor.
function pruneVersions(root) {
	if (process.platform !== "linux") return;
	// A local process inventory cannot prove inactivity on another host sharing this filesystem.
	const localFilesystems = new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x794c7630, 0x2fc12fc1, 0xf2f52010]);
	try {
		if (!localFilesystems.has(fs.statfsSync(root).type)) return;
	} catch {
		return;
	}
	const installed = record(root);
	const versions = path.join(root, "versions");
	const keep = new Set([installed?.current, installed?.previous, installed?.desktopManager]);
	const protect = (text) => {
		for (const candidate of fs.readdirSync(versions)) {
			const prefix = path.join(versions, candidate);
			if (text.includes(prefix + path.sep) || text === prefix) keep.add(prefix);
		}
	};
	try {
		const home = os.homedir();
		const state =
			process.env.CLIO_CODER_STATE_DIR ||
			(process.env.CLIO_CODER_HOME
				? path.join(process.env.CLIO_CODER_HOME, "state")
				: path.join(process.env.XDG_STATE_HOME || path.join(home, ".local/state"), "clio-coder"));
		const background = path.join(state, "gui/background/server.json");
		if (fs.existsSync(background)) protect(fs.readFileSync(background, "utf8"));
		const units = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd/user");
		for (const unit of fs.existsSync(units) ? fs.readdirSync(units) : []) {
			if (/^clio-coder-gui-.*\.service$/.test(unit)) protect(fs.readFileSync(path.join(units, unit), "utf8"));
		}
		const receipts = path.join(root, ".active");
		for (const file of fs.existsSync(receipts) ? fs.readdirSync(receipts) : []) {
			const receipt = JSON.parse(fs.readFileSync(path.join(receipts, file), "utf8"));
			if (!Number.isInteger(receipt.pid) || receipt.pid <= 0 || typeof receipt.current !== "string") return;
			if (receipt.host !== os.hostname()) {
				protect(receipt.current);
				continue;
			}
			try {
				process.kill(receipt.pid, 0);
				protect(receipt.current);
			} catch (error) {
				if (error.code !== "ESRCH") return;
			}
		}
		for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
			try {
				if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
				const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
				protect(command);
				if (/(?:^|\/)node(?:\0|$)|clio-coder/.test(command.split("\0")[0])) protect(fs.readlinkSync(`/proc/${pid}/cwd`));
			} catch (error) {
				if (error.code !== "ENOENT" && error.code !== "ESRCH") return;
			}
		}
		for (const name of fs.readdirSync(versions)) {
			const prefix = path.join(versions, name);
			const info = fs.lstatSync(prefix);
			if (name.startsWith(".") || !info.isDirectory() || keep.has(prefix)) continue;
			const refused = fs.existsSync(path.join(prefix, ".clio-coder-refused-candidate"));
			if (!refused && Date.now() - info.mtimeMs < 7 * 24 * 60 * 60 * 1000) continue;
			const pkg = JSON.parse(
				fs.readFileSync(path.join(prefix, "lib/node_modules/@iowarp/clio-coder/package.json"), "utf8"),
			);
			if (pkg.name !== "@iowarp/clio-coder") continue;
			fs.rmSync(prefix, { recursive: true });
			process.stdout.write(`[install] removed unused version ${name}\n`);
		}
	} catch (error) {
		process.stderr.write(`[install] retained older versions: ${error.message}\n`);
	}
}

async function main() {
	const [action, root, ...args] = process.argv.slice(2);
	if (action === "launch") {
		let current = record(root);
		if (!current) throw new Error(`No installer manifest in ${root}`);
		for (const file of [current.node, current.launcher, entry(current.current)]) {
			try {
				if (!fs.statSync(file).isFile()) throw new Error("not a file");
			} catch {
				throw new Error(
					`Incomplete managed installation: missing file ${file}; rerun the installer with the same install and bin directories`,
				);
			}
		}
		const removing = path.join(root, ".install-lock", "uninstall");
		if (fs.existsSync(removing)) throw new Error("Uninstall is in progress; retry after it exits");
		const active = path.join(root, ".active");
		fs.mkdirSync(active, { recursive: true });
		const receipt = path.join(active, `${process.pid}.json`);
		// Publish before importing, then recheck activation. A launcher paused across upgrades
		// must follow the new manifest rather than importing a prefix collection just removed.
		for (;;) {
			atomic(
				receipt,
				JSON.stringify({ pid: process.pid, host: os.hostname(), current: current.current, node: current.node }),
			);
			const latest = record(root);
			if (latest.current === current.current && latest.node === current.node) break;
			current = latest;
		}
		process.on("exit", () => {
			try {
				fs.rmSync(receipt, { force: true });
			} catch {
				/* Uninstall may already have removed the receipt. */
			}
		});
		if (fs.existsSync(removing)) throw new Error("Uninstall is in progress; retry after it exits");
		let cli = entry(current.current);
		// The installed desktop host stays capable across rollback to an older CLI. It launches
		// the activated server, but keeps the owned Windows profile and error handling introduced here.
		if (current.desktopManager && args[0] === "gui" && (args[1] === "background" || args.length === 1)) {
			const manager = path.join(current.desktopManager, "lib/node_modules/@iowarp/clio-coder/dist/gui/server.js");
			const managerArgs = args[1] === "background" ? ["managed-background", ...args.slice(2)] : [];
			const result = spawnSync(current.node, [manager, ...managerArgs], {
				stdio: "inherit",
				env: {
					...process.env,
					CLIO_CODER_PACKAGE_ROOT: path.dirname(path.dirname(path.dirname(cli))),
					CLIO_CODER_DESKTOP_NODE: current.node,
				},
			});
			if (result.error) throw result.error;
			process.exitCode = result.status ?? 1;
			return;
		}
		// Cleanup must understand desktop state written by the newer installer even after rollback.
		if (current.desktopManager && args[0] === "uninstall") cli = entry(current.desktopManager);
		process.argv = [current.node, cli, ...args];
		if (path.resolve(current.node) === path.resolve(process.execPath)) {
			await import(pathToFileURL(cli).href);
		} else {
			const result = spawnSync(current.node, [cli, ...args], {
				stdio: "inherit",
				env: { ...process.env, CLIO_CODER_LAUNCHER_PID: String(process.pid) },
			});
			if (result.error) throw result.error;
			process.exitCode = result.status ?? 1;
		}
		return;
	}
	if (action === "prune") {
		pruneVersions(root);
		return;
	}
	const old = record(root);
	if (action === "path-added") {
		if (!old || args[0] !== path.dirname(old.launcher)) throw new Error("PATH receipt does not match owned launcher");
		atomic(
			path.join(root, "install.json"),
			`${JSON.stringify({ ...old, pathAdded: true, pathEntry: args[0] }, null, 2)}\n`,
		);
		return;
	}
	if (action === "rollback") {
		if (!old?.previous || !inside(path.join(root, "versions"), old.previous))
			throw new Error("No owned previous install available");
		const node = old.previousNode || old.node;
		check(node, old.previous, false, false);
		const restored = packageVersion(old.previous) || old.previous;
		const replaced = packageVersion(old.current) || old.current;
		// A pin follows the operator to the version they rolled back to. Left on the
		// replaced version, the next upgrade or installer run reinstalled exactly it.
		const pin = old.versionPin ? packageVersion(old.previous) || old.versionPin : "";
		atomic(
			path.join(root, "install.json"),
			`${JSON.stringify(
				{
					...old,
					node,
					nodeVersion: old.previousNodeVersion || old.nodeVersion,
					nodeBuild: old.previousNodeBuild || old.nodeBuild,
					current: old.previous,
					previous: old.current,
					previousNode: old.node,
					previousNodeVersion: old.nodeVersion,
					previousNodeBuild: old.nodeBuild,
					versionPin: pin,
					autoUpdate: false,
				},
				null,
				2,
			)}\n`,
		);
		process.stdout.write(
			`[install] rolled back to ${restored}; ${replaced} stays installed and another rollback returns to it\n` +
				`[install] background updates disabled until explicitly enabled${pin ? `; pinned ${pin}` : ""}\n`,
		);
		return;
	}
	if (action !== "activate") throw new Error(`Unknown installer action ${action}`);
	let [node, nodeVersion, nodeBuild, current, launcher, channel, pin, autoUpdate, postInstall] = args;
	if (process.env.CLIO_CODER_BACKGROUND_UPDATE === "1") {
		if (
			old?.current !== process.env.CLIO_CODER_BACKGROUND_CURRENT ||
			!old?.autoUpdate ||
			old.versionPin ||
			old.channel !== channel ||
			process.env.CLIO_CODER_AUTO_UPDATE === "0"
		)
			throw new Error("Background update policy changed; candidate not activated");
		pin = "-";
		autoUpdate = "1";
		postInstall = "0";
	}
	if (autoUpdate === "preserve") autoUpdate = old?.autoUpdate === false ? "0" : "1";
	if (!inside(path.join(root, "versions"), current) || !inside(path.join(root, "runtime"), node))
		throw new Error("Candidate is outside owned install directories");
	if (process.platform === "win32" && /[%\r\n"]/u.test([node, old?.launcherNode, old?.node, root, launcher].join("")))
		throw new Error("Windows installer paths cannot contain percent, newline or quote characters");
	pruneVersions(root);
	check(node, current, postInstall === "1");
	// Activation has one commit point: launchers read this manifest on each invocation.
	const helper = fs.readFileSync(__filename, "utf8");
	const helpers = path.join(root, "launchers");
	fs.mkdirSync(helpers, { recursive: true });
	const bootstrap = path.join(helpers, `${crypto.createHash("sha256").update(helper).digest("hex")}.cjs`);
	if (!fs.existsSync(bootstrap)) atomic(bootstrap, helper);
	const launcherNode = old?.launcherNode || old?.node || node;
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const body =
		process.platform === "win32"
			? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "CLIO_CODER_LAUNCHER_CP=%%C"\r\nchcp 65001 >nul\r\nrem ${MARK}\r\n"${launcherNode}" "${bootstrap}" launch "${root}" %*\r\nset "CLIO_CODER_LAUNCHER_EXIT=%errorlevel%"\r\nchcp %CLIO_CODER_LAUNCHER_CP% >nul\r\nexit /b %CLIO_CODER_LAUNCHER_EXIT%\r\n`
			: `#!/bin/sh\n${MARK}\nexec ${quote(launcherNode)} ${quote(bootstrap)} launch ${quote(root)} "$@"\n`;
	if (process.platform === "win32" && /[%\r\n"]/u.test(launcherNode + bootstrap + root + launcher))
		throw new Error("Windows installer paths cannot contain percent, newline or quote characters");
	fs.mkdirSync(path.dirname(launcher), { recursive: true });
	atomic(launcher, body, 0o755);
	atomic(
		path.join(root, "install.json"),
		`${JSON.stringify(
			{
				schema: 2,
				kind: "clio-coder-installer",
				node,
				nodeVersion,
				nodeBuild,
				current,
				desktopManager: current,
				previous: old?.current || "",
				previousNode: old?.node || "",
				previousNodeVersion: old?.nodeVersion || "",
				previousNodeBuild: old?.nodeBuild || "",
				launcher,
				launcherNode,
				channel,
				manager: process.env.CLIO_CODER_INSTALL_MANAGER || old?.manager || "",
				pathAdded: old?.pathAdded === true,
				pathEntry: old?.pathEntry || "",
				versionPin: pin === "-" ? "" : pin,
				autoUpdate: autoUpdate === "1" && (!pin || pin === "-"),
				installedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
	);
	pruneVersions(root);
	process.stdout.write(
		`[install] background updates ${autoUpdate === "1" && (!pin || pin === "-") ? "enabled" : "disabled"}${pin && pin !== "-" ? `; pinned ${pin}` : ""}${old ? "; previous version retained for rollback and running sessions" : ""}\n`,
	);
}

main().catch((error) => {
	process.stderr.write(`[install] ${error.message}\n`);
	process.exitCode = 1;
});
