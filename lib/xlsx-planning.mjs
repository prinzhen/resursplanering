import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { WEEKLY_HEADERS, PROJECT_HEADERS } from "./planning-rules.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const escapeXml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const column = (i) => { let value = i + 1, out = ""; while (value) { value--; out = String.fromCharCode(65 + value % 26) + out; value = Math.floor(value / 26); } return out; };

function sheetXML(headers, rows, type) {
  const width = column(headers.length - 1);
  const allRows = [headers, ...rows];
  const cells = allRows.map((row, y) => {
    const values = row.map((v, x) => {
      const ref = column(x) + (y + 1);
      const style = y === 0 ? ' s="1"' : "";
      if (v === null || v === undefined || v === "") return "";
      if (y > 0 && typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
    }).join("");
    return `<row r="${y + 1}">${values}</row>`;
  }).join("");
  // Datavalidering i Excel och LibreOffice: tillåter också tomma veckodagar.
  const validations = type === "weekly" ?
    `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="B2:B10000"><formula1>"Måndag,Tisdag,Onsdag,Torsdag,Fredag,Lördag,Söndag"</formula1></dataValidation></dataValidations>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><dimension ref="A1:${width}${Math.max(1, allRows.length)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/><cols>${headers.map((h,i)=>`<col min="${i+1}" max="${i+1}" width="${Math.min(48, Math.max(14, h.length + 5))}" customWidth="1"/>`).join("")}</cols><sheetData>${cells}</sheetData><autoFilter ref="A1:${width}${Math.max(1, allRows.length)}"/>${validations}</worksheet>`;
}

/** Skapar en riktig OOXML XLSX, inte en CSV med ändrad filändelse. */
export function createPlanningWorkbook(type, rows = []) {
  if (!["weekly", "project"].includes(type)) throw new Error("Okänd malltyp");
  if (!Array.isArray(rows) || rows.length > 50000) throw new Error("För många planeringsrader");
  const headers = type === "weekly" ? WEEKLY_HEADERS : PROJECT_HEADERS;
  const ordered = rows.map(row => headers.map(header => row[header] ?? ""));
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${type === "weekly" ? "Veckoplanering" : "Projektplanering"}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFill="1" applyFont="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": sheetXML(headers, ordered, type),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));
}

/** Läser XLSX i webbläsaren. Ingen databasoperation sker här. */
export function parsePlanningWorkbook(buffer, type) {
  if (!["weekly", "project"].includes(type)) throw new Error("Okänd malltyp");
  const bytes = new Uint8Array(buffer);
  if (bytes.length > 15 * 1024 * 1024) throw new Error("Filen är för stor (max 15 MB)");
  const files = unzipSync(bytes);
  const xml = files["xl/worksheets/sheet1.xml"];
  if (!xml) throw new Error("Arbetsboken saknar första arbetsbladet");
  if (xml.byteLength > 40 * 1024 * 1024) throw new Error("Arbetsbladet är för stort");
  const parser = new DOMParser();
  const parse = bytes => {
    const document = parser.parseFromString(strFromU8(bytes), "application/xml");
    if (document.getElementsByTagName("parsererror").length) throw new Error("Felaktig XLSX/XML");
    return document;
  };
  const sheet = parse(xml);
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = sharedXml ? Array.from(parse(sharedXml).getElementsByTagNameNS(NS, "si")).map(si =>
    Array.from(si.getElementsByTagNameNS(NS, "t")).map(t => t.textContent ?? "").join("")
  ) : [];
  const rows = Array.from(sheet.getElementsByTagNameNS(NS, "row")).map(row => {
    const values = [];
    for (const cell of Array.from(row.getElementsByTagNameNS(NS, "c"))) {
      const ref = cell.getAttribute("r") ?? "";
      const letters = /^[A-Z]+/.exec(ref)?.[0];
      if (!letters) continue;
      let index = 0;
      for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
      index--;
      if (index > 100) throw new Error("För många kolumner");
      const kind = cell.getAttribute("t");
      const raw = cell.getElementsByTagNameNS(NS, "v")[0]?.textContent ?? "";
      let value = kind === "inlineStr" ?
        Array.from(cell.getElementsByTagNameNS(NS, "t")).map(t => t.textContent ?? "").join("") :
        kind === "s" ? shared[Number(raw)] ?? "" :
        kind === "b" ? raw === "1" : kind === "n" || (!kind && raw !== "") ? Number(raw) : raw;
      values[index] = value;
    }
    return values;
  });
  const expected = type === "weekly" ? WEEKLY_HEADERS : PROJECT_HEADERS;
  if (!rows.length || !expected.every((h, i) => String(rows[0][i] ?? "").trim() === h)) {
    throw new Error("Felaktiga kolumnrubriker eller kolumnordning för " + type);
  }
  if (rows.length > 50001) throw new Error("För många planeringsrader");
  return rows.slice(1).filter(row => row.some(value => value !== undefined && value !== "")).map(row =>
    Object.fromEntries(expected.map((name, i) => [name, row[i] ?? ""]))
  );
}
