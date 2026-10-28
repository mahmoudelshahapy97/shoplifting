import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === "packages" || n === "node_modules" ? [] : walk(p)) : /\.jsx?$/.test(n) ? [p] : []; });
let bad = 0;
for (const f of walk(process.argv[2])) { try { parse(readFileSync(f, "utf8"), { sourceType: "module", plugins: ["jsx"] }); } catch (e) { bad++; console.log(f, e.message); } }
console.log(bad ? `${bad} files fail to parse` : "all files parse");
