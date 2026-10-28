/**
 * Spreadsheet-safe CSV from rows already in the browser. A leading = + - @
 * is quoted with an apostrophe so a camera named "=HYPERLINK(...)" cannot run
 * as a formula when the export is opened in Excel.
 */
const cell = (value) => {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(rows, columns) {
  const head = columns.map((c) => cell(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => cell(c.value ? c.value(row) : row[c.key])).join(","));
  // BOM: Excel otherwise reads UTF-8 (Arabic names) as Windows-1252.
  return `\uFEFF${[head, ...body].join("\r\n")}`;
}

/** Save a Blob (or CSV text) under `filename`. */
export function downloadBlob(data, filename, type = "text/csv;charset=utf-8") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadCsv = (rows, columns, filename) => downloadBlob(toCsv(rows, columns), filename);

/** "events-2026-10-27.csv" */
export const datedFilename = (stem, ext = "csv") => `${stem}-${new Date().toISOString().slice(0, 10)}.${ext}`;
