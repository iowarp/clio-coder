import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ExternalEditorProbe = (candidates: ReadonlyArray<string>) => string | null;

export interface ExternalEditResult {
	ok: boolean;
	text?: string;
	error?: string;
}

function defaultProbe(candidates: ReadonlyArray<string>): string | null {
	for (const candidate of candidates) {
		const result = spawnSync("sh", ["-lc", `command -v ${candidate}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const resolved = typeof result.stdout === "string" ? result.stdout.trim() : "";
		if (result.status === 0 && resolved.length > 0) return resolved;
	}
	return null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function runEditor(command: string, filePath: string): ReturnType<typeof spawnSync> {
	if (process.platform === "win32") {
		return spawnSync(command, [filePath], {
			stdio: "inherit",
			shell: true,
		});
	}
	return spawnSync(process.env.SHELL || "/bin/sh", ["-lc", `${command} ${shellQuote(filePath)}`], {
		stdio: "inherit",
	});
}

export function resolveExternalEditor(
	env: NodeJS.ProcessEnv = process.env,
	probe: ExternalEditorProbe = defaultProbe,
): string | null {
	const visual = env.VISUAL?.trim();
	if (visual) return visual;
	const editor = env.EDITOR?.trim();
	if (editor) return editor;
	return probe(["nano", "vi"]);
}

export function editTextExternally(initialText: string, command: string | null): ExternalEditResult {
	if (!command) return { ok: false, error: "no external editor configured; set VISUAL or EDITOR" };
	const tmpFile = join(tmpdir(), `clio-editor-${process.pid}-${randomUUID()}.md`);
	try {
		writeFileSync(tmpFile, initialText, "utf8");
		const result = runEditor(command, tmpFile);
		if (result.error) return { ok: false, error: result.error.message };
		if (result.status !== 0) return { ok: false, error: `external editor exited with code ${result.status ?? "?"}` };
		return { ok: true, text: readFileSync(tmpFile, "utf8").replace(/\n$/, "") };
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Best-effort cleanup; the editor may already have removed the file.
		}
	}
}
