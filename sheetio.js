/* sheetio.js — reads LibreOffice .ods, .csv and .xlsx; writes results back.
   Runs in the dashboard page (needs DOMParser, DecompressionStream). No network. */
(function (root) {
  'use strict';
  const NS = {
    office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
    table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
    text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
  };
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8');

  /* ---------- ZIP ---------- */
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  function readZip(bytes) {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--)
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This file is not a valid .ods/.xlsx (zip) file.');
    const count = u16(bytes, eocd + 10);
    let p = u32(bytes, eocd + 16);
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('Corrupt zip directory.');
      const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
      entries.push({
        flags: u16(bytes, p + 8), method: u16(bytes, p + 10), time: u16(bytes, p + 12), date: u16(bytes, p + 14),
        crc: u32(bytes, p + 16), csize: u32(bytes, p + 20), usize: u32(bytes, p + 24),
        offset: u32(bytes, p + 42), name: dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }
  function rawData(bytes, e) {
    const o = e.offset;
    if (u32(bytes, o) !== 0x04034b50) throw new Error('Corrupt zip entry: ' + e.name);
    const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    return bytes.subarray(start, start + e.csize);
  }
  async function pump(stream, data) {
    const w = stream.writable.getWriter();
    w.write(data).catch(() => {}); w.close().catch(() => {});
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  }
  async function unzipEntry(bytes, e) {
    const raw = rawData(bytes, e);
    if (e.method === 0) return raw.slice();
    if (e.method === 8) return pump(new DecompressionStream('deflate-raw'), raw);
    throw new Error('Unsupported zip compression in ' + e.name);
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  // parts: [{name, method, flags, time, date, crc, usize, data(compressed bytes as stored)}]
  function writeZip(parts) {
    const chunks = [], central = [];
    let offset = 0;
    const push = a => { chunks.push(a); offset += a.length; };
    for (const p of parts) {
      const name = enc.encode(p.name), flags = (p.flags & 0x0800) | 0;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, flags, true);
      h.setUint16(8, p.method, true); h.setUint16(10, p.time, true); h.setUint16(12, p.date, true);
      h.setUint32(14, p.crc, true); h.setUint32(18, p.data.length, true); h.setUint32(22, p.usize, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      central.push({ p, name, flags, offset });
      push(new Uint8Array(h.buffer)); push(name); push(p.data);
    }
    const cdStart = offset;
    for (const c of central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, c.flags, true);
      h.setUint16(10, c.p.method, true); h.setUint16(12, c.p.time, true); h.setUint16(14, c.p.date, true);
      h.setUint32(16, c.p.crc, true); h.setUint32(20, c.p.data.length, true); h.setUint32(24, c.p.usize, true);
      h.setUint16(28, c.name.length, true); h.setUint32(42, c.offset, true);
      push(new Uint8Array(h.buffer)); push(c.name);
    }
    const cdSize = offset - cdStart;
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, cdStart, true);
    push(new Uint8Array(e.buffer));
    const out = new Uint8Array(offset); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /* ---------- helpers ---------- */
  const parseXml = text => {
    const d = new DOMParser().parseFromString(text, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error('The spreadsheet XML could not be read.');
    return d;
  };
  const kids = (el, ns, local) => [...el.childNodes].filter(n => n.nodeType === 1 && n.localName === local && (!ns || n.namespaceURI === ns));
  const colName = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const colIndex = ref => { let n = 0; for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

  /* ---------- ODS ---------- */
  function odsText(cell) {
    const out = [];
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out.push(c.nodeValue);
        else if (c.nodeType === 1) {
          if (c.namespaceURI === NS.text && c.localName === 's') out.push(' '.repeat(+c.getAttributeNS(NS.text, 'c') || 1));
          else if (c.namespaceURI === NS.text && c.localName === 'tab') out.push('\t');
          else if (c.namespaceURI === NS.text && c.localName === 'line-break') out.push('\n');
          else walk(c);
        }
      }
    };
    const ps = kids(cell, NS.text, 'p');
    ps.forEach((p, i) => { if (i) out.push('\n'); walk(p); });
    return out.join('');
  }
  function odsValue(cell) {
    const type = cell.getAttributeNS(NS.office, 'value-type');
    if (type === 'float' || type === 'percentage' || type === 'currency') {
      const v = cell.getAttributeNS(NS.office, 'value');
      if (v !== null && v !== '') return v;
    }
    if (type === 'string') { const s = cell.getAttributeNS(NS.office, 'string-value'); if (s) return s; }
    if (type === 'date') { const v = cell.getAttributeNS(NS.office, 'date-value'); if (v) return v; }
    return odsText(cell);
  }
  const isCellEl = n => n.nodeType === 1 && n.namespaceURI === NS.table && (n.localName === 'table-cell' || n.localName === 'covered-table-cell');
  const rep = (el, attr) => Math.max(1, +el.getAttributeNS(NS.table, attr) || 1);
  function tableRowEls(table) {
    const rows = [];
    const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1 && c.namespaceURI === NS.table) {
      if (c.localName === 'table-row') rows.push(c);
      else if (['table-header-rows', 'table-row-group', 'table-rows'].includes(c.localName)) walk(c);
    } };
    walk(table);
    return rows;
  }
  function rowHasContent(row) {
    return [...row.childNodes].some(c => isCellEl(c) && (c.hasAttributeNS(NS.office, 'value-type') || c.childNodes.length));
  }
  // Expand repeated NON-empty rows/cells so every real row and cell has its own element.
  function normalizeTable(table) {
    for (const row of tableRowEls(table)) {
      const n = rep(row, 'number-rows-repeated');
      if (n > 1 && rowHasContent(row) && n <= 500) {
        row.removeAttributeNS(NS.table, 'number-rows-repeated');
        let after = row;
        for (let i = 1; i < n; i++) { const c = row.cloneNode(true); after.parentNode.insertBefore(c, after.nextSibling); after = c; }
      }
    }
    for (const row of tableRowEls(table)) {
      for (const cell of [...row.childNodes].filter(isCellEl)) {
        const n = rep(cell, 'number-columns-repeated');
        if (n > 1 && n <= 60 && (cell.hasAttributeNS(NS.office, 'value-type') || cell.childNodes.length)) {
          cell.removeAttributeNS(NS.table, 'number-columns-repeated');
          let after = cell;
          for (let i = 1; i < n; i++) { const c = cell.cloneNode(true); after.parentNode.insertBefore(c, after.nextSibling); after = c; }
        }
      }
    }
  }
  // Returns sparse grid: [{r (0-based logical row), el, cells: [strings]}] for non-empty rows only.
  function odsGrid(table) {
    const grid = []; let r = 0;
    for (const row of tableRowEls(table)) {
      const n = rep(row, 'number-rows-repeated');
      const cells = []; let c = 0;
      for (const cell of [...row.childNodes].filter(isCellEl)) {
        const cn = rep(cell, 'number-columns-repeated');
        const v = cell.localName === 'covered-table-cell' ? '' : odsValue(cell);
        if (v !== '') for (let k = 0; k < Math.min(cn, 200); k++) cells[c + k] = v;
        c += cn;
      }
      if (cells.some(v => v !== undefined && v !== '')) grid.push({ r, el: row, cells: Array.from(cells, v => v ?? '') });
      r += n;
    }
    return grid;
  }
  function odsSetCell(doc, row, col, text) {
    const cells = [...row.childNodes].filter(isCellEl);
    let pos = 0, target = null;
    for (const cell of cells) {
      const n = rep(cell, 'number-columns-repeated');
      if (col < pos + n) {
        if (n > 1) { // split the repeated blank cell around col
          const before = col - pos, afterN = n - before - 1;
          cell.removeAttributeNS(NS.table, 'number-columns-repeated');
          if (before > 0) { const b = cell.cloneNode(true); b.setAttributeNS(NS.table, 'table:number-columns-repeated', String(before)); cell.parentNode.insertBefore(b, cell); }
          if (afterN > 0) { const a = cell.cloneNode(true); a.setAttributeNS(NS.table, 'table:number-columns-repeated', String(afterN)); cell.parentNode.insertBefore(a, cell.nextSibling); }
        }
        target = cell; break;
      }
      pos += n;
    }
    if (!target) {
      if (pos < col) { const gap = doc.createElementNS(NS.table, 'table:table-cell'); gap.setAttributeNS(NS.table, 'table:number-columns-repeated', String(col - pos)); row.appendChild(gap); }
      target = doc.createElementNS(NS.table, 'table:table-cell'); row.appendChild(target);
    }
    if (target.localName === 'covered-table-cell') return; // never write into merged-away cells
    for (const a of ['value-type', 'value', 'string-value', 'date-value', 'boolean-value', 'currency', 'time-value'])
      target.removeAttributeNS(NS.office, a);
    target.removeAttributeNS(NS.table, 'formula');
    while (target.firstChild) target.removeChild(target.firstChild);
    if (text === '' || text == null) return;
    target.setAttributeNS(NS.office, 'office:value-type', 'string');
    String(text).split('\n').forEach(line => { const p = doc.createElementNS(NS.text, 'text:p'); p.textContent = line; target.appendChild(p); });
  }

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  const csvEscape = v => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

  /* ---------- XLSX (read only) ---------- */
  async function readXlsx(bytes) {
    const entries = readZip(bytes), get = async n => { const e = entries.find(x => x.name === n); return e ? dec.decode(await unzipEntry(bytes, e)) : null; };
    const wb = parseXml(await get('xl/workbook.xml')), rels = parseXml(await get('xl/_rels/workbook.xml.rels'));
    const shared = [];
    const sst = await get('xl/sharedStrings.xml');
    if (sst) for (const si of parseXml(sst).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
    const sheets = [];
    for (const s of wb.getElementsByTagName('sheet')) {
      const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const rel = [...rels.getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid);
      const path = 'xl/' + rel.getAttribute('Target').replace(/^\/?(xl\/)?/, '');
      const doc = parseXml(await get(path)); const rows = [];
      for (const rowEl of doc.getElementsByTagName('row')) {
        const cells = [];
        for (const c of rowEl.getElementsByTagName('c')) {
          const t = c.getAttribute('t'), vEl = c.getElementsByTagName('v')[0]; let v = vEl ? vEl.textContent : '';
          if (t === 's') v = shared[+v] ?? ''; else if (t === 'inlineStr') v = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
          cells[colIndex(c.getAttribute('r'))] = v;
        }
        rows[+rowEl.getAttribute('r') - 1] = Array.from(cells, v => v ?? '');
      }
      sheets.push({ name: s.getAttribute('name'), rows: Array.from(rows, r => r || []) });
    }
    return sheets;
  }

  /* ---------- Column detection ---------- */
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const SYN = {
    store: ['storecode', 'store', 'storeid', 'storeno', 'locationcode', 'code'],
    name: ['businessname', 'storename', 'name', 'title'],
    address: ['streetaddress', 'streetaddressline1', 'addressline1', 'address1', 'address', 'street'],
    address2: ['streetaddressline2', 'addressline2', 'address2'],
    address3: ['streetaddressline3', 'addressline3', 'address3'],
    locality: ['locality', 'city', 'town'],
    admin: ['administrativearea', 'state', 'province', 'region'],
    postal: ['postalcode', 'pincode', 'pin', 'zipcode', 'zip', 'postcode'],
    latitude: ['latitude', 'lat'],
    longitude: ['longitude', 'lng', 'long', 'lon'],
    team: ['team'], remarks: ['remarks', 'remark', 'notes', 'comments', 'comment']
  };
  function detectColumns(matrix) { // matrix: array of rows (arrays of strings, indexed by column)
    for (let r = 0; r < Math.min(matrix.length, 15); r++) {
      const row = matrix[r] || [], map = {};
      const used = new Set();
      for (const [key, names] of Object.entries(SYN)) {
        // earlier synonyms win: "Business name" beats a plain "Name" column, "Store code" beats "Code"
        for (const n of names) {
          const i = row.findIndex((h, ci) => !used.has(ci) && norm(h) === n);
          if (i >= 0) { map[key] = i; used.add(i); break; }
        }
      }
      if (map.store !== undefined) return { headerRow: r, map };
    }
    return null;
  }
  const RESULT_HEADERS = ['Coordinate status', 'Name check', 'Address check', 'Locality check', 'Admin area check', 'Postal code check', 'Business Manager shows', 'Last checked', 'Notes'];

  function cleanNumber(v) { // "9.089 775" / "9,089775" / " 9.0 " -> number or NaN
    let s = String(v ?? '').trim().replace(/\s+/g, '');
    if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }
  const cleanText = v => { v = String(v ?? '').trim(); return /^-?\d+\.0+$/.test(v) ? v.replace(/\.0+$/, '') : v; };

  /* ---------- Public API ---------- */
  // load(file) -> {kind, sheets:[{name, matrix, detect}], bytes, ...}
  async function load(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'ods') {
      const entries = readZip(bytes), e = entries.find(x => x.name === 'content.xml');
      if (!e) throw new Error('content.xml not found: not a LibreOffice .ods file.');
      const doc = parseXml(dec.decode(await unzipEntry(bytes, e)));
      const tables = [...doc.getElementsByTagNameNS(NS.table, 'table')].filter(t => t.parentNode.localName === 'spreadsheet');
      const sheets = tables.map(t => {
        normalizeTable(t);
        const grid = odsGrid(t), matrix = [];
        for (const g of grid) matrix[g.r] = g.cells;
        return { name: t.getAttributeNS(NS.table, 'name'), matrix: Array.from(matrix, r => r || []), grid, el: t };
      });
      sheets.forEach(s => s.detect = detectColumns(s.matrix));
      return { kind: 'ods', name: file.name, bytes, entries, doc, sheets };
    }
    if (ext === 'xlsx') {
      const sheets = (await readXlsx(bytes)).map(s => ({ name: s.name, matrix: s.rows }));
      sheets.forEach(s => s.detect = detectColumns(s.matrix));
      return { kind: 'xlsx', name: file.name, bytes, sheets };
    }
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      const matrix = parseCsv(dec.decode(bytes));
      const sheets = [{ name: 'CSV', matrix }]; sheets[0].detect = detectColumns(matrix);
      return { kind: 'csv', name: file.name, bytes, sheets };
    }
    throw new Error('Please choose a LibreOffice .ods file (or .csv / .xlsx).');
  }

  // queueFromSheet(sheet) -> {rows, problems}
  function queueFromSheet(sheet) {
    if (!sheet.detect) return { rows: [], problems: ['Could not find the header row. It needs a Store code column.'] };
    const { headerRow, map } = sheet.detect, rows = [], problems = [], seen = new Map();
    for (let r = headerRow + 1; r < sheet.matrix.length; r++) {
      const m = sheet.matrix[r]; if (!m || !m.some(v => String(v).trim() !== '')) continue;
      const get = k => map[k] === undefined ? '' : cleanText(m[map[k]]);
      const store = get('store'), lat = cleanNumber(get('latitude')), lng = cleanNumber(get('longitude'));
      const row = { store, name: get('name'), address: get('address'), address2: get('address2'), address3: get('address3'),
        locality: get('locality'), admin: get('admin'), postal: get('postal'),
        latitude: lat, longitude: lng, team: get('team'), sheetRow: r + 1, status: 'queued' };
      const bad = [];
      if (!store) bad.push('no store code');
      row.coordinateError = RunPolicy.coordinateError(row);
      if (row.coordinateError) problems.push(`Row ${r + 1} (${store}): ${row.coordinateError} Address-only mode is still available.`);
      const dataKey = [row.name, row.address, row.address2, row.address3, row.locality, row.admin, row.postal, lat, lng].join('|').toLowerCase();
      if (!bad.length && store && seen.has(store)) {
        const first = seen.get(store);
        row.status = 'skipped'; row.sheetSkip = true;
        row.skipReason = first.key === dataKey
          ? 'Duplicate row in sheet (exact copy of row ' + first.row + ')'
          : 'Same store code as sheet row ' + first.row + ' but different data - row ' + first.row + ' is used for every business with this code';
        problems.push(`Row ${r + 1} (${store}): skipped - ${row.skipReason}`);
      } else if (store && !bad.length) seen.set(store, { row: r + 1, key: dataKey });
      if (bad.length) { row.status = 'invalid'; row.error = bad.join('; '); problems.push(`Row ${r + 1} (${store || 'no code'}): ${row.error}`); }
      rows.push(row);
    }
    return { rows, problems };
  }

  const STATUS_TEXT = {
    submitted: 'Done - saved in Business Manager', done_manual: 'Done (marked by you)', queued: 'Not done yet', processing: 'Interrupted - check this store',
    saving: 'Check this store (save may have gone through)', submitted_review: 'Check this store (save may have gone through)',
    reviewed_skip: 'Reviewed by you - check manually', skipped: 'Skipped', error: 'Not done - error', invalid: 'Not done - invalid data in sheet'
  };
  const CHECK_TEXT = { match: 'OK', partial: 'Partial match', mismatch: 'MISMATCH', not_found: 'Could not read', blank: '(blank in sheet)' };
  function resultCells(row) {
    const c = row.checks || {};
    return [STATUS_TEXT[row.status] || row.status || '', ...['name', 'address', 'locality', 'admin', 'postal'].map(k => c[k] ? CHECK_TEXT[c[k]] : ''),
      row.observed || '', row.checkedAt ? row.checkedAt.replace('T', ' ').slice(0, 16) : '', [row.error, row.checkError].filter(Boolean).join(' | ')];
  }

  // writeResults(loaded, sheetIndex, rows) -> {blob, filename, updated, missing}
  async function writeResults(loaded, sheetIndex, rows) {
    const sheet = loaded.sheets[sheetIndex];
    if (!sheet.detect) throw new Error('No header row detected on this sheet.');
    const { headerRow, map } = sheet.detect, byStore = new Map(rows.map(r => [r.store, r]));
    const hdr = sheet.matrix[headerRow];
    let last = hdr.length; while (last > 0 && String(hdr[last - 1]).trim() === '') last--;
    const cols = RESULT_HEADERS.map(h => { const i = hdr.findIndex(x => String(x).trim().toLowerCase() === h.toLowerCase()); return i >= 0 ? i : last++; });
    let updated = 0; const missing = [];
    const base = loaded.name.replace(/\.[^.]+$/, '');

    if (loaded.kind === 'ods') {
      const { doc } = loaded, hdrEntry = sheet.grid.find(g => g.r === headerRow);
      RESULT_HEADERS.forEach((h, i) => odsSetCell(doc, hdrEntry.el, cols[i], h));
      for (const g of sheet.grid) {
        if (g.r <= headerRow) continue;
        const store = cleanText(g.cells[map.store]), row = byStore.get(store);
        if (!store) continue;
        if (!row) { missing.push(store); continue; }
        resultCells(row).forEach((v, i) => odsSetCell(doc, g.el, cols[i], v)); updated++;
      }
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc.documentElement);
      const xmlBytes = enc.encode(xml), packed = await pump(new CompressionStream('deflate-raw'), xmlBytes);
      const parts = loaded.entries.map(e => e.name === 'content.xml'
        ? { name: e.name, method: 8, flags: e.flags, time: e.time, date: e.date, crc: crc32(xmlBytes), usize: xmlBytes.length, data: packed }
        : { name: e.name, method: e.method, flags: e.flags, time: e.time, date: e.date, crc: e.crc, usize: e.usize, data: rawData(loaded.bytes, e).slice() });
      return { blob: new Blob([writeZip(parts)], { type: 'application/vnd.oasis.opendocument.spreadsheet' }), filename: base + '_updated.ods', updated, missing };
    }
    // CSV / XLSX input -> updated CSV that LibreOffice opens directly
    const out = sheet.matrix.map(r => Array.from(r, v => v ?? ''));
    RESULT_HEADERS.forEach((h, i) => { out[headerRow][cols[i]] = h; });
    for (let r = headerRow + 1; r < out.length; r++) {
      const store = cleanText(out[r][map.store]), row = byStore.get(store);
      if (!store) continue;
      if (!row) { missing.push(store); continue; }
      resultCells(row).forEach((v, i) => { out[r][cols[i]] = v; }); updated++;
    }
    const width = Math.max(...out.map(r => r.length));
    const csv = '\ufeff' + out.map(r => Array.from({ length: width }, (_, i) => csvEscape(r[i])).join(',')).join('\r\n');
    return { blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename: base + '_updated.csv', updated, missing };
  }

  root.SheetIO = { load, queueFromSheet, writeResults, RESULT_HEADERS, colName, parseCsv, readZip, unzipEntry, crc32, writeZip, pump };
})(typeof globalThis !== 'undefined' ? globalThis : window);
