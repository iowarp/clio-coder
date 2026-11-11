import { deepStrictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { packageManagerLaunch } from "../../src/core/self-update.js";
import { fleetPackLaunch } from "../../src/domains/dispatch/fleet-node-install.js";
import { pnpmAddLaunch } from "../../src/domains/lifecycle/deferred-update.js";

describe("packageManagerLaunch", () => {
	it("runs pnpm directly off Windows", () => {
		deepStrictEqual(packageManagerLaunch("pnpm", ["run", "build"], "linux"), { file: "pnpm", args: ["run", "build"] });
	});

	it("runs the cmd shim through cmd.exe on Windows", () => {
		deepStrictEqual(packageManagerLaunch("pnpm", ["run", "build"], "win32", "C:\\Windows\\system32\\cmd.exe"), {
			file: "C:\\Windows\\system32\\cmd.exe",
			args: ["/d", "/s", "/c", "pnpm.cmd", "run", "build"],
		});
		deepStrictEqual(packageManagerLaunch("npm", ["pack", "--json"], "win32", undefined).file, "cmd.exe");
	});

	it("packs fleet installs through the npm shim without passing the destination path", () => {
		deepStrictEqual(fleetPackLaunch("C:\\src\\clio", "C:\\Users\\A B\\cache\\fleet-install-x", "win32"), {
			file: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c", "npm.cmd", "pack", "..\\..\\..\\..\\src\\clio", "--ignore-scripts", "--json"],
			cwd: "C:\\Users\\A B\\cache\\fleet-install-x",
		});
		deepStrictEqual(fleetPackLaunch("/r", "/d", "linux"), {
			file: "npm",
			args: ["pack", "--ignore-scripts", "--json", "--pack-destination", "/d"],
			cwd: "/r",
		});
	});

	it("runs a bare pnpm through the cmd shim in deferred updates", () => {
		deepStrictEqual(pnpmAddLaunch("C:\\pnpm\\pnpm", "@iowarp/clio-coder@1.2.3", "win32").args, [
			"/d",
			"/s",
			"/c",
			"pnpm.cmd",
			"add",
			"-g",
			"@iowarp/clio-coder@1.2.3",
		]);
		deepStrictEqual(pnpmAddLaunch("/bin/pnpm", "x@1", "linux"), { file: "/bin/pnpm", args: ["add", "-g", "x@1"] });
	});

	it("refuses arguments cmd.exe would reinterpret", () => {
		for (const arg of ["a&calc", "x|y", "%PATH%", 'q"', "has space", "a^b"])
			throws(() => packageManagerLaunch("npm", ["install", arg], "win32"), /Refusing/);
	});
});
