// Labels a new issue from the facts it states: the `clio-coder-report` block
// written by /report, or the bug form's dropdowns. GitHub drops labels a
// reporter without triage rights asks for, so the repository applies them.
// The body is attacker-controlled text: it is only matched with regexes here
// and never reaches a shell or a workflow expression.

export const ALLOWED_LABELS = new Set([
	"bug",
	"enhancement",
	"question",
	"area:tui",
	"area:cli",
	"area:engine",
	"area:dispatch",
	"area:context",
	"area:memory",
	"area:skills",
	"area:api",
	"area:build",
	"area:docs",
	"area:tests",
	"area:gui",
	"area:acp",
	"area:providers",
	"area:safety",
	"area:install",
	"area:telemetry",
	"os:linux",
	"os:macos",
	"os:windows",
	"via:report",
	"has-bundle",
	"needs-repro",
	"needs-triage",
	"regression",
	"crash",
]);

const KIND_LABELS = { bug: "bug", feature: "enhancement", question: "question" };
const OS_LABELS = { linux: "os:linux", macos: "os:macos", windows: "os:windows" };
const FORM_SURFACE_LABELS = {
	Terminal: "area:tui",
	"Headless run": "area:cli",
	"Editor over ACP": "area:acp",
	"Desktop app": "area:gui",
	Installer: "area:install",
};
const FORM_OS_LABELS = { Linux: "os:linux", macOS: "os:macos", Windows: "os:windows" };
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FINGERPRINT = /^fp_[0-9a-f]{12}$/u;
const MAX_BODY = 65536;

export function reportBlock(body) {
	const match = /^```clio-coder-report[ \t]*\r?\n([\s\S]*?)^```/mu.exec(String(body ?? "").slice(0, MAX_BODY));
	if (!match) return null;
	const fields = new Map();
	for (const line of match[1].split(/\r?\n/u)) {
		const pair = /^([a-z]+):[ \t]*(.*?)[ \t]*$/u.exec(line);
		if (pair && !fields.has(pair[1])) fields.set(pair[1], pair[2]);
	}
	return fields;
}

// The text under a form heading (`### Surface`), up to the next heading.
function formSection(body, heading) {
	const lines = String(body ?? "")
		.slice(0, MAX_BODY)
		.split(/\r?\n/u);
	const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
	if (start < 0) return null;
	const rest = [];
	for (const line of lines.slice(start + 1)) {
		if (/^#{1,3} /u.test(line)) break;
		rest.push(line);
	}
	return rest.join("\n").trim();
}

export function fingerprintOf(body) {
	const value = reportBlock(body)?.get("fingerprint");
	return value && FINGERPRINT.test(value) ? value : null;
}

/**
 * @param {{ title?: string, body?: string | null, author_association?: string }} issue
 * @param {{ sameFingerprint?: number | null }} [found]
 * @returns {{ add: string[], comment: string | null }}
 */
export function labelsFor(issue, found = {}) {
	const title = String(issue.title ?? "");
	const body = issue.body ?? "";
	const block = reportBlock(body);
	const add = [];
	let isBug = /^fix\b/u.test(title);
	if (block) {
		add.push("via:report");
		const kind = KIND_LABELS[block.get("kind")];
		if (kind) add.push(kind);
		if (block.get("kind") === "bug") isBug = true;
		const area = block.get("area");
		if (area && area !== "none") add.push(`area:${area}`);
		const os = OS_LABELS[block.get("os")];
		if (os) add.push(os);
		if (block.get("trigger") === "crash") add.push("crash");
		const bundle = block.get("bundle") ?? "";
		if (bundle === "attached" || /^gist:[0-9a-f]+#\S+$/u.test(bundle)) add.push("has-bundle");
		const links = block.get("links") ?? "";
		if (block.get("regression") === "yes" && /^fix\b/u.test(title) && /#\d+/u.test(links)) add.push("regression");
	} else {
		const surface = FORM_SURFACE_LABELS[formSection(body, "Surface")];
		if (surface) add.push(surface);
		const os = FORM_OS_LABELS[formSection(body, "Operating system")];
		if (os) add.push(os);
		if (formSection(body, "What happened") !== null) isBug = true;
	}
	if (isBug) {
		const steps = formSection(body, "Steps, if you have them");
		if (!steps || steps === "_No response_") add.push("needs-repro");
	}
	if (!TRUSTED_ASSOCIATIONS.has(issue.author_association)) add.push("needs-triage");
	const comment = found.sameFingerprint ? `Same fingerprint as #${found.sameFingerprint}.` : null;
	return { add: [...new Set(add)].filter((label) => ALLOWED_LABELS.has(label)), comment };
}

// Entry point for actions/github-script. On `opened` it labels and may leave
// one comment; a dispatch relabels one issue and adds only missing labels.
export async function run({ github, context, core }) {
	const { owner, repo } = context.repo;
	const dispatched = context.eventName === "workflow_dispatch";
	const issue = dispatched
		? (
				await github.rest.issues.get({
					owner,
					repo,
					issue_number: Number.parseInt(String(context.payload.inputs?.issue ?? ""), 10),
				})
			).data
		: context.payload.issue;
	if (!issue || issue.pull_request) return;
	let sameFingerprint = null;
	const fingerprint = dispatched ? null : fingerprintOf(issue.body);
	if (fingerprint) {
		const { data } = await github.rest.search.issuesAndPullRequests({
			q: `"${fingerprint}" repo:${owner}/${repo} is:issue`,
			per_page: 20,
		});
		const older = data.items
			.filter((item) => item.number < issue.number && fingerprintOf(item.body) === fingerprint)
			.map((item) => item.number)
			.sort((a, b) => a - b);
		sameFingerprint = older[0] ?? null;
	}
	const { add, comment } = labelsFor(issue, { sameFingerprint });
	const present = new Set((issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)));
	const missing = add.filter((label) => !present.has(label));
	if (missing.length > 0)
		await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: missing });
	if (comment) await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: comment });
	core.info(`#${issue.number}: added ${missing.join(", ") || "nothing"}${comment ? `; ${comment}` : ""}`);
}
