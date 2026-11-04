import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { holdUnresolvedUserinfo, redactSecretString, redactUrlCredentials } from "../../src/domains/safety/redaction.js";

// Secrets draw on letters nothing else here uses, so one leaked character is enough to fail.
const SECRET_LETTERS = /[ZQXJ]/u;

test("one-shot redaction leaves compact JSON valid and untouched when it holds no credential", () => {
	for (const text of [
		'{"url":"https://example.com","email":"a@b.com"}',
		'{"a":"http://h:8080","b":"me@corp.com"}',
		'{"a":"https://h:abc/def","b":"me@corp.com"}',
		'["https://example.com:443","me@corp.com"]',
		'{"a":"https://example.com"}@x',
		'{\\"a\\":\\"http://h:8080\\",\\"b\\":\\"me@corp.com\\"}',
		'<a href="https://example.com:443">me@corp.com</a>',
		'f("https://example.com",me@corp.com)',
	]) {
		strictEqual(redactUrlCredentials(text), text);
		strictEqual(redactSecretString(text), text);
	}
});

test("one-shot redaction hides a credential in compact JSON and the JSON still parses", () => {
	for (const [text, redacted] of [
		['{"a":"https://u:ZQ@h/x","b":"me@corp.com"}', '{"a":"https://u:[redacted]@h/x","b":"me@corp.com"}'],
		['{"u":"https://h/?token=ZQ","e":"a@b.com"}', '{"u":"https://h/?token=[redacted]","e":"a@b.com"}'],
		['{"u":"https://me@corp.com:ZQ@h/","e":"a@b.com"}', '{"u":"https://me@corp.com:[redacted]@h/","e":"a@b.com"}'],
	] as const) {
		strictEqual(redactUrlCredentials(text), redacted);
		deepStrictEqual(Object.keys(JSON.parse(redacted)).length, 2);
	}
	// A quote with no structure after it is still password, so the rule cannot be used to show one.
	for (const text of ['https://u:Z"Q@h', 'https://u:Z"$Q@h', 'https://u:ZQ"@h', 'https://h/?token="ZQ"']) {
		ok(!SECRET_LETTERS.test(redactUrlCredentials(text)), text);
	}
});

test("one-shot redaction reads an @ in the name, and a name with an @ has no reach past the path", () => {
	strictEqual(redactUrlCredentials("https://me@corp.com:hunter2@host/"), "https://me@corp.com:[redacted]@host/");
	for (const text of [
		"ssh://git@github.com:org/repo.git@v1",
		"ssh://git@host:2222/path@tag",
		"https://me@corp.com:8080/a@b",
		"https://me@corp.com/a:b@c",
	]) {
		strictEqual(redactUrlCredentials(text), text);
	}
});

test("a frame releases what a closing quote settled and still holds what a quote cannot settle", () => {
	const settled = '{"u":"https://x.io:80","d":"ppp';
	strictEqual(holdUnresolvedUserinfo(settled), settled);
	strictEqual(holdUnresolvedUserinfo('{"u":"https://u:hun"'), '{"u":"https://u:');
	strictEqual(holdUnresolvedUserinfo('https://u:Z"Q'), "https://u:");
	strictEqual(holdUnresolvedUserinfo("https://me@corp.com:hunter"), "https://me@corp.com:");
	strictEqual(holdUnresolvedUserinfo("https://me@corp.com:8080/x"), "https://me@corp.com:8080/x");
	strictEqual(holdUnresolvedUserinfo("https://me@corp.com:hunter2@ho"), "https://me@corp.com:hunter2@");
});
