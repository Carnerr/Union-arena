#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeCatalog, validateCatalog } from "../src/catalog.js";

const [, , inputPath, outputPath = "data/imported-catalog.json"] = process.argv;

if (!inputPath) {
  console.error("Usage: node tools/import-catalog.mjs <cards.json|cards.csv> [output.json]");
  process.exit(1);
}

const input = readFileSync(inputPath, "utf8");
const records = inputPath.toLowerCase().endsWith(".csv")
  ? parseCsv(input)
  : JSON.parse(input);
const catalog = normalizeCatalog(records.cards ?? records);
validateCatalog(catalog);
writeFileSync(outputPath, `${JSON.stringify({ cards: catalog }, null, 2)}\n`);
console.log(`Wrote ${Object.keys(catalog).length} cards to ${outputPath}`);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [headers, ...data] = rows.filter((item) => item.some((cell) => cell.trim()));
  return data.map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header.trim()] = cells[index]?.trim() ?? "";
    });
    return record;
  });
}
