/* ระบบลงทะเบียนแขก รอบเสด็จ  v2
   โหมดสาธิต: ไม่มีค่า Supabase ใน config.js → ข้อมูลเดโม่ในเบราว์เซอร์ (แท็บบนเครื่องเดียวกัน sync กัน)
   ใช้งานจริง: Supabase (Auth + Postgres + Realtime) กฎสิทธิ์และสถานะงานบังคับที่ฐานข้อมูล */
(function () {
'use strict';

const CFG = window.APP_CONFIG || {};
const DEMO = !(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('th-TH');
const TZ = { timeZone: 'Asia/Bangkok' };
const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', ...TZ }) : '');
const ROLE_LABEL = { counter: 'เคาน์เตอร์', supervisor: 'Lead', viewer: 'Onboard' };
const PHASE = {
  draft: { label: 'เตรียมข้อมูล', text: '<b>เตรียมข้อมูล</b> · ยังไม่เปิดลงทะเบียน ฝ่ายข้อมูลแก้ไขรายชื่อและที่นั่งได้', chip: 'warn' },
  open: { label: 'เปิดลงทะเบียน', text: '<b>เปิดลงทะเบียน</b> · ฐานข้อมูลล็อก แก้ได้เฉพาะงานหน้างาน', chip: 'ok' },
  closed: { label: 'ปิดลงทะเบียน', text: '<b>ปิดลงทะเบียนแล้ว</b> · อ่านอย่างเดียว', chip: '' },
};
const UNDO_MIN = 10;
const sget = (st, k, d) => { try { const v = st.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const sset = (st, k, v) => { try { st.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked */ } };
let toastTimer;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6500 : 3200);
}

/* ================================================================ state */
const S = {
  guests: new Map(), seats: new Map(), assign: new Map(), gseats: new Map(), groups: new Map(),
  phase: { phase: 'draft' }, log: [], pending: new Set(), me: { name: '', role: null }, live: DEMO,
};
const can = (...r) => r.includes(S.me.role);
const phase = () => S.phase.phase || 'draft';
function setRows(d) {
  if (d.guests) S.guests = new Map(d.guests.map((g) => [g.id, g]));
  if (d.seats) S.seats = new Map(d.seats.map((s) => [s.seat_id, s]));
  if (d.assignments) S.assign = new Map(d.assignments.map((a) => [a.seat_id, a.guest_id]));
  if (d.groups) S.groups = new Map(d.groups.map((g) => [g.group_no, g]));
  if (d.phase) S.phase = d.phase;
  if (d.log) S.log = d.log;
  reindex();
}
function seatCmp(a, b) { const x = S.seats.get(a), y = S.seats.get(b); if (!x || !y) return a < b ? -1 : 1; return x.row_idx - y.row_idx || x.pos - y.pos; }
function reindex() {
  S.gseats = new Map();
  for (const [sid, gid] of S.assign) { if (!S.gseats.has(gid)) S.gseats.set(gid, []); S.gseats.get(gid).push(sid); }
  for (const l of S.gseats.values()) l.sort(seatCmp);
}
const seatsOf = (gid) => S.gseats.get(gid) || [];
const isReg = (g) => !!g.registered_at || S.pending.has(g.id);
const seatMoved = (g) => g.registered_at && g.seat_changed_at && new Date(g.seat_changed_at) > new Date(g.registered_at);
const need = (g) => Math.max(0, (g.seat_count || 0) - (g.returned_seats || []).length);
const gname = (no) => (S.groups.get(no) || {}).name || `กลุ่ม ${no}`;
const canUndo = (g) => can('supervisor') || S.pending.has(g.id) ||
  (can('counter') && g.registered_by === S.me.name && Date.now() - new Date(g.registered_at) < UNDO_MIN * 60000);
function readiness() {
  const short = [], over = [], issues = [], noWin = [], blocked = [];
  for (const g of S.guests.values()) {
    const n = seatsOf(g.id).length;
    if (!g.no_seat_ok && n < need(g)) short.push(g);
    if (n > need(g)) over.push(g);
    if ((g.issues || []).length) issues.push(g);
    if (g.counter_no == null && g.seat_count > 0) noWin.push(g);
  }
  for (const [sid] of S.assign) if (S.seats.get(sid)?.blocked) blocked.push(sid);
  return { short, over, issues, noWin, blocked, errors: short.length + blocked.length };
}
function totals() {
  let seats = 0, reg = 0, entries = 0;
  for (const g of S.guests.values()) { const n = seatsOf(g.id).length; seats += n; if (isReg(g)) { reg += n; entries++; } }
  let spare = 0, reserve = 0;
  for (const s of S.seats.values()) { if (S.assign.has(s.seat_id) || s.blocked) continue; if (s.reserve) reserve++; else if (s.zone !== 'royal') spare++; }
  return { seats, reg, wait: seats - reg, people: S.guests.size, entries, spare, reserve };
}

/* ================================================================ demo backend */
const LocalBackend = (() => {
  const KEY = 'royal-demo-db-v2';
  let db = null, ch = null;
  try { ch = new BroadcastChannel('royal-demo-v2'); } catch (e) { /* unsupported */ }
  function fresh() {
    const D = window.DEMO_DATA || { layout: [], guests: [], groups: [], reserve: [] };
    const seats = D.layout.map((s) => ({ seat_id: s.seat_id, row_label: s.row, row_idx: s.row_idx, block: s.block, pos: s.n, col: s.col, zone: s.zone,
      blocked: !!s.blocked, reserve: D.reserve.includes(s.seat_id), reserve_for: null, note: null }));
    const guests = [], assignments = [];
    D.guests.forEach((g) => {
      const { seats: gs, ...rest } = g;
      guests.push({ ...rest, no_seat_ok: false, issues: [], informant: null, registered_at: null, registered_by: null, seat_changed_at: null,
        substitute_name: null, substitute_at: null, substitute_by: null, returned_seats: [] });
      gs.forEach((s) => assignments.push({ seat_id: s, guest_id: g.id }));
    });
    return { seats, guests, assignments, groups: D.groups, phase: { phase: 'open', changed_at: null, changed_by: 'ระบบสาธิต' }, log: [], nextId: guests.reduce((m, g) => Math.max(m, g.id), 0) + 1 };
  }
  const read = () => { db = sget(localStorage, KEY, null) || fresh(); };
  const save = () => { sset(localStorage, KEY, db); if (ch) ch.postMessage('sync'); };
  const publish = () => setRows({ guests: db.guests.map((g) => ({ ...g })), seats: db.seats.map((s) => ({ ...s })), assignments: db.assignments,
    groups: db.groups, phase: { ...db.phase }, log: db.log.slice(0, 200) });
  const log = (action, guest_id, detail) => { db.log.unshift({ id: Date.now() + Math.random(), at: new Date().toISOString(), actor: S.me.name, action, guest_id, detail }); db.log.length = Math.min(db.log.length, 500); };
  const G = (id) => { const g = db.guests.find((x) => x.id === id); if (!g) throw new Error('ไม่พบรายชื่อนี้'); return g; };
  const need = (...r) => { if (!r.includes(S.me.role)) throw new Error('ไม่มีสิทธิ์ทำรายการนี้'); };
  const needPhase = (...p) => {
    if (p.includes(db.phase.phase)) return db.phase.phase;
    throw new Error({ draft: 'ยังไม่เปิดลงทะเบียน ทำรายการนี้ไม่ได้', open: 'เปิดลงทะเบียนแล้ว ฐานข้อมูลถูกล็อก ทำได้เฉพาะงานหน้างาน', closed: 'ปิดลงทะเบียนแล้ว ทำรายการนี้ไม่ได้' }[db.phase.phase]);
  };
  const reasonIfOpen = (ph, r) => { if (ph === 'open' && !String(r || '').trim()) throw new Error('เปิดลงทะเบียนแล้ว ต้องระบุเหตุผล'); };
  const seat = (sid) => db.seats.find((s) => s.seat_id === sid);
  const owner = (sid) => db.assignments.find((a) => a.seat_id === sid);
  const commit = () => { save(); publish(); render(); };
  const now = () => new Date().toISOString();
  return {
    async load() { read(); publish(); },
    subscribe() {
      const re = () => { read(); publish(); render(); };
      if (ch) ch.onmessage = re;
      window.addEventListener('storage', (e) => { if (e.key === KEY) re(); });
    },
    async register(gid, sub) {
      need('counter', 'supervisor'); needPhase('open'); const g = G(gid);
      if (g.registered_at) throw new Error(`ลงทะเบียนไปแล้วเมื่อ ${hhmm(g.registered_at)} น. โดย ${g.registered_by || '-'}`);
      g.registered_at = now(); g.registered_by = S.me.name;
      if (sub && sub.trim()) Object.assign(g, { substitute_name: sub.trim(), substitute_at: now(), substitute_by: S.me.name });
      log('register', gid, { name: g.full_name, substitute: sub || null }); commit();
    },
    async unregister(gid, reason) {
      need('counter', 'supervisor'); needPhase('open'); const g = G(gid);
      if (!canUndo(g)) throw new Error(`เคาน์เตอร์ยกเลิกได้เฉพาะรายการของตัวเองภายใน ${UNDO_MIN} นาที ให้แจ้ง Lead`);
      g.registered_at = g.registered_by = g.seat_changed_at = null; log('unregister', gid, { name: g.full_name, reason }); commit();
    },
    async setSubstitute(gid, name) {
      need('counter', 'supervisor'); if (S.me.role === 'counter') needPhase('open'); else needPhase('draft', 'open');
      const g = G(gid); const sub = String(name || '').trim() || null;
      Object.assign(g, { substitute_name: sub, substitute_at: sub ? now() : null, substitute_by: sub ? S.me.name : null });
      log('substitute', gid, { name: g.full_name, substitute: sub }); commit();
    },
    async returnSeats(gid, seats, reason) {
      need('counter', 'supervisor'); needPhase('open'); const g = G(gid);
      if (!String(reason || '').trim()) throw new Error('ต้องระบุเหตุผลการคืนที่นั่ง');
      if (!seats.length) throw new Error('เลือกที่นั่งที่จะคืนอย่างน้อย 1 ที่');
      for (const s of seats) {
        const i = db.assignments.findIndex((a) => a.seat_id === s && a.guest_id === gid); if (i < 0) throw new Error(`แขกคนนี้ไม่ได้นั่งที่ ${s}`);
        db.assignments.splice(i, 1); Object.assign(seat(s), { note: `ว่าง · คืนบัตรจาก ${g.full_name} · ${reason.trim()}`, note_at: now() });
      }
      g.returned_seats = [...(g.returned_seats || []), ...seats]; log('return', gid, { name: g.full_name, seats, reason }); commit();
    },
    async assign(gid, from, to, reason) {
      need('supervisor'); const ph = needPhase('draft', 'open'); const g = G(gid); const st = seat(to);
      if (!st) throw new Error(`ไม่พบที่นั่ง ${to}`); if (st.blocked) throw new Error(`ที่นั่ง ${to} ถูกปิด`);
      reasonIfOpen(ph, reason);
      if (owner(to)) throw new Error(`ที่นั่ง ${to} มีผู้จองแล้ว ให้ใช้การสลับที่นั่ง`);
      if (from) { const a = db.assignments.find((x) => x.seat_id === from && x.guest_id === gid); if (!a) throw new Error(`แขกคนนี้ไม่ได้นั่งที่ ${from}`); a.seat_id = to; }
      else db.assignments.push({ seat_id: to, guest_id: gid });
      const wasReserve = st.reserve; Object.assign(st, { reserve: false, reserve_for: null, note: null, note_at: null });
      if (g.registered_at) g.seat_changed_at = now();
      log(from ? 'move' : wasReserve ? 'assign_reserve' : 'assign', gid, { name: g.full_name, from, to, reason, phase: ph }); commit();
    },
    async swap(a, b, reason) {
      need('supervisor'); const ph = needPhase('draft', 'open'); reasonIfOpen(ph, reason);
      const A = owner(a), B = owner(b);
      if (!A || !B) throw new Error('ต้องเลือกที่นั่งที่มีผู้จองทั้งสองที่'); if (A.guest_id === B.guest_id) throw new Error('ทั้งสองที่นั่งเป็นของแขกคนเดียวกัน');
      [A.guest_id, B.guest_id] = [B.guest_id, A.guest_id];
      [A.guest_id, B.guest_id].forEach((id) => { const g = G(id); if (g.registered_at) g.seat_changed_at = now(); });
      log('swap', B.guest_id, { a, b, reason, phase: ph }); commit();
    },
    async release(sid, reason) {
      need('supervisor'); const ph = needPhase('draft', 'open'); reasonIfOpen(ph, reason);
      const i = db.assignments.findIndex((x) => x.seat_id === sid); if (i < 0) throw new Error(`ที่นั่ง ${sid} ว่างอยู่แล้ว`);
      const [a] = db.assignments.splice(i, 1); if (ph === 'open') Object.assign(seat(sid), { note: `ว่าง · ${reason.trim()}`, note_at: now() });
      log('release', a.guest_id, { seat: sid, reason, phase: ph }); commit();
    },
    async seatFlags(sid, f) {
      need('supervisor'); const ph = needPhase('draft', 'open'); const st = seat(sid); if (!st) throw new Error(`ไม่พบที่นั่ง ${sid}`);
      if (owner(sid) && (f.blocked === true || f.reserve === true)) throw new Error(`ที่นั่ง ${sid} มีผู้จองอยู่ ย้ายแขกออกก่อน`);
      if (f.blocked != null) st.blocked = f.blocked;
      if (f.reserve != null) { st.reserve = f.reserve; st.reserve_for = f.reserve ? f.reserve_for || null : null; }
      if (f.note != null) { st.note = f.note.trim() || null; st.note_at = f.note.trim() ? now() : null; }
      log('seat', null, { seat: sid, ...f, phase: ph }); commit();
    },
    async updateGuest(gid, f, reason) {
      need('supervisor'); needPhase('draft'); const g = G(gid); if (!String(f.full_name || '').trim()) throw new Error('ต้องใส่ชื่อ-นามสกุล');
      const old = g.full_name;
      Object.assign(g, { full_name: f.full_name.trim(), org: f.org || null, note: f.note || null, seat_count: Math.max(0, +f.seat_count || 0),
        counter_no: f.counter_no ? +f.counter_no : null, no_seat_ok: !!f.no_seat_ok, issues: [] });
      log('edit', gid, { old_name: old, name: g.full_name, reason }); commit();
    },
    async addGuest(f) {
      need('supervisor'); const ph = needPhase('draft', 'open'); if (!String(f.full_name || '').trim()) throw new Error('ต้องใส่ชื่อ-นามสกุล');
      const order = db.guests.filter((g) => g.group_no === +f.group_no).reduce((m, g) => Math.max(m, g.order_no), 0) + 1;
      const g = { id: db.nextId++, group_no: +f.group_no, order_no: order, ref_no: (ph === 'open' ? 'หน้างาน-' : '') + order, full_name: f.full_name.trim(), org: null,
        invited: +f.seat_count || 1, seat_count: Math.max(1, +f.seat_count || 1), counter_no: f.counter_no ? +f.counter_no : null, note: f.note || null,
        no_seat_ok: false, issues: [], informant: null, registered_at: null, registered_by: null, seat_changed_at: null,
        substitute_name: null, substitute_at: null, substitute_by: null, returned_seats: [] };
      db.guests.push(g); log('add', g.id, { name: g.full_name, group: g.group_no, phase: ph }); commit(); return g;
    },
    async importRows(rows, groups, replace) {
      need('supervisor'); needPhase('draft');
      const next = JSON.parse(JSON.stringify(db));
      if (replace) { next.guests = []; next.assignments = []; next.seats.forEach((s) => Object.assign(s, { reserve: false, reserve_for: null, note: null })); }
      groups.forEach((g) => { const e = next.groups.find((x) => x.group_no === g.group_no); if (e) e.name = g.name; else next.groups.push({ ...g }); });
      next.groups.sort((a, b) => a.group_no - b.group_no);
      const ids = rows.map((r) => {
        let g = next.guests.find((x) => x.group_no === r.group_no && x.order_no === r.order_no);
        if (!g) { g = { id: next.nextId++, registered_at: null, registered_by: null, seat_changed_at: null, substitute_name: null, returned_seats: [] }; next.guests.push(g); }
        Object.assign(g, { group_no: r.group_no, order_no: r.order_no, ref_no: r.ref_no, full_name: r.full_name, org: r.org, invited: r.invited,
          seat_count: r.seat_count, counter_no: r.counter_no, note: r.note, informant: r.informant, no_seat_ok: !!r.no_seat_ok, issues: [...(r.issues || [])] });
        return g.id;
      });
      const inFile = new Set(ids); next.assignments = next.assignments.filter((a) => !inFile.has(a.guest_id));
      let conflicts = 0;
      rows.forEach((r, i) => {
        const g = next.guests.find((x) => x.id === ids[i]);
        for (const s of r.seats || []) {
          if (!next.seats.some((x) => x.seat_id === s)) { g.issues.push(`ไม่มีที่นั่ง ${s} ในผัง`); continue; }
          const o = next.assignments.find((a) => a.seat_id === s);
          if (o) { g.issues.push(`ที่นั่ง ${s} ซ้ำกับ ${next.guests.find((x) => x.id === o.guest_id)?.full_name}`); conflicts++; continue; }
          next.assignments.push({ seat_id: s, guest_id: g.id });
        }
        for (const s of r.reserve_seats || []) {
          const st = next.seats.find((x) => x.seat_id === s);
          if (st && !next.assignments.some((a) => a.seat_id === s)) Object.assign(st, { reserve: true, reserve_for: g.id }); else g.issues.push(`ที่นั่งสำรอง ${s} ใช้ไม่ได้`);
        }
      });
      db = next; log('import', null, { rows: rows.length, replace, conflicts }); commit(); return { rows: rows.length, conflicts };
    },
    async setLayout(seats) {
      need('supervisor'); needPhase('draft'); const ids = new Set(seats.map((s) => s.seat_id));
      const lost = db.assignments.filter((a) => !ids.has(a.seat_id)).map((a) => a.seat_id);
      if (lost.length) throw new Error('ผังใหม่ไม่มีที่นั่งที่มีผู้จองอยู่: ' + lost.slice(0, 10).join(', '));
      db.seats = seats.map((s) => { const o = seat(s.seat_id) || {}; return { seat_id: s.seat_id, row_label: s.row, row_idx: s.row_idx, block: s.block, pos: s.n, col: s.col,
        zone: s.zone, blocked: !!s.blocked, reserve: !!o.reserve, reserve_for: o.reserve_for || null, note: o.note || null }; });
      log('layout', null, { seats: seats.length }); commit(); return seats.length;
    },
    async setPhase(p, force) {
      need('supervisor');
      if (p === 'open') { const r = readiness(); if (r.errors && !force) throw new Error(`ยังเปิดไม่ได้: ขาดที่นั่ง ${r.short.length} รายการ, นั่งในที่นั่งที่ปิด ${r.blocked.length} รายการ`); }
      db.phase = { phase: p, changed_at: now(), changed_by: S.me.name }; log('phase', null, { phase: p, force }); commit();
    },
    async reset() {
      need('supervisor'); needPhase('draft');
      db.guests.forEach((g) => Object.assign(g, { registered_at: null, registered_by: null, seat_changed_at: null, substitute_name: null, substitute_at: null, substitute_by: null }));
      log('reset', null, null); commit();
    },
    async simulate(n) {
      needPhase('open');
      const wait = db.guests.filter((g) => !g.registered_at && db.assignments.some((a) => a.guest_id === g.id));
      for (let i = 0; i < n && wait.length; i++) { const g = wait.splice(Math.floor(Math.random() * wait.length), 1)[0]; g.registered_at = new Date(Date.now() - Math.random() * 600000).toISOString(); g.registered_by = 'จำลอง'; }
      log('simulate', null, { n }); commit();
    },
  };
})();

/* ================================================================ Supabase backend */
const SupaBackend = (() => {
  let sb = null, wasDown = false;
  const QKEY = 'royal-queue-v1', SNAP = 'royal-snapshot-v2', MEKEY = 'royal-me-v1';
  const isNet = (e) => !navigator.onLine || /fetch|network|Failed to fetch|Load failed/i.test(e?.message || '');
  async function rpc(name, args) { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(error.message); return data; }
  async function fetchAll(table, order) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999);
      if (error) throw new Error(error.message); out.push(...data); if (data.length < 1000) break;
    }
    return out;
  }
  async function loadAll() {
    const [guests, seats, assignments, groups, ev] = await Promise.all([fetchAll('guests', 'id'), fetchAll('seats', 'seat_id'),
      fetchAll('seat_assignments', 'seat_id'), fetchAll('groups', 'group_no'), sb.from('event_state').select('*').eq('id', 1).maybeSingle()]);
    const { data: log } = await sb.from('change_log').select('*').order('id', { ascending: false }).limit(200);
    setRows({ guests, seats, assignments, groups, phase: ev.data || { phase: 'draft' }, log: log || [] });
  }
  const saveSnap = () => sset(localStorage, SNAP, { at: new Date().toISOString(), guests: [...S.guests.values()], seats: [...S.seats.values()],
    assignments: [...S.assign].map(([seat_id, guest_id]) => ({ seat_id, guest_id })), groups: [...S.groups.values()], phase: S.phase, log: S.log.slice(0, 50) });
  const upsertGuest = (g) => S.guests.set(g.id, g);
  const queue = () => sget(localStorage, QKEY, []);
  const setQueue = (q) => { sset(localStorage, QKEY, q); S.pending = new Set(q.map((x) => x.gid)); setConn(); };
  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      let q = queue();
      while (q.length) {
        const it = q[0];
        try { upsertGuest(await rpc('register_guest', { p_guest: it.gid, p_at: it.at, p_substitute: it.sub || null })); }
        catch (e) { if (isNet(e)) break; if (!/^ลงทะเบียนไปแล้ว/.test(e.message)) toast('ส่งรายการค้างไม่สำเร็จ: ' + e.message, true); }
        q = queue().slice(1); setQueue(q);
      }
    } finally { flushing = false; render(); }
  }
  return {
    client() { if (!sb) sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true } }); return sb; },
    async session() { const { data } = await this.client().auth.getSession(); return data.session; },
    async signIn(email, password) {
      const { error } = await this.client().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message === 'Invalid login credentials' ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' : error.message);
    },
    async signOut() { try { localStorage.removeItem(SNAP); localStorage.removeItem(MEKEY); } catch (e) {} await this.client().auth.signOut(); },
    async staff() {
      const { data: ses } = await sb.auth.getSession(); const uid = ses.session?.user?.id;
      try {
        const { data, error } = await sb.from('staff').select('display_name, role').eq('user_id', uid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw Object.assign(new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน ติดต่อผู้ดูแลระบบ'), { final: true });
        const me = { name: data.display_name, role: data.role, uid }; sset(localStorage, MEKEY, me); return me;
      } catch (e) { const me = sget(localStorage, MEKEY, null); if (!e.final && isNet(e) && me && me.uid === uid) return me; throw e; }
    },
    async load() {
      S.pending = new Set(queue().map((x) => x.gid));
      try { await loadAll(); saveSnap(); }
      catch (e) { const snap = sget(localStorage, SNAP, null); if (!snap) throw e; setRows(snap); toast(`ออฟไลน์: ใช้ข้อมูลในเครื่อง เมื่อ ${hhmm(snap.at)} น.`, true); }
      setInterval(saveSnap, 30000);
    },
    subscribe() {
      sb.channel('royal-db')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'guests' }, (p) => { if (p.eventType === 'DELETE') S.guests.delete(p.old.id); else upsertGuest(p.new); render(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'seat_assignments' }, (p) => {
          if (p.eventType !== 'INSERT' && p.old && p.old.seat_id) S.assign.delete(p.old.seat_id);
          if (p.eventType !== 'DELETE') S.assign.set(p.new.seat_id, p.new.guest_id); reindex(); render();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, (p) => { if (p.eventType === 'DELETE') S.seats.delete(p.old.seat_id); else S.seats.set(p.new.seat_id, p.new); reindex(); render(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'groups' }, (p) => { if (p.eventType === 'DELETE') S.groups.delete(p.old.group_no); else S.groups.set(p.new.group_no, p.new); render(); })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'event_state' }, (p) => { if (p.new) { S.phase = p.new; render(); route(); } })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'change_log' }, (p) => { S.log.unshift(p.new); S.log.length = Math.min(S.log.length, 200); if (currentView() === 'manage') renderLog(); })
        .subscribe(async (status) => {
          S.live = status === 'SUBSCRIBED';
          if (S.live && wasDown) { wasDown = false; try { await loadAll(); render(); } catch (e) {} }
          if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) wasDown = true;
          setConn(); if (S.live) flush();
        });
      window.addEventListener('online', () => { flush(); loadAll().then(render).catch(() => {}); });
      window.addEventListener('offline', setConn);
      setInterval(() => { if (!S.live && navigator.onLine) loadAll().then(render).catch(() => {}); }, 30000);
      setInterval(() => { if (queue().length) flush(); }, 10000);
    },
    async register(gid, sub) {
      const at = new Date().toISOString();
      try { upsertGuest(await rpc('register_guest', { p_guest: gid, p_at: at, p_substitute: sub || null })); }
      catch (e) {
        if (!isNet(e)) throw e;
        setQueue([...queue().filter((x) => x.gid !== gid), { gid, at, sub }]);
        toast('เน็ตขัดข้อง: บันทึกไว้ในเครื่อง จะส่งให้อัตโนมัติเมื่อเน็ตกลับมา');
      }
    },
    async unregister(gid, reason) { if (S.pending.has(gid)) { setQueue(queue().filter((x) => x.gid !== gid)); return; } upsertGuest(await rpc('unregister_guest', { p_guest: gid, p_reason: reason || null })); },
    async setSubstitute(gid, name) { upsertGuest(await rpc('set_substitute', { p_guest: gid, p_name: name || '' })); },
    async returnSeats(gid, seats, reason) { upsertGuest(await rpc('return_seats', { p_guest: gid, p_seats: seats, p_reason: reason || '' })); },
    assign: (gid, from, to, reason) => rpc('assign_seat', { p_guest: gid, p_from: from || null, p_to: to, p_reason: reason || null }),
    swap: (a, b, reason) => rpc('swap_seats', { p_a: a, p_b: b, p_reason: reason || null }),
    release: (sid, reason) => rpc('release_seat', { p_seat: sid, p_reason: reason || null }),
    async seatFlags(sid, f) { const s = await rpc('set_seat_flags', { p_seat: sid, p_blocked: f.blocked ?? null, p_reserve: f.reserve ?? null, p_reserve_for: f.reserve_for ?? null, p_note: f.note ?? null }); if (s) S.seats.set(s.seat_id, s); },
    async updateGuest(gid, f, reason) {
      upsertGuest(await rpc('update_guest', { p_guest: gid, p_name: f.full_name, p_org: f.org || null, p_note: f.note || null, p_seat_count: +f.seat_count || 0,
        p_counter: f.counter_no ? +f.counter_no : null, p_reason: reason || null, p_group: null, p_no_seat_ok: !!f.no_seat_ok }));
    },
    async addGuest(f) { const g = await rpc('add_guest', { p_group: +f.group_no, p_name: f.full_name, p_org: null, p_seat_count: +f.seat_count || 1, p_counter: f.counter_no ? +f.counter_no : null, p_note: f.note || null }); upsertGuest(g); return g; },
    async importRows(rows, groups, replace) { const r = await rpc('import_guests', { p_rows: rows, p_replace: replace, p_groups: groups }); await loadAll(); return r; },
    async setLayout(seats) { const n = await rpc('set_layout', { p_seats: seats }); await loadAll(); return n; },
    async setPhase(p, force) { const st = await rpc('set_phase', { p_phase: p, p_force: !!force, p_note: null }); if (st) S.phase = st; },
    async reset() { await rpc('reset_registrations', {}); await loadAll(); },
    async simulate() { throw new Error('ใช้ได้เฉพาะโหมดสาธิต'); },
    async afterWrite() { if (!S.live) await loadAll(); },
  };
})();

const B = DEMO ? LocalBackend : SupaBackend;
async function act(fn, okMsg) {
  try { const r = await fn(); if (B.afterWrite) await B.afterWrite(); render(); if (okMsg) toast(okMsg); return r ?? true; }
  catch (e) { toast(e.message || String(e), true); return false; }
}

/* ================================================================ theme */
const THEMES = ['auto', 'light', 'dark'];
const ICON = {
  auto: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
};
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  sset(localStorage, 'royal-theme', t);
  const label = { auto: 'ตามระบบ', light: 'สว่าง', dark: 'มืด' }[t];
  ['themeBtn', 'bTheme'].forEach((id) => { const b = $(id); if (b) { b.innerHTML = ICON[t]; b.title = 'โหมดแสดงผล: ' + label; } });
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0c0b1c' : '#ffffff';
}
const curTheme = () => { const v = sget(localStorage, 'royal-theme', 'auto'); return THEMES.includes(v) ? v : 'auto'; };
const nextTheme = () => { applyTheme(THEMES[(THEMES.indexOf(curTheme()) + 1) % 3]); toast('โหมดแสดงผล: ' + { auto: 'ตามระบบ', light: 'สว่าง', dark: 'มืด' }[curTheme()]); };

/* ================================================================ header */
function setConn() {
  const c = $('conn'); const q = S.pending.size;
  if (DEMO) { c.className = 'chip warn'; c.textContent = 'โหมดสาธิต'; return; }
  if (!navigator.onLine) { c.className = 'chip bad'; c.textContent = 'ออฟไลน์' + (q ? ` · รอส่ง ${q}` : ''); return; }
  if (S.live) { c.className = 'chip ok'; c.textContent = 'ออนไลน์' + (q ? ` · รอส่ง ${q}` : ''); return; }
  c.className = 'chip warn'; c.textContent = 'กำลังเชื่อมต่อ' + (q ? ` · รอส่ง ${q}` : '');
}
function renderHeader() {
  const t = totals();
  $('sTotal').textContent = fmt(t.seats); $('sTaken').textContent = fmt(t.reg); $('sFree').textContent = fmt(t.wait);
  $('sPeople').textContent = fmt(t.entries) + ' / ' + fmt(t.people);
  $('sBar').style.width = (t.seats ? (t.reg / t.seats) * 100 : 0) + '%';
  const p = phase(); $('phaseBar').className = 'phase ' + p;
  $('phaseText').innerHTML = PHASE[p].text + (S.phase.changed_by ? ` <span class="ag">· ${esc(S.phase.changed_by)} ${hhmm(S.phase.changed_at)}</span>` : '');
  setConn();
}

/* ================================================================ counter */
let selectedId = null, list = [], cur = -1, slipMode = 'view';
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function search() {
  const q = $('q').value.trim().replace(/\s+/g, ' ');
  const m = q.match(/^(ก|กลุ่ม)\s*(\d+)$/); const seat = q.toUpperCase().match(/^([A-Z]{1,2})\s?(\d{1,2})$/);
  const all = [...S.guests.values()];
  if (m) list = all.filter((g) => g.group_no === +m[2]).sort((a, b) => a.order_no - b.order_no);
  else if (seat && S.seats.has(seat[1] + +seat[2])) { const gid = S.assign.get(seat[1] + +seat[2]); list = gid != null ? [S.guests.get(gid)] : []; }
  else if (!q) list = [];
  else {
    const parts = norm(q).split(' ');
    list = all.filter((g) => { const h = norm(`${g.full_name} ${g.org || ''} ${g.substitute_name || ''} ${g.note || ''} ${gname(g.group_no)}`); return parts.every((p) => h.includes(p)); })
      .sort((a, b) => a.group_no - b.group_no || a.order_no - b.order_no).slice(0, 60);
  }
  cur = list.length ? 0 : -1; renderResults();
}
function statusPill(g) {
  if (S.pending.has(g.id)) return '<span class="pill warn">รอส่ง</span>';
  if (seatMoved(g)) return `<span class="pill warn">มาแล้ว ${hhmm(g.registered_at)} · ย้ายที่</span>`;
  return g.registered_at ? `<span class="pill taken">มาแล้ว ${hhmm(g.registered_at)}</span>` : '<span class="pill free">ยังไม่มา</span>';
}
function renderResults() {
  const box = $('results');
  if (!$('q').value.trim()) { box.innerHTML = `<div class="empty">เริ่มพิมพ์ชื่อแขกเพื่อค้นหา<br>รายชื่อทั้งหมด ${fmt(S.guests.size)} รายการ · ${fmt(S.groups.size)} กลุ่ม</div>`; return; }
  list = list.map((g) => g && S.guests.get(g.id)).filter(Boolean);
  if (!list.length) { box.innerHTML = '<div class="empty">ไม่พบรายชื่อนี้ ลองพิมพ์เฉพาะชื่อหรือนามสกุล</div>'; return; }
  box.innerHTML = list.map((g, i) => `<button type="button" class="row${selectedId === g.id || i === cur ? ' sel' : ''}" data-id="${g.id}">
    <div class="gq">กลุ่ม<b>${g.group_no}</b>ที่ ${esc(g.ref_no ?? g.order_no)}</div>
    <div><div class="nm">${esc(g.full_name)}</div><div class="ag">${esc(gname(g.group_no))} · ${seatsOf(g.id).length} ที่นั่ง · ช่อง ${g.counter_no ?? '–'}${g.substitute_name ? ' · แทนโดย ' + esc(g.substitute_name) : ''}</div></div>
    ${statusPill(g)}</button>`).join('');
}
const isSheet = () => matchMedia('(max-width:880px)').matches;
function openSlip() { if (isSheet()) { $('slip').classList.add('open'); $('slipBack').hidden = false; } }
function closeSlip() { $('slip').classList.remove('open'); $('slipBack').hidden = true; }
function selectGuest(id) { selectedId = id; slipMode = 'view'; renderResults(); renderSlip(); openSlip(); if (isSheet()) $('q').blur(); }
function renderSlip() {
  const s = $('slip'); const g = selectedId != null ? S.guests.get(selectedId) : null; const p = phase();
  const x = '<button type="button" class="sheet-x" aria-label="ปิด">✕</button>';
  if (!g) {
    s.innerHTML = x + `<h2>ใบลงทะเบียน</h2><p class="sub">เลือกรายชื่อจากผลการค้นหา ตรวจบัตรเชิญและบัตรประชาชน แล้วยืนยัน</p>
      <div class="big"><div><span>กลุ่ม</span><b>–</b></div><div><span>ลำดับที่</span><b>–</b></div><div class="ch"><span>รับบัตรช่อง</span><b>–</b></div></div>
      ${p !== 'open' ? `<div class="msg ${p === 'draft' ? 'warn' : 'info'}">${p === 'draft' ? 'ยังไม่เปิดลงทะเบียน ค้นหาได้อย่างเดียว' : 'ปิดลงทะเบียนแล้ว'}</div>` : ''}`;
    s.querySelector('.sheet-x').onclick = closeSlip; return;
  }
  const seats = seatsOf(g.id); const keep = s.dataset.gid === String(g.id) ? [$('c1')?.checked, $('c2')?.checked, $('subName')?.value] : [false, false, ''];
  s.dataset.gid = g.id;
  const head = `${x}<div class="gname">กลุ่ม ${g.group_no} · ${esc(gname(g.group_no))}</div><h2>${esc(g.full_name)}</h2>
    ${g.substitute_name ? `<div class="msg info" style="margin-top:6px">ผู้มาแทน: <b>${esc(g.substitute_name)}</b> <span class="ag">· ${esc(g.substitute_by || '')} ${hhmm(g.substitute_at)}</span></div>` : ''}
    <div class="big"><div><span>กลุ่ม</span><b>${g.group_no}</b></div><div><span>ลำดับที่</span><b>${esc(g.ref_no ?? g.order_no)}</b></div><div class="ch"><span>รับบัตรช่อง</span><b>${g.counter_no ?? '–'}</b></div></div>`;
  if (slipMode === 'edit') return renderEdit(s, g, head);
  if (slipMode === 'return') return renderReturn(s, g, head, seats);
  if (slipMode === 'sub') return renderSub(s, g, head);
  const warns = [];
  if (seatMoved(g)) warns.push(`<div class="msg warn">ย้ายที่นั่งหลังลงทะเบียน (${hhmm(g.seat_changed_at)} น.) เรียกบัตรเดิมคืนแล้วออกบัตรใหม่</div>`);
  if (!g.no_seat_ok && seats.length < need(g)) warns.push(`<div class="msg warn">มี ${need(g)} ท่าน แต่จัดที่นั่งแล้ว ${seats.length} ที่ ${can('supervisor') ? '' : '· แจ้ง Lead'}</div>`);
  if ((g.returned_seats || []).length) warns.push(`<div class="msg info">คืนที่นั่งแล้ว: ${esc(g.returned_seats.join(', '))}</div>`);
  if (can('supervisor') && (g.issues || []).length) warns.push(`<div class="msg err">${g.issues.map(esc).join('<br>')}</div>`);
  let action = '';
  if (can('counter', 'supervisor')) {
    if (isReg(g)) {
      action = `<div class="done">${S.pending.has(g.id) ? 'ลงทะเบียนแล้ว (รอส่งขึ้นระบบ)' : `มาแล้ว ${hhmm(g.registered_at)} น. · ${esc(g.registered_by || '')}`}</div>
        <div class="row-flex" style="margin-top:8px">
          ${p === 'open' && canUndo(g) ? '<button class="btn ghost" id="undo" type="button">ยกเลิก (กดผิด)</button>' : ''}
          ${p === 'open' && seats.length ? '<button class="btn ghost" id="toReturn" type="button">คืนที่นั่ง</button>' : ''}
          ${p === 'open' ? '<button class="btn ghost" id="toSub" type="button">ผู้มาแทน</button>' : ''}
        </div>${p === 'open' && !canUndo(g) ? '<p class="ag">ต้องการยกเลิกการลงทะเบียน แจ้ง Lead</p>' : ''}`;
    } else if (p === 'open') {
      action = `<details class="subbox"${keep[2] ? ' open' : ''}><summary>มีผู้มาแทน? (ชื่อไม่ตรงบัตรเชิญ)</summary>
          <label class="f" style="margin-top:8px">ชื่อ-นามสกุลผู้มาแทน<input id="subName" value="${esc(keep[2] || '')}" placeholder="ตรวจกับบัตรประชาชน"></label></details>
        <div class="checks" style="margin-top:10px"><label><input type="checkbox" id="c1"${keep[0] ? ' checked' : ''}> ตรวจบัตรเชิญแล้ว</label><label><input type="checkbox" id="c2"${keep[1] ? ' checked' : ''}> ตรวจบัตรประชาชนแล้ว</label></div>
        <button class="btn full" id="confirm" type="button" style="margin-top:10px"${keep[0] && keep[1] ? '' : ' disabled'}>ยืนยันลงทะเบียน · ส่งไปช่อง ${g.counter_no ?? '–'}</button>`;
    } else action = `<div class="msg ${p === 'draft' ? 'warn' : 'info'}">${p === 'draft' ? 'ยังไม่เปิดลงทะเบียน' : 'ปิดลงทะเบียนแล้ว'}</div>`;
  }
  const lead = can('supervisor') ? `<div class="row-flex" style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
      <span class="ag" style="width:100%">เครื่องมือ Lead</span>
      ${p !== 'closed' ? '<button class="small-btn" type="button" id="toAssign">จัดที่นั่งเพิ่ม / สำรอง</button>' : ''}
      ${p === 'draft' ? '<button class="small-btn" type="button" id="toEdit">แก้ไขข้อมูล</button><button class="small-btn" type="button" id="toSub2">ผู้มาแทน</button>' : ''}
      ${seats.length ? '<button class="small-btn" type="button" id="toMap">ดูบนผัง</button>' : ''}</div>` : '';
  s.innerHTML = head + `<dl><dt>ที่นั่ง</dt><dd class="num">${seats.join(', ') || (g.no_seat_ok ? 'ตามขบวน' : '–')} (${seats.length}/${need(g)}${(g.returned_seats || []).length ? ` · คืน ${g.returned_seats.length}` : ''})</dd>
    <dt>หมายเหตุ</dt><dd>${esc(g.note || '–')}</dd>${g.informant ? `<dt>ผู้แจ้ง</dt><dd>${esc(g.informant)}</dd>` : ''}</dl>
    <div class="stack" style="margin-bottom:10px">${warns.join('')}</div>${action}${lead}`;
  s.querySelector('.sheet-x').onclick = closeSlip;
  if ($('c1')) {
    const upd = () => ($('confirm').disabled = !($('c1').checked && $('c2').checked)); $('c1').onchange = upd; $('c2').onchange = upd;
    $('confirm').onclick = async () => {
      $('confirm').disabled = true; const sub = $('subName')?.value.trim() || '';
      if (await act(() => B.register(g.id, sub), `ลงทะเบียนแล้ว · ส่งแขกไปช่อง ${g.counter_no ?? '–'}`)) { if (isSheet()) { closeSlip(); $('q').value = ''; search(); } }
      $('q').focus(); $('q').select();
    };
  }
  if ($('undo')) $('undo').onclick = () => act(() => B.unregister(g.id, 'กดผิด'), 'ยกเลิกแล้ว');
  if ($('toReturn')) $('toReturn').onclick = () => { slipMode = 'return'; renderSlip(); };
  ['toSub', 'toSub2'].forEach((id) => { if ($(id)) $(id).onclick = () => { slipMode = 'sub'; renderSlip(); }; });
  if ($('toEdit')) $('toEdit').onclick = () => { slipMode = 'edit'; renderSlip(); };
  if ($('toAssign')) $('toAssign').onclick = () => { startPick(g.id); closeSlip(); location.hash = 'seats'; };
  if ($('toMap')) $('toMap').onclick = () => { closeSlip(); location.hash = 'seats'; setTimeout(() => { const el = document.querySelector(`#seats .seat[data-s="${CSS.escape(seats[0])}"]`); if (el) { el.scrollIntoView({ block: 'center', inline: 'center' }); openInfo(el); } }, 120); };
}
function backBtn(s) { s.querySelector('.sheet-x').onclick = closeSlip; $('back').onclick = () => { slipMode = 'view'; renderSlip(); }; }
function renderSub(s, g, head) {
  s.innerHTML = head + `<form id="subForm" class="stack"><label class="f">ชื่อ-นามสกุลผู้มาแทน (เว้นว่าง = ลบ)<input id="subEdit" value="${esc(g.substitute_name || '')}"></label>
    <button class="btn full" type="submit">บันทึกผู้มาแทน</button><button class="btn ghost full" type="button" id="back">กลับ</button></form>`;
  backBtn(s);
  $('subForm').onsubmit = async (e) => { e.preventDefault(); if (await act(() => B.setSubstitute(g.id, $('subEdit').value), 'บันทึกผู้มาแทนแล้ว')) { slipMode = 'view'; renderSlip(); } };
  $('subEdit').focus();
}
function renderReturn(s, g, head, seats) {
  s.innerHTML = head + `<form id="retForm" class="stack"><p class="sub" style="margin:0">ใช้เมื่อแขกยินดีคืนบัตรที่ช่องรับบัตรเท่านั้น ที่นั่งที่คืนจะกลายเป็นที่ว่างพร้อมโน้ต</p>
    <div class="seatpick">${seats.map((x) => `<label><input type="checkbox" value="${esc(x)}"> ${esc(x)}</label>`).join('')}</div>
    <label class="f">เหตุผล<select id="retWhy"><option>แขกมาไม่ครบ คืนบัตร</option><option>ผู้ติดตามไม่มา คืนบัตร</option><option value="">อื่น ๆ (พิมพ์เอง)</option></select></label>
    <input class="inp" id="retOther" placeholder="ระบุเหตุผล" hidden>
    <button class="btn full" type="submit">ยืนยันคืนที่นั่ง</button><button class="btn ghost full" type="button" id="back">กลับ</button></form>`;
  backBtn(s);
  $('retWhy').onchange = () => ($('retOther').hidden = $('retWhy').value !== '');
  $('retForm').onsubmit = async (e) => {
    e.preventDefault(); const picked = [...s.querySelectorAll('.seatpick input:checked')].map((i) => i.value);
    const why = $('retWhy').value || $('retOther').value.trim();
    if (await act(() => B.returnSeats(g.id, picked, why), `คืนที่นั่ง ${picked.join(', ')} แล้ว`)) { slipMode = 'view'; renderSlip(); }
  };
}
function renderEdit(s, g, head) {
  s.innerHTML = head + `<form id="editForm" class="stack"><p class="sub" style="margin:0">แก้ได้เฉพาะช่วงเตรียมข้อมูล</p>
    <label class="f">ชื่อ-นามสกุล<input id="eName" value="${esc(g.full_name)}" required></label>
    <label class="f">หน่วยงาน<input id="eOrg" value="${esc(g.org || '')}"></label>
    <div class="formgrid"><label class="f">จำนวนที่นั่ง<input id="eSeats" type="number" min="0" value="${g.seat_count}"></label>
    <label class="f">ช่องรับบัตร<input id="eCounter" type="number" min="1" value="${g.counter_no ?? ''}"></label></div>
    <label class="f">หมายเหตุ<input id="eNote" value="${esc(g.note || '')}"></label>
    <label class="checks" style="flex-direction:row"><input type="checkbox" id="eNoSeat"${g.no_seat_ok ? ' checked' : ''}> ไม่ต้องมีที่นั่ง (ตามขบวน)</label>
    <button class="btn full" type="submit">บันทึก</button><button class="btn ghost full" type="button" id="back">กลับ</button></form>`;
  backBtn(s);
  $('editForm').onsubmit = async (e) => {
    e.preventDefault();
    if (await act(() => B.updateGuest(g.id, { full_name: $('eName').value, org: $('eOrg').value, note: $('eNote').value, seat_count: $('eSeats').value, counter_no: $('eCounter').value, no_seat_ok: $('eNoSeat').checked }), 'บันทึกแล้ว')) { slipMode = 'view'; renderSlip(); }
  };
}

/* ================================================================ seat map (shared) */
const MAPS = {};
function seatClass(sid) {
  const st = S.seats.get(sid); const gid = S.assign.get(sid); const g = gid != null ? S.guests.get(gid) : null;
  let c = 'seat';
  if (st?.zone === 'royal') c += ' roy';
  if (st?.blocked) c += ' x'; else if (g) c += isReg(g) ? ' t' : ' f'; else if (st?.reserve) c += ' r';
  if (!g && st?.note) c += ' nt';
  if (g && seatMoved(g)) c += ' chg';
  return c;
}
function buildMap(el, key) {
  const seats = [...S.seats.values()];
  const sig = seats.length + ':' + seats.map((s) => s.seat_id + '@' + s.col + '.' + s.row_idx).sort().join(',');
  if (MAPS[key] && MAPS[key].sig === sig && el.childElementCount) return MAPS[key];
  if (!seats.length) { el.innerHTML = '<div class="empty">ยังไม่มีผังที่นั่ง Lead นำเข้าผังได้ที่หน้า “จัดการ”</div>'; MAPS[key] = { sig, cols: 1, rows: 1 }; return MAPS[key]; }
  const hasCol = seats.every((s) => s.col != null);
  const colOf = (s) => (hasCol ? s.col : s.pos + s.block * 2);
  const minCol = Math.min(...seats.map(colOf)), maxCol = Math.max(...seats.map(colOf));
  const rowIdx = [...new Set(seats.map((s) => s.row_idx))].sort((a, b) => a - b);
  const rmap = new Map(rowIdx.map((r, i) => [r, i + 1]));
  const cols = maxCol - minCol + 3;
  const parts = [];
  rowIdx.forEach((r) => {
    const lab = seats.find((s) => s.row_idx === r).row_label;
    parts.push(`<span class="rl" style="grid-row:${rmap.get(r)};grid-column:1">${esc(lab)}</span><span class="rl" style="grid-row:${rmap.get(r)};grid-column:${cols}">${esc(lab)}</span>`);
  });
  const roy = seats.filter((s) => s.zone === 'royal');
  if (roy.length) {
    const r1 = Math.min(...roy.map((s) => rmap.get(s.row_idx))), r2 = Math.max(...roy.map((s) => rmap.get(s.row_idx)));
    const c1 = Math.min(...roy.map(colOf)) - minCol + 2, c2 = Math.max(...roy.map(colOf)) - minCol + 2;
    parts.push(`<div class="zone" style="grid-row:${r1}/${r2 + 1};grid-column:${c1}/${c2 + 1}"><span>ที่ประทับ · ผู้ตามเสด็จ</span></div>`);
  }
  seats.forEach((s) => parts.push(`<button type="button" class="seat" data-s="${esc(s.seat_id)}" aria-label="ที่นั่ง ${esc(s.seat_id)}" style="grid-row:${rmap.get(s.row_idx)};grid-column:${colOf(s) - minCol + 2}"></button>`));
  el.style.gridTemplateColumns = `repeat(${cols}, var(--s))`;
  el.style.gridTemplateRows = `repeat(${rowIdx.length}, var(--s))`;
  el.innerHTML = parts.join('');
  MAPS[key] = { sig, cols, rows: rowIdx.length, fitted: false };
  return MAPS[key];
}
function fitMap(el, key, box, mult) {
  const m = MAPS[key]; if (!m || !box) return;
  const w = box.clientWidth - 8, h = box.clientHeight - 8;
  let s = Math.floor(w / (m.cols * 1.16));
  if (key === 'board' && h > 60) s = Math.min(s, Math.floor(h / (m.rows * 1.16)));
  s = Math.max(6, Math.min(34, Math.round(s * (mult || 1))));
  el.style.setProperty('--s', s + 'px'); el.style.gap = Math.max(1, Math.round(s * 0.16)) + 'px';
}
function paintMap(el, opts) {
  const gf = opts.groupFilter; const hl = opts.hl || new Set();
  el.querySelectorAll('.seat').forEach((b) => {
    const sid = b.dataset.s; let c = seatClass(sid);
    if (gf) { const gid = S.assign.get(sid); const g = gid != null ? S.guests.get(gid) : null; if (!g || g.group_no !== +gf) c += ' dim'; }
    if (hl.has(sid)) c += ' hl';
    if (opts.src === sid) c += ' src';
    if (opts.fresh && opts.fresh.has(sid)) c += ' pop-in';
    if (b.className !== c) b.className = c;
  });
}

/* ---------- seats view ---------- */
const EM = { on: false, src: null, pick: null };
let zoomMult = 1, popSeat = null;
function paintSeats() {
  const el = $('seats'); const m = buildMap(el, 'main');
  if (!m.fitted) { m.fitted = true; requestAnimationFrame(() => fitMap(el, 'main', $('hall'), zoomMult)); }
  const hl = new Set(popSeat && S.assign.has(popSeat) ? seatsOf(S.assign.get(popSeat)) : []);
  paintMap(el, { groupFilter: $('gfilter').value, hl, src: EM.src });
  renderEditBar();
}
function showTip(sid) {
  const gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null, st = S.seats.get(sid);
  if (g) $('tip').innerHTML = `ที่นั่ง <b>${esc(sid)}</b> · ${esc(g.full_name)}${g.substitute_name ? ' (แทนโดย ' + esc(g.substitute_name) + ')' : ''}<br><span class="ag">${esc(gname(g.group_no))} · ที่ ${esc(g.ref_no ?? g.order_no)} · ช่อง ${g.counter_no ?? '–'}</span> ${statusPill(g)}`;
  else $('tip').innerHTML = `ที่นั่ง <b>${esc(sid)}</b> · ${st?.blocked ? 'ปิดที่นั่ง' : st?.reserve ? 'ที่นั่งสำรอง' : 'ว่าง'}${st?.zone === 'royal' ? ' · โซนที่ประทับ' : ''}${st?.note ? '<br><span class="ag">' + esc(st.note) + '</span>' : ''}`;
}
function closePop() { $('pop').hidden = true; popSeat = null; if (currentView() === 'seats') paintSeats(); }
function placePop(el) {
  const p = $('pop'); p.hidden = false; const r = el.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), innerWidth - w - 16) + 'px';
  let top = r.bottom + 10; if (top + h > innerHeight - 16) top = Math.max(16, r.top - h - 10); p.style.top = top + 'px';
}
function guestCard(g) {
  return `<div class="ag" style="color:var(--accent)">กลุ่ม ${g.group_no} · ${esc(gname(g.group_no))}</div><h4>${esc(g.full_name)}</h4>
    ${g.substitute_name ? `<div class="ag">ผู้มาแทน: <b>${esc(g.substitute_name)}</b></div>` : ''}
    <div class="big"><div><span>กลุ่ม</span><b>${g.group_no}</b></div><div><span>ลำดับที่</span><b>${esc(g.ref_no ?? g.order_no)}</b></div><div class="ch"><span>ช่อง</span><b>${g.counter_no ?? '–'}</b></div></div>
    <dl><dt>ที่นั่ง</dt><dd class="num">${seatsOf(g.id).join(', ')} (${seatsOf(g.id).length}/${g.seat_count})</dd><dt>สถานะ</dt><dd>${statusPill(g)}${g.registered_by ? ' · ' + esc(g.registered_by) : ''}</dd><dt>หมายเหตุ</dt><dd>${esc(g.note || '–')}</dd></dl>`;
}
function openInfo(el) {
  const sid = el.dataset.s, gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null, st = S.seats.get(sid), p = $('pop');
  popSeat = sid; showTip(sid);
  const rf = st?.reserve_for != null ? S.guests.get(st.reserve_for) : null;
  p.innerHTML = '<button class="x" type="button" aria-label="ปิด">✕</button>' + (g
    ? guestCard(g) + (can('counter', 'supervisor') ? '<button class="small-btn" type="button" id="popGo" style="width:100%">เปิดในหน้าเคาน์เตอร์</button>' : '')
    : `<h4>ที่นั่ง ${esc(sid)}</h4><div class="ag">${st?.blocked ? 'ปิดที่นั่ง' : st?.reserve ? 'ที่นั่งสำรอง' + (rf ? ' ของ ' + esc(rf.full_name) : '') : 'ว่าง'}${st?.zone === 'royal' ? ' · โซนที่ประทับ' : ''}</div>${st?.note ? `<div class="msg info" style="margin-top:8px">${esc(st.note)}</div>` : ''}`);
  p.querySelector('.x').onclick = closePop;
  if ($('popGo')) $('popGo').onclick = () => { $('q').value = g.full_name; search(); closePop(); location.hash = 'register'; selectGuest(g.id); };
  placePop(el); paintSeats();
}
function confirmPop(el, title, body, warn, run) {
  const p = $('pop'); popSeat = el.dataset.s; const req = phase() === 'open' || !!warn;
  p.innerHTML = `<button class="x" type="button" aria-label="ปิด">✕</button><h4>${title}</h4><div class="ag">${body}</div>
    ${warn ? `<div class="msg warn" style="margin:8px 0">${warn}</div>` : ''}
    <label class="f" style="margin-top:8px">เหตุผล${req ? ' (จำเป็น)' : ''}<textarea id="popReason" placeholder="เช่น แขกยกเลิก ขยับเติมที่ว่าง"></textarea></label>
    <div class="acts"><button class="btn" type="button" id="popOk">ยืนยัน</button><button class="btn ghost" type="button" id="popNo">ยกเลิก</button></div>`;
  p.querySelector('.x').onclick = closePop; $('popNo').onclick = closePop;
  $('popOk').onclick = async () => {
    const reason = $('popReason').value.trim();
    if (req && !reason) { toast('กรุณาระบุเหตุผล', true); return; }
    $('popOk').disabled = true; if (await run(reason)) closePop(); else $('popOk').disabled = false;
  };
  placePop(el); paintSeats(); setTimeout(() => $('popReason')?.focus(), 30);
}
function seatMenu(el) {
  const sid = el.dataset.s, st = S.seats.get(sid), p = $('pop'); popSeat = sid;
  p.innerHTML = `<button class="x" type="button" aria-label="ปิด">✕</button><h4>ที่นั่ง ${esc(sid)}</h4><div class="ag">${st.blocked ? 'ปิดอยู่' : st.reserve ? 'ที่นั่งสำรอง' : 'ว่าง'}${st.zone === 'royal' ? ' · โซนที่ประทับ' : ''}</div>
    <div class="acts" style="margin:10px 0">
      ${st.blocked ? '' : `<button class="small-btn" type="button" id="mRes">${st.reserve ? 'ยกเลิกที่นั่งสำรอง' : 'ตั้งเป็นที่นั่งสำรอง'}</button>`}
      <button class="small-btn" type="button" id="mBlk">${st.blocked ? 'เปิดที่นั่ง' : 'ปิดที่นั่ง'}</button></div>
    <label class="f">โน้ตที่นั่ง<textarea id="mNote" placeholder="เช่น ว่าง: แขกคืนบัตร">${esc(st.note || '')}</textarea></label>
    <div class="acts"><button class="btn" type="button" id="mSave">บันทึกโน้ต</button></div>`;
  p.querySelector('.x').onclick = closePop;
  if ($('mRes')) $('mRes').onclick = async () => { if (await act(() => B.seatFlags(sid, { reserve: !st.reserve }), st.reserve ? 'ยกเลิกสำรองแล้ว' : 'ตั้งเป็นที่นั่งสำรองแล้ว')) closePop(); };
  $('mBlk').onclick = async () => { if (await act(() => B.seatFlags(sid, { blocked: !st.blocked }), st.blocked ? 'เปิดที่นั่งแล้ว' : 'ปิดที่นั่งแล้ว')) closePop(); };
  $('mSave').onclick = async () => { if (await act(() => B.seatFlags(sid, { note: $('mNote').value }), 'บันทึกโน้ตแล้ว')) closePop(); };
  placePop(el); paintSeats();
}
function startPick(gid) { EM.on = true; EM.src = null; EM.pick = gid; $('editMode').classList.add('on'); }
function stopEdit() { EM.on = false; EM.src = null; EM.pick = null; $('editMode').classList.remove('on'); closePop(); }
function renderEditBar() {
  const bar = $('editBar'); if (!EM.on) { bar.hidden = true; return; }
  bar.hidden = false; let txt;
  if (EM.pick != null) {
    const g = S.guests.get(EM.pick); if (!g) { EM.pick = null; return renderEditBar(); }
    txt = `จัดที่นั่งให้ <b>${esc(g.full_name)}</b> (มี ${seatsOf(g.id).length}/${g.seat_count}) · แตะที่นั่งว่างหรือที่นั่งสำรอง (กรอบทอง)`;
  } else if (EM.src) {
    const g = S.guests.get(S.assign.get(EM.src));
    txt = `ย้าย/สลับ <b>${esc(g ? g.full_name : '')}</b> จาก ${esc(EM.src)} · แตะที่ว่างเพื่อย้าย หรือที่นั่งที่มีคนเพื่อสลับ <button class="small-btn" type="button" id="relSeat">ปล่อยที่นั่งนี้ให้ว่าง</button>`;
  } else txt = `โหมดแก้ไข${phase() === 'open' ? ' (หน้างาน · ต้องระบุเหตุผล)' : ''}: แตะที่นั่งที่มีคนเพื่อย้าย/สลับ · แตะที่ว่างเพื่อตั้งสำรอง ปิดที่นั่ง หรือเขียนโน้ต`;
  bar.innerHTML = `<span style="flex:1 1 260px">${txt}</span><button class="small-btn" type="button" id="editDone">เสร็จสิ้น</button>`;
  $('editDone').onclick = stopEdit;
  if ($('relSeat')) $('relSeat').onclick = () => {
    const src = EM.src; const el = document.querySelector(`#seats .seat[data-s="${CSS.escape(src)}"]`); const g = S.guests.get(S.assign.get(src));
    confirmPop(el, `ปล่อยที่นั่ง ${esc(src)} ให้ว่าง`, `${esc(g.full_name)} จะไม่มีที่นั่งนี้`, g.registered_at ? 'แขกลงทะเบียนแล้ว ต้องเรียกบัตรเดิมคืน' : '',
      async (r) => { const ok = await act(() => B.release(src, r), 'ปล่อยที่นั่งแล้ว'); if (ok) EM.src = null; return ok; });
  };
}
function editClick(el) {
  if (phase() === 'closed') { toast('ปิดลงทะเบียนแล้ว แก้ไขไม่ได้', true); return; }
  const sid = el.dataset.s, st = S.seats.get(sid), gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null;
  if (EM.pick != null) {
    const pg = S.guests.get(EM.pick);
    if (g || st.blocked) { toast('เลือกที่นั่งว่างหรือที่นั่งสำรองที่ไม่ได้ปิด', true); return; }
    confirmPop(el, `จัดที่นั่ง ${esc(sid)}${st.reserve ? ' (สำรอง)' : ''}`, `ให้ ${esc(pg.full_name)} · กลุ่ม ${pg.group_no} ที่ ${esc(pg.ref_no ?? pg.order_no)}`,
      pg.registered_at ? 'แขกลงทะเบียนแล้ว แจ้งช่องรับบัตรให้ออกบัตรเพิ่ม' : '',
      async (r) => { const ok = await act(() => B.assign(pg.id, null, sid, r), `จัดที่นั่ง ${sid} แล้ว`); const ng = S.guests.get(pg.id); if (ok && ng && seatsOf(ng.id).length >= ng.seat_count) EM.pick = null; return ok; });
    return;
  }
  if (!EM.src) { if (g) { EM.src = sid; showTip(sid); paintSeats(); } else seatMenu(el); return; }
  if (sid === EM.src) { EM.src = null; paintSeats(); return; }
  const src = EM.src, sg = S.guests.get(S.assign.get(src));
  if (st.blocked) { toast(`ที่นั่ง ${sid} ถูกปิดอยู่`, true); return; }
  if (g) {
    const w = [sg, g].filter((x) => x.registered_at).map((x) => esc(x.full_name));
    confirmPop(el, `สลับที่นั่ง ${esc(src)} ↔ ${esc(sid)}`, `${esc(sg.full_name)} → ${esc(sid)}<br>${esc(g.full_name)} → ${esc(src)}`, w.length ? `${w.join(' และ ')} ลงทะเบียนแล้ว ต้องเรียกบัตรเดิมคืน` : '',
      async (r) => { const ok = await act(() => B.swap(src, sid, r), 'สลับที่นั่งแล้ว'); if (ok) EM.src = null; return ok; });
  } else {
    confirmPop(el, `ย้ายที่นั่ง ${esc(src)} → ${esc(sid)}`, `${esc(sg.full_name)} · กลุ่ม ${sg.group_no}`, sg.registered_at ? 'แขกลงทะเบียนแล้ว ต้องเรียกบัตรเดิมคืน' : '',
      async (r) => { const ok = await act(() => B.assign(sg.id, src, sid, r), `ย้ายไป ${sid} แล้ว`); if (ok) EM.src = null; return ok; });
  }
}

/* ================================================================ groups */
let openGroup = null, gMode = 'all';
function groupStats() {
  const by = new Map();
  for (const g of S.guests.values()) {
    if (!by.has(g.group_no)) by.set(g.group_no, { no: g.group_no, list: [], seats: 0, reg: 0, win: new Set() });
    const o = by.get(g.group_no); const n = seatsOf(g.id).length; o.list.push(g); o.seats += n; if (isReg(g)) o.reg += n; if (g.counter_no) o.win.add(g.counter_no);
  }
  return [...by.values()].sort((a, b) => a.no - b.no);
}
function renderGroups() {
  const gs = groupStats();
  $('groups').innerHTML = gs.map((o) => `<button type="button" class="g" data-g="${o.no}"><div class="top"><h3>${o.no} · ${esc(gname(o.no))}</h3><span class="n">${o.reg}/${o.seats}</span></div>
    <div class="meta">${o.list.length} รายการ · ช่อง ${[...o.win].sort().join(', ') || '–'}</div><div class="bar"><i style="width:${o.seats ? (o.reg / o.seats) * 100 : 0}%"></i></div></button>`).join('')
    || '<div class="empty">ยังไม่มีรายชื่อ Lead นำเข้าได้ที่หน้า “จัดการ”</div>';
  fillGroupFilter(gs); renderDetail();
}
function fillGroupFilter(gs) {
  const sel = $('gfilter'), v = sel.value; gs = gs || groupStats();
  const html = '<option value="">ทุกกลุ่ม</option>' + gs.map((o) => `<option value="${o.no}">${o.no} · ${esc(gname(o.no))}</option>`).join('');
  if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; sel.value = v; }
}
function renderDetail() {
  const d = $('gdetail');
  if (openGroup == null) { d.hidden = true; $('glist').hidden = false; return; }
  d.hidden = false; $('glist').hidden = true;
  const gs = [...S.guests.values()].filter((g) => g.group_no === openGroup).sort((a, b) => a.order_no - b.order_no);
  const done = gs.filter(isReg), wait = gs.filter((g) => !isReg(g));
  const st = gs.reduce((a, g) => a + seatsOf(g.id).length, 0), sd = done.reduce((a, g) => a + seatsOf(g.id).length, 0);
  const rows = gMode === 'done' ? done : gMode === 'wait' ? wait : gs;
  d.innerHTML = `<div class="gd-head"><button class="small-btn" id="gback" type="button">← ทุกกลุ่ม</button><h2>${openGroup} · ${esc(gname(openGroup))}</h2><button class="small-btn" id="gmap" type="button">ดูกลุ่มนี้บนผัง</button></div>
    <div class="gd-sum"><div class="stat"><b>${gs.length}</b><span>รายการ</span></div><div class="stat red"><b>${done.length}</b><span>มาแล้ว</span></div><div class="stat blue"><b>${wait.length}</b><span>ยังไม่มา</span></div><div class="stat"><b>${sd}/${st}</b><span>ที่นั่ง</span></div></div>
    <div class="seg" role="group" aria-label="กรองสถานะ">
      <button type="button" data-m="all" aria-pressed="${gMode === 'all'}">ทั้งหมด ${gs.length}</button>
      <button type="button" data-m="wait" aria-pressed="${gMode === 'wait'}">ยังไม่มา ${wait.length}</button>
      <button type="button" data-m="done" aria-pressed="${gMode === 'done'}">มาแล้ว ${done.length}</button></div>
    <div class="tbl"><table><thead><tr><th>ที่</th><th>รายชื่อ</th><th>เลขที่นั่ง</th><th>ช่อง</th><th>หมายเหตุ</th><th>สถานะ</th></tr></thead><tbody>
    ${rows.length ? rows.map((g) => `<tr data-id="${g.id}"${can('counter', 'supervisor') ? ' class="click"' : ''}><td class="num c-order">${esc(g.ref_no ?? g.order_no)}</td>
      <td class="c-name">${esc(g.full_name)}${g.substitute_name ? `<div class="ag">ผู้มาแทน: ${esc(g.substitute_name)}</div>` : ''}${g.org ? `<div class="ag">${esc(g.org)}</div>` : ''}</td>
      <td class="num" data-label="ที่นั่ง">${seatsOf(g.id).join(', ') || (g.no_seat_ok ? 'ตามขบวน' : '–')}</td><td class="num" data-label="ช่อง">${g.counter_no ?? '–'}</td>
      <td data-label="หมายเหตุ">${esc(g.note || '–')}</td><td class="c-status">${statusPill(g)}</td></tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">ไม่มีรายการในสถานะนี้</td></tr>'}
    </tbody></table></div>`;
  $('gback').onclick = () => { openGroup = null; renderDetail(); };
  $('gmap').onclick = () => { fillGroupFilter(); $('gfilter').value = openGroup; location.hash = 'seats'; };
  d.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { gMode = b.dataset.m; renderDetail(); }));
  if (can('counter', 'supervisor')) d.querySelectorAll('tbody tr[data-id]').forEach((tr) => (tr.onclick = () => { const g = S.guests.get(+tr.dataset.id); $('q').value = g.full_name; search(); location.hash = 'register'; selectGuest(g.id); }));
}
function exportCsv() {
  const head = ['กลุ่ม', 'ชื่อกลุ่ม', 'ที่', 'รายชื่อ', 'ผู้มาแทน', 'จำนวนที่นั่ง', 'เลขที่นั่ง', 'คืนที่นั่ง', 'ช่องรับบัตร', 'หมายเหตุ', 'สถานะ', 'เวลาลงทะเบียน', 'ผู้บันทึก', 'ย้ายที่นั่งหลังลงทะเบียน'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [...S.guests.values()].sort((a, b) => a.group_no - b.group_no || a.order_no - b.order_no).map((g) => [
    g.group_no, gname(g.group_no), g.ref_no ?? g.order_no, g.full_name, g.substitute_name, g.seat_count, seatsOf(g.id).join(' '), (g.returned_seats || []).join(' '), g.counter_no, g.note,
    isReg(g) ? 'มาแล้ว' : 'ยังไม่มา', g.registered_at ? new Date(g.registered_at).toLocaleString('th-TH', TZ) : '', g.registered_by, seatMoved(g) ? 'ใช่' : '']);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `รายงานลงทะเบียน-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`; document.body.appendChild(a); a.click(); a.remove();
}
function printList() {
  $('print').innerHTML = `<p>${esc(CFG.EVENT_NAME || '')} · รายชื่อสำรอง พิมพ์เมื่อ ${new Date().toLocaleString('th-TH', TZ)}</p>` + groupStats().map((o) =>
    `<section><h2>กลุ่ม ${o.no} · ${esc(gname(o.no))}</h2><table><thead><tr><th>ที่</th><th>รายชื่อ</th><th>ที่นั่ง</th><th>ช่อง</th><th>หมายเหตุ</th><th>มาแล้ว</th></tr></thead><tbody>` +
    o.list.sort((a, b) => a.order_no - b.order_no).map((g) => `<tr><td>${esc(g.ref_no ?? g.order_no)}</td><td>${esc(g.full_name)}</td><td>${seatsOf(g.id).join(', ')}</td><td>${g.counter_no ?? ''}</td><td>${esc(g.note || '')}</td><td>${isReg(g) ? '✓ ' + hhmm(g.registered_at) : '☐'}</td></tr>`).join('') +
    '</tbody></table></section>').join('');
  window.print();
}

/* ================================================================ board (จอหน้างาน) */
let showNames = sget(localStorage, 'royal-board-names', false), lastReg = null;
function renderBoard() {
  const t = totals(); const pct = t.seats ? Math.round((t.reg / t.seats) * 100) : 0;
  $('bTitle').textContent = CFG.EVENT_NAME || 'ลงทะเบียนแขก'; $('bSub').textContent = CFG.VENUE || '';
  const p = phase(); $('bPhase').className = 'chip ' + PHASE[p].chip; $('bPhase').textContent = PHASE[p].label;
  $('bPct').textContent = pct + '%'; $('bRing').style.strokeDashoffset = 326.7 * (1 - pct / 100);
  $('bSeatsIn').textContent = fmt(t.reg); $('bSeatsWait').textContent = fmt(t.wait);
  $('bEntries').textContent = `${fmt(t.entries)}/${fmt(t.people)}`; $('bSpare').textContent = fmt(t.spare); $('bSpareSub').textContent = `ที่ว่าง · สำรอง ${fmt(t.reserve)}`;
  const nW = Math.max(5, +(S.phase.windows || 5)); const since = Date.now() - 15 * 60000; const w = Array.from({ length: nW }, () => ({ all: 0, recent: 0 }));
  const regd = [...S.guests.values()].filter((g) => g.registered_at);
  regd.forEach((g) => { const i = (g.counter_no || 0) - 1; if (i >= 0 && i < nW) { w[i].all++; if (new Date(g.registered_at) > since) w[i].recent++; } });
  $('bWin').innerHTML = w.map((x, i) => `<div><small>ช่อง ${i + 1}</small><b>${x.recent}</b><em>รวม ${x.all}</em></div>`).join('');
  const gs = groupStats().map((o) => ({ ...o, left: o.seats - o.reg })).filter((o) => o.seats).sort((a, b) => b.left - a.left || a.no - b.no);
  $('bGroups').innerHTML = gs.slice(0, 12).map((o) => `<div class="gi"><span>${o.no} · ${esc(gname(o.no))}</span><span class="num">${o.reg}/${o.seats}</span><div class="bar"><i style="width:${o.seats ? (o.reg / o.seats) * 100 : 0}%"></i></div></div>`).join('') || '<div class="ag">ยังไม่มีข้อมูล</div>';
  regd.sort((a, b) => new Date(b.registered_at) - new Date(a.registered_at));
  $('bLastAt').textContent = regd[0] ? 'ล่าสุด ' + hhmm(regd[0].registered_at) : '';
  $('bFeed').innerHTML = regd.slice(0, 8).map((g) => `<div><time>${hhmm(g.registered_at)}</time><span>${showNames ? esc(g.substitute_name || g.full_name) : `กลุ่ม ${g.group_no} · ที่ ${esc(g.ref_no ?? g.order_no)}`}<span class="ag"> · ${seatsOf(g.id).join(' ')}</span></span><span class="w">ช่อง ${g.counter_no ?? '–'}</span></div>`).join('') || '<div class="ag" style="background:none">ยังไม่มีแขกลงทะเบียน</div>';
  const nowReg = new Set(regd.map((g) => g.id)); const fresh = new Set();
  if (lastReg) for (const id of nowReg) if (!lastReg.has(id)) seatsOf(id).forEach((s) => fresh.add(s));
  lastReg = nowReg;
  const el = $('bSeats'); const m = buildMap(el, 'board');
  if (!m.fitted) { m.fitted = true; requestAnimationFrame(() => fitMap(el, 'board', $('bHall'))); }
  paintMap(el, { fresh });
}
function tickClock() { const c = $('bClock'); if (c && currentView() === 'board') c.textContent = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', ...TZ }); }

/* ================================================================ manage */
let importData = null, layoutData = null, armed = null;
function twoStep(btn, label, run) {
  btn.onclick = async () => {
    if (armed !== btn) { armed = btn; const t = btn.textContent; btn.textContent = label; setTimeout(() => { if (armed === btn) { armed = null; btn.textContent = t; } }, 4000); return; }
    armed = null; btn.disabled = true; await run(); btn.disabled = false;
  };
}
const ACT = { register: 'ลงทะเบียน', unregister: 'ยกเลิกลงทะเบียน', substitute: 'ผู้มาแทน', return: 'คืนที่นั่ง', move: 'ย้ายที่นั่ง', assign: 'จัดที่นั่ง', assign_reserve: 'ใช้ที่นั่งสำรอง',
  swap: 'สลับที่นั่ง', release: 'ปล่อยที่นั่ง', seat: 'ตั้งค่าที่นั่ง', edit: 'แก้ไขข้อมูล', add: 'เพิ่มแขก', import: 'นำเข้ารายชื่อ', layout: 'บันทึกผังที่นั่ง', reset: 'ล้างการลงทะเบียน',
  simulate: 'จำลองแขกมาถึง', phase: 'เปลี่ยนสถานะงาน', block: 'ปิดที่นั่ง', unblock: 'เปิดที่นั่ง' };
function logText(l) {
  const d = l.detail || {}; const g = l.guest_id != null ? S.guests.get(l.guest_id) : null; const nm = esc(d.name || (g && g.full_name) || '');
  let t = `<b>${ACT[l.action] || esc(l.action)}</b> `;
  if (l.action === 'move') t += `${nm} ${esc(d.from)} → ${esc(d.to)}`;
  else if (l.action === 'assign' || l.action === 'assign_reserve') t += `${nm} → ${esc(d.to)}`;
  else if (l.action === 'swap') t += `${esc(d.a)} ↔ ${esc(d.b)}`;
  else if (l.action === 'return') t += `${nm} คืน ${esc((d.seats || []).join(', '))}`;
  else if (l.action === 'substitute') t += `${nm} → ${esc(d.substitute || '(ลบ)')}`;
  else if (l.action === 'register') t += nm + (d.substitute ? ` · ผู้มาแทน ${esc(d.substitute)}` : '');
  else if (l.action === 'seat') t += `${esc(d.seat)}${d.reserve === true ? ' · ตั้งสำรอง' : d.reserve === false ? ' · ยกเลิกสำรอง' : ''}${d.blocked === true ? ' · ปิด' : d.blocked === false ? ' · เปิด' : ''}${d.note != null ? ' · โน้ต' : ''}`;
  else if (l.action === 'release') t += esc(d.seat) + (nm ? ' · ' + nm : '');
  else if (l.action === 'import') t += `${d.rows} รายการ${d.replace ? ' (แทนที่ทั้งหมด)' : ''}${d.conflicts ? ` · ที่นั่งชน ${d.conflicts}` : ''}`;
  else if (l.action === 'layout') t += `${d.seats} ที่นั่ง`;
  else if (l.action === 'phase') t += `→ ${esc(PHASE[d.phase]?.label || d.phase)}${d.force ? ' (ยืนยันแม้มีรายการค้าง)' : ''}`;
  else if (l.action === 'simulate') t += `${d.n} รายการ`;
  else if (l.action === 'edit') t += d.old_name && d.old_name !== d.name ? `${esc(d.old_name)} → ${esc(d.name)}` : nm;
  else t += nm;
  if (d.reason) t += ` · เหตุผล: ${esc(d.reason)}`;
  return `<div><time>${hhmm(l.at)}</time>${t} <span class="ag">· ${esc(l.actor || '')}</span></div>`;
}
function renderLog() { $('log').innerHTML = S.log.length ? S.log.slice(0, 200).map(logText).join('') : '<div>ยังไม่มีรายการ</div>'; }
function renderManage() {
  const p = phase(); const r = readiness(); const t = totals();
  document.querySelectorAll('#steps [data-p]').forEach((d) => d.classList.toggle('on', d.dataset.p === p));
  const A = $('phaseActions'); const sig = p + r.errors;
  if (A.dataset.sig !== sig) {
    A.dataset.sig = sig;
    if (p === 'draft') {
      A.innerHTML = `${r.errors ? `<div class="msg err">ยังมีรายการต้องแก้ ${r.errors} รายการ ระบบจะยังไม่ให้เปิดลงทะเบียน</div>
        <label class="checks" style="flex-direction:row"><input type="checkbox" id="force"> Lead ยืนยันเปิดลงทะเบียนแม้มีรายการค้าง</label>` : '<div class="msg ok">ข้อมูลพร้อมเปิดลงทะเบียน</div>'}
        <button class="btn ok full" type="button" id="goOpen"${r.errors ? ' disabled' : ''}>เปิดลงทะเบียน</button>`;
      if ($('force')) $('force').onchange = () => ($('goOpen').disabled = !$('force').checked);
      twoStep($('goOpen'), 'กดอีกครั้งเพื่อยืนยันเปิดลงทะเบียน', () => act(() => B.setPhase('open', !!$('force')?.checked), 'เปิดลงทะเบียนแล้ว'));
    } else if (p === 'open') {
      A.innerHTML = `<div class="msg ok">เปิดลงทะเบียนอยู่ เคาน์เตอร์ลงทะเบียนได้</div>
        <button class="btn danger full" type="button" id="goClose">ปิดลงทะเบียน</button>
        <button class="btn ghost full" type="button" id="goDraft">กลับไปเตรียมข้อมูล (ปลดล็อกฐานข้อมูล)</button>`;
      twoStep($('goClose'), 'กดอีกครั้งเพื่อยืนยันปิดลงทะเบียน', () => act(() => B.setPhase('closed'), 'ปิดลงทะเบียนแล้ว'));
      twoStep($('goDraft'), 'กดอีกครั้ง: เคาน์เตอร์จะลงทะเบียนไม่ได้จนกว่าจะเปิดใหม่', () => act(() => B.setPhase('draft'), 'กลับเป็นเตรียมข้อมูลแล้ว'));
    } else {
      A.innerHTML = `<div class="msg info">ปิดลงทะเบียนแล้ว</div>
        <button class="btn full" type="button" id="goOpen">เปิดลงทะเบียนอีกครั้ง</button><button class="btn ghost full" type="button" id="goDraft">กลับไปเตรียมข้อมูล</button>`;
      twoStep($('goOpen'), 'กดอีกครั้งเพื่อยืนยัน', () => act(() => B.setPhase('open', true), 'เปิดลงทะเบียนแล้ว'));
      twoStep($('goDraft'), 'กดอีกครั้งเพื่อยืนยัน', () => act(() => B.setPhase('draft'), 'กลับเป็นเตรียมข้อมูลแล้ว'));
    }
  }
  $('readyKv').innerHTML = `<div><b>${fmt(S.groups.size)}</b><span>กลุ่ม</span></div><div><b>${fmt(t.people)}</b><span>รายการ</span></div>
    <div><b>${fmt([...S.guests.values()].reduce((a, g) => a + (g.seat_count || 0), 0))}</b><span>ท่านที่มา</span></div><div><b>${fmt(t.seats)}</b><span>ที่นั่งที่จัดแล้ว</span></div>`;
  const item = (cls, txt, n) => `<div class="it ${cls}"><span>${txt}</span><b class="num">${n}</b></div>`;
  $('readyList').innerHTML = [
    item(r.short.length ? 'bad' : 'good', 'มาได้แต่ที่นั่งไม่ครบ', r.short.length),
    item(r.blocked.length ? 'bad' : 'good', 'จัดลงที่นั่งที่ปิดไว้', r.blocked.length),
    item(r.issues.length ? 'warn' : 'good', 'ปัญหาจากไฟล์ (ที่นั่งซ้ำ / ผิดคอลัมน์)', r.issues.length),
    item(r.over.length ? 'warn' : 'good', 'ที่นั่งเกินจำนวนที่มา', r.over.length),
    item(r.noWin.length ? 'warn' : 'good', 'ยังไม่ระบุช่องรับบัตร', r.noWin.length),
  ].join('');
  const probs = [...r.short.map((g) => [g, `ขาดที่นั่ง ${need(g) - seatsOf(g.id).length}`]), ...r.issues.map((g) => [g, g.issues[0]]), ...r.over.map((g) => [g, 'ที่นั่งเกิน']), ...r.noWin.map((g) => [g, 'ไม่มีช่องรับบัตร'])];
  const seen = new Set();
  $('issueList').innerHTML = probs.filter(([g]) => !seen.has(g.id) && seen.add(g.id)).slice(0, 80).map(([g, why]) =>
    `<button type="button" data-id="${g.id}">กลุ่ม ${g.group_no} ที่ ${esc(g.ref_no ?? g.order_no)} · ${esc(g.full_name)} <span class="ag">— ${esc(why)}</span></button>`).join('');
  $('issueList').querySelectorAll('button').forEach((b) => (b.onclick = () => { const g = S.guests.get(+b.dataset.id); $('q').value = g.full_name; search(); location.hash = 'register'; selectGuest(g.id); }));
  const draft = p === 'draft';
  ['cardImport', 'cardLayout', 'cardReset'].forEach((id) => { $(id).style.opacity = draft ? '' : '.55'; $(id).querySelectorAll('input').forEach((x) => (x.disabled = !draft)); });
  $('importBtn').disabled = !draft || !importData || !importData.rows.length; $('layoutBtn').disabled = !draft || !layoutData; $('resetBtn').disabled = !draft || !$('resetOk').checked;
  const seats = [...S.seats.values()];
  $('layoutKv').innerHTML = `<div><b>${fmt(seats.filter((s) => s.zone !== 'royal').length)}</b><span>ที่นั่งปกติ</span></div><div><b>${fmt(seats.filter((s) => s.zone === 'royal').length)}</b><span>โซนที่ประทับ</span></div>
    <div><b>${fmt(seats.filter((s) => s.reserve).length)}</b><span>ที่นั่งสำรอง</span></div><div><b>${fmt(seats.filter((s) => s.blocked).length)}</b><span>ปิดไว้</span></div>`;
  const ag = $('aGroup'); const v = ag.value;
  const opts = [...S.groups.values()].sort((a, b) => a.group_no - b.group_no).map((g) => `<option value="${g.group_no}">${g.group_no} · ${esc(g.name)}</option>`).join('') || '<option value="1">1</option>';
  if (ag.dataset.h !== opts) { ag.innerHTML = opts; ag.dataset.h = opts; if (v) ag.value = v; }
  $('demoArrive').hidden = !DEMO || p !== 'open'; renderLog();
}
function previewImport(d) {
  const people = d.rows.reduce((a, r) => a + r.seat_count, 0), seats = d.rows.reduce((a, r) => a + r.seats.length, 0);
  const sk = {}; d.skipped.forEach((s) => (sk[s.why] = (sk[s.why] || 0) + 1));
  const byType = {}; d.issues.forEach((i) => { const k = /ซ้ำ/.test(i.text) ? 'ที่นั่งซ้ำ' : /คอลัมน์/.test(i.text) ? 'เลขที่นั่งอยู่ผิดคอลัมน์' : /มากกว่า/.test(i.text) ? 'ที่นั่งเกินจำนวน' : 'ที่นั่งไม่ครบ'; byType[k] = (byType[k] || 0) + 1; });
  return `<div class="kv"><div><b>${d.groups.length}</b><span>กลุ่ม</span></div><div><b>${fmt(d.rows.length)}</b><span>รายการที่มาได้</span></div><div><b>${fmt(people)}</b><span>ท่าน</span></div><div><b>${fmt(seats)}</b><span>เลขที่นั่ง</span></div></div>
    <div class="msg info">ไม่นำเข้า: ${Object.entries(sk).map(([k, v]) => `${k} ${v}`).join(' · ') || '–'}${d.ignoredSheets.length ? ` · ข้ามชีท ${d.ignoredSheets.length} ชีท (${esc(d.ignoredSheets.slice(0, 4).join(', '))}${d.ignoredSheets.length > 4 ? ' …' : ''})` : ''}</div>
    ${d.issues.length ? `<div class="msg warn">พบ ${d.issues.length} ประเด็นที่ต้องตรวจ: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' · ')}<br><span class="ag">นำเข้าได้ แต่ต้องแก้ให้ครบก่อนเปิดลงทะเบียน</span></div>
      <div class="issues">${d.issues.slice(0, 60).map((i) => `<div style="padding:6px 10px;border-radius:8px;background:var(--surface-2)">กลุ่ม ${i.group_no} ที่ ${esc(i.ref_no)} · ${esc(i.full_name)} <span class="ag">— ${esc(i.text)}</span></div>`).join('')}</div>` : '<div class="msg ok">ไม่พบปัญหาในไฟล์</div>'}`;
}

/* ================================================================ render / routing */
let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0; renderHeader(); const v = currentView();
    if (v === 'register') { renderResults(); if (slipMode === 'view') renderSlip(); }
    if (v === 'seats') { fillGroupFilter(); paintSeats(); if (popSeat && !$('pop').hidden && !$('popReason') && !$('mNote')) { const el = document.querySelector(`#seats .seat[data-s="${CSS.escape(popSeat)}"]`); if (el) openInfo(el); } }
    if (v === 'groups') renderGroups();
    if (v === 'board') renderBoard();
    if (v === 'manage') renderManage();
  });
}
const allowed = (el) => { const n = el.dataset.need; return !n || n.split(',').includes(S.me.role); };
function currentView() {
  const v = location.hash.slice(1); const link = document.querySelector(`nav.top a[data-v="${v}"]`);
  if (link && allowed(link)) return v;
  return can('viewer') ? 'board' : 'register';
}
function route() {
  const v = currentView();
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  document.querySelectorAll('nav.top a, .tabbar a').forEach((a) => { a.hidden = !allowed(a); if (a.dataset.v === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.body.classList.toggle('board-mode', v === 'board');
  $('editMode').hidden = !can('supervisor');
  if (v !== 'seats') { if (EM.on) stopEdit(); else if (!$('pop').hidden) closePop(); }
  if (v !== 'register') closeSlip();
  if (MAPS.board) MAPS.board.fitted = false;
  if (MAPS.main) MAPS.main.fitted = false;
  render(); keepAwake(); tickClock();
  if (v === 'register' && !isSheet()) setTimeout(() => $('q').focus(), 0);
}

/* ================================================================ wiring */
function wire() {
  $('q').addEventListener('input', search);
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && list.length) { cur = Math.min(cur + 1, list.length - 1); renderResults(); e.preventDefault(); }
    if (e.key === 'ArrowUp' && list.length) { cur = Math.max(cur - 1, 0); renderResults(); e.preventDefault(); }
    if (e.key === 'Enter' && cur >= 0) selectGuest(list[cur].id);
  });
  $('results').addEventListener('click', (e) => { const b = e.target.closest('.row'); if (b) { cur = -1; selectGuest(+b.dataset.id); } });
  $('slipBack').onclick = closeSlip;
  $('seats').addEventListener('mouseover', (e) => { const s = e.target.closest('.seat'); if (s && !EM.src) showTip(s.dataset.s); });
  $('seats').addEventListener('click', (e) => {
    const s = e.target.closest('.seat'); if (!s) return; e.stopPropagation();
    if (EM.on) { editClick(s); return; }
    if (popSeat === s.dataset.s) closePop(); else openInfo(s);
  });
  document.addEventListener('click', (e) => { if (!$('pop').hidden && !e.target.closest('#pop') && !e.target.closest('.seat') && !e.target.closest('#editBar')) closePop(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('pop').hidden) closePop(); else if (EM.src) { EM.src = null; paintSeats(); } else closeSlip(); }
    if (currentView() === 'board' && e.key.toLowerCase() === 'f' && !e.target.closest('input,textarea')) toggleFull();
  });
  $('gfilter').addEventListener('change', paintSeats);
  $('editMode').onclick = () => { if (EM.on) stopEdit(); else { EM.on = true; EM.src = null; EM.pick = null; $('editMode').classList.add('on'); closePop(); paintSeats(); } };
  document.querySelectorAll('.zoom [data-z]').forEach((b) => (b.onclick = () => {
    const d = +b.dataset.z; zoomMult = d === 0 ? 1 : Math.min(3, Math.max(0.5, zoomMult * (d > 0 ? 1.25 : 0.8))); fitMap($('seats'), 'main', $('hall'), zoomMult);
  }));
  $('groups').addEventListener('click', (e) => { const b = e.target.closest('.g'); if (!b) return; openGroup = +b.dataset.g; gMode = 'all'; renderDetail(); window.scrollTo(0, 0); });
  $('exportCsv').onclick = exportCsv; $('printList').onclick = printList;
  $('bExit').onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); location.hash = can('viewer') ? 'seats' : 'register'; };
  $('bFull').onclick = toggleFull; $('bTheme').onclick = nextTheme; $('themeBtn').onclick = nextTheme;
  $('bNames').onclick = () => { showNames = !showNames; sset(localStorage, 'royal-board-names', showNames); $('bNames').classList.toggle('on', showNames); renderBoard(); toast(showNames ? 'แสดงชื่อแขกในรายการล่าสุด' : 'ซ่อนชื่อแขก (แสดงกลุ่มและลำดับ)'); };
  $('bNames').classList.toggle('on', showNames);
  $('xlsx').onchange = async () => {
    const f = $('xlsx').files[0]; importData = null; $('importBtn').disabled = true; if (!f) { $('importInfo').innerHTML = ''; return; }
    if (!window.XLSX) { $('importInfo').innerHTML = '<div class="msg err">โหลดตัวอ่าน Excel ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองใหม่</div>'; return; }
    try {
      importData = Importer.parseMaster(XLSX.read(await f.arrayBuffer(), { type: 'array' }), { onlyNumeric: $('onlyNumeric').checked });
      $('importInfo').innerHTML = importData.rows.length ? previewImport(importData) : '<div class="msg err">ไม่พบรายชื่อ ตรวจว่าแต่ละชีทมีหัวตาราง “ที่ · รายชื่อ · มาได้ · เลขที่นั่ง”</div>';
      $('importBtn').disabled = !importData.rows.length || phase() !== 'draft';
    } catch (e) { $('importInfo').innerHTML = `<div class="msg err">อ่านไฟล์ไม่ได้: ${esc(e.message)}</div>`; }
  };
  $('onlyNumeric').onchange = () => { if ($('xlsx').files[0]) $('xlsx').onchange(); };
  $('importBtn').onclick = async () => {
    if (!importData) return; $('importBtn').disabled = true;
    const res = await act(() => B.importRows(importData.rows, importData.groups, $('importReplace').checked));
    if (res) { toast(`นำเข้าแล้ว ${fmt(res.rows ?? importData.rows.length)} รายการ${res.conflicts ? ` · ที่นั่งชน ${res.conflicts} (ดูในตรวจความพร้อม)` : ''}`); importData = null; $('xlsx').value = ''; $('importInfo').innerHTML = ''; render(); }
    else $('importBtn').disabled = false;
  };
  $('layoutFile').onchange = async () => {
    const f = $('layoutFile').files[0]; layoutData = null; $('layoutBtn').disabled = true; if (!f) { $('layoutInfo').innerHTML = ''; return; }
    if (!window.XLSX) { $('layoutInfo').innerHTML = '<div class="msg err">โหลดตัวอ่าน Excel ไม่สำเร็จ</div>'; return; }
    try {
      const L = Importer.parseLayout(XLSX.read(await f.arrayBuffer(), { type: 'array' }));
      const rows = [...new Set(L.map((s) => s.row))];
      $('layoutInfo').innerHTML = L.length ? `<div class="msg ok">พบ ${fmt(L.filter((s) => s.zone === 'normal').length)} ที่นั่ง แถว ${esc(rows[0])}–${esc(rows[rows.length - 1])} · โซนที่ประทับ ${L.filter((s) => s.zone === 'royal').length} ที่</div>` : '<div class="msg err">ไม่พบที่นั่งในชีทแรก</div>';
      layoutData = L.length ? L : null; $('layoutBtn').disabled = !layoutData || phase() !== 'draft';
    } catch (e) { $('layoutInfo').innerHTML = `<div class="msg err">อ่านไฟล์ไม่ได้: ${esc(e.message)}</div>`; }
  };
  $('layoutBtn').onclick = async () => { if (!layoutData) return; const n = await act(() => B.setLayout(layoutData)); if (n) { toast(`บันทึกผังแล้ว ${fmt(n)} ที่นั่ง`); layoutData = null; $('layoutFile').value = ''; $('layoutInfo').innerHTML = ''; } };
  $('addForm').onsubmit = async (e) => {
    e.preventDefault();
    const g = await act(() => B.addGuest({ group_no: $('aGroup').value, full_name: $('aName').value, seat_count: $('aSeats').value, counter_no: $('aCounter').value, note: $('aNote').value }));
    if (g && g.id != null) { toast(`เพิ่ม ${g.full_name} แล้ว เลือกที่นั่งบนผังได้เลย`); $('addForm').reset(); $('aSeats').value = 1; startPick(g.id); location.hash = 'seats'; }
  };
  $('resetOk').onchange = () => ($('resetBtn').disabled = !$('resetOk').checked || phase() !== 'draft');
  $('resetBtn').onclick = async () => { if (await act(() => B.reset(), 'ล้างการลงทะเบียนแล้ว')) { $('resetOk').checked = false; $('resetBtn').disabled = true; } };
  $('demoArrive').onclick = () => act(() => B.simulate(25), 'จำลองแขกมาถึง 25 รายการแล้ว');
  window.addEventListener('hashchange', route);
  $('logout').onclick = async () => { if (DEMO) { try { sessionStorage.removeItem('royal-demo-me'); } catch (e) {} } else await SupaBackend.signOut(); location.hash = ''; location.reload(); };
  $('reloadBtn').onclick = () => location.reload();
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { Object.values(MAPS).forEach((m) => (m.fitted = false)); if (!isSheet()) closeSlip(); render(); }, 150); });
  const mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => applyTheme(curTheme()));
}
function toggleFull() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('กด F11 เพื่อเต็มจอ', true)); }

/* ================================================================ PWA */
let installEvt = null, wake = null;
function setupPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('ติดตั้งแอปแล้ว เปิดจากหน้าจอโฮมได้เลย'); });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('installBtn').hidden = false;
  $('installBtn').onclick = async () => {
    if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; }
    else toast('iPhone/iPad: แตะปุ่มแชร์ใน Safari แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”');
  };
}
async function keepAwake() {
  try {
    const want = document.visibilityState === 'visible' && (currentView() === 'board' || (can('viewer') && currentView() === 'seats'));
    if (want && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); }
    if (!want && wake) { await wake.release(); wake = null; }
  } catch (e) { /* not allowed */ }
}
let ver = null;
async function checkVersion() {
  try { const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return; const v = (await r.json()).version; if (ver == null) ver = v; else if (v !== ver) $('verBanner').hidden = false; } catch (e) {}
}

/* ================================================================ start */
async function start() {
  $('login').hidden = true; $('app').hidden = false;
  $('whoName').textContent = `${S.me.name} · ${ROLE_LABEL[S.me.role]}`;
  try { await B.load(); } catch (e) { toast('โหลดข้อมูลไม่สำเร็จ: ' + e.message, true); }
  B.subscribe(); route();
  document.addEventListener('visibilitychange', keepAwake);
  setInterval(tickClock, 1000);
  setInterval(() => { if (currentView() === 'board') renderBoard(); }, 30000);
  checkVersion(); setInterval(checkVersion, 60000);
}
function toEmail(v) { v = String(v || '').trim(); if (v.includes('@')) return v.toLowerCase(); return v.toLowerCase().replace(/\s+/g, '') + '@' + (CFG.STAFF_DOMAIN || 'khonperformance.com'); }
function loadScript(src) { return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); }); }
async function init() {
  applyTheme(curTheme());
  if (DEMO && !window.DEMO_DATA) { try { await loadScript('demo-data.js'); } catch (e) {} }
  document.title = CFG.EVENT_NAME || document.title;
  $('eventName').textContent = $('loginTitle').textContent = CFG.EVENT_NAME || 'ระบบลงทะเบียนรอบเสด็จ';
  $('venue').textContent = $('loginVenue').textContent = (CFG.VENUE || '') + (DEMO ? ' · โหมดสาธิต ข้อมูลสมมุติ' : '');
  wire(); setupPwa();
  if (DEMO) {
    const me = sget(sessionStorage, 'royal-demo-me', null); if (me) { S.me = me; return start(); }
    $('login').hidden = false; $('loginDemo').hidden = false;
    document.querySelectorAll('#loginDemo [data-role]').forEach((b) => (b.onclick = () => { S.me = { name: $('demoName').value.trim() || ROLE_LABEL[b.dataset.role], role: b.dataset.role }; sset(sessionStorage, 'royal-demo-me', S.me); start(); }));
    return;
  }
  if (!window.supabase) { $('login').hidden = false; $('loginForm').hidden = false; $('loginErr').hidden = false; $('loginErr').textContent = 'โหลดไลบรารี Supabase ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วรีเฟรช'; return; }
  SupaBackend.client();
  const showForm = (msg) => { $('login').hidden = false; $('loginForm').hidden = false; $('loginErr').hidden = !msg; $('loginErr').textContent = msg || ''; };
  const enter = async () => { try { S.me = await SupaBackend.staff(); await start(); } catch (e) { await SupaBackend.signOut(); showForm(e.message); } };
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault(); $('loginBtn').disabled = true;
    try { await SupaBackend.signIn(toEmail($('email').value), $('password').value); await enter(); } catch (err) { showForm(err.message); } finally { $('loginBtn').disabled = false; }
  };
  if (await SupaBackend.session()) await enter(); else showForm();
}
init();
})();
