#!/usr/bin/env node
// Every English key has an Arabic one and vice versa (plural suffixes aside),
// for the package's strings and for a console's own:
//   node packages/insighteye-ui/scripts/check-locales.mjs src/i18n/en.json src/i18n/ar.json
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pairs = [[join(here, "../src/i18n/locales/en.json"), join(here, "../src/i18n/locales/ar.json")]];
if (process.argv[2] && process.argv[3]) pairs.push([process.argv[2], process.argv[3]]);

const PLURAL = /_(zero|one|two|few|many|other)$/;
const keys = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`.replace(PLURAL, "")]
  );

let failed = false;
for (const [enPath, arPath] of pairs) {
  const en = new Set(keys(JSON.parse(readFileSync(enPath, "utf8"))));
  const ar = new Set(keys(JSON.parse(readFileSync(arPath, "utf8"))));
  const missing = [...en].filter((k) => !ar.has(k));
  const extra = [...ar].filter((k) => !en.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${arPath}:`);
    for (const k of missing) console.error(`  missing  ${k}`);
    for (const k of extra) console.error(`  extra    ${k}`);
  } else {
    console.log(`${arPath}: ${ar.size} keys match ${enPath}`);
  }
}
process.exit(failed ? 1 : 0);
