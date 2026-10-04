"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
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
	const rel = path.relative(root, file);
	return (
		path.isAbsolute(file) && rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)
	);
}

function record(root) {
	const file = path.join(root, "install.json");
	if (!fs.existsSync(file)) return null;
	const value = JSON.parse(fs.readFileSync(file, "utf8"));
	if (![1, 2].includes(value.schema)) throw new Error(`Unsupported installer schema in ${file}`);
	if (
		value.kind !== "clio-coder-installer" ||
		!inside(path.join(root, "versions"), value.current) ||
		!inside(path.join(root, "runtime"), value.node)
	)
		throw new Error(`Invalid installer ownership: ${file}`);
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

function check(node, prefix, postInstall, echo = true) {
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

async function main() {
	const [action, root, ...args] = process.argv.slice(2);
	if (action === "launch") {
		const current = record(root);
		if (!current) throw new Error(`No installer manifest in ${root}`);
		const removing = path.join(root, ".install-lock", "uninstall");
		if (fs.existsSync(removing)) throw new Error("Uninstall is in progress; retry after it exits");
		const active = path.join(root, ".active");
		fs.mkdirSync(active, { recursive: true });
		const receipt = path.join(active, `${process.pid}.json`);
		atomic(receipt, JSON.stringify({ pid: process.pid, current: current.current, node: current.node }));
		process.on("exit", () => {
			try {
				fs.rmSync(receipt, { force: true });
			} catch {
				/* Uninstall may already have removed the receipt. */
			}
		});
		if (fs.existsSync(removing)) throw new Error("Uninstall is in progress; retry after it exits");
		const cli = entry(current.current);
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
	process.stdout.write(
		`[install] background updates ${autoUpdate === "1" && (!pin || pin === "-") ? "enabled" : "disabled"}${pin && pin !== "-" ? `; pinned ${pin}` : ""}; previous versions retained for running sessions\n`,
	);
}

main().catch((error) => {
	process.stderr.write(`[install] ${error.message}\n`);
	process.exitCode = 1;
});
