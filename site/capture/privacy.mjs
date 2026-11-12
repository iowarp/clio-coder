// The privacy scan for everything the capture harness publishes: machine and
// operator names, private addresses, credential shapes, and the gateway behind
// the alias. Nothing that matches is written to the site. Tested by
// `node --test site/capture/tests/privacy.test.mjs`.

// Strips terminal control sequences, enough for scanning the output text.
const ESC = "\u001b";
const BEL = "\u0007";
const controls = [
	new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
	new RegExp(`${ESC}\\[[0-9;?<>=!]*[ -/]*[@-~]`, "g"),
	new RegExp(`${ESC}[PX^_][\\s\\S]*?${ESC}\\\\`, "g"),
	new RegExp(`${ESC}[@-Z\\\\-_]`, "g"),
];
export const plain = (text) => controls.reduce((value, pattern) => value.replace(pattern, ""), text);

const HOME = "/home/researcher";
const homePath = /\/home\/(?!researcher(?![\w.-]))[a-z]/g;
const patterns = [
	[/mini\//i, "a gateway model id"],
	[/\b(?:blade|mini|dragon|zbook|dynamo)\b/i, "a host name"],
	[/\b192\.168\.\d/, "a private address"],
	[/\b10\.\d+\.\d+\.\d+\b/, "a private address"],
	[/\b(?:sk|ghp|gho|github_pat|xox[bp]|AKIA)[-_][A-Za-z0-9_-]{12,}/, "a key shape"],
	[
		/\b[a-z][a-z0-9+.-]*:\/\/(?!(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|\b)|(?:[a-z0-9-]+\.)*iowarp\.ai\b|github\.com\/iowarp\b)\S+/i,
		"a URL",
	],
];

// `ends` holds offsets in `text` where an output chunk ended. A streamed line can
// stop partway through the sandbox home; such a fragment is allowed only when it is
// a strict prefix of /home/researcher and either ends where a chunk ends (only
// control sequences may follow it in that chunk) or is a streamed tool argument followed by the preparing spinner ("/home/resea ◌"),
// and the text after it does not continue the name. Every other home path is refused.
export function privacyHits(text, secrets = [], ends = new Set()) {
	const hits = secrets
		.filter((value) => value && value.length >= 3 && text.includes(value))
		.map(() => "an operator secret or path");
	const chunkEnds = [...ends].sort((a, b) => a - b);
	const endsChunk = (at) => {
		const next = chunkEnds.find((value) => value >= at);
		return next !== undefined && plain(text.slice(at, next)) === "";
	};
	for (const match of text.matchAll(homePath)) {
		const word = text.slice(match.index).match(/^\/home\/[\w.-]*/)[0];
		const end = match.index + word.length;
		const preparing = plain(text.slice(end, end + 120)).startsWith(" ◌");
		if (word.length < HOME.length && HOME.startsWith(word) && (endsChunk(end) || preparing)) continue;
		hits.push(`a home path (${JSON.stringify(word.slice(0, 40))})`);
		break;
	}
	for (const [pattern, label] of patterns) {
		const match = text.match(pattern);
		if (match) hits.push(`${label} (${JSON.stringify(match[0].slice(0, 40))})`);
	}
	return hits;
}

// Scans output chunks as one text, so a name split across chunks is still found,
// while remembering where each chunk ended.
export function scanChunks(chunks, secrets = []) {
	const ends = new Set();
	let text = "";
	for (const chunk of chunks) {
		text += chunk;
		ends.add(text.length);
	}
	return privacyHits(text, secrets, ends);
}
