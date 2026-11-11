import { deepStrictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { packageManagerLaunch } from "../../src/core/self-update.js";

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

	it("refuses arguments cmd.exe would reinterpret", () => {
		for (const arg of ["a&calc", "x|y", "%PATH%", 'q"', "has space", "a^b"])
			throws(() => packageManagerLaunch("npm", ["install", arg], "win32"), /Refusing/);
	});
});
