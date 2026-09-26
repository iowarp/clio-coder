import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Attachment,
	acceptsType,
	admitAttachment,
	attachmentRefusal,
	attachmentSummary,
	fittedSize,
} from "../client/chat/attachments-model.js";
import { TURN_IMAGE_MAX, TURN_IMAGES_MAX_BASE64 } from "../contracts/attachments.js";

const image = (id: string, length: number): Attachment => ({
	id,
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
	assert.match(attachmentRefusal([image("a", 4)], true) ?? "", /Images go with a new request/);
});
