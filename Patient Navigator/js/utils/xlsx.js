// ============================================================
// exportToXLSX: hand somebody a real .xlsx instead of a CSV.
//
// CSV is fine until it is not. A caller note with a comma and a newline in it,
// a 10-digit phone number that Excel renders as 9.19876E+09, a date that
// becomes American on one machine and Indian on another: all of those are CSV
// problems and none of them are Excel problems. The research team opens these
// files in Excel, so they should be Excel files.
//
// SheetJS is loaded LAZILY, on the first click, not in index.html. It is about
// 400 KB and the overwhelming majority of sessions never export anything, so
// putting it in the boot path would slow the portal down for everyone to serve
// a button some people press once a week. The import is cached by the browser
// after the first use.
// ============================================================

const CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm';
let xlsxPromise = null;

function loadXLSX() {
  if (!xlsxPromise) {
    xlsxPromise = import(/* @vite-ignore */ CDN).catch((e) => {
      xlsxPromise = null;   // a failed load must not poison every later click
      throw new Error('The spreadsheet library could not be loaded. Check the connection, or use CSV.');
    });
  }
  return xlsxPromise;
}

// Excel decides a cell is a number, a date or text by looking at it, and gets
// two of those wrong for this data. A phone number and a patient code are text
// even though they look numeric; a real count is a number even though it
// arrives from Postgres as a string.
function cellValue(raw, col) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (col && col.text) return String(raw);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'object') return JSON.stringify(raw);
  const s = String(raw);
  // A leading zero is meaningful in a phone number and a pin code, so anything
  // carrying one stays text. So does anything long enough to lose precision.
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s) && s.length <= 15) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/**
 * @param {object[]} data      rows
 * @param {string}   filename  without extension; the date is appended
 * @param {{label:string, accessor?:Function, key?:string, text?:boolean}[]} columns
 * @param {string}   [sheetName]
 */
export async function exportToXLSX(data, filename, columns, sheetName = 'Data') {
  if (!data || !data.length) return;
  const XLSX = await loadXLSX();

  const header = columns.map((c) => c.label);
  const body = data.map((row) => columns.map((c) => {
    const raw = c.accessor ? c.accessor(row) : row[c.key];
    return cellValue(raw, c);
  }));

  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);

  // Column widths from the content, capped so one long free-text note does not
  // push every other column off the screen.
  ws['!cols'] = header.map((h, i) => {
    let w = String(h).length;
    for (let r = 0; r < Math.min(body.length, 400); r++) {
      w = Math.max(w, String(body[r][i] ?? '').length);
    }
    return { wch: Math.min(Math.max(w + 2, 9), 46) };
  });
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  if (body.length) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: header.length - 1, r: body.length } }) };
  }

  const wb = XLSX.utils.book_new();
  // Excel refuses sheet names over 31 chars or carrying any of : \ / ? * [ ]
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Data');
  XLSX.writeFile(wb, `${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
