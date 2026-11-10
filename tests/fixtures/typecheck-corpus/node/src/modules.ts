// NodeNext needs .js specifiers on relative imports; paths aliases resolve to source.
import { readFileSync } from "node:fs";
import { describe, type Mode, missingExport } from "@corpus/lib";
import { first } from "./indexed";
import { absent } from "./absent.js";
import settings from "./lib/settings.json" with { type: "json" };

export const mode: Mode = "slow";
export const text: string = describe({ retries: settings.limit });
export const size: number = settings.name;
export const head = first([readFileSync("x", "utf8")]);
export { absent, missingExport };
