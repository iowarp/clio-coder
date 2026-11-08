/**
 * Campaign persistence under `<project>/.clio-coder/research/<id>/`: the immutable `campaign.json`, the append-only
 * `journal.jsonl` of typed events, and the raw `samples/<name>.json` every grade is recomputed from.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { clioProjectRoot, ensureProjectIgnore } from "../../core/project-root.js";
import { fsyncDirectory, safeResourceWrite } from "../../core/safe-resource-write.js";
import {
	RESEARCH_CAMPAIGN_VERSION,
	type ResearchCampaign,
	type ResearchJournalEvent,
	type ResearchSamples,
} from "./types.js";

const CAMPAIGN_ID = /^r[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/u;
const JOURNAL_TYPES = new Set<ResearchJournalEvent["type"]>([
	"opened",
	"aa",
	"iteration-started",
	"agent-finished",
	"committed",
	"measured",
	"graded",
	"ratcheted",
	"archived",
	"recorded",
	"stopped",
]);

export function isResearchCampaignId(id: string): boolean {
	return CAMPAIGN_ID.test(id);
}

/** A sortable id: `r<yyyymmdd>-<hhmmss>-<4 hex>` in UTC. */
export function newResearchCampaignId(now: Date = new Date(), suffix: string = randomBytes(2).toString("hex")): string {
	const iso = now.toISOString();
	return `r${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${suffix}`;
}

/** The repository root whose `.clio-coder/research/` holds a cwd's campaigns. */
export function researchProjectRoot(cwd: string): string {
	return clioProjectRoot(cwd, "research");
}

export function researchRoot(project: string): string {
	return join(project, ".clio-coder", "research");
}

export function campaignDir(project: string, id: string): string {
	if (!isResearchCampaignId(id)) throw new Error(`invalid research campaign id '${id}'`);
	return join(researchRoot(project), id);
}

export function samplesName(iteration: number | "aa"): string {
	return iteration === "aa" ? "aa" : `it-${String(iteration).padStart(4, "0")}`;
}

/** Write `campaign.json` once; a second write for the same id is refused. */
export function writeCampaign(campaign: ResearchCampaign): string {
	ensureProjectIgnore(campaign.project);
	const dir = campaignDir(campaign.project, campaign.id);
	const path = join(dir, "campaign.json");
	if (existsSync(path)) throw new Error(`research campaign ${campaign.id} already exists`);
	mkdirSync(join(dir, "samples"), { recursive: true });
	safeResourceWrite(path, `${JSON.stringify(campaign, null, 2)}\n`, { encoding: "utf8" });
	return path;
}

export function readCampaign(project: string, id: string): ResearchCampaign {
	const path = join(campaignDir(project, id), "campaign.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`research campaign ${id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		(parsed as { version?: unknown }).version !== RESEARCH_CAMPAIGN_VERSION ||
		(parsed as { id?: unknown }).id !== id
	)
		throw new Error(`research campaign ${id} has a campaign.json this build does not read`);
	return parsed as ResearchCampaign;
}

/** Append one event to the journal and fsync it, so a crash keeps every step that completed. */
export function appendJournal(project: string, id: string, event: ResearchJournalEvent): void {
	const dir = campaignDir(project, id);
	const path = join(dir, "journal.jsonl");
	const created = !existsSync(path);
	const fd = openSync(path, "a", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(event)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (created) fsyncDirectory(dir);
}

export interface JournalRead {
	events: ResearchJournalEvent[];
	/** Lines that are not a known event, such as a line torn by a crash. */
	unreadable: number;
}

export function parseJournal(text: string): JournalRead {
	const events: ResearchJournalEvent[] = [];
	let unreadable = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (
				value !== null &&
				typeof value === "object" &&
				JOURNAL_TYPES.has((value as { type?: unknown }).type as ResearchJournalEvent["type"])
			)
				events.push(value as ResearchJournalEvent);
			else unreadable += 1;
		} catch {
			unreadable += 1;
		}
	}
	return { events, unreadable };
}

export function readJournal(project: string, id: string): JournalRead {
	const path = join(campaignDir(project, id), "journal.jsonl");
	if (!existsSync(path)) return { events: [], unreadable: 0 };
	return parseJournal(readFileSync(path, "utf8"));
}

export function writeSamples(project: string, id: string, samples: ResearchSamples): string {
	const name = `${samplesName(samples.iteration)}.json`;
	safeResourceWrite(join(campaignDir(project, id), "samples", name), `${JSON.stringify(samples, null, 2)}\n`, {
		encoding: "utf8",
	});
	return `samples/${name}`;
}

export function readSamples(project: string, id: string, relative: string): ResearchSamples {
	if (!/^samples\/(aa|it-[0-9]{4,})\.json$/u.test(relative)) throw new Error(`invalid samples path '${relative}'`);
	return JSON.parse(readFileSync(join(campaignDir(project, id), relative), "utf8")) as ResearchSamples;
}

/** Campaign ids under a project, oldest first. */
export function listCampaignIds(project: string): string[] {
	const root = researchRoot(project);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isResearchCampaignId(entry.name))
		.map((entry) => entry.name)
		.filter((id) => existsSync(join(root, id, "campaign.json")))
		.sort();
}
