import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctorModelChecks } from "../../src/domains/lifecycle/doctor.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function settings(url: string, contextWindow?: number): string {
	return [
		"version: 2",
		"targets:",
		"  - id: decider-npu",
		"    runtime: systemone",
		`    url: ${url}/v1`,
		...(contextWindow === undefined ? [] : ["    capabilities:", `      contextWindow: ${contextWindow}`]),
		"systemOne:",
		"  engines:",
		"    npu:",
		"      kind: systemone",
		"      target: decider-npu",
		"      profile: strands-decider",
		"  sites:",
		"    consult: npu",
		"    turnEnd: npu",
		"",
	].join("\n");
}

test("doctor shows each bound System One engine's profile, window and passive round trip", async (t) => {
	const home = await isolateClioEnv("clio-doctor-system-one-engine-");
	t.after(() => home.restore());
	const decisions: string[] = [];
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url === "/v1/models") response.end(JSON.stringify({ models: [{ name: "strands-decider-npu" }] }));
		else {
			decisions.push(request.url ?? "");
			response.statusCode = 404;
			response.end("{}");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), settings(url, 8192));

	const findings = await runDoctorModelChecks();
	const rows = findings.filter((finding) => finding.name === "system one (experimental) engine npu");
	assert.equal(rows.length, 1, "one row per engine, however many sites it serves");
	const row = rows[0];
	assert.equal(row?.ok, true);
	assert.equal(row?.level, undefined);
	assert.match(
		row?.detail ?? "",
		/profile strands-decider; window 4096 tokens \(target decider-npu declares 8192, profile ceiling 4096\)/u,
	);
	assert.match(
		row?.detail ?? "",
		/answered, round trip \d+ ms; serving strands-decider-npu; passive check, no decision asked/u,
	);
	assert.deepEqual(decisions, [], "doctor never posts a decision");
});

test("doctor warns that an unreachable System One engine leaves its sites as if unbound", async (t) => {
	const home = await isolateClioEnv("clio-doctor-system-one-engine-down-");
	t.after(() => home.restore());
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), settings(url));

	const findings = await runDoctorModelChecks();
	const row = findings.find((finding) => finding.name === "system one (experimental) engine npu");
	assert.equal(row?.ok, true);
	assert.equal(row?.level, "warn");
	assert.match(row?.detail ?? "", /window 480 tokens \(the systemone runtime default; set capabilities\.contextWindow/u);
	assert.match(row?.detail ?? "", /did not answer: .*every site it serves behaves as if unbound/u);
});
