#!/usr/bin/env node
// Lists string literals that still look like English prose (capitalised, two
// or more words) outside t()/i18n.t() calls, for a last manual pass after
// i18n-extract.mjs.   node i18n-leftovers.mjs <src-dir>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default || traverseModule;
const root = process.argv[2];
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (["node_modules", "packages", "i18n"].includes(n) ? [] : walk(p)) : /\.jsx?$/.test(n) ? [p] : []; });
const prose = (s) => /^[A-Z“"(]?[A-Za-z][a-z']*[,]? [a-zA-Z]/.test(s.trim()) && /[a-z]{2}/.test(s);
for (const file of walk(root)) {
  const code = readFileSync(file, "utf8");
  let ast;
  try { ast = parse(code, { sourceType: "module", plugins: ["jsx"] }); } catch { continue; }
  traverse(ast, {
    "StringLiteral|TemplateLiteral|JSXText"(path) {
      const n = path.node;
      const text = n.type === "StringLiteral" ? n.value : n.type === "JSXText" ? n.value : n.quasis.map((q) => q.value.cooked).join("{}");
      if (!prose(text)) return;
      if (path.findParent((p) => p.isImportDeclaration() || p.isExportNamedDeclaration() && p.node.source)) return;
      if (path.findParent((p) => p.isCallExpression() && /(^|\.)t$|console\.|Error$/.test(code.slice(p.node.callee.start, p.node.callee.end)))) return;
      if (path.findParent((p) => p.isNewExpression())) return;
      const attr = path.findParent((p) => p.isJSXAttribute());
      if (attr && ["className", "sx", "style", "href", "to", "variant", "color", "key", "data-testid", "src"].includes(attr.node.name.name)) return;
      const line = code.slice(0, n.start).split("\n").length;
      console.log(`${relative(root, file)}:${line}: ${JSON.stringify(text.trim().slice(0, 90))}`);
    },
  });
}
