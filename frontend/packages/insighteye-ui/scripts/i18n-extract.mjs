#!/usr/bin/env node
/**
 * One-off extraction of a console's hard-coded English into i18n keys.
 *
 *   node i18n-extract.mjs <src-dir> <out en.json> [--dry] [files...]
 *
 * Needs @babel/parser and @babel/traverse on NODE_PATH. The parser is only
 * used for positions: every change is spliced into the original text, so the
 * file keeps its formatting and comments.
 *
 * What becomes t("<file>.<slug>"):
 *  - JSX text. An element whose children are only text and simple {expr}
 *    becomes one interpolated string ("Showing {{shown}} of {{total}}"), so
 *    a translator sees the whole sentence;
 *  - string and template literals in user-facing props (label, title,
 *    helperText, placeholder, aria-label, subtitle, description, ...),
 *    including both arms of a ?: or the right side of &&/||;
 *  - literals passed to toast.*(), setError(), setNotice(), setMessage();
 *  - the same literals in object properties (label: "...", title: ...).
 *
 * Inside a component or hook the call is t(), with `const { t } =
 * useTranslation();` added at the top of it. Anywhere else (module helpers)
 * it is i18n.t(), which reads the language when it runs; a module-level
 * object property becomes a getter for the same reason.
 *
 * The output is a starting point: review the diff, and the JSON for keys
 * worth renaming or merging.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default || traverseModule;

const PROPS = new Set([
  "label", "title", "subtitle", "description", "helperText", "placeholder", "aria-label", "confirmLabel",
  "heading", "hint", "tooltip", "emptyText", "primary", "secondary", "message", "caption", "alt", "text",
  "noOptionsText", "loadingText", "fallbackLabel", "emptyLabel", "noDataText", "labelRowsPerPage", "emptyTitle", "emptyDescription", "actionLabel",
]);
const OBJECT_KEYS = new Set(["label", "heading", "title", "description", "subtitle", "helperText", "hint", "text", "message", "tooltip", "emptyText", "caption", "short", "long", "help", "helpText", "summary", "detail"]);
// Module-level lookup tables of prose, e.g. STATUS_HINT = {OPEN: "..."}.
const PROSE_TABLE = /(HINTS?|LABELS?|DESCRIPTIONS?|HELP|TEXTS?|TITLES?|MESSAGES?|CAPTIONS?|EXPLAINS?|EXPLANATIONS?)$/;
const SETTERS = new Set(["setError", "setNotice", "setMessage", "setInfo", "setWarning", "setSuccess", "notify"]);
const TOAST = new Set(["success", "error", "info", "warning"]);

const [srcDir, outPath, ...rest] = process.argv.slice(2);
const dry = rest.includes("--dry");
const only = rest.filter((a) => !a.startsWith("--"));

const hasWords = (s) => /[A-Za-z]{2,}/.test(s);
const decode = (s) =>
  s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&rsquo;/g, "’").replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”").replace(/&hellip;/g, "…").replace(/&mdash;/g, "—").replace(/&middot;/g, "·");

// React's rule for JSX text: trim each line, drop blank lines, join with a space.
function cleanJsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) lastNonEmpty = i;
  });
  let out = "";
  lines.forEach((line, i) => {
    const first = i === 0;
    const last = i === lines.length - 1;
    const isLastNonEmpty = i === lastNonEmpty;
    let trimmed = line.replace(/\t/g, " ");
    if (!first) trimmed = trimmed.replace(/^[ ]+/, "");
    if (!last) trimmed = trimmed.replace(/[ ]+$/, "");
    if (trimmed) {
      if (!isLastNonEmpty) trimmed += " ";
      out += trimmed;
    }
  });
  return decode(out);
}

const camel = (s) =>
  s
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("")
    .slice(0, 36) || "text";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === "packages" ? [] : walk(p);
    return /\.(jsx|js)$/.test(name) ? [p] : [];
  });
}

const catalogue = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const files = only.length ? only.map((f) => join(srcDir, f)) : walk(srcDir);
let total = 0;

for (const file of files) {
  const code = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["jsx"] });
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
    continue;
  }
  const stemBase = basename(file, extname(file));
  const stem = stemBase.charAt(0).toLowerCase() + stemBase.slice(1);
  const section = (catalogue[stem] = catalogue[stem] || {});
  const byText = new Map(Object.entries(section).map(([k, v]) => [v, k]));
  const edits = [];
  const hookFns = new Set();
  let usesI18n = false;
  const claimed = [];

  const keyFor = (text) => {
    if (byText.has(text)) return `${stem}.${byText.get(text)}`;
    let slug = camel(text);
    let n = 2;
    while (section[slug] !== undefined && section[slug] !== text) slug = `${camel(text)}${n++}`;
    section[slug] = text;
    byText.set(text, slug);
    return `${stem}.${slug}`;
  };
  const overlaps = (s, e) => claimed.some(([a, b]) => s < b && e > a);
  const claim = (s, e) => claimed.push([s, e]);

  const isComponentOrHook = (fnPath) => {
    let name = fnPath.node.id?.name;
    if (!name && fnPath.parentPath.isVariableDeclarator()) name = fnPath.parentPath.node.id.name;
    if (!name && fnPath.parentPath.isCallExpression()) {
      // memo(function X() {}), forwardRef((props, ref) => ...)
      const decl = fnPath.parentPath.parentPath;
      if (decl?.isVariableDeclarator()) name = decl.node.id.name;
    }
    if (!name && fnPath.parentPath.isExportDefaultDeclaration()) name = "Default";
    return Boolean(name && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name)));
  };

  // t() if a component/hook encloses this node and no inner `t` shadows it;
  // otherwise i18n.t().
  function caller(path) {
    const binding = path.scope.getBinding("t");
    let fn = path.getFunctionParent();
    while (fn && !isComponentOrHook(fn)) fn = fn.getFunctionParent();
    if (!fn) {
      usesI18n = true;
      return { fn: "i18n.t", inModule: !path.getFunctionParent() };
    }
    if (binding && binding.kind !== "const") {
      usesI18n = true;
      return { fn: "i18n.t", inModule: false };
    }
    hookFns.add(fn);
    return { fn: "t", inModule: false };
  }

  const names = (exprs) => {
    const used = new Set();
    return exprs.map((e, i) => {
      let n = e.type === "Identifier" ? e.name : e.type === "MemberExpression" && !e.computed ? e.property.name : `v${i}`;
      if (["t", "lng", "ns", "defaultValue", "context", "replace"].includes(n)) n = `${n}Value`;
      let candidate = n;
      let k = 2;
      while (used.has(candidate)) candidate = `${n}${k++}`;
      used.add(candidate);
      return candidate;
    });
  };
  const src = (node) => code.slice(node.start, node.end);
  function replaceLiteral(path, node, { inJsxAttr = false } = {}) {
    if (overlaps(node.start, node.end)) return;
    const c = caller(path);
    let call;
    if (node.type === "StringLiteral") {
      if (!hasWords(node.value)) return;
      call = `${c.fn}("${keyFor(node.value)}")`;
    } else if (node.type === "TemplateLiteral") {
      if (node.expressions.some((e) => /JSX|Template/.test(e.type))) return;
      const quasis = node.quasis.map((q) => q.value.cooked);
      if (!hasWords(quasis.join(""))) return;
      const ids = names(node.expressions);
      let text = "";
      quasis.forEach((q, i) => {
        text += q;
        if (i < ids.length) text += `{{${ids[i]}}}`;
      });
      const args = node.expressions.map((e, i) => (ids[i] === src(e) ? ids[i] : `${ids[i]}: ${src(e)}`)).join(", ");
      call = `${c.fn}("${keyFor(text)}", { ${args} })`;
    } else return;
    claim(node.start, node.end);
    edits.push({ start: node.start, end: node.end, text: inJsxAttr ? `{${call}}` : call });
    total += 1;
  }

  // Literals reachable through ?:, &&, || inside an expression.
  function eachLiteral(path, fn) {
    const n = path.node;
    if (n.type === "StringLiteral" || n.type === "TemplateLiteral") fn(path);
    else if (n.type === "ConditionalExpression") {
      eachLiteral(path.get("consequent"), fn);
      eachLiteral(path.get("alternate"), fn);
    } else if (n.type === "LogicalExpression") {
      eachLiteral(path.get("right"), fn);
      if (n.operator !== "&&") eachLiteral(path.get("left"), fn);
    }
  }

  const simpleExpr = (e) => !JSON.stringify(e, (k, v) => (k === "loc" ? undefined : v)).includes('"JSX');

  traverse(ast, {
    JSXElement(path) {
      const kids = path.node.children;
      const texts = kids.filter((k) => k.type === "JSXText" && hasWords(cleanJsxText(k.value)));
      if (!texts.length) return;
      const onlySimple = kids.every(
        (k) =>
          k.type === "JSXText" ||
          (k.type === "JSXExpressionContainer" && k.expression.type !== "JSXEmptyExpression" && simpleExpr(k.expression))
      );
      const exprKids = kids.filter((k) => k.type === "JSXExpressionContainer" && k.expression.type !== "StringLiteral");
      if (onlySimple && exprKids.length && exprKids.length <= 6) {
        // One sentence with slots.
        const ids = names(exprKids.map((k) => k.expression));
        let text = "";
        let i = 0;
        for (const k of kids) {
          if (k.type === "JSXText") text += cleanJsxText(k.value).replace(/^\s+/, (m) => (text ? " " : "")).replace(/\s+$/, (m) => " ");
          else if (k.expression.type === "StringLiteral") text += k.expression.value;
          else text += `{{${ids[i++]}}}`;
        }
        text = text.replace(/\s+/g, " ").trim();
        const first = kids[0];
        const last = kids[kids.length - 1];
        if (overlaps(first.start, last.end)) return;
        const c = caller(path);
        const args = exprKids.map((k, j) => (ids[j] === src(k.expression) ? ids[j] : `${ids[j]}: ${src(k.expression)}`)).join(", ");
        // Keep the original leading/trailing newlines+indent.
        const lead = code.slice(first.start, last.end).match(/^\s*/)[0];
        const trail = code.slice(first.start, last.end).match(/\s*$/)[0];
        claim(first.start, last.end);
        edits.push({ start: first.start, end: last.end, text: `${lead}{${c.fn}("${keyFor(text)}", { ${args} })}${trail}` });
        total += 1;
        return;
      }
      for (const k of texts) {
        if (overlaps(k.start, k.end)) continue;
        const cleaned = cleanJsxText(k.value);
        const core = cleaned.trim();
        const raw = k.value;
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        // Inline neighbours need their separating space kept as {" "}.
        const keepLead = /^[ \t]+/.test(raw) && !/\n/.test(lead) ? '{" "}' : "";
        const keepTrail = /[ \t]+$/.test(raw) && !/\n/.test(trail) ? '{" "}' : "";
        const c = caller(path);
        claim(k.start, k.end);
        edits.push({ start: k.start, end: k.end, text: `${/\n/.test(lead) ? lead : ""}${keepLead}{${c.fn}("${keyFor(core)}")}${keepTrail}${/\n/.test(trail) ? trail : ""}` });
        total += 1;
      }
    },
    JSXExpressionContainer(path) {
      // {busy ? "Saving…" : "Save"} as a child.
      if (!path.parentPath.isJSXElement() && !path.parentPath.isJSXFragment()) return;
      eachLiteral(path.get("expression"), (p) => replaceLiteral(p, p.node));
    },
    JSXAttribute(path) {
      const name = path.node.name.name;
      if (!PROPS.has(name)) return;
      const v = path.get("value");
      if (!v.node) return;
      if (v.isStringLiteral()) replaceLiteral(v, v.node, { inJsxAttr: true });
      else if (v.isJSXExpressionContainer()) eachLiteral(v.get("expression"), (p) => replaceLiteral(p, p.node));
    },
    CallExpression(path) {
      const callee = path.node.callee;
      const isToast =
        callee.type === "MemberExpression" && !callee.computed && TOAST.has(callee.property.name) && /toast|notify|snack/i.test(src(callee.object));
      const isSetter = callee.type === "Identifier" && SETTERS.has(callee.name);
      const isErrorMessage = callee.type === "Identifier" && callee.name === "errorMessage" && path.node.arguments.length > 1;
      if (isToast || isSetter) {
        const arg = path.get("arguments.0");
        if (arg?.node) eachLiteral(arg, (p) => replaceLiteral(p, p.node));
      } else if (isErrorMessage) {
        eachLiteral(path.get("arguments.1"), (p) => replaceLiteral(p, p.node));
      } else if (callee.type === "NewExpression" || (callee.type === "Identifier" && callee.name === "Error")) {
        // leave thrown errors alone
      }
    },
    AssignmentExpression(path) {
      // errors.name = "Required" in form validators.
      const left = path.node.left;
      if (left.type !== "MemberExpression") return;
      const owner = left.object.type === "Identifier" ? left.object.name : "";
      if (!/error|problem|message/i.test(owner)) return;
      eachLiteral(path.get("right"), (p) => replaceLiteral(p, p.node));
    },
    VariableDeclarator(path) {
      if (path.getFunctionParent()) return;
      if (path.node.id.type !== "Identifier" || !PROSE_TABLE.test(path.node.id.name)) return;
      if (path.node.init?.type !== "ObjectExpression") return;
      for (const prop of path.node.init.properties) {
        if (prop.type !== "ObjectProperty" || prop.value.type !== "StringLiteral" || !hasWords(prop.value.value)) continue;
        if (overlaps(prop.start, prop.end)) continue;
        usesI18n = true;
        const keySrc = prop.computed ? `[${src(prop.key)}]` : src(prop.key);
        claim(prop.start, prop.end);
        edits.push({ start: prop.start, end: prop.end, text: `get ${keySrc}() { return i18n.t("${keyFor(prop.value.value)}"); }` });
        total += 1;
      }
    },
    ObjectProperty(path) {
      const keyNode = path.node.key;
      const keyName = keyNode.type === "Identifier" ? keyNode.name : keyNode.type === "StringLiteral" ? keyNode.value : null;
      if (!keyName || !OBJECT_KEYS.has(keyName)) return;
      const v = path.get("value");
      if (!(v.isStringLiteral() || v.isTemplateLiteral())) return;
      if (v.isStringLiteral() && !hasWords(v.node.value)) return;
      // Inside sx/style objects these are never prose.
      if (path.findParent((p) => p.isJSXAttribute() && ["sx", "style"].includes(p.node.name.name))) return;
      const inModule = !path.getFunctionParent();
      if (inModule) {
        if (overlaps(path.node.start, path.node.end)) return;
        usesI18n = true;
        const text = v.isStringLiteral() ? v.node.value : null;
        if (text === null) return;
        claim(path.node.start, path.node.end);
        edits.push({ start: path.node.start, end: path.node.end, text: `get ${keyName.includes("-") ? JSON.stringify(keyName) : keyName}() { return i18n.t("${keyFor(text)}"); }` });
        total += 1;
      } else {
        replaceLiteral(v, v.node);
      }
    },
  });

  if (!edits.length) continue;

  // Hooks: `const { t } = useTranslation();` at the top of each component.
  for (const fn of hookFns) {
    const body = fn.node.body;
    if (fn.scope.hasOwnBinding("t")) continue;
    if (body.type === "BlockStatement") {
      const indentMatch = code.slice(0, body.body[0]?.start ?? body.end).match(/\n([ \t]*)[^\n]*$/);
      const indent = body.body[0] ? indentMatch[1] : "  ";
      edits.push({ start: body.start + 1, end: body.start + 1, text: `\n${indent}const { t } = useTranslation();` });
    } else {
      edits.push({ start: body.start, end: body.start, text: "{\n  const { t } = useTranslation();\n  return " });
      edits.push({ start: body.end, end: body.end, text: ";\n}" });
    }
  }

  const imports = [];
  if (hookFns.size && !/from "react-i18next"/.test(code)) imports.push('import { useTranslation } from "react-i18next";');
  if (usesI18n && !/import i18n from "i18next"/.test(code)) imports.push('import i18n from "i18next";');
  if (imports.length) {
    const lastImport = ast.program.body.filter((n) => n.type === "ImportDeclaration").pop();
    const at = lastImport ? lastImport.end : 0;
    edits.push({ start: at, end: at, text: lastImport ? `\n${imports.join("\n")}` : `${imports.join("\n")}\n` });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  if (!dry) writeFileSync(file, out);
  console.log(`${relative(srcDir, file)}: ${edits.length} edits`);
}

if (!dry) writeFileSync(outPath, `${JSON.stringify(catalogue, null, 2)}\n`);
console.log(`${total} strings`);
