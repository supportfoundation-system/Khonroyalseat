/* ตัวอ่านไฟล์ Excel  (ใช้ในหน้า "จัดการ")
   parseMaster(wb, {onlyNumeric})  : ไฟล์มาสเตอร์รายชื่อ 1 ชีทต่อ 1 กลุ่ม (รูปแบบ ศูนย์วัฒนธรรม 1 พ.ย. 69)
   parseLayout(wb)                 : ไฟล์ผังที่นั่ง (ชีทแรก)  */
(function (root) {
'use strict';
const SEAT = /\b([A-Z]{1,2})\s?(\d{1,2})\b/g;
const str = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const num = (v) => { const m = str(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Math.round(+m[0]) : null; };

// แถวของชีท + คอลัมน์เริ่มต้น (SheetJS)  / รองรับชีทจำลองตอนทดสอบ {__rows}
function sheetRows(ws) {
  if (ws.__rows) return { rows: ws.__rows, c0: 0 };
  const X = root.XLSX; const ref = ws['!ref'];
  if (!ref) return { rows: [], c0: 0 };
  const rg = X.utils.decode_range(ref);
  return { rows: X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true }), c0: rg.s.c };
}
function seatsIn(text) {
  const out = []; const up = str(text).toUpperCase(); let m; SEAT.lastIndex = 0;
  while ((m = SEAT.exec(up))) out.push(m[1] + (+m[2]));
  return out;
}

const COLS = [
  ['ref', (h) => h === 'ที่' || h === 'ลำดับ' || h === 'ลำดับที่'],
  ['name', (h) => /^(รายชื่อ|ชื่อ)|พระนาม/.test(h)],
  ['invited', (h) => h === 'จำนวน'],
  ['attend', (h) => h === 'มาได้'],
  ['count', (h) => /จำนวนที่นั่ง/.test(h)],
  ['note', (h) => h === 'หมายเหตุ' || h === 'ประเทศ'],
  ['seats', (h) => /เลขที่นั่ง/.test(h)],
  ['window', (h) => /ช่อง/.test(h)],
  ['org', (h) => /หน่วยงาน|สังกัด/.test(h)],
  ['informant', (h) => h === 'ผู้แจ้ง'],
  ['group', (h) => h === 'กลุ่ม'],
];

function parseMaster(wb, opts) {
  opts = Object.assign({ onlyNumeric: true }, opts);
  const groups = [], rows = [], skipped = [], issues = [], usedSheets = [], ignoredSheets = [];
  const seatOwner = new Map();
  for (const name of wb.SheetNames) {
    const sheetNo = /^\s*\d+\s*$/.test(name) ? +name : (str(name).match(/^กลุ่ม\s*(\d+)/) || [])[1];
    if (opts.onlyNumeric && !sheetNo) { ignoredSheets.push(name); continue; }
    const { rows: R } = sheetRows(wb.Sheets[name]);
    const isHead = (r) => r.some((c) => /^(รายชื่อ|ชื่อ)|พระนาม/.test(str(c))) && r.some((c) => /^(ที่|ลำดับ|จำนวน|มาได้)/.test(str(c)));
    const hi = R.findIndex(isHead);
    if (hi < 0) { ignoredSheets.push(name); continue; }
    let col = {};
    const mapHead = (r) => { col = {}; r.map(str).forEach((h, i) => { for (const [k, f] of COLS) if (col[k] == null && f(h)) { col[k] = i; break; } }); };
    mapHead(R[hi]);
    const title = str((R.slice(0, hi).find((r) => r.some((c) => str(c))) || []).find((c) => str(c)) || '');
    const groupNo = sheetNo ? +sheetNo : null;
    if (!groupNo) { ignoredSheets.push(name); continue; }
    usedSheets.push(name);
    groups.push({ group_no: groupNo, name: title || `กลุ่ม ${groupNo}` });
    let lastRef = '', sub = 0, order = 0;
    let ended = false;
    R.slice(hi + 1).forEach((r, k) => {
      if (ended) return;
      // แถว "รวมทั้งสิ้น" = จบรายชื่อรอบนี้ ข้อมูลด้านล่าง (เช่น ย้ายไปรอบอื่น) ไม่นำเข้า
      if (r.slice(0, 3).some((c) => /^รวม/.test(str(c)))) { ended = true; return; }
      if (isHead(r)) { mapHead(r); return; }
      const nm = str(r[col.name]); if (!nm) return;
      const line = `ชีท ${name} แถว ${hi + k + 2}`;
      const refRaw = col.ref != null ? str(r[col.ref]) : '';
      let ref; if (refRaw) { ref = refRaw.replace(/\.0$/, ''); lastRef = ref; sub = 0; } else { sub++; ref = lastRef ? `${lastRef}-${sub}` : `-${sub}`; }
      const seatText = col.seats != null ? str(r[col.seats]) : '';
      const winText = col.window != null ? str(r[col.window]) : '';
      const hasAttendCol = col.attend != null;
      const attend = hasAttendCol ? (num(r[col.attend]) || 0) : (num(r[col.count]) ?? (seatsIn(seatText).length || 1));
      const base = { sheet: name, line, group_no: groupNo, ref_no: ref, full_name: nm };
      if (/^ซ้ำ/.test(seatText)) { skipped.push({ ...base, why: 'ซ้ำกับกลุ่มอื่น', detail: seatText }); return; }
      if (/ไปรอบ|รอบ\s*\d{3}/.test(seatText)) { skipped.push({ ...base, why: 'ย้ายไปรอบอื่น', detail: seatText }); return; }
      if (attend <= 0) { skipped.push({ ...base, why: 'มาไม่ได้ / รอตอบ' }); return; }
      const rowIssues = [];
      let main = seatText, reserveTxt = '';
      const sp = seatText.split(/สำรอง/); if (sp.length > 1) { main = sp[0]; reserveTxt = sp.slice(1).join(' '); }
      let seats = seatsIn(main); const reserve = seatsIn(reserveTxt);
      let window = null;
      if (winText) {
        const ws = seatsIn(winText);
        if (ws.length) {
          rowIssues.push(`เลขที่นั่ง ${ws.join(' ')} อยู่ในคอลัมน์ช่องรับบัตร`);
          if (!seats.length) seats = ws;
        } else window = num(winText);
      }
      const noSeatOk = /ตามขบวน|ตามเสด็จ/.test(seatText);
      for (const s of seats) {
        if (seatOwner.has(s)) rowIssues.push(`ที่นั่ง ${s} ซ้ำกับ ${seatOwner.get(s)}`);
        else seatOwner.set(s, `${nm} (กลุ่ม ${groupNo} ที่ ${ref})`);
      }
      const uniq = [...new Set(seats)];
      if (!noSeatOk && uniq.length < attend) rowIssues.push(`มา ${attend} ท่าน แต่มีเลขที่นั่ง ${uniq.length} ที่`);
      if (uniq.length > attend) rowIssues.push(`มีเลขที่นั่ง ${uniq.length} ที่ มากกว่าจำนวนที่มา ${attend}`);
      rows.push({ group_no: groupNo, order_no: ++order, ref_no: ref, full_name: nm,
        org: col.org != null ? str(r[col.org]) || null : null, invited: col.invited != null ? num(r[col.invited]) : null,
        seat_count: attend, counter_no: window, note: col.note != null ? str(r[col.note]) || null : null,
        informant: col.informant != null ? str(r[col.informant]) || null : null,
        no_seat_ok: noSeatOk, seats: uniq, reserve_seats: reserve, issues: rowIssues.filter((x) => /อยู่ในคอลัมน์/.test(x)) });
      rowIssues.forEach((t) => issues.push({ line, group_no: groupNo, ref_no: ref, full_name: nm, text: t }));
    });
  }
  return { groups, rows, skipped, issues, usedSheets, ignoredSheets };
}

function parseLayout(wb) {
  const { rows: R, c0 } = sheetRows(wb.Sheets[wb.SheetNames[0]]);
  const ROW = /^[A-Z]{1,2}$/; const rows = [];
  R.forEach((r) => {
    const cells = r.map((v, i) => [i + c0 + 1, str(v)]);
    const label = cells.find(([, v]) => ROW.test(v)); if (!label) return;
    const seats = new Map(), texts = [];
    cells.forEach(([c, v]) => { if (/^\d+(\.0)?$/.test(v)) { if (!seats.has(+v)) seats.set(+v, c); } else if (v && !ROW.test(v)) texts.push([c, v]); });
    rows.push({ label: label[1], seats, texts });
  });
  const gap = (row) => { const ns = [...row.seats.keys()].sort((a, b) => a - b); const g = new Set(); if (!ns.length) return g; for (let n = ns[0]; n <= ns[ns.length - 1]; n++) if (!row.seats.has(n)) g.add(n); return g; };
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const marked = rows.map((r, i) => { const g = gap(r); if (!g.size || !r.texts.length) return -1; const cs = [...r.seats.values()]; return r.texts.some(([c]) => c > Math.min(...cs) && c < Math.max(...cs)) ? i : -1; }).filter((i) => i >= 0);
  const royal = new Set();
  if (marked.length) {
    const g = gap(rows[marked[0]]); let lo = Math.min(...marked), hi = Math.max(...marked);
    while (lo > 0 && same(gap(rows[lo - 1]), g)) lo--;
    while (hi < rows.length - 1 && same(gap(rows[hi + 1]), g)) hi++;
    for (let i = lo; i <= hi; i++) royal.add(i);
  }
  const out = [];
  rows.forEach((r, i) => {
    const all = new Map(r.seats); const z = new Set();
    if (royal.has(i)) {
      const g = gap(r); const ref = [...rows.slice(i + 1), ...rows.slice(0, i).reverse()].find((x) => [...g].every((n) => x.seats.has(n)));
      if (ref) g.forEach((n) => { all.set(n, ref.seats.get(n)); z.add(n); });
    }
    const blockedRow = r.texts.some(([, t]) => /เว้นไม่จัด/.test(t));
    const list = [...all.entries()].sort((a, b) => a[1] - b[1]);
    let b = 0; list.forEach(([n, c], k) => {
      if (k && c - list[k - 1][1] > 1) b++;
      const zone = z.has(n) ? 'royal' : 'normal';
      out.push({ seat_id: r.label + n, row: r.label, row_idx: i, n, col: c, block: b, zone, blocked: zone === 'royal' && blockedRow });
    });
  });
  return out;
}

const api = { parseMaster, parseLayout, seatsIn };
if (typeof module !== 'undefined') module.exports = api; else root.Importer = api;
})(typeof window !== 'undefined' ? window : globalThis);
