import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export type SubprocessWithStdio = ChildProcessByStdio<null, Readable, Readable>;

export async function readStderr(child: { stderr: Readable }): Promise<string> {
	let stderr = "";
	for await (const chunk of child.stderr) {
		stderr += String(chunk);
		if (stderr.length > 8192) stderr = stderr.slice(-8192);
	}
	return stderr;
}

export function waitForClose(child: {
	once(event: "error", listener: (err: Error) => void): unknown;
	once(event: "close", listener: (code: number | null) => void): unknown;
}): Promise<number> {
	return new Promise((resolve) => {
		child.once("error", () => resolve(1));
		child.once("close", (code: number | null) => resolve(code ?? 1));
	});
}
