#!/usr/bin/env node
/*
 * The package's command. It checks the running Node before the ESM graph in
 * dist/ is linked: on an older Node that graph fails to link (a named
 * `globSync` import from node:fs, `node:sqlite`) with an error that names
 * neither Node nor a fix, so the friendly check inside dist/cli/index.js never
 * ran there (#408). This file must therefore parse and run on any Node: plain
 * CommonJS, ES5 syntax, nothing imported from dist/ until the check passes.
 *
 * CLIO_CODER_NODE names another Node binary to run Clio under, for a host whose
 * default `node` is too old and cannot be changed (a cluster login node).
 */
"use strict";

var MIN_NODE = [22, 19, 0];
var INSTALLER = "curl -fsSL https://coder.iowarp.ai/install.sh | sh";
var REEXEC_MARK = "CLIO_CODER_NODE_GUARD";

function parseVersion(text) {
	var parts = String(text).replace(/^v/, "").split(".");
	var out = [];
	for (var i = 0; i < 3; i += 1) {
		var n = parseInt(parts[i], 10);
		out.push(isNaN(n) ? 0 : n);
	}
	return out;
}

/** True when `version` (such as "22.19.0" or "v24.1.0") is at least `min`. */
function isSupportedNode(version, min) {
	var have = parseVersion(version);
	var want = min || MIN_NODE;
	for (var i = 0; i < 3; i += 1) {
		if (have[i] > want[i]) return true;
		if (have[i] < want[i]) return false;
	}
	return true;
}

function glibcVersion() {
	try {
		var report = process.report && process.report.getReport ? process.report.getReport() : null;
		var header = report && (typeof report === "string" ? JSON.parse(report).header : report.header);
		return (header && header.glibcVersionRuntime) || null;
	} catch (_error) {
		// Diagnostic reports are optional; the advice still reads without the glibc line.
		return null;
	}
}

function tooOldAdvice(version) {
	var lines = [
		"clio-coder requires Node.js >=" + MIN_NODE.join(".") + "; this is " + version + " (" + process.execPath + ").",
		"Install Clio with its own Node, no root needed:",
		"  " + INSTALLER,
		"Or point Clio at a newer Node you already have:",
		"  export CLIO_CODER_NODE=/path/to/node22-or-newer/bin/node",
	];
	var glibc = process.platform === "linux" ? glibcVersion() : null;
	if (glibc && !isSupportedNode(glibc, [2, 28, 0])) {
		lines.push(
			"This system has glibc " +
				glibc +
				"; official Node 22+ builds need glibc 2.28. The installer picks the unofficial glibc-2.17 build on x64, and conda-forge nodejs also works.",
		);
	} else {
		lines.push("Other user-space options: nvm, fnm, or conda-forge nodejs; then reinstall with that Node's npm.");
	}
	return lines.join("\n");
}

function runUnder(nodePath, entryArgs) {
	var spawn = require("child_process").spawn;
	var env = {};
	for (var key in process.env) env[key] = process.env[key];
	env[REEXEC_MARK] = "1";
	var child = spawn(nodePath, entryArgs, { stdio: "inherit", env: env });
	// The terminal delivers Ctrl+C to both processes; the child decides what it means.
	process.on("SIGINT", function () {});
	["SIGTERM", "SIGHUP"].forEach(function (signal) {
		process.on(signal, function () {
			child.kill(signal);
		});
	});
	child.on("error", function (error) {
		process.stderr.write("clio-coder: could not run CLIO_CODER_NODE=" + nodePath + ": " + error.message + "\n");
		process.exit(1);
	});
	child.on("exit", function (code, signal) {
		if (signal) {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code === null ? 1 : code);
	});
}

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
	if (!(typeof pid === "number" && pid > 0 && pid % 1 === 0 && pid <= 9007199254740991)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/* Same host id as the update wrapper: machine-id, else the host name. */
function hostId(fs) {
	var files = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
	for (var i = 0; i < files.length; i += 1) {
		try {
			var value = fs.readFileSync(files[i], "utf8").trim();
			if (value) return value + ":" + require("os").hostname();
		} catch (_error) {
			/* not on this platform */
		}
	}
	return require("os").hostname();
}

/* Linux start time of a pid, so a reused pid does not pass for its predecessor. */
function birthToken(fs, pid) {
	try {
		var stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
	} catch (_error) {
		return null;
	}
}

/*
 * True for the global layouts a deferred update can replace: npm and volta
 * (lib/node_modules), bun (install/global/node_modules) and pnpm
 * (global/<n>/.pnpm). npx caches and project-local node_modules never are.
 */
function updatableRoot(path, root) {
	var parts = root.split(path.sep);
	if (parts.indexOf("_npx") !== -1) return false;
	var modules = path.dirname(path.dirname(root));
	if (path.basename(path.dirname(root)) !== "@iowarp" || path.basename(modules) !== "node_modules") return false;
	var above = path.basename(path.dirname(modules));
	if (above === "lib") return true;
	if (above === "global" && path.basename(path.dirname(path.dirname(modules))) === "install") return true;
	var pnpm = parts.indexOf(".pnpm");
	return pnpm > 1 && /^\d+$/.test(parts[pnpm - 1]) && parts[pnpm - 2] === "global";
}

/*
 * A package-manager install is replaced in place after a session quits, by a
 * detached wrapper that waits until no Clio of this install runs (#436). A
 * launch registers itself so that wrapper waits for it, and waits while the
 * wrapper's lease is live so it never links half-replaced files. The common
 * case costs one stat; source checkouts, native installs, npx and
 * project-local copies skip all of it. Returns false to stop.
 */
/* The wrapper's result counts only when written by this run: the path is fixed per install. */
function resultSince(fs, lease) {
	if (!lease.result) return false;
	try {
		var result = JSON.parse(fs.readFileSync(String(lease.result), "utf8"));
		return Number(result.at) >= Number(lease.startedAt);
	} catch (_error) {
		return false;
	}
}

function holdInstall(path) {
	var fs = require("fs");
	var root = path.dirname(__dirname);
	if (!updatableRoot(path, root)) return true;
	var hold = path.dirname(path.dirname(root));
	var marker = path.join(hold, ".clio-coder-update.json");
	var present = false;
	try {
		fs.statSync(marker);
		present = true;
	} catch (_error) {
		present = false;
	}
	var host = hostId(fs);
	var active = path.join(hold, ".clio-coder-active");
	var self = path.join(active, String(process.pid));
	try {
		fs.mkdirSync(active, { recursive: true });
		fs.writeFileSync(
			self,
			JSON.stringify({
				host: host,
				hostname: require("os").hostname(),
				birth: birthToken(fs, process.pid),
				startedAt: Date.now(),
			}) + "\n",
		);
		process.on("exit", function () {
			try {
				fs.unlinkSync(self);
			} catch (_error) {
				/* already gone */
			}
		});
		// The heartbeat lets a wrapper on another host tell a live session on a
		// shared home from one that crashed with its machine.
		setInterval(
			function () {
				try {
					var now = new Date();
					fs.utimesSync(self, now, now);
				} catch (_error) {
					/* removed by a wrapper that judged it stale; nothing to do */
				}
			},
			5 * 60 * 1000,
		).unref();
	} catch (_error) {
		/* A read-only prefix never gets a deferred update, so nothing waits on this file. */
	}
	// A wrapper that staked its lease between the first stat and the
	// registration above has not seen this process; look once more.
	if (!present) {
		try {
			fs.statSync(marker);
			present = true;
		} catch (_error) {
			return true;
		}
	}
	var lease = null;
	try {
		lease = JSON.parse(fs.readFileSync(marker, "utf8"));
	} catch (_error) {
		lease = null;
	}
	if (!lease || typeof lease.pid !== "number") {
		// A stake that died between create and write: hold until the cap by
		// the file's own time, then clear it so updates can run again.
		var mtime = 0;
		try {
			mtime = fs.statSync(marker).mtimeMs;
		} catch (_error) {
			return true;
		}
		if (Date.now() - mtime > 30 * 60 * 1000) {
			try {
				fs.unlinkSync(marker);
			} catch (_error) {
				/* another launch removed it */
			}
			return true;
		}
		lease = { pid: -1, host: "", hostname: "an unreadable lease", startedAt: mtime, manager: "unknown" };
	}
	// A lease from this host is judged by its pid and birth token. One from
	// another host on a shared home is held until the 30 min cap: its pid means
	// nothing here, and deleting it would load a half-replaced dist.
	var leaseAlive = function () {
		var age = Date.now() - Number(lease.startedAt);
		if (!(age < 30 * 60 * 1000)) return false;
		if (lease.pid === -1) return fs.existsSync(marker);
		// A foreign lease dated more than five minutes ahead is skewed or planted.
		if (lease.host !== host) return age > -5 * 60 * 1000;
		if (!processAlive(Number(lease.pid))) return false;
		var born = birthToken(fs, Number(lease.pid));
		return !lease.birth || born === null || born === lease.birth;
	};
	if (!leaseAlive()) {
		try {
			fs.unlinkSync(marker);
		} catch (_error) {
			/* another launch removed it */
		}
		return true;
	}
	var where = lease.host === host ? "" : " on " + String(lease.hostname || "another host");
	process.stderr.write("Clio Coder is updating (" + String(lease.manager) + where + "); waiting…\n");
	var deadline = Date.now() + 120 * 1000;
	while (Date.now() < deadline) {
		if (!fs.existsSync(marker) || resultSince(fs, lease)) return true;
		if (!leaseAlive()) return true;
		sleepMs(250);
	}
	process.stderr.write("clio-coder: the update is still running after 120 s; see " + String(lease.log) + "\n");
	process.exitCode = 75;
	return false;
}

function main() {
	var path = require("path");
	var entry = path.join(__dirname, "..", "dist", "cli", "index.js");
	var override = process.env.CLIO_CODER_NODE;
	if (override && !process.env[REEXEC_MARK] && path.resolve(override) !== process.execPath) {
		runUnder(override, [__filename].concat(process.argv.slice(2)));
		return;
	}
	if (!isSupportedNode(process.versions.node, MIN_NODE)) {
		process.stderr.write(tooOldAdvice(process.versions.node) + "\n");
		process.exitCode = 1;
		return;
	}
	if (!holdInstall(path)) return;
	// dist/cli/index.js and install-method detection read argv[1] as the entry.
	process.argv[1] = entry;
	var url = require("url").pathToFileURL(entry).href;
	// Written through Function so that a Node too old to parse import() still
	// reaches the advice above instead of a SyntaxError.
	new Function("u", "return import(u)")(url).catch(function (error) {
		process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
		process.exitCode = 1;
	});
}

module.exports = { isSupportedNode: isSupportedNode, MIN_NODE: MIN_NODE };

if (require.main === module) main();
