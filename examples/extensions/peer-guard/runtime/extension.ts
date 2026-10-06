import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionApiV2, ExtensionContextV2, ExtensionOutputV2 } from "@iowarp/clio-coder/extensions";

interface Claim {
	owner: string;
	at: number;
}
type Claims = Record<string, Claim>;
const STORE_KEY = "claims";
const MAX_CLAIMS = 100;

function leaseMs(ctx: ExtensionContextV2): number {
	const minutes = ctx.options.claimMinutes;
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0.1 || minutes > 1440)
		throw new Error("claimMinutes must be between 0.1 and 1440.");
	return minutes * 60000;
}
function contained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Resolve existing symlink parents even when the claimed file does not exist yet. */
function canonicalPath(ctx: ExtensionContextV2, input: string): string {
	if (!input.trim() || input.length > 1000 || input.includes("\0"))
		throw new Error("Supply a workspace file path of 1–1000 characters.");
	const root = realpathSync(ctx.snapshot.workspace);
	const candidate = path.resolve(root, input.trim());
	if (!contained(root, candidate)) throw new Error("Claim paths must stay inside this workspace.");
	let existing = candidate;
	const missing: string[] = [];
	let physical: string;
	while (true) {
		try {
			physical = path.join(realpathSync(existing), ...missing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
	if (!contained(root, physical)) throw new Error("Claim paths must stay inside the physical workspace.");
	return physical;
}

/** Claims begin only after a real session exists; session state then preserves the owner across reloads. */
async function owner(ctx: ExtensionContextV2): Promise<string> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await ctx.state.get<string>("owner");
		if (current.value) return current.value;
		const identity = ctx.snapshot.sessionId;
		if (identity === null) throw new Error("A session ID is required for claim ownership.");
		if ((await ctx.state.set("owner", identity, { ifVersion: current.version })).ok) return identity;
	}
	throw new Error("Session identity changed repeatedly; retry the command.");
}
function activeClaims(value: unknown, ctx: ExtensionContextV2): Claims {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid claims store.");
	const result: Claims = {};
	const now = Date.now(),
		age = leaseMs(ctx);
	for (const [file, raw] of Object.entries(value)) {
		const claim = raw as Partial<Claim> | null;
		if (
			!path.isAbsolute(file) ||
			!claim ||
			typeof claim.owner !== "string" ||
			typeof claim.at !== "number" ||
			!Number.isFinite(claim.at)
		)
			throw new Error("Invalid claim record.");
		if (claim.at <= now && now - claim.at < age) result[file] = { owner: claim.owner, at: claim.at };
	}
	if (Object.keys(result).length > MAX_CLAIMS) throw new Error("Claims exceed the 100-row example limit.");
	return result;
}
function reply(text: string): ExtensionOutputV2 {
	return { text, card: { t: "text", text: text.slice(0, 2000), wrap: "wrap" } };
}

async function change(ctx: ExtensionContextV2, args: string, release: boolean): Promise<ExtensionOutputV2> {
	if (ctx.snapshot.sessionId === null)
		return reply("Claims require an established Clio session. Start a turn before claiming or releasing paths.");
	const file = canonicalPath(ctx, args);
	const mine = await owner(ctx);
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await ctx.store.get<Claims>(STORE_KEY);
		const claims = activeClaims(current.value, ctx);
		const prior = claims[file];
		if (prior && prior.owner !== mine)
			return reply(`Cannot ${release ? "release" : "claim"} ${file}: claimed by another session (${prior.owner}).`);
		if (release) delete claims[file];
		else {
			if (!prior && Object.keys(claims).length >= MAX_CLAIMS)
				return reply("100 active claims already exist; release one or wait for expiry.");
			claims[file] = { owner: mine, at: Date.now() };
		}
		ctx.signal.throwIfAborted();
		if ((await ctx.store.set(STORE_KEY, claims, { ifVersion: current.version })).ok)
			return reply(release ? `Released ${file}.` : `Claimed ${file} for ${ctx.options.claimMinutes} minutes.`);
	}
	return reply("The shared store kept changing; no claim change was confirmed. Retry the command.");
}

export default function extension(api: ExtensionApiV2): void {
	api.handle("claim", (args, ctx) => change(ctx, args, false));
	api.handle("release", (args, ctx) => change(ctx, args, true));
	api.handle("claims", async (_args, ctx) => {
		const claims = activeClaims((await ctx.store.get<Claims>(STORE_KEY)).value, ctx);
		const rows = Object.entries(claims)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([file, claim]) => [
				file.slice(0, 2000),
				claim.owner.slice(0, 120),
				`${Math.ceil((leaseMs(ctx) - (Date.now() - claim.at)) / 60000)} min`,
			]);
		return {
			text: rows.length
				? rows
						.map((row) => row.join(" · "))
						.join("\n")
						.slice(0, 32768)
				: "No active claims.",
			card: { t: "table", columns: ["Path", "Session", "Lease left"], rows },
		};
	});
	api.hook("before_tool", async (event, ctx) => {
		if (event.point !== "before_tool" || !["write", "edit"].includes(event.tool)) return {};
		const input = event.args && typeof event.args === "object" && "path" in event.args ? event.args.path : undefined;
		if (typeof input !== "string") return {};
		let file: string;
		try {
			file = canonicalPath(ctx, input);
		} catch {
			return {};
		}
		const claim = activeClaims((await ctx.store.get<Claims>(STORE_KEY)).value, ctx)[file];
		if (!claim || (ctx.snapshot.sessionId !== null && claim.owner === (await owner(ctx)))) return {};
		return {
			effects: [
				{
					kind: "block_tool",
					reason: `peer-guard: ${file} is claimed by another session (${claim.owner}); ask it to release or wait for expiry.`,
				},
			],
		};
	});
}
