import { execFile } from "node:child_process";
import type { ExtensionApiV2, ExtensionContextV2, ExtensionOutputV2 } from "@iowarp/clio-coder/extensions";

interface Snapshot {
	branch: string | null;
	dirty: number | null;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	checkedAt: number;
	error: string | null;
}

/** Porcelain v2 with -z preserves filenames, including newlines; renames carry a second path token. */
function parseStatus(stdout: string): Omit<Snapshot, "checkedAt" | "error"> {
	const snapshot = {
		branch: null as string | null,
		dirty: 0,
		upstream: null as string | null,
		ahead: null as number | null,
		behind: null as number | null,
	};
	const records = stdout.split("\0");
	let oid = "";
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.startsWith("# branch.head ")) snapshot.branch = record.slice(14);
		else if (record.startsWith("# branch.oid ")) oid = record.slice(13);
		else if (record.startsWith("# branch.upstream ")) snapshot.upstream = record.slice(18);
		else if (record.startsWith("# branch.ab ")) {
			const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
			if (match) {
				snapshot.ahead = Number(match[1]);
				snapshot.behind = Number(match[2]);
			}
		} else if (/^[12u?] /.test(record)) {
			snapshot.dirty++;
			if (record.startsWith("2 ")) i++;
		}
	}
	if (!snapshot.branch) throw new Error("Git did not report a branch header.");
	if (snapshot.branch === "(detached)") snapshot.branch = `detached@${oid.slice(0, 8)}`;
	return snapshot;
}

/** This example launches only Git, with fixed argv, no shell, no remote query and no optional index locks. */
function readStatus(ctx: ExtensionContextV2): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-C",
				ctx.snapshot.workspace,
				"status",
				"--porcelain=v2",
				"--branch",
				"--untracked-files=all",
				"-z",
			],
			{ encoding: "utf8", timeout: 1200, maxBuffer: 256 * 1024, signal: ctx.signal },
			(error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)),
		);
	});
}

async function refresh(ctx: ExtensionContextV2): Promise<ExtensionOutputV2> {
	let snapshot: Snapshot;
	const checkedAt = Date.now();
	try {
		snapshot = { ...parseStatus(await readStatus(ctx)), checkedAt, error: null };
	} catch (error) {
		snapshot = {
			branch: null,
			dirty: null,
			upstream: null,
			ahead: null,
			behind: null,
			checkedAt,
			error: String(error).slice(0, 300),
		};
	}
	ctx.signal.throwIfAborted();
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await ctx.state.get<Snapshot>("lastSnapshot");
		if (current.value && current.value.checkedAt > snapshot.checkedAt) {
			snapshot = current.value;
			break;
		}
		if ((await ctx.state.set("lastSnapshot", snapshot, { ifVersion: current.version })).ok) break;
		if (attempt === 7) throw new Error("Git snapshot changed repeatedly; try pulse again.");
	}
	const branch = snapshot.branch?.slice(0, 70) ?? "unavailable";
	const divergence = snapshot.error
		? "upstream unavailable"
		: snapshot.upstream
			? `ahead ${snapshot.ahead ?? "?"} · behind ${snapshot.behind ?? "?"}`
			: "no upstream";
	const text = snapshot.error
		? `Git unavailable: ${snapshot.error}`
		: `${branch} · dirty ${snapshot.dirty} · ${divergence}`;
	return {
		text,
		status: {
			text: `Git ${branch} · ${snapshot.dirty ?? "?"} dirty · ${snapshot.error ? "upstream ?" : snapshot.upstream ? `↑${snapshot.ahead ?? "?"} ↓${snapshot.behind ?? "?"}` : "no upstream"}`,
			tone: snapshot.error ? "warning" : snapshot.dirty ? "warning" : "neutral",
		},
		band: { t: "text", text, tone: snapshot.error ? "warning" : "muted", wrap: "truncate" },
	};
}

export default function extension(api: ExtensionApiV2): void {
	api.handle("pulse", async (_args, ctx) => {
		const output = await refresh(ctx);
		return { ...output, card: { t: "text", text: output.text, wrap: "wrap" } };
	});
	for (const event of ["session_open", "fs_changed", "tick"] as const) api.on(event, (_event, ctx) => refresh(ctx));
}
