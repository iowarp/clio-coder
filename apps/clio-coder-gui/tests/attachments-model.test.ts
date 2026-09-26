import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Attachment,
	acceptsType,
	admitAttachment,
	attachmentRefusal,
	attachmentSummary,
	decodeTextFile,
	fittedSize,
} from "../client/chat/attachments-model.js";
import {
	TURN_FILE_MAX,
	TURN_FILE_MAX_BYTES,
	TURN_IMAGE_MAX,
	TURN_IMAGES_MAX_BASE64,
} from "../contracts/attachments.js";

const image = (id: string, length: number): Attachment => ({
	id,
	kind: "image",
	name: `${id}.png`,
	mimeType: "image/png",
	data: "A".repeat(length),
	width: 10,
	height: 10,
});

test("only the types the agent can read are offered", () => {
	for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(acceptsType(type), true);
	for (const type of ["image/svg+xml", "image/heic", "application/pdf", ""]) assert.equal(acceptsType(type), false);
});

test("large images are drawn down to the longest edge and small ones are left alone", () => {
	assert.deepEqual(fittedSize(4000, 3000), { width: 1568, height: 1176 });
	assert.deepEqual(fittedSize(1000, 3136), { width: 500, height: 1568 });
	assert.deepEqual(fittedSize(800, 600), { width: 800, height: 600 });
	assert.deepEqual(fittedSize(0, 0), { width: 1, height: 1 });
});

test("a request stops at the image count and at the bytes one agent line can carry", () => {
	const full = Array.from({ length: TURN_IMAGE_MAX }, (_, index) => image(`i${index}`, 10));
	assert.match(String(admitAttachment(full, image("next", 10)).ok === false && "refused"), /refused/);
	const heavy = [image("big", TURN_IMAGES_MAX_BASE64 - 100)];
	const refused = admitAttachment(heavy, image("more", 200));
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.reason, /more\.png would make this request too large/);
	assert.equal(admitAttachment(heavy, image("fits", 100)).ok, true);
});

test("attachments are summarized in words and refused while a turn runs", () => {
	assert.equal(attachmentSummary([]), "");
	assert.equal(attachmentSummary([image("a", 4096)]), "1 image, about 3 KiB");
	assert.equal(attachmentRefusal([image("a", 4)], false), null);
	assert.equal(attachmentRefusal([], true), null);
	assert.match(attachmentRefusal([image("a", 4)], true) ?? "", /Attachments go with a new request/);
});

const file = (id: string, text: string): Attachment => ({
	id,
	kind: "file",
	name: `${id}.md`,
	text,
	bytes: new TextEncoder().encode(text).length,
});

test("a text file is read as UTF-8 text or refused with the reason, before anything is sent", () => {
	const encode = (text: string) => new TextEncoder().encode(text);
	const read = decodeTextFile("notes.md", encode("# Soil\nsample A: 4.2\n"));
	assert.deepEqual(read, { ok: true, text: "# Soil\nsample A: 4.2\n", bytes: 21 });
	const binary = decodeTextFile("photo.bin", new Uint8Array([0x50, 0x4b, 0x00, 0x03]));
	assert.match(binary.ok ? "" : binary.reason, /photo\.bin is not a text file/);
	const latin1 = decodeTextFile("old.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
	assert.match(latin1.ok ? "" : latin1.reason, /old\.txt is not UTF-8 text/);
	const control = decodeTextFile("term.log", encode("ok\u001b[31mred"));
	assert.match(control.ok ? "" : control.reason, /term\.log is not a text file/);
	const huge = decodeTextFile("dump.csv", new Uint8Array(TURN_FILE_MAX_BYTES + 1).fill(0x61));
	assert.match(huge.ok ? "" : huge.reason, /dump\.csv is larger than/);
});

test("files and images share one request budget, counted as the bytes the agent line will carry", () => {
	const files = Array.from({ length: TURN_FILE_MAX }, (_, index) => file(`f${index}`, "x"));
	const counted = admitAttachment(files, file("next", "x"));
	assert.match(counted.ok ? "" : counted.reason, /at most 4 files/);
	// Four images do not use up the file slots, and the reverse.
	const images = Array.from({ length: TURN_IMAGE_MAX }, (_, index) => image(`i${index}`, 10));
	assert.equal(admitAttachment(images, file("notes", "x")).ok, true);
	assert.equal(admitAttachment(files, image("shot", 10)).ok, true);
	// Escaping can double a file's bytes on the wire, so a file weighs twice its size.
	const heavy = [image("big", TURN_IMAGES_MAX_BASE64 - 100)];
	assert.equal(admitAttachment(heavy, file("half", "x".repeat(50))).ok, true);
	const over = admitAttachment(heavy, file("over", "x".repeat(51)));
	assert.match(over.ok ? "" : over.reason, /over\.md would make this request too large/);
});

test("mixed attachments are summarized by kind", () => {
	assert.equal(attachmentSummary([file("a", "x".repeat(2048))]), "1 file, about 2 KiB");
	assert.equal(
		attachmentSummary([image("a", 4096), file("b", "x".repeat(1024)), file("c", "y")]),
		"1 image and 2 files, about 4 KiB",
	);
	assert.match(attachmentRefusal([file("a", "x")], true) ?? "", /Attachments go with a new request/);
});
