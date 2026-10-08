/* xlsxout.js — builds the result workbook (.xlsx) from the saved sheet + the run log.
   Needs sheetio.js (zip helpers). No network. Also loadable in Node for testing. */
(function (root) {
  'use strict';
  const enc = new TextEncoder();
  const FIELDS = [['name', 'Business name'], ['address', 'Street address'], ['address2', 'Street address line 2'], ['address3', 'Street address line 3'],
    ['locality', 'Locality'], ['admin', 'Administrative area'], ['postal', 'Postal code']];
  const HEADERS = ['Run option', 'Coordinate status', 'Business name check', 'Address check', 'Locality check', 'Admin area check', 'Postal code check',
    ...FIELDS.map(f => f[1] + ' update'), 'Update summary',
    ...FIELDS.map(f => f[1] + ' after refresh'), 'Refresh check summary',
    'Skip reason', 'Shared store ID', 'Business Manager shows', 'Last checked', 'Notes'];
  const STATUS_TEXT = {
    submitted: 'Done - saved in Business Manager', done_manual: 'Done (marked by you)', queued: 'Not done yet', processing: 'Interrupted - check this store',
    saving: 'Check this store (save may have gone through)', submitted_review: 'Check this store (save may have gone through)',
    reviewed_skip: 'Reviewed by you - check manually', skipped: 'Skipped', error: 'Not done - error', invalid: 'Not done - invalid data in sheet'
  };
  const CHECK_TEXT = { match: 'OK', partial: 'Partial match', mismatch: 'MISMATCH', not_found: 'Could not read', blank: '(blank in sheet)' };

  function updateText(tg, key) {
    if (tg.skip) return 'Skipped';
    const d = tg.detail?.[key];
    if (!d) return '';
    if (d === 'blank' && (key === 'address2' || key === 'address3')) return ''; // empty line 2 / 3 in the sheet: nothing to do, nothing to report
    if (d === 'updated') return (tg.notes?.[key] === 'cleared' ? 'Cleared (was: ' : 'Updated (was: ') + (tg.was?.[key] || '(empty)') + ')';
    return { ok: 'Already correct - no change', blank: 'Not updated - blank in sheet', notfound: 'Not updated - field not found on the page',
      failed: 'NOT updated - ' + (tg.notes?.[key] || 'could not change or save'), review: 'CHECK MANUALLY - save may not have gone through',
      pending: 'Not confirmed' }[d] || d;
  }
  // What the page showed after it was refreshed and the store opened again (read only).
  function refreshText(tg, key) {
    if (tg.skip) return '';
    const v = tg.verify?.[key];
    if (!v || typeof v !== 'object') return '';
    if (v.got === null || v.got === undefined) return 'Could not read after refresh';
    return v.ok ? 'Confirmed: ' + (v.got || '(empty)') : 'NOT matching - page shows: ' + v.got;
  }
  const VKEYS = FIELDS.map(f => f[0]);
  function refreshSummaryOne(tg) {
    if (tg.skip) return '';
    const v = tg.verify;
    const changed = Object.values(tg.detail || {}).includes('updated');
    if (!v) return changed ? 'NOT confirmed - page was not refreshed and re-read' : '';
    if (v.status === 'error') return 'COULD NOT CONFIRM - ' + (v.note || 'unknown reason');
    const keys = VKEYS.filter(k => v[k] && typeof v[k] === 'object');
    if (!keys.length) return '';
    const bad = keys.filter(k => !v[k].ok).map(k => FIELDS.find(f => f[0] === k)[1]);
    return bad.length ? 'MISMATCH after refresh: ' + bad.join(', ') : 'All ' + keys.length + ' values confirmed after refresh';
  }
  function refreshSummary(row) {
    const t = targetsOf(row); if (!t.length) return '';
    if (t.length === 1) return refreshSummaryOne(t[0]);
    return t.map((x, i) => refreshSummaryOne(x) ? 'Business #' + (i + 1) + ' - ' + refreshSummaryOne(x) : '').filter(Boolean).join(' || ');
  }
  function perFieldRefresh(row, key) {
    const t = targetsOf(row); if (!t.length) return '';
    if (t.length === 1) return refreshText(t[0], key);
    return t.map((x, i) => refreshText(x, key) ? '#' + (i + 1) + ': ' + refreshText(x, key) : '').filter(Boolean).join('; ');
  }
  function targetsOf(row) { return row.targets?.length ? row.targets : []; }
  const multi = row => Math.max(row.sharedCount || 0, targetsOf(row).length) > 1;
  function perField(row, key) {
    const t = targetsOf(row); if (!t.length) return '';
    if (t.length === 1) return updateText(t[0], key);
    return t.map((x, i) => '#' + (i + 1) + ': ' + (updateText(x, key) || '-')).join('; ');
  }
  function summaryText(row) {
    const one = tg => {
      if (tg.skip) return 'Skipped';
      const ups = FIELDS.filter(([k]) => tg.detail?.[k] === 'updated').map(f => f[1]);
      const bad = FIELDS.filter(([k]) => ['failed', 'review', 'pending', 'notfound'].includes(tg.detail?.[k])).map(f => f[1]);
      if (!Object.keys(tg.detail || {}).length) return '';
      return (ups.length ? 'Updated: ' + ups.join(', ') : 'No changes needed') + (bad.length ? ' | NOT updated: ' + bad.join(', ') : '');
    };
    const t = targetsOf(row); if (!t.length) return '';
    return t.length === 1 ? one(t[0]) : t.map((x, i) => 'Business #' + (i + 1) + ' - ' + (one(x) || 'not processed')).join(' || ');
  }
  function skipText(row) {
    if (row.skipReason && !targetsOf(row).some(t => t.skip)) return row.skipReason;
    const t = targetsOf(row).map((x, i) => x.skip ? (t0(row) > 1 ? '#' + (i + 1) + ': ' : '') + x.skip : '').filter(Boolean);
    return t.length ? t.join('; ') : (row.skipReason || '');
  }
  const t0 = row => Math.max(row.sharedCount || 0, targetsOf(row).length);
  function sharedText(row) {
    const n = t0(row); if (n < 2) return '';
    const t = targetsOf(row), done = t.filter(x => !x.skip && Object.keys(x.detail || {}).length || x.coordDone).length;
    return 'YES - ' + n + ' businesses share this store ID' + (t.length ? ' (' + done + ' processed, ' + (n - done) + ' skipped/not processed)' : '');
  }
  function resultCells(row) {
    const c = row.checks || {};
    return [({coords_address:'1 - Coordinates + address',coords_check:'2 - Coordinates + check address',address_only:'3 - Address only'})[row.lastRunMode] || '', STATUS_TEXT[row.status] || row.status || '',
      ...['name', 'address', 'locality', 'admin', 'postal'].map(k => c[k] ? CHECK_TEXT[c[k]] : ''),
      ...FIELDS.map(([k]) => perField(row, k)), summaryText(row),
      ...FIELDS.map(([k]) => perFieldRefresh(row, k)), refreshSummary(row), skipText(row), sharedText(row),
      row.targets?.length > 1 ? row.targets.map((x, i) => '#' + (i + 1) + ' ' + (x.shows || '')).join(' || ') : (row.observed || row.targets?.[0]?.shows || ''),
      row.checkedAt ? row.checkedAt.replace('T', ' ').slice(0, 16) : '', [row.detailsReview ? 'Review address save before resuming' : '', row.error, row.coordinateError, row.checkError, row.checkSummary, row.detailError, row.note, ...targetsOf(row).map(x => x.diag)].filter(Boolean).join(' | ')];
  }
  // style ids: 0 plain, 1 header, 2 green, 3 amber, 4 red, 5 blue
  function styleFor(header, text) {
    if (!text) return 0;
    if (/status$/i.test(header)) return /^Done/.test(text) ? 2 : /^Skipped/.test(text) ? 3 : /^Not done/.test(text) ? 4 : /^Not done yet/.test(text) ? 0 : 3;
    if (/ check$/i.test(header)) return text === 'OK' ? 2 : text === 'MISMATCH' ? 4 : text === '(blank in sheet)' ? 0 : 3;
    if (/ update$/i.test(header)) return /^(Updated|Cleared)/.test(text) ? 2 : /^(NOT|CHECK)/.test(text) ? 4 : /^(Skipped|Not updated|Not confirmed)/.test(text) ? 3 : /^#/.test(text) ? (/Updated|Cleared/.test(text) ? 2 : 0) : 0;
    if (/ after refresh$/i.test(header)) return /^Confirmed/.test(text) ? 2 : /^(NOT|Could not)/.test(text) ? 4 : /^#/.test(text) ? (/NOT|Could not/.test(text) ? 4 : 2) : 0;
    if (header === 'Refresh check summary') return /^All/.test(text) ? 2 : /(MISMATCH|NOT confirmed|COULD NOT)/.test(text) ? 4 : 0;
    if (header === 'Update summary') return /NOT updated/.test(text) ? 4 : /^Updated/.test(text) ? 2 : /^Skipped/.test(text) ? 3 : 0;
    if (header === 'Skip reason') return 3;
    if (header === 'Shared store ID') return 5;
    return 0;
  }
  const xmlEsc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colL = i => SheetIO.colName(i);
  function sheetXml(matrix, opts) { // matrix: rows of {v, s}; opts: header row index, numeric cols
    const widths = [];
    const rowsXml = matrix.map((r, ri) => {
      const cells = r.map((c, ci) => {
        if (c.v === '' || c.v == null) return c.s ? `<c r="${colL(ci)}${ri + 1}" s="${c.s}"/>` : '';
        widths[ci] = Math.max(widths[ci] || 0, Math.min(String(c.v).length, 60));
        const ref = `${colL(ci)}${ri + 1}`, st = c.s ? ` s="${c.s}"` : '';
        if (c.n) return `<c r="${ref}"${st}><v>${c.v}</v></c>`;
        return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const nCols = Math.max(...matrix.map(r => r.length), 1), nRows = matrix.length;
    const cols = Array.from({ length: nCols }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(10, Math.min(52, (widths[i] || 8) + 2))}" customWidth="1"/>`).join('');
    const h = opts.headerRow + 1;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${h}" topLeftCell="A${h + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${cols}</cols><sheetData>${rowsXml}</sheetData><autoFilter ref="A${h}:${colL(nCols - 1)}${nRows}"/></worksheet>`;
  }
  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    ['FF1F4E78', 'FFC6EFCE', 'FFFFEB9C', 'FFFFC7CE', 'FFBDD7EE'].map(c => `<fill><patternFill patternType="solid"><fgColor rgb="${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('') + '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    [3, 4, 5, 6].map(f => `<xf numFmtId="0" fontId="0" fillId="${f}" borderId="0" xfId="0" applyFill="1"/>`).join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const isNum = v => /^-?(0|[1-9]\d*)(\.\d+)?$/.test(String(v));
  // source: {name, matrix, headerRow, map, fileName}; rows: batchRows -> {blob, filename, counts}
  async function build(source, rows) {
    const matrix = Array.from(source.matrix, r => Array.from(r || [], v => v == null ? '' : String(v)));
    const { headerRow, map } = source, hdr = matrix[headerRow];
    let last = hdr.length; while (last > 0 && String(hdr[last - 1]).trim() === '') last--;
    const ALIAS = { 'Business name check': ['Name check'] };
    const cols = HEADERS.map(h => { const names = [h, ...(ALIAS[h] || [])].map(x => x.toLowerCase()); const i = hdr.findIndex(x => names.includes(String(x).trim().toLowerCase())); return i >= 0 ? i : last++; });
    const byRow = new Map(rows.map(r => [r.sheetRow - 1, r]));
    const width = Math.max(last, ...matrix.map(r => r.length));
    const numCols = new Set([map.latitude, map.longitude, map.postal].filter(i => i !== undefined));
    const out = matrix.map((r, ri) => {
      const cells = Array.from({ length: width }, (_, ci) => {
        const v = r[ci] ?? '';
        if (ri === headerRow) return { v, s: 1 };
        return numCols.has(ci) && ri > headerRow && isNum(v) ? { v, n: true } : { v, s: 0 };
      });
      if (ri === headerRow) HEADERS.forEach((h, i) => { cells[cols[i]] = { v: h, s: 1 }; });
      else if (ri > headerRow && byRow.has(ri)) {
        const row = byRow.get(ri);
        resultCells(row).forEach((t, i) => { cells[cols[i]] = { v: t, s: styleFor(HEADERS[i], t) }; });
        if (multi(row) && map.store !== undefined) cells[map.store] = { v: cells[map.store].v, s: 5 };
      }
      return cells;
    });
    const counts = { rows: rows.length, updated: 0, skipped: 0, shared: 0, confirmed: 0, unconfirmed: 0 };
    for (const r of rows) {
      if (r.status === 'skipped') counts.skipped++;
      if (multi(r)) counts.shared++;
      if (targetsOf(r).some(t => FIELDS.some(([k]) => t.detail?.[k] === 'updated'))) {
        counts.updated++;
        if (targetsOf(r).every(t => t.skip || !FIELDS.some(([k]) => t.detail?.[k] === 'updated') || t.verify?.status === 'ok')) counts.confirmed++; else counts.unconfirmed++;
      }
    }
    const sheets = [{ name: (source.name || 'Results').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 20) + ' - results', xml: sheetXml(out, { headerRow }) }];

    // second sheet: one line per business for store IDs that belong to several businesses
    const sharedRows = rows.filter(multi);
    if (sharedRows.length) {
      const H = ['Store code', 'Sheet row', 'Business #', 'Businesses with this ID', 'Business Manager shows', 'Skip reason', 'Coordinates',
        ...FIELDS.map(f => f[1] + ' update'), 'Refresh check summary', 'Listing link'];
      const body = [H.map(v => ({ v, s: 1 }))];
      for (const r of sharedRows) {
        const t = targetsOf(r).length ? targetsOf(r) : [{ shows: r.observed || '' }];
        t.forEach((x, i) => {
          const vals = [r.store, r.sheetRow, i + 1, t0(r), x.shows || '', x.skip || '', x.coordDone ? 'Done - saved' : (x.skip ? 'Skipped' : (STATUS_TEXT[r.status] || '')),
            ...FIELDS.map(([k]) => updateText(x, k)), refreshSummaryOne(x), x.link || ''];
          body.push(vals.map((v, ci) => ({ v, s: ci === 5 && v ? 3 : (ci >= 7 && ci < 7 + FIELDS.length ? styleFor('x update', v) : (ci === 7 + FIELDS.length ? styleFor('Refresh check summary', v) : (ci === 0 ? 5 : 0))), n: typeof v === 'number' ? true : undefined })));
        });
      }
      sheets.push({ name: 'Shared store IDs', xml: sheetXml(body, { headerRow: 0 }) });
    }

    const parts = [];
    const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const add = async (name, text) => {
      const bytes = enc.encode(text), packed = await SheetIO.pump(new CompressionStream('deflate-raw'), bytes);
      parts.push({ name, method: 8, flags: 0x0800, time, date, crc: SheetIO.crc32(bytes), usize: bytes.length, data: packed });
    };
    const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>';
    await add('[Content_Types].xml', ct);
    await add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    await add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>');
    await add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    await add('xl/styles.xml', STYLES);
    for (let i = 0; i < sheets.length; i++) await add(`xl/worksheets/sheet${i + 1}.xml`, sheets[i].xml);
    const base = String(source.fileName || 'stores').replace(/\.[^.]+$/, '').replace(/_updated$/i, '');
    return { blob: new Blob([SheetIO.writeZip(parts)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename: base + '_updated.xlsx', counts };
  }
  root.XlsxOut = { build, summaryText, refreshSummary, sharedText, skipText, HEADERS, FIELDS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
