/**
 * Package-manager launches (npm, pnpm, npx). On Windows these are `.cmd`
 * shims, which CreateProcess cannot run and Node refuses to spawn without a
 * shell since its 2024 batch-file fix. They go through `cmd.exe /d /s /c`
 * instead, and only with arguments cmd.exe cannot reinterpret, so no quoting
 * is needed and nothing in an argument becomes a second command.
 */
const SAFE_CMD_ARG = /^[A-Za-z0-9@._+=:/\\,-]+$/u;

export function packageManagerLaunch(
	command: "npm" | "pnpm" | "npx",
	args: ReadonlyArray<string>,
	platform: NodeJS.Platform = process.platform,
	comSpec: string | undefined = process.env.ComSpec,
): { file: string; args: string[] } {
	if (platform !== "win32") return { file: command, args: [...args] };
	for (const arg of args)
		if (!SAFE_CMD_ARG.test(arg))
			throw new Error(`Refusing to pass ${JSON.stringify(arg)} to ${command}.cmd through cmd.exe`);
	return { file: comSpec || "cmd.exe", args: ["/d", "/s", "/c", `${command}.cmd`, ...args] };
}
