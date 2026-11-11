/**
 * Credential shapes every redactor and the sandbox env scrub share, so a shape one of them hides is never shown by
 * another. A pattern with `keepsHead` keeps group 1 (the command or header naming the secret) and hides group 2; the
 * others hide the whole match. Each pattern is global; callers clone it or reset `lastIndex` before `test`.
 */
export interface CredentialShape {
	kind: string;
	re: RegExp;
	keepsHead?: true;
}

/** Shapes that are a credential by their value alone, wherever they sit. */
export const CREDENTIAL_VALUE_SHAPES: ReadonlyArray<CredentialShape> = [
	{ kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
	{ kind: "gitlab-token", re: /\bgl(?:pat|dt|rt|ptt|soat|ft)-[A-Za-z0-9_-]{20,}/g },
	{ kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ kind: "provider-key", re: /\b(?:hf_|npm_)[A-Za-z0-9]{20,}\b/g },
	{ kind: "slack-token", re: /\bxox[bpars]-[A-Za-z0-9-]{8,}\b/g },
	{
		kind: "slack-webhook",
		re: /\b(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,}/gi,
	},
];

/** Shapes where the command or header names the credential that follows it. */
export const CREDENTIAL_LEAD_SHAPES: ReadonlyArray<CredentialShape> = [
	// `curl -u name:pw` and `--user name:pw`: the name stays, the password goes.
	{
		kind: "basic-auth",
		re: /(\bcurl\b[^\n|;&]*?\s(?:-u|--user)(?:\s+|=)["']?[^\s:"']+:)([^\s"']+)/g,
		keepsHead: true,
	},
	{ kind: "cookie", re: /(\b(?:set-)?cookie\s*["']?\s*:\s*)([^\r\n"']{8,})/gi, keepsHead: true },
	{ kind: "cli-password", re: /(\bsshpass\s+(?:-[a-oq-zA-Z]\S*\s+)*-p\s*)([^\s"']+)/g, keepsHead: true },
	{ kind: "cli-password", re: /(\bdocker\s+login\b[^\n|;&]*?\s-p(?:\s+|=))([^\s"']+)/g, keepsHead: true },
];

export const CREDENTIAL_SHAPES: ReadonlyArray<CredentialShape> = [
	...CREDENTIAL_VALUE_SHAPES,
	...CREDENTIAL_LEAD_SHAPES,
];

/** Whether `value` holds any shared credential shape. */
export function holdsCredentialShape(value: string): boolean {
	return CREDENTIAL_SHAPES.some((shape) => {
		shape.re.lastIndex = 0;
		return shape.re.test(value);
	});
}

/** Replace every match of `shapes` in `value`; `marker` names the replacement for a kind. */
export function replaceCredentialShapes(
	value: string,
	shapes: ReadonlyArray<CredentialShape>,
	marker: (kind: string) => string,
): string {
	let out = value;
	for (const shape of shapes) {
		out = out.replace(shape.re, (_match: string, head: unknown) => {
			return shape.keepsHead && typeof head === "string" ? `${head}${marker(shape.kind)}` : marker(shape.kind);
		});
	}
	return out;
}
