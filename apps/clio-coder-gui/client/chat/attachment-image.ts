// Reads a picked, pasted or dropped image into what a request sends. Kept apart from the model so the
// rules stay testable under node:test; this half needs a browser to decode and draw.

import { type Attachment, acceptsType, fittedSize } from "./attachments-model.js";

function base64(bytes: ArrayBuffer): string {
	let binary = "";
	const view = new Uint8Array(bytes);
	// Chunked so a large image does not overflow the argument list of String.fromCharCode.
	for (let index = 0; index < view.length; index += 0x8000)
		binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
	return btoa(binary);
}

/**
 * An image that already fits is sent as its own bytes. A larger one is drawn down to the longest
 * edge and sent as JPEG, except a PNG or GIF, which stays lossless as PNG because it is often a
 * screenshot whose text would blur. An animated GIF is sent as its first frame when it is redrawn.
 */
export async function readAttachment(file: File, id: string): Promise<Attachment> {
	if (!acceptsType(file.type)) throw new Error(`${file.name} is not a PNG, JPEG, GIF or WebP image.`);
	const bitmap = await createImageBitmap(file).catch(() => {
		throw new Error(`${file.name} could not be read as an image.`);
	});
	try {
		const size = fittedSize(bitmap.width, bitmap.height);
		const name = file.name || "Pasted image";
		if (size.width === bitmap.width && size.height === bitmap.height && file.size <= 500 * 1024)
			return { id, name, mimeType: file.type, data: base64(await file.arrayBuffer()), ...size };
		const canvas = new OffscreenCanvas(size.width, size.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error(`${name} could not be resized in this browser.`);
		context.drawImage(bitmap, 0, 0, size.width, size.height);
		const mimeType = file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg";
		const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.85 });
		return { id, name, mimeType, data: base64(await blob.arrayBuffer()), ...size };
	} finally {
		bitmap.close();
	}
}
