import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseReadyLine,
	reconnectDelayMs,
	remoteGuiCommand,
	type SshEndpoint,
	sshCommandArgs,
	sshForwardArgs,
	versionGate,
} from "../server/ssh-model.js";

const node: SshEndpoint = {
	id: "blade",
	host: "blade.lan",
	user: "ops",
	port: 2222,
	identityFile: "/home/me/.ssh/fleet",
	connectTimeoutSec: 4,
	clioCoderEntry: '"$HOME/.local/share/clio-coder/workers/abc/node_modules/.bin/clio-coder" worker',
};

test("the command channel is a batch, keepalive, no-terminal ssh with the node's user, port and key", () => {
	assert.deepEqual(sshCommandArgs(node, "run me"), [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=4",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-T",
		"-p",
		"2222",
		"-i",
		"/home/me/.ssh/fleet",
		"-l",
		"ops",
		"blade.lan",
		"--",
		"run me",
	]);
	assert.deepEqual(sshCommandArgs({ id: "mini", host: "mini" }, "x").slice(0, 4), [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
	]);
	assert.deepEqual(sshCommandArgs({ id: "mini", host: "mini", user: "", port: null }, "x").slice(-3), [
		"mini",
		"--",
		"x",
	]);
	assert.throws(() => sshCommandArgs({ id: "bad", host: "-oProxyCommand=x" }, "x"), /usable SSH host/);
});

test("the forward runs no command, fails on a refused forward and never uses a mux master", () => {
	assert.deepEqual(sshForwardArgs(node, 40001, 38211), [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=4",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-N",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ControlMaster=no",
		"-o",
		"ControlPath=none",
		"-o",
		"PermitLocalCommand=yes",
		"-o",
		"LocalCommand=echo clio-coder-forward-held",
		"-L",
		"127.0.0.1:40001:127.0.0.1:38211",
		"-p",
		"2222",
		"-i",
		"/home/me/.ssh/fleet",
		"-l",
		"ops",
		"blade.lan",
	]);
	assert.throws(() => sshForwardArgs(node, 0, 38211), /Local forward port/);
	assert.throws(() => sshForwardArgs(node, 40001, 70000), /Remote GUI port/);
});

test("the remote GUI command comes from the installed worker entry, else the clio-coder on the node's PATH", () => {
	const flags = "gui --foreground --port 0 --no-open --idle-exit 600000 --token-stdin";
	assert.equal(
		remoteGuiCommand(node.clioCoderEntry),
		`"$HOME/.local/share/clio-coder/workers/abc/node_modules/.bin/clio-coder" ${flags}`,
	);
	assert.equal(remoteGuiCommand(undefined), `clio-coder ${flags}`);
	assert.equal(remoteGuiCommand("  "), `clio-coder ${flags}`);
	assert.equal(
		remoteGuiCommand("/opt/clio/bin/clio-coder", 5000),
		"/opt/clio/bin/clio-coder gui --foreground --port 0 --no-open --idle-exit 5000 --token-stdin",
	);
	assert.throws(() => remoteGuiCommand(null, 0), /positive/);
});

test("the ready line yields the port with or without a launch fragment and nothing else does", () => {
	assert.equal(parseReadyLine("[clio-coder:gui] http://127.0.0.1:38211/"), 38211);
	assert.equal(parseReadyLine("[clio-coder:gui] http://127.0.0.1:38211/#ticket=abc\n"), 38211);
	assert.equal(parseReadyLine("[clio-coder:gui] http://127.0.0.1:38211/sessions"), 38211);
	assert.equal(parseReadyLine("[clio-coder:gui] Background app ready at http://127.0.0.1:4343."), null);
	assert.equal(parseReadyLine("[clio-coder:gui] http://10.0.0.5:38211/"), null);
	assert.equal(parseReadyLine("[clio-coder:gui] http://127.0.0.1:0/"), null);
	assert.equal(parseReadyLine("Clio Coder runs while this terminal stays open."), null);
});

test("the version gate refuses a different package version or a different known build and names the install", () => {
	assert.deepEqual(versionGate("blade", { clio: "0.6.7", build: "b1" }, { clio: "0.6.7", build: "b1" }), { ok: true });
	assert.deepEqual(versionGate("blade", { clio: "0.6.7", build: null }, { clio: "0.6.7", build: "b1" }), { ok: true });
	assert.deepEqual(versionGate("blade", { clio: "0.6.7", build: "b1" }, { clio: "0.6.7", build: null }), { ok: true });
	const version = versionGate("blade", { clio: "0.6.7-dev", build: "b1" }, { clio: "0.6.6", build: "b1" });
	assert.equal(version.ok, false);
	assert.match(version.ok ? "" : version.detail, /0\.6\.6 and this app is 0\.6\.7-dev/);
	assert.match(version.ok ? "" : version.detail, /clio-coder fleet nodes install blade --yes$/);
	const build = versionGate("blade", { clio: "0.6.7-dev", build: "b1" }, { clio: "0.6.7-dev", build: "b2" });
	assert.equal(build.ok, false);
	assert.match(build.ok ? "" : build.detail, /different build of Clio Coder 0\.6\.7-dev \(b2, this app is b1\)/);
	assert.match(build.ok ? "" : build.detail, /clio-coder fleet nodes install blade --yes$/);
});

test("reconnects back off from one second, double, and stop after the fifth failure", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 0].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 16000, null, null]);
});
