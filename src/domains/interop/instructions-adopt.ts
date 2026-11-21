/**
 * An instruction file another agent loads into every session
 * (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) adopted into the operator's user
 * handbook (core/user-handbook.ts), which CLIO Coder loads ahead of project
 * handbooks. Each source owns one marked section, so adopting a host again
 * replaces only its own section and leaves the operator's writing alone.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioUserHandbookPath, USER_HANDBOOK_MAX_BYTES } from "../../core/user-handbook.js";
import { inventoryText } from "./inventory.js";
import type { InteropAgentId, InteropInventoryItem } from "./types.js";

const HEADER =
	"# User handbook\n\nCLIO Coder loads this file ahead of project handbooks in every session. Sections between clio-coder markers were adopted from other coding agents; `clio-coder interop adopt` replaces only its own sections.\n";

export type InstructionsAdoption =
	| { ok: true; destination: string; digest: string; section: string; replaces: boolean; notes: string[] }
	| { ok: false; reason: string };

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionPattern(host: InteropAgentId, name: string): RegExp {
	const id = `${escapeRegExp(host)} ${escapeRegExp(name)}`;
	return new RegExp(
		`<!-- clio-coder:adopted ${id} sha256=([0-9a-f]{64}) -->\\n[\\s\\S]*?\\n<!-- clio-coder:end ${id} -->`,
	);
}

function currentHandbook(destination: string): string | null {
	return existsSync(destination) ? readFileSync(destination, "utf8") : null;
}

function merged(existing: string | null, pattern: RegExp, section: string): string {
	if (existing === null || existing.trim().length === 0) return `${HEADER}\n${section}\n`;
	if (pattern.test(existing)) return existing.replace(pattern, () => section);
	return `${existing.replace(/\s*$/, "")}\n\n${section}\n`;
}

/** Plan one instruction file into its section of the user handbook. */
export function planInstructionsAdoption(item: InteropInventoryItem, host: InteropAgentId): InstructionsAdoption {
	if (item.scope !== "user")
		return {
			ok: false,
			reason:
				"Project instruction files reach CLIO Coder through the compiled handbook or `clio-coder context init --adopt`.",
		};
	let body: string;
	try {
		body = inventoryText(item.path).trim();
	} catch (error) {
		return { ok: false, reason: `Cannot read ${item.path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (body.length === 0) return { ok: false, reason: "Empty; nothing to adopt." };
	if (body.includes("<!-- clio-coder:"))
		return { ok: false, reason: "Contains clio-coder section markers; adopt it by hand." };
	const digest = createHash("sha256").update(body).digest("hex");
	const id = `${host} ${item.name}`;
	const section = `<!-- clio-coder:adopted ${id} sha256=${digest} -->\n## Adopted from ${item.path}\n\n${body}\n<!-- clio-coder:end ${id} -->`;
	const destination = clioUserHandbookPath();
	let existing: string | null;
	try {
		existing = currentHandbook(destination);
	} catch (error) {
		return { ok: false, reason: `Cannot read ${destination}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const pattern = sectionPattern(host, item.name);
	const previous = existing === null ? null : pattern.exec(existing);
	if (previous?.[1] === digest) return { ok: false, reason: "Already adopted: same content in your user handbook." };
	const next = merged(existing, pattern, section);
	if (Buffer.byteLength(next) > USER_HANDBOOK_MAX_BYTES)
		return {
			ok: false,
			reason: `The user handbook would exceed ${USER_HANDBOOK_MAX_BYTES} bytes, which CLIO Coder refuses to load; shorten ${item.path} or ${destination} first.`,
		};
	const imports = body.split("\n").filter((line) => /^@\S/.test(line.trim())).length;
	return {
		ok: true,
		destination,
		digest,
		section,
		replaces: previous !== null,
		notes: imports > 0 ? [`${imports} @import line(s) are copied as text; the files they name are not read`] : [],
	};
}

/** Write the reviewed section, re-reading the source and the handbook first. */
export function applyInstructionsAdoption(
	item: InteropInventoryItem,
	host: InteropAgentId,
	reviewedDigest: string,
): { ok: true; destination: string } | { ok: false; reason: string } {
	const current = planInstructionsAdoption(item, host);
	if (!current.ok) return current;
	if (current.digest !== reviewedDigest)
		return { ok: false, reason: "Source changed after review; inspect a new plan." };
	const next = merged(currentHandbook(current.destination), sectionPattern(host, item.name), current.section);
	safeResourceWrite(current.destination, next);
	return { ok: true, destination: current.destination };
}
