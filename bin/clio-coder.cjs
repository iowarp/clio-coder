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
