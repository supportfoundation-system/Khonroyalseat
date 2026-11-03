/* ระบบลงทะเบียนแขก รอบเสด็จ
   - โหมดสาธิต: ไม่มีค่า Supabase ใน config.js → ข้อมูลเดโม่ใน localStorage, แท็บบนเครื่องเดียวกัน sync กัน
   - โหมดใช้งานจริง: Supabase (Auth + Postgres + Realtime) ทุกเครื่องเห็นข้อมูลเดียวกันทันที */
(function () {
'use strict';

const CFG = window.APP_CONFIG || {};
const DEMO = !(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('th-TH');
const hhmm = (t) => (t ? new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : '');
const ROLE_LABEL = { counter: 'เคาน์เตอร์', supervisor: 'หัวหน้างาน', viewer: 'ผู้ดู' };
const can = (...roles) => roles.includes(S.me.role);

let toastTimer;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}
const sget = (store, k, d) => { try { const v = store.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const sset = (store, k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

/* ================================================================ state */
const S = {
  guests: new Map(),   // id -> guest row
  seats: new Map(),    // seat_id -> seat row
  assign: new Map(),   // seat_id -> guest_id
  gseats: new Map(),   // guest_id -> [seat_id] (sorted)
  log: [],
  pending: new Set(),  // guest ids registered offline, waiting to send
  me: { name: '', role: null },
  live: DEMO,
  layoutSig: '',
};

function setRows({ guests, seats, assignments, log }) {
  S.guests = new Map(guests.map((g) => [g.id, g]));
  S.seats = new Map(seats.map((s) => [s.seat_id, s]));
  S.assign = new Map(assignments.map((a) => [a.seat_id, a.guest_id]));
  if (log) S.log = log;
  reindex();
}
function seatCmp(a, b) {
  const x = S.seats.get(a), y = S.seats.get(b);
  if (!x || !y) return a < b ? -1 : 1;
  return x.row_idx - y.row_idx || x.pos - y.pos;
}
function reindex() {
  S.gseats = new Map();
  for (const [sid, gid] of S.assign) {
    if (!S.gseats.has(gid)) S.gseats.set(gid, []);
    S.gseats.get(gid).push(sid);
  }
  for (const list of S.gseats.values()) list.sort(seatCmp);
}
const seatsOf = (gid) => S.gseats.get(gid) || [];
const isReg = (g) => !!g.registered_at || S.pending.has(g.id);
const UNDO_MIN = 10;   // เคาน์เตอร์ยกเลิกได้เฉพาะรายการของตัวเองภายใน 10 นาที นอกนั้นต้องเป็น Lead
const canUndo = (g) => can('supervisor') || S.pending.has(g.id) ||
  (can('counter') && g.registered_by === S.me.name && Date.now() - new Date(g.registered_at) < UNDO_MIN * 60000);
const seatMoved = (g) => g.registered_at && g.seat_changed_at && new Date(g.seat_changed_at) > new Date(g.registered_at);

/* ================================================================ demo backend */
const LocalBackend = (() => {
  const KEY = 'royal-demo-db-v1';
  let db = null, ch = null;
  try { ch = new BroadcastChannel('royal-demo'); } catch (e) { /* not supported */ }

  function fresh() {
    const D = window.DEMO_DATA || { layout: [], guests: [] };
    const seats = [];
    D.layout.forEach((r, i) => {
      let num = 0;
      r.blocks.forEach((cnt, b) => { for (let k = 0; k < cnt; k++) { num++; seats.push({ seat_id: r.row + num, row_label: r.row, row_idx: i, block: b, pos: num, blocked: false }); } });
    });
    const guests = [], assignments = [];
    D.guests.forEach((g) => {
      guests.push({ id: g.id, group_no: g.group_no, order_no: g.order_no, full_name: g.full_name, org: g.org, seat_count: g.seat_count,
        counter_no: g.counter_no, note: g.note || null, registered_at: null, registered_by: null, seat_changed_at: null });
      g.seats.forEach((s) => assignments.push({ seat_id: s, guest_id: g.id }));
    });
    return { seats, guests, assignments, log: [], nextId: guests.reduce((m, g) => Math.max(m, g.id), 0) + 1 };
  }
  function read() { db = sget(localStorage, KEY, null) || fresh(); }
  function save() { sset(localStorage, KEY, db); if (ch) ch.postMessage('sync'); }
  function publish() { setRows({ guests: db.guests.map((g) => ({ ...g })), seats: db.seats.map((s) => ({ ...s })), assignments: db.assignments, log: db.log.slice(0, 200) }); }
  function log(action, guest_id, detail) { db.log.unshift({ id: Date.now() + Math.random(), at: new Date().toISOString(), actor: S.me.name, action, guest_id, detail }); db.log.length = Math.min(db.log.length, 500); }
  const G = (id) => { const g = db.guests.find((x) => x.id === id); if (!g) throw new Error('ไม่พบรายชื่อนี้'); return g; };
  const need = (...roles) => { if (!roles.includes(S.me.role)) throw new Error('ไม่มีสิทธิ์ทำรายการนี้'); };
  const seatRow = (sid) => db.seats.find((s) => s.seat_id === sid);
  const owner = (sid) => db.assignments.find((a) => a.seat_id === sid);
  function commit() { save(); publish(); render(); }

  return {
    async load() { read(); publish(); },
    subscribe() {
      const re = () => { read(); publish(); render(); };
      if (ch) ch.onmessage = re;
      window.addEventListener('storage', (e) => { if (e.key === KEY) re(); });
    },
    async register(gid) {
      need('counter', 'supervisor'); const g = G(gid);
      if (g.registered_at) throw new Error(`ลงทะเบียนไปแล้วเมื่อ ${hhmm(g.registered_at)} น. โดย ${g.registered_by || '-'}`);
      g.registered_at = new Date().toISOString(); g.registered_by = S.me.name; log('register', gid, { name: g.full_name }); commit();
    },
    async unregister(gid, reason) {
      need('counter', 'supervisor'); const g = G(gid);
      if (!canUndo(g)) throw new Error(`เคาน์เตอร์ยกเลิกได้เฉพาะรายการของตัวเองภายใน ${UNDO_MIN} นาที ให้แจ้ง Lead`);
      g.registered_at = g.registered_by = g.seat_changed_at = null; log('unregister', gid, { name: g.full_name, reason }); commit();
    },
    async assign(gid, from, to, reason) {
      need('supervisor'); const g = G(gid); const s = seatRow(to);
      if (!s || s.blocked) throw new Error(`ไม่พบที่นั่ง ${to} หรือที่นั่งถูกปิด`);
      if (owner(to)) throw new Error(`ที่นั่ง ${to} มีผู้จองแล้ว ให้ใช้การสลับที่นั่ง`);
      if (from) { const a = db.assignments.find((x) => x.seat_id === from && x.guest_id === gid); if (!a) throw new Error(`แขกคนนี้ไม่ได้นั่งที่ ${from}`); a.seat_id = to; }
      else db.assignments.push({ seat_id: to, guest_id: gid });
      if (g.registered_at) g.seat_changed_at = new Date().toISOString();
      log(from ? 'move' : 'assign', gid, { name: g.full_name, from, to, reason }); commit();
    },
    async swap(a, b, reason) {
      need('supervisor'); const A = owner(a), B = owner(b);
      if (!A || !B) throw new Error('ต้องเลือกที่นั่งที่มีผู้จองทั้งสองที่');
      if (A.guest_id === B.guest_id) throw new Error('ทั้งสองที่นั่งเป็นของแขกคนเดียวกัน');
      [A.guest_id, B.guest_id] = [B.guest_id, A.guest_id];
      [A.guest_id, B.guest_id].forEach((id) => { const g = G(id); if (g.registered_at) g.seat_changed_at = new Date().toISOString(); });
      log('swap', B.guest_id, { a, b, guest_a: B.guest_id, guest_b: A.guest_id, reason }); commit();
    },
    async release(sid, reason) {
      need('supervisor'); const i = db.assignments.findIndex((x) => x.seat_id === sid);
      if (i < 0) throw new Error(`ที่นั่ง ${sid} ว่างอยู่แล้ว`);
      const [a] = db.assignments.splice(i, 1); log('release', a.guest_id, { seat: sid, reason }); commit();
    },
    async block(sid, on) {
      need('supervisor'); if (on && owner(sid)) throw new Error(`ที่นั่ง ${sid} มีผู้จองอยู่ ย้ายแขกออกก่อนจึงปิดได้`);
      const s = seatRow(sid); if (!s) throw new Error(`ไม่พบที่นั่ง ${sid}`); s.blocked = on; log(on ? 'block' : 'unblock', null, { seat: sid }); commit();
    },
    async updateGuest(gid, f, reason) {
      need('supervisor'); const g = G(gid); if (!String(f.full_name || '').trim()) throw new Error('ต้องใส่ชื่อ-นามสกุล');
      const old = { name: g.full_name, org: g.org };
      Object.assign(g, { full_name: f.full_name.trim(), org: f.org || null, note: f.note || null, seat_count: Math.max(1, +f.seat_count || 1), counter_no: f.counter_no ? +f.counter_no : null });
      log('edit', gid, { old_name: old.name, name: g.full_name, old_org: old.org, org: g.org, reason }); commit();
    },
    async addGuest(f) {
      need('supervisor'); if (!String(f.full_name || '').trim()) throw new Error('ต้องใส่ชื่อ-นามสกุล');
      const order = db.guests.filter((g) => g.group_no === +f.group_no).reduce((m, g) => Math.max(m, g.order_no), 0) + 1;
      const g = { id: db.nextId++, group_no: +f.group_no, order_no: order, full_name: f.full_name.trim(), org: f.org || null, seat_count: Math.max(1, +f.seat_count || 1),
        counter_no: f.counter_no ? +f.counter_no : null, note: f.note || null, registered_at: null, registered_by: null, seat_changed_at: null };
      db.guests.push(g); log('add', g.id, { name: g.full_name, group: g.group_no }); commit(); return g;
    },
    async importRows(rows, replace) {
      need('supervisor');
      const next = JSON.parse(JSON.stringify(db));
      if (replace) { next.guests = []; next.assignments = []; }
      const seatSet = new Set(next.seats.map((s) => s.seat_id));
      const ids = rows.map((r) => {
        let g = next.guests.find((x) => x.group_no === r.group_no && x.order_no === r.order_no);
        if (!g) { g = { id: next.nextId++, registered_at: null, registered_by: null, seat_changed_at: null }; next.guests.push(g); }
        Object.assign(g, { group_no: r.group_no, order_no: r.order_no, full_name: r.full_name, org: r.org, seat_count: r.seat_count, counter_no: r.counter_no, note: r.note });
        return g.id;
      });
      const inFile = new Set(ids);
      next.assignments = next.assignments.filter((a) => !inFile.has(a.guest_id));
      for (const [i, r] of rows.entries()) {
        const g = { id: ids[i] };
        for (const s of r.seats) {
          if (!seatSet.has(s)) throw new Error(`ไม่มีที่นั่ง ${s} ในผัง (กลุ่ม ${r.group_no} ลำดับ ${r.order_no})`);
          const o = next.assignments.find((a) => a.seat_id === s);
          if (o) throw new Error(`ที่นั่ง ${s} ซ้ำ: กลุ่ม ${r.group_no} ลำดับ ${r.order_no} กับ ${next.guests.find((x) => x.id === o.guest_id)?.full_name}`);
          next.assignments.push({ seat_id: s, guest_id: g.id });
        }
      }
      db = next; log('import', null, { rows: rows.length, replace }); commit(); return rows.length;
    },
    async setLayout(layout) {
      need('supervisor'); const seats = [];
      layout.forEach((r, i) => { let num = 0; r.blocks.forEach((cnt, b) => { for (let k = 0; k < cnt; k++) { num++; const old = seatRow(r.row + num); seats.push({ seat_id: r.row + num, row_label: r.row, row_idx: i, block: b, pos: num, blocked: old ? old.blocked : false }); } }); });
      const ids = new Set(seats.map((s) => s.seat_id));
      const lost = db.assignments.filter((a) => !ids.has(a.seat_id)).map((a) => a.seat_id);
      if (lost.length) throw new Error('ผังใหม่ไม่มีที่นั่งที่มีผู้จองอยู่: ' + lost.slice(0, 10).join(', '));
      db.seats = seats; log('layout', null, { seats: seats.length }); commit(); return seats.length;
    },
    async reset() { need('supervisor'); db.guests.forEach((g) => (g.registered_at = g.registered_by = g.seat_changed_at = null)); log('reset', null, null); commit(); },
    async simulate(n) {
      const wait = db.guests.filter((g) => !g.registered_at && (db.assignments.some((a) => a.guest_id === g.id)));
      for (let i = 0; i < n && wait.length; i++) { const g = wait.splice(Math.floor(Math.random() * wait.length), 1)[0]; g.registered_at = new Date().toISOString(); g.registered_by = 'จำลอง'; }
      log('simulate', null, { n }); commit();
    },
  };
})();

/* ================================================================ Supabase backend */
const SupaBackend = (() => {
  let sb = null, channel = null, wasDown = false;
  const QKEY = 'royal-queue-v1', SNAP = 'royal-snapshot-v1', MEKEY = 'royal-me-v1';
  // สำเนาข้อมูลล่าสุดในเครื่อง: ค้นชื่อได้แม้เปิดแอปตอนเน็ตหลุด
  const saveSnap = () => sset(localStorage, SNAP, { at: new Date().toISOString(), guests: [...S.guests.values()], seats: [...S.seats.values()],
    assignments: [...S.assign].map(([seat_id, guest_id]) => ({ seat_id, guest_id })), log: S.log.slice(0, 50) });
  const isNet = (e) => !navigator.onLine || /fetch|network|Failed to fetch|Load failed/i.test(e?.message || '');

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  }
  async function fetchAll(table, order) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select('*').order(order).range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }
  async function loadAll() {
    const [guests, seats, assignments] = await Promise.all([fetchAll('guests', 'id'), fetchAll('seats', 'seat_id'), fetchAll('seat_assignments', 'seat_id')]);
    const { data: log } = await sb.from('change_log').select('*').order('id', { ascending: false }).limit(200);
    setRows({ guests, seats, assignments, log: log || [] });
  }
  const upsertGuest = (g) => { S.guests.set(g.id, g); };

  // คิวลงทะเบียนตอนเน็ตหลุด
  const queue = () => sget(localStorage, QKEY, []);
  const setQueue = (q) => { sset(localStorage, QKEY, q); S.pending = new Set(q.map((x) => x.gid)); setConn(); };
  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      let q = queue();
      while (q.length) {
        const item = q[0];
        try { upsertGuest(await rpc('register_guest', { p_guest: item.gid, p_at: item.at })); }
        catch (e) { if (isNet(e)) break; if (!/^ลงทะเบียนไปแล้ว/.test(e.message)) toast('ส่งรายการค้างไม่สำเร็จ: ' + e.message, true); }
        q = queue().slice(1); setQueue(q);
      }
    } finally { flushing = false; render(); }
  }

  return {
    client() {
      if (!sb) sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true } });
      return sb;
    },
    async session() { const { data } = await this.client().auth.getSession(); return data.session; },
    async signIn(email, password) {
      const { error } = await this.client().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message === 'Invalid login credentials' ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' : error.message);
    },
    async signOut() { try { localStorage.removeItem(SNAP); localStorage.removeItem(MEKEY); } catch (e) {} await this.client().auth.signOut(); },
    async staff() {
      const { data: ses } = await sb.auth.getSession();
      const uid = ses.session?.user?.id;
      try {
        const { data, error } = await sb.from('staff').select('display_name, role').eq('user_id', uid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw Object.assign(new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน ติดต่อผู้ดูแลระบบ'), { final: true });
        const me = { name: data.display_name, role: data.role, uid }; sset(localStorage, MEKEY, me); return me;
      } catch (e) {
        const me = sget(localStorage, MEKEY, null);
        if (!e.final && isNet(e) && me && me.uid === uid) return me;   // เปิดแอปตอนออฟไลน์
        throw e;
      }
    },
    async load() {
      S.pending = new Set(queue().map((x) => x.gid));
      try { await loadAll(); saveSnap(); }
      catch (e) {
        const snap = sget(localStorage, SNAP, null); if (!snap) throw e;
        setRows(snap); toast(`ออฟไลน์: ใช้ข้อมูลที่บันทึกในเครื่อง เมื่อ ${hhmm(snap.at)} น.`, true);
      }
      setInterval(saveSnap, 30000);
    },
    subscribe() {
      channel = sb.channel('royal-db')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'guests' }, (p) => {
          if (p.eventType === 'DELETE') S.guests.delete(p.old.id); else upsertGuest(p.new);
          render();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'seat_assignments' }, (p) => {
          if (p.eventType !== 'INSERT' && p.old && p.old.seat_id) S.assign.delete(p.old.seat_id);
          if (p.eventType !== 'DELETE') S.assign.set(p.new.seat_id, p.new.guest_id);
          reindex(); render();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, (p) => {
          if (p.eventType === 'DELETE') S.seats.delete(p.old.seat_id); else S.seats.set(p.new.seat_id, p.new);
          reindex(); render();
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'change_log' }, (p) => { S.log.unshift(p.new); S.log.length = Math.min(S.log.length, 200); if (location.hash === '#manage') renderLog(); })
        .subscribe(async (status) => {
          S.live = status === 'SUBSCRIBED';
          if (S.live && wasDown) { wasDown = false; try { await loadAll(); render(); } catch (e) { /* retry later */ } }
          if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) wasDown = true;
          setConn();
          if (S.live) flush();
        });
      window.addEventListener('online', () => { flush(); loadAll().then(render).catch(() => {}); });
      window.addEventListener('offline', setConn);
      setInterval(() => { if (!S.live && navigator.onLine) loadAll().then(render).catch(() => {}); }, 60000);
      setInterval(() => { if (queue().length) flush(); }, 10000);
    },
    async register(gid) {
      const at = new Date().toISOString();
      try { upsertGuest(await rpc('register_guest', { p_guest: gid, p_at: at })); }
      catch (e) {
        if (!isNet(e)) throw e;
        setQueue([...queue().filter((x) => x.gid !== gid), { gid, at }]);
        toast('เน็ตขัดข้อง: บันทึกไว้ในเครื่อง จะส่งให้อัตโนมัติเมื่อเน็ตกลับมา');
      }
    },
    async unregister(gid, reason) {
      if (S.pending.has(gid)) { setQueue(queue().filter((x) => x.gid !== gid)); return; }
      upsertGuest(await rpc('unregister_guest', { p_guest: gid, p_reason: reason || null }));
    },
    assign: (gid, from, to, reason) => rpc('assign_seat', { p_guest: gid, p_from: from || null, p_to: to, p_reason: reason || null }),
    swap: (a, b, reason) => rpc('swap_seats', { p_a: a, p_b: b, p_reason: reason || null }),
    release: (sid, reason) => rpc('release_seat', { p_seat: sid, p_reason: reason || null }),
    block: (sid, on) => rpc('set_seat_blocked', { p_seat: sid, p_blocked: on }),
    async updateGuest(gid, f, reason) {
      upsertGuest(await rpc('update_guest', { p_guest: gid, p_name: f.full_name, p_org: f.org || null, p_note: f.note || null, p_seat_count: +f.seat_count || 1, p_counter: f.counter_no ? +f.counter_no : null, p_reason: reason || null }));
    },
    async addGuest(f) {
      const g = await rpc('add_guest', { p_group: +f.group_no, p_name: f.full_name, p_org: f.org || null, p_seat_count: +f.seat_count || 1, p_counter: f.counter_no ? +f.counter_no : null, p_note: f.note || null });
      upsertGuest(g); return g;
    },
    async importRows(rows, replace) { const n = await rpc('import_guests', { p_rows: rows, p_replace: replace }); await loadAll(); return n; },
    async setLayout(layout) { const n = await rpc('set_layout', { p_layout: layout }); await loadAll(); return n; },
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

/* ================================================================ header / status */
function setConn() {
  const c = $('conn'); const q = S.pending.size;
  if (DEMO) { c.className = 'chip warn'; c.textContent = 'โหมดสาธิต'; return; }
  if (!navigator.onLine) { c.className = 'chip bad'; c.textContent = 'ออฟไลน์' + (q ? ` · รอส่ง ${q}` : ''); return; }
  if (S.live) { c.className = 'chip ok'; c.textContent = 'ออนไลน์ · อัปเดตสด' + (q ? ` · รอส่ง ${q}` : ''); return; }
  c.className = 'chip warn'; c.textContent = 'กำลังเชื่อมต่อใหม่' + (q ? ` · รอส่ง ${q}` : '');
}
function renderStats() {
  let total = 0, taken = 0, ppl = 0;
  for (const g of S.guests.values()) { const n = seatsOf(g.id).length; total += n; if (isReg(g)) { taken += n; ppl++; } }
  $('sTotal').textContent = fmt(total); $('sTaken').textContent = fmt(taken); $('sFree').textContent = fmt(total - taken);
  $('sPeople').textContent = fmt(ppl) + ' / ' + fmt(S.guests.size);
  $('sBar').style.width = (total ? (taken / total) * 100 : 0) + '%';
}

/* ================================================================ counter */
let selectedId = null, list = [], cur = -1;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function search() {
  const q = $('q').value.trim().replace(/\s+/g, ' ');
  const m = q.match(/^(ก|กลุ่ม)\s*(\d+)$/);
  const all = [...S.guests.values()];
  if (m) list = all.filter((g) => g.group_no === +m[2]).sort((a, b) => a.order_no - b.order_no);
  else if (!q) list = [];
  else {
    const parts = norm(q).split(' ');
    list = all.filter((g) => { const h = norm(g.full_name + ' ' + (g.org || '')); return parts.every((p) => h.includes(p)); })
      .sort((a, b) => a.group_no - b.group_no || a.order_no - b.order_no).slice(0, 50);
  }
  cur = list.length ? 0 : -1; renderResults();
}
function statusPill(g) {
  if (S.pending.has(g.id)) return '<span class="pill warn">รอส่ง</span>';
  if (seatMoved(g)) return `<span class="pill warn">ลงแล้ว ${hhmm(g.registered_at)} · ย้ายที่นั่ง</span>`;
  return g.registered_at ? `<span class="pill taken">ลงแล้ว ${hhmm(g.registered_at)}</span>` : '<span class="pill free">ยังไม่ลง</span>';
}
function renderResults() {
  const box = $('results');
  if (!$('q').value.trim()) { box.innerHTML = `<div class="empty">เริ่มพิมพ์ชื่อแขกเพื่อค้นหา<br>รายชื่อทั้งหมด ${fmt(S.guests.size)} ราย</div>`; return; }
  list = list.map((g) => S.guests.get(g.id)).filter(Boolean);
  if (!list.length) { box.innerHTML = '<div class="empty">ไม่พบรายชื่อนี้ ลองพิมพ์เฉพาะชื่อหรือนามสกุล</div>'; return; }
  box.innerHTML = list.map((g, i) => `<button type="button" class="row${selectedId === g.id || i === cur ? ' sel' : ''}" data-id="${g.id}">
    <div class="gq">กลุ่ม<b>${g.group_no}</b>ลำดับ ${g.order_no}</div>
    <div><div class="nm">${esc(g.full_name)}</div><div class="ag">${esc(g.org || '')} · ${seatsOf(g.id).length} ที่นั่ง · ช่อง ${g.counter_no ?? '–'}</div></div>
    ${statusPill(g)}</button>`).join('');
}
let slipEdit = false;
const isSheet = () => matchMedia('(max-width:880px)').matches;
function openSlip() { if (!isSheet()) return; $('slip').classList.add('open'); $('slipBack').hidden = false; }
function closeSlip() { $('slip').classList.remove('open'); $('slipBack').hidden = true; }
function renderSlip() {
  renderSlipInner();
  const x = document.createElement('button'); x.type = 'button'; x.className = 'sheet-x'; x.setAttribute('aria-label', 'ปิด'); x.textContent = '✕';
  x.onclick = closeSlip; $('slip').prepend(x);
}
function renderSlipInner() {
  const s = $('slip'); const g = selectedId != null ? S.guests.get(selectedId) : null;
  if (!g) {
    s.innerHTML = '<h2>ใบลงทะเบียน</h2><p class="sub">เลือกรายชื่อจากผลการค้นหา แล้วตรวจบัตรเชิญและบัตรประชาชนก่อนยืนยัน</p><div class="big"><div><span>กลุ่ม</span><b>–</b></div><div><span>ลำดับที่</span><b>–</b></div><div class="ch"><span>รับบัตรช่อง</span><b>–</b></div></div>';
    return;
  }
  const seats = seatsOf(g.id);
  const keepChecks = s.dataset.gid === String(g.id) ? [$('c1')?.checked, $('c2')?.checked] : [false, false];
  s.dataset.gid = g.id;
  if (slipEdit && can('supervisor')) {
    s.innerHTML = `<h2>แก้ไขข้อมูลแขก</h2><p class="sub">กลุ่ม ${g.group_no} ลำดับ ${g.order_no} · ใช้กรณีผู้มาแทนหรือข้อมูลผิด</p>
      <form id="editForm" class="stack">
        <label class="f">ชื่อ-นามสกุล<input id="eName" value="${esc(g.full_name)}" required></label>
        <label class="f">หน่วยงาน/สังกัด<input id="eOrg" value="${esc(g.org || '')}"></label>
        <div class="formgrid"><label class="f">จำนวนที่นั่ง<input id="eSeats" type="number" min="1" value="${g.seat_count}"></label>
        <label class="f">ช่องรับบัตร<input id="eCounter" type="number" min="1" value="${g.counter_no ?? ''}"></label></div>
        <label class="f">หมายเหตุ<input id="eNote" value="${esc(g.note || '')}"></label>
        <label class="f">เหตุผล<input id="eReason" placeholder="เช่น ผู้มาแทน นาย ก."></label>
        <button class="btn full" type="submit">บันทึก</button><button class="btn ghost full" type="button" id="eCancel">ยกเลิก</button>
      </form>`;
    $('eCancel').onclick = () => { slipEdit = false; renderSlip(); };
    $('editForm').onsubmit = async (e) => {
      e.preventDefault();
      const ok = await act(() => B.updateGuest(g.id, { full_name: $('eName').value, org: $('eOrg').value, note: $('eNote').value, seat_count: $('eSeats').value, counter_no: $('eCounter').value }, $('eReason').value), 'บันทึกแล้ว');
      if (ok) { slipEdit = false; renderSlip(); }
    };
    return;
  }
  const warns = [];
  if (seatMoved(g)) warns.push(`<div class="msg warn">ย้ายที่นั่งหลังลงทะเบียน เมื่อ ${hhmm(g.seat_changed_at)} น. ให้เรียกบัตรที่นั่งเดิมคืน แล้วออกบัตรใหม่</div>`);
  if (seats.length !== g.seat_count) warns.push(`<div class="msg warn">จัดที่นั่งแล้ว ${seats.length} จาก ${g.seat_count} ที่ ${can('supervisor') ? '' : 'แจ้งหัวหน้างาน'}</div>`);
  const sup = can('supervisor') ? `<div class="stack" style="margin-top:8px"><button class="btn ghost full" type="button" id="toEdit">แก้ไขข้อมูล / ผู้มาแทน</button>
     ${seats.length < g.seat_count ? '<button class="btn ghost full" type="button" id="toAssign">จัดที่นั่งบนผัง</button>' : ''}</div>` : '';
  let action = '';
  if (can('counter', 'supervisor')) {
    action = isReg(g)
      ? `<div class="done">${S.pending.has(g.id) ? 'ลงทะเบียนแล้ว (รอส่งขึ้นระบบ)' : `ลงทะเบียนแล้ว ${hhmm(g.registered_at)} น. · ${esc(g.registered_by || '')}`}</div>
         ${canUndo(g) ? '<button class="btn ghost full" id="undo" type="button">ยกเลิกการลงทะเบียน (กรณีกดผิด)</button>' : '<p class="ag" style="text-align:center">ต้องการยกเลิก ให้แจ้ง Lead</p>'}`
      : `<div class="checks"><label><input type="checkbox" id="c1"${keepChecks[0] ? ' checked' : ''}> ตรวจบัตรเชิญแล้ว</label><label><input type="checkbox" id="c2"${keepChecks[1] ? ' checked' : ''}> ตรวจบัตรประชาชนตรงกับชื่อ</label></div>
         <button class="btn full" id="confirm" type="button"${keepChecks[0] && keepChecks[1] ? '' : ' disabled'}>ยืนยันลงทะเบียน · ส่งไปช่อง ${g.counter_no ?? '–'}</button>`;
  }
  s.innerHTML = `<h2>${esc(g.full_name)}</h2><p class="sub">${esc(g.org || '')}</p>
    <div class="big"><div><span>กลุ่ม</span><b>${g.group_no}</b></div><div><span>ลำดับที่</span><b>${g.order_no}</b></div><div class="ch"><span>รับบัตรช่อง</span><b>${g.counter_no ?? '–'}</b></div></div>
    <dl><dt>จำนวนที่นั่ง</dt><dd>${g.seat_count}</dd><dt>เลขที่นั่ง</dt><dd class="num">${seats.join(', ') || '–'}</dd><dt>หมายเหตุ</dt><dd>${esc(g.note || '–')}</dd></dl>
    <div class="stack" style="margin-bottom:10px">${warns.join('')}</div>${action}${sup}`;
  if ($('c1')) { const upd = () => ($('confirm').disabled = !($('c1').checked && $('c2').checked)); $('c1').onchange = upd; $('c2').onchange = upd;
    $('confirm').onclick = async () => {
      $('confirm').disabled = true;
      if (await act(() => B.register(g.id), `ลงทะเบียนแล้ว · ส่งแขกไปช่อง ${g.counter_no ?? '–'}`)) { if (isSheet()) { closeSlip(); $('q').value = ''; search(); } }
      $('q').focus(); $('q').select();
    }; }
  if ($('undo')) $('undo').onclick = () => act(() => B.unregister(g.id, 'กดผิด'), 'ยกเลิกแล้ว');
  if ($('toEdit')) $('toEdit').onclick = () => { slipEdit = true; renderSlip(); };
  if ($('toAssign')) $('toAssign').onclick = () => { startPick(g.id); location.hash = 'seats'; };
}
function selectGuest(id) {
  selectedId = id; slipEdit = false; renderResults(); renderSlip(); openSlip();
  if (isSheet()) $('q').blur();
}

/* ================================================================ seat map */
const EM = { on: false, src: null, pick: null };   // edit mode: src = seat ที่เลือกต้นทาง, pick = guest id ที่กำลังจัดที่นั่ง
function buildSeats() {
  const rows = new Map();
  for (const s of S.seats.values()) { if (!rows.has(s.row_idx)) rows.set(s.row_idx, { label: s.row_label, blocks: new Map() }); const r = rows.get(s.row_idx); if (!r.blocks.has(s.block)) r.blocks.set(s.block, []); r.blocks.get(s.block).push(s); }
  const html = [...rows.keys()].sort((a, b) => a - b).map((k) => {
    const r = rows.get(k);
    const blocks = [...r.blocks.keys()].sort((a, b) => a - b).map((b) => '<div class="blk">' + r.blocks.get(b).sort((x, y) => x.pos - y.pos)
      .map((s) => `<button type="button" class="seat" data-s="${esc(s.seat_id)}" aria-label="ที่นั่ง ${esc(s.seat_id)}"></button>`).join('') + '</div>').join('');
    return `<div class="srow"><span class="rl">${esc(r.label)}</span>${blocks}<span class="rl">${esc(r.label)}</span></div>`;
  }).join('');
  $('seats').innerHTML = html || '<div class="empty">ยังไม่มีผังที่นั่ง หัวหน้างานตั้งผังได้ที่หน้า “จัดการ”</div>';
}
let zoom = null;   // null = พอดีจอ
function applyZoom() {
  const seats = $('seats'); seats.style.zoom = 1;
  const z = zoom ?? Math.min(1.6, Math.max(0.4, ($('hall').clientWidth - 16) / Math.max(1, seats.scrollWidth)));
  seats.style.zoom = z.toFixed(3);
}
function paintSeats() {
  const sig = [...S.seats.keys()].join(',');
  if (sig !== S.layoutSig) { S.layoutSig = sig; buildSeats(); requestAnimationFrame(applyZoom); }
  const gf = $('gfilter').value;
  const hl = new Set(popSeat && S.assign.has(popSeat) ? seatsOf(S.assign.get(popSeat)) : []);
  document.querySelectorAll('.seat').forEach((el) => {
    const sid = el.dataset.s, st = S.seats.get(sid), gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null;
    let c = 'seat';
    if (st && st.blocked) c += ' x'; else if (g) c += isReg(g) ? ' t' : ' f';
    if (g && seatMoved(g)) c += ' chg';
    if (gf && (!g || g.group_no !== +gf)) c += ' dim';
    if (hl.has(sid)) c += ' hl';
    if (EM.src === sid) c += ' src';
    el.className = c;
  });
  renderEditBar();
}
function showTip(sid) {
  const gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null, st = S.seats.get(sid);
  $('tip').innerHTML = g ? `ที่นั่ง <b>${esc(sid)}</b> · ${esc(g.full_name)} · ${esc(g.org || '')}<br>กลุ่ม ${g.group_no} ลำดับ ${g.order_no} · ช่อง ${g.counter_no ?? '–'} · ${statusPill(g)}`
    : `ที่นั่ง <b>${esc(sid)}</b> · ${st && st.blocked ? 'ปิดที่นั่ง' : 'ว่าง ไม่มีผู้จอง'}`;
}
let popSeat = null;
function closePop() { $('pop').hidden = true; popSeat = null; paintSeats(); }
function placePop(el) {
  const p = $('pop'); p.hidden = false;
  const r = el.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), innerWidth - w - 16) + 'px';
  let top = r.bottom + 10; if (top + h > innerHeight - 16) top = Math.max(16, r.top - h - 10);
  p.style.top = top + 'px';
}
function guestCard(g) {
  return `<h4>${esc(g.full_name)}</h4><div class="ag">${esc(g.org || '')}</div>
    <div class="big"><div><span>กลุ่ม</span><b>${g.group_no}</b></div><div><span>ลำดับที่</span><b>${g.order_no}</b></div><div class="ch"><span>ช่อง</span><b>${g.counter_no ?? '–'}</b></div></div>
    <dl><dt>ที่นั่ง</dt><dd class="num">${seatsOf(g.id).join(', ')} (${seatsOf(g.id).length} ที่)</dd><dt>สถานะ</dt><dd>${statusPill(g)}${g.registered_by ? ' · ' + esc(g.registered_by) : ''}</dd><dt>หมายเหตุ</dt><dd>${esc(g.note || '–')}</dd></dl>`;
}
function openInfo(el) {
  const sid = el.dataset.s, gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null, st = S.seats.get(sid), p = $('pop');
  popSeat = sid; showTip(sid);
  p.innerHTML = '<button class="x" type="button" aria-label="ปิด">✕</button>' + (g
    ? guestCard(g) + (can('counter', 'supervisor') ? '<button class="small-btn" type="button" id="popGo" style="width:100%">เปิดในหน้าเคาน์เตอร์</button>' : '')
    : `<h4>ที่นั่ง ${esc(sid)}</h4><div class="ag">${st && st.blocked ? 'ปิดที่นั่ง ใช้ไม่ได้' : 'ว่าง ไม่มีผู้จอง'}</div>`);
  p.querySelector('.x').onclick = closePop;
  if ($('popGo')) $('popGo').onclick = () => { $('q').value = g.full_name; search(); selectGuest(g.id); closePop(); location.hash = 'register'; };
  placePop(el); paintSeats();
}
function confirmPop(el, title, body, warn, run) {
  const p = $('pop'); popSeat = el.dataset.s;
  p.innerHTML = `<button class="x" type="button" aria-label="ปิด">✕</button><h4>${title}</h4><div class="ag">${body}</div>
    ${warn ? `<div class="msg warn" style="margin-bottom:6px">${warn}</div>` : ''}
    <label class="f">เหตุผล${warn ? ' (จำเป็น)' : ''}<textarea id="popReason" placeholder="เช่น ผู้ใหญ่ขอนั่งติดกัน"></textarea></label>
    <div class="acts"><button class="btn" type="button" id="popOk">ยืนยัน</button><button class="btn ghost" type="button" id="popNo">ยกเลิก</button></div>`;
  p.querySelector('.x').onclick = closePop; $('popNo').onclick = closePop;
  $('popOk').onclick = async () => {
    const reason = $('popReason').value.trim();
    if (warn && !reason) { toast('ต้องใส่เหตุผล เพราะแขกรับบัตรไปแล้ว', true); return; }
    $('popOk').disabled = true;
    if (await run(reason)) { closePop(); }
    else $('popOk').disabled = false;
  };
  placePop(el); paintSeats();
}
function startPick(gid) { EM.on = true; EM.src = null; EM.pick = gid; $('editMode').classList.add('on'); paintSeats(); }
function stopEdit() { EM.on = false; EM.src = null; EM.pick = null; $('editMode').classList.remove('on'); closePop(); }
function renderEditBar() {
  const bar = $('editBar');
  if (!EM.on) { bar.hidden = true; return; }
  bar.hidden = false;
  let txt;
  if (EM.pick != null) {
    const g = S.guests.get(EM.pick); const n = seatsOf(EM.pick).length;
    if (!g || n >= g.seat_count) { EM.pick = null; return renderEditBar(); }
    txt = `จัดที่นั่งให้ <b>${esc(g.full_name)}</b> (${n}/${g.seat_count}) · แตะที่นั่งว่าง`;
  } else if (EM.src) {
    const g = S.guests.get(S.assign.get(EM.src));
    txt = `ย้าย/สลับ <b>${esc(g ? g.full_name : '')}</b> จาก ${esc(EM.src)} · แตะที่นั่งว่างเพื่อย้าย หรือที่นั่งที่มีคนเพื่อสลับ <button class="small-btn" type="button" id="relSeat">ปล่อยที่นั่งนี้ให้ว่าง</button>`;
  } else txt = 'โหมดแก้ไขที่นั่ง: แตะที่นั่งที่มีคนเพื่อย้ายหรือสลับ · แตะที่นั่งว่างเพื่อปิด/เปิดที่นั่ง';
  bar.innerHTML = `<span style="flex:1 1 240px">${txt}</span><button class="small-btn" type="button" id="editDone">เสร็จสิ้น</button>`;
  $('editDone').onclick = stopEdit;
  if ($('relSeat')) $('relSeat').onclick = () => {
    const el = document.querySelector(`.seat[data-s="${CSS.escape(EM.src)}"]`); const g = S.guests.get(S.assign.get(EM.src)); const src = EM.src;
    confirmPop(el, `ปล่อยที่นั่ง ${esc(src)} ให้ว่าง`, `${esc(g.full_name)} จะไม่มีที่นั่งนี้`, g.registered_at ? 'แขกลงทะเบียนแล้ว ต้องเรียกบัตรเดิมคืน' : '',
      async (r) => { const ok = await act(() => B.release(src, r), 'ปล่อยที่นั่งแล้ว'); if (ok) EM.src = null; return ok; });
  };
}
function editClick(el) {
  const sid = el.dataset.s, st = S.seats.get(sid), gid = S.assign.get(sid), g = gid != null ? S.guests.get(gid) : null;
  if (EM.pick != null) {
    const pg = S.guests.get(EM.pick);
    if (g || (st && st.blocked)) { toast('เลือกที่นั่งว่างที่ไม่ได้ปิด', true); return; }
    confirmPop(el, `จัดที่นั่ง ${esc(sid)}`, `ให้ ${esc(pg.full_name)} (กลุ่ม ${pg.group_no} ลำดับ ${pg.order_no})`, pg.registered_at ? 'แขกลงทะเบียนแล้ว แจ้งช่องรับบัตรให้ออกบัตรเพิ่ม' : '',
      (r) => act(() => B.assign(pg.id, null, sid, r), `จัดที่นั่ง ${sid} แล้ว`));
    return;
  }
  if (!EM.src) {
    if (g) { EM.src = sid; showTip(sid); paintSeats(); return; }
    const on = !(st && st.blocked);
    confirmPop(el, `${on ? 'ปิด' : 'เปิด'}ที่นั่ง ${esc(sid)}`, on ? 'ที่นั่งนี้จะจัดให้แขกไม่ได้' : 'ที่นั่งนี้จะกลับมาใช้งานได้', '',
      () => act(() => B.block(sid, on), on ? 'ปิดที่นั่งแล้ว' : 'เปิดที่นั่งแล้ว'));
    return;
  }
  if (sid === EM.src) { EM.src = null; paintSeats(); return; }
  const src = EM.src, sg = S.guests.get(S.assign.get(src));
  if (st && st.blocked) { toast(`ที่นั่ง ${sid} ถูกปิดอยู่`, true); return; }
  if (g) {
    const w = [sg, g].filter((x) => x.registered_at).map((x) => esc(x.full_name));
    confirmPop(el, `สลับที่นั่ง ${esc(src)} ↔ ${esc(sid)}`, `${esc(sg.full_name)} ไปนั่ง ${esc(sid)}<br>${esc(g.full_name)} ไปนั่ง ${esc(src)}`,
      w.length ? `${w.join(' และ ')} ลงทะเบียนแล้ว ต้องเรียกบัตรเดิมคืน` : '',
      async (r) => { const ok = await act(() => B.swap(src, sid, r), 'สลับที่นั่งแล้ว'); if (ok) EM.src = null; return ok; });
  } else {
    confirmPop(el, `ย้ายที่นั่ง ${esc(src)} → ${esc(sid)}`, `${esc(sg.full_name)} (กลุ่ม ${sg.group_no} ลำดับ ${sg.order_no})`,
      sg.registered_at ? 'แขกลงทะเบียนแล้ว ต้องเรียกบัตรเดิมคืน' : '',
      async (r) => { const ok = await act(() => B.assign(sg.id, src, sid, r), `ย้ายไป ${sid} แล้ว`); if (ok) EM.src = null; return ok; });
  }
}

/* ================================================================ groups */
let openGroup = null, gMode = 'all';
function groupNos() { return [...new Set([...S.guests.values()].map((g) => g.group_no))].sort((a, b) => a - b); }
function renderGroups() {
  const by = new Map();
  for (const g of S.guests.values()) { if (!by.has(g.group_no)) by.set(g.group_no, []); by.get(g.group_no).push(g); }
  $('groups').innerHTML = [...by.keys()].sort((a, b) => a - b).map((no) => {
    const gs = by.get(no); let t = 0, d = 0; const rows = new Set(); const ctr = new Set();
    gs.forEach((g) => { const ss = seatsOf(g.id); t += ss.length; if (isReg(g)) d += ss.length; ss.forEach((s) => rows.add(S.seats.get(s)?.row_label)); if (g.counter_no) ctr.add(g.counter_no); });
    const rl = [...rows].filter(Boolean);
    return `<button type="button" class="g" data-g="${no}"><div class="top"><h3>กลุ่ม ${no}</h3><span class="n">${d}/${t}</span></div>
      <div class="meta">${gs.length} รายชื่อ · ช่อง ${[...ctr].join(', ') || '–'}${rl.length ? ' · แถว ' + esc(rl[0]) + (rl.length > 1 ? '–' + esc(rl[rl.length - 1]) : '') : ''}</div>
      <div class="bar"><i style="width:${t ? (d / t) * 100 : 0}%"></i></div></button>`;
  }).join('') || '<div class="empty">ยังไม่มีรายชื่อ หัวหน้างานนำเข้าได้ที่หน้า “จัดการ”</div>';
  const sel = $('gfilter'), v = sel.value;
  sel.innerHTML = '<option value="">ทุกกลุ่ม</option>' + groupNos().map((n) => `<option value="${n}">กลุ่ม ${n}</option>`).join('');
  sel.value = v;
  renderDetail();
}
function renderDetail() {
  const d = $('gdetail');
  if (openGroup == null) { d.hidden = true; $('glist').hidden = false; return; }
  d.hidden = false; $('glist').hidden = true;
  const gs = [...S.guests.values()].filter((g) => g.group_no === openGroup).sort((a, b) => a.order_no - b.order_no);
  const done = gs.filter(isReg), wait = gs.filter((g) => !isReg(g));
  const st = gs.reduce((a, g) => a + seatsOf(g.id).length, 0), sd = done.reduce((a, g) => a + seatsOf(g.id).length, 0);
  const rows = gMode === 'done' ? done : gMode === 'wait' ? wait : gs;
  d.innerHTML = `<div class="gd-head"><button class="small-btn" id="gback" type="button">← ทุกกลุ่ม</button><h2>กลุ่ม ${openGroup}</h2><button class="small-btn" id="gmap" type="button">ดูกลุ่มนี้ในผังที่นั่ง</button></div>
    <div class="gd-sum"><div class="stat"><b>${gs.length}</b><span>รายชื่อ</span></div><div class="stat red"><b>${done.length}</b><span>ลงทะเบียนแล้ว</span></div><div class="stat blue"><b>${wait.length}</b><span>ยังไม่มา</span></div><div class="stat"><b>${sd}/${st}</b><span>ที่นั่ง</span></div></div>
    <div class="seg" role="group" aria-label="กรองสถานะ">
      <button type="button" data-m="all" aria-pressed="${gMode === 'all'}">ทั้งหมด ${gs.length}</button>
      <button type="button" data-m="wait" aria-pressed="${gMode === 'wait'}">ยังไม่ลงทะเบียน ${wait.length}</button>
      <button type="button" data-m="done" aria-pressed="${gMode === 'done'}">ลงทะเบียนแล้ว ${done.length}</button></div>
    <div class="tbl"><table><thead><tr><th>ลำดับ</th><th>ชื่อ-นามสกุล / หน่วยงาน</th><th>เลขที่นั่ง</th><th>ช่อง</th><th>หมายเหตุ</th><th>สถานะ</th></tr></thead><tbody>
    ${rows.length ? rows.map((g) => `<tr data-id="${g.id}"${can('counter', 'supervisor') ? ' class="click"' : ''}><td class="num c-order">${g.order_no}</td><td class="c-name">${esc(g.full_name)}<div class="ag">${esc(g.org || '')}</div></td><td class="num" data-label="ที่นั่ง">${seatsOf(g.id).join(', ') || '–'}</td><td class="num" data-label="ช่อง">${g.counter_no ?? '–'}</td><td data-label="หมายเหตุ">${esc(g.note || '–')}</td><td class="c-status">${statusPill(g)}</td></tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">ไม่มีรายชื่อในสถานะนี้</td></tr>'}
    </tbody></table></div>`;
  $('gback').onclick = () => { openGroup = null; renderDetail(); };
  $('gmap').onclick = () => { $('gfilter').value = openGroup; location.hash = 'seats'; paintSeats(); };
  d.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { gMode = b.dataset.m; renderDetail(); }));
  if (can('counter', 'supervisor')) d.querySelectorAll('tbody tr[data-id]').forEach((tr) => (tr.onclick = () => {
    const g = S.guests.get(+tr.dataset.id); $('q').value = g.full_name; search(); selectGuest(g.id); location.hash = 'register';
  }));
}
function exportCsv() {
  const head = ['กลุ่ม', 'ลำดับ', 'ชื่อ-นามสกุล', 'หน่วยงาน/สังกัด', 'จำนวนที่นั่ง', 'เลขที่นั่ง', 'ช่องติดต่อ', 'หมายเหตุ', 'สถานะ', 'เวลาลงทะเบียน', 'ผู้บันทึก', 'ย้ายที่นั่งหลังลงทะเบียน'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [...S.guests.values()].sort((a, b) => a.group_no - b.group_no || a.order_no - b.order_no).map((g) => [
    g.group_no, g.order_no, g.full_name, g.org, g.seat_count, seatsOf(g.id).join(' '), g.counter_no, g.note,
    isReg(g) ? 'ลงทะเบียนแล้ว' : 'ยังไม่มา', g.registered_at ? new Date(g.registered_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '', g.registered_by, seatMoved(g) ? 'ใช่' : '']);
  const csv = '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `รายงานลงทะเบียน-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`; document.body.appendChild(a); a.click(); a.remove();
}
function printList() {
  const by = new Map(); for (const g of S.guests.values()) { if (!by.has(g.group_no)) by.set(g.group_no, []); by.get(g.group_no).push(g); }
  $('print').innerHTML = `<p>${esc(CFG.EVENT_NAME || '')} · รายชื่อสำรอง พิมพ์เมื่อ ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>` +
    [...by.keys()].sort((a, b) => a - b).map((no) => `<section><h2>กลุ่ม ${no}</h2><table><thead><tr><th>ลำดับ</th><th>ชื่อ-นามสกุล</th><th>หน่วยงาน</th><th>ที่นั่ง</th><th>ช่อง</th><th>หมายเหตุ</th><th>มาแล้ว</th></tr></thead><tbody>` +
      by.get(no).sort((a, b) => a.order_no - b.order_no).map((g) => `<tr><td>${g.order_no}</td><td>${esc(g.full_name)}</td><td>${esc(g.org || '')}</td><td>${seatsOf(g.id).join(', ')}</td><td>${g.counter_no ?? ''}</td><td>${esc(g.note || '')}</td><td>${isReg(g) ? '✓ ' + hhmm(g.registered_at) : '☐'}</td></tr>`).join('') +
      '</tbody></table></section>').join('');
  window.print();
}

/* ================================================================ manage */
let importRows = null;
function parseSeats(v) { return String(v ?? '').toUpperCase().split(/[,\s;、/]+/).map((s) => s.trim()).filter(Boolean); }
function parseWorkbook(wb) {
  const rows = [], errors = [];
  wb.SheetNames.forEach((name) => {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
    const hi = data.findIndex((r) => r.some((c) => /ชื่อ/.test(String(c))));
    if (hi < 0) return;
    const head = data[hi].map((c) => String(c).trim()); const col = {};
    head.forEach((h, i) => {
      if (col.group == null && /^กลุ่ม/.test(h)) col.group = i;
      else if (col.order == null && /^ลำดับ/.test(h)) col.order = i;
      else if (col.count == null && /จำนวน/.test(h)) col.count = i;
      else if (col.seats == null && /ที่นั่ง/.test(h)) col.seats = i;
      else if (col.name == null && /ชื่อ/.test(h)) col.name = i;
      else if (col.org == null && /หน่วยงาน|สังกัด/.test(h)) col.org = i;
      else if (col.counter == null && /ช่อง/.test(h)) col.counter = i;
      else if (col.note == null && /หมายเหตุ/.test(h)) col.note = i;
    });
    const sheetGroup = +(String(name).match(/\d+/) || [])[0] || null;
    data.slice(hi + 1).forEach((r, k) => {
      const nameV = String(r[col.name] ?? '').trim(); if (!nameV) return;
      const group = col.group != null && String(r[col.group]).trim() ? +String(r[col.group]).replace(/\D/g, '') : sheetGroup;
      const line = `ชีท “${name}” แถว ${hi + k + 2}`;
      if (!group) { errors.push(`${line}: ไม่รู้เลขกลุ่ม (ตั้งชื่อชีทเป็น “กลุ่ม 1” หรือเพิ่มคอลัมน์ กลุ่ม)`); return; }
      const order = col.order != null && String(r[col.order]).trim() ? +String(r[col.order]).replace(/\D/g, '') : rows.filter((x) => x.group_no === group).length + 1;
      const seats = col.seats != null ? parseSeats(r[col.seats]) : [];
      const count = col.count != null && +r[col.count] ? +r[col.count] : Math.max(1, seats.length);
      rows.push({ group_no: group, order_no: order, full_name: nameV, org: col.org != null ? String(r[col.org]).trim() || null : null, seat_count: count,
        counter_no: col.counter != null && String(r[col.counter]).trim() ? +String(r[col.counter]).replace(/\D/g, '') || null : null,
        note: col.note != null ? String(r[col.note]).trim() || null : null, seats, _line: line });
    });
  });
  const seen = new Map(), key = new Set();
  rows.forEach((r) => {
    const k = r.group_no + '-' + r.order_no; if (key.has(k)) errors.push(`${r._line}: กลุ่ม ${r.group_no} ลำดับ ${r.order_no} ซ้ำ`); key.add(k);
    r.seats.forEach((s) => {
      if (!S.seats.has(s)) errors.push(`${r._line}: ไม่มีที่นั่ง ${s} ในผัง`);
      if (seen.has(s)) errors.push(`${r._line}: ที่นั่ง ${s} ซ้ำกับ ${seen.get(s)}`); seen.set(s, r.full_name);
    });
  });
  return { rows, errors };
}
function layoutToText() {
  const rows = new Map();
  for (const s of S.seats.values()) { if (!rows.has(s.row_idx)) rows.set(s.row_idx, { label: s.row_label, b: [] }); const r = rows.get(s.row_idx); r.b[s.block] = (r.b[s.block] || 0) + 1; }
  return [...rows.keys()].sort((a, b) => a - b).map((k) => `${rows.get(k).label}: ${rows.get(k).b.map((x) => x || 0).join(', ')}`).join('\n');
}
function parseLayout(text) {
  return text.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l, i) => {
    const m = l.match(/^([^:]+):\s*(.+)$/); if (!m) throw new Error(`บรรทัด ${i + 1}: ต้องเป็นรูปแบบ  A: 4, 12, 4`);
    const blocks = m[2].split(/[,\s]+/).filter(Boolean).map(Number);
    if (!blocks.length || blocks.some((n) => !Number.isInteger(n) || n < 0 || n > 200)) throw new Error(`บรรทัด ${i + 1}: จำนวนที่นั่งไม่ถูกต้อง`);
    return { row: m[1].trim().toUpperCase(), blocks };
  });
}
const ACT = { register: 'ลงทะเบียน', unregister: 'ยกเลิกลงทะเบียน', move: 'ย้ายที่นั่ง', assign: 'จัดที่นั่ง', swap: 'สลับที่นั่ง', release: 'ปล่อยที่นั่ง', block: 'ปิดที่นั่ง', unblock: 'เปิดที่นั่ง', edit: 'แก้ไขข้อมูล', add: 'เพิ่มแขก', import: 'นำเข้ารายชื่อ', layout: 'แก้ผังที่นั่ง', reset: 'ล้างการลงทะเบียน', simulate: 'จำลองแขกมาถึง' };
function logText(l) {
  const d = l.detail || {}; const g = l.guest_id != null ? S.guests.get(l.guest_id) : null; const nm = esc(d.name || (g && g.full_name) || '');
  let t = `<b>${ACT[l.action] || esc(l.action)}</b> `;
  if (l.action === 'move') t += `${nm} ${esc(d.from)} → ${esc(d.to)}`;
  else if (l.action === 'assign') t += `${nm} → ${esc(d.to)}`;
  else if (l.action === 'swap') t += `${esc(d.a)} ↔ ${esc(d.b)}`;
  else if (['release', 'block', 'unblock'].includes(l.action)) t += esc(d.seat) + (nm ? ' · ' + nm : '');
  else if (l.action === 'edit') t += d.old_name !== d.name ? `${esc(d.old_name)} → ${esc(d.name)}` : nm;
  else if (l.action === 'import') t += `${d.rows} รายชื่อ${d.replace ? ' (แทนที่ทั้งหมด)' : ''}`;
  else if (l.action === 'layout') t += `${d.seats} ที่นั่ง`;
  else if (l.action === 'simulate') t += `${d.n} คน`;
  else t += nm;
  if (d.reason) t += ` · เหตุผล: ${esc(d.reason)}`;
  return `<div><time>${hhmm(l.at)}</time>${t} <span class="ag">· ${esc(l.actor || '')}</span></div>`;
}
function renderLog() { $('log').innerHTML = S.log.length ? S.log.slice(0, 200).map(logText).join('') : '<div>ยังไม่มีรายการ</div>'; }
function renderManage() {
  if (document.activeElement !== $('layoutText')) $('layoutText').value = layoutToText();
  $('demoArrive').hidden = !DEMO; renderLog();
}

/* ================================================================ render / routing */
let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0; renderStats(); setConn();
    const v = currentView();
    if (v === 'register') { renderResults(); renderSlip(); }
    if (v === 'seats') { paintSeats(); if (popSeat && !$('pop').hidden && !$('popReason')) { const el = document.querySelector(`.seat[data-s="${CSS.escape(popSeat)}"]`); if (el) openInfo(el); } }
    if (v === 'groups') renderGroups();
    if (v === 'manage') renderManage();
  });
}
function allowed(el) { const need = el.dataset.need; return !need || need.split(',').includes(S.me.role); }
function currentView() {
  const v = location.hash.slice(1);
  const link = document.querySelector(`nav a[data-v="${v}"]`);
  if (link && allowed(link)) return v;
  return can('viewer') ? 'seats' : 'register';
}
function route() {
  const v = currentView();
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  document.querySelectorAll('nav a').forEach((a) => { a.hidden = !allowed(a); if (a.dataset.v === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('editMode').hidden = !can('supervisor');
  if (v !== 'seats') { if (!$('pop').hidden) closePop(); }
  if (v === 'groups') renderGroups();
  render();
  if (v === 'register') setTimeout(() => $('q').focus(), 0);
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

  $('seats').addEventListener('mouseover', (e) => { const s = e.target.closest('.seat'); if (s && !EM.src) showTip(s.dataset.s); });
  $('seats').addEventListener('click', (e) => {
    const s = e.target.closest('.seat'); if (!s) return; e.stopPropagation();
    if (EM.on) { editClick(s); return; }
    if (popSeat === s.dataset.s) closePop(); else openInfo(s);
  });
  document.addEventListener('click', (e) => { if (!$('pop').hidden && !e.target.closest('#pop') && !e.target.closest('.seat')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('pop').hidden) closePop(); else if (EM.src) { EM.src = null; paintSeats(); } } });
  window.addEventListener('scroll', () => { if (!$('pop').hidden && !$('popReason')) closePop(); }, { passive: true });
  $('gfilter').addEventListener('change', paintSeats);
  $('editMode').onclick = () => { if (EM.on) stopEdit(); else { EM.on = true; EM.src = null; EM.pick = null; $('editMode').classList.add('on'); closePop(); } };

  $('groups').addEventListener('click', (e) => { const b = e.target.closest('.g'); if (!b) return; openGroup = +b.dataset.g; gMode = 'all'; renderDetail(); window.scrollTo(0, 0); });
  $('exportCsv').onclick = exportCsv;
  $('printList').onclick = printList;

  $('xlsx').onchange = async () => {
    const f = $('xlsx').files[0]; importRows = null; $('importBtn').disabled = true;
    if (!f) { $('importInfo').innerHTML = ''; return; }
    if (!window.XLSX) { $('importInfo').innerHTML = '<div class="msg err">โหลดตัวอ่าน Excel ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองใหม่</div>'; return; }
    try {
      const { rows, errors } = parseWorkbook(XLSX.read(await f.arrayBuffer(), { type: 'array' }));
      const groups = new Set(rows.map((r) => r.group_no)).size, seats = rows.reduce((a, r) => a + r.seats.length, 0);
      if (errors.length) $('importInfo').innerHTML = `<div class="msg err">พบ ${errors.length} ปัญหา แก้ในไฟล์แล้วเลือกใหม่<br>${errors.slice(0, 8).map(esc).join('<br>')}${errors.length > 8 ? '<br>...' : ''}</div>`;
      else if (!rows.length) $('importInfo').innerHTML = '<div class="msg err">ไม่พบรายชื่อ ตรวจว่าแถวหัวตารางมีคำว่า “ชื่อ”</div>';
      else { importRows = rows.map(({ _line, ...r }) => r); $('importBtn').disabled = false; $('importInfo').innerHTML = `<div class="msg ok">พร้อมนำเข้า ${fmt(rows.length)} รายชื่อ · ${groups} กลุ่ม · ${fmt(seats)} ที่นั่ง</div>`; }
    } catch (e) { $('importInfo').innerHTML = `<div class="msg err">อ่านไฟล์ไม่ได้: ${esc(e.message)}</div>`; }
  };
  $('importBtn').onclick = async () => {
    if (!importRows) return; $('importBtn').disabled = true;
    const n = await act(() => B.importRows(importRows, $('importReplace').checked));
    if (n) { toast(`นำเข้าแล้ว ${fmt(n)} รายชื่อ`); importRows = null; $('xlsx').value = ''; $('importInfo').innerHTML = ''; } else $('importBtn').disabled = false;
  };
  $('addForm').onsubmit = async (e) => {
    e.preventDefault();
    const g = await act(() => B.addGuest({ group_no: $('aGroup').value, full_name: $('aName').value, org: $('aOrg').value, seat_count: $('aSeats').value, counter_no: $('aCounter').value, note: $('aNote').value }));
    if (g && g.id != null) { toast(`เพิ่ม ${g.full_name} เป็นกลุ่ม ${g.group_no} ลำดับ ${g.order_no} แล้ว เลือกที่นั่งได้เลย`); $('addForm').reset(); $('aSeats').value = 1; startPick(g.id); location.hash = 'seats'; }
  };
  $('layoutBtn').onclick = async () => {
    let layout; try { layout = parseLayout($('layoutText').value); } catch (e) { toast(e.message, true); return; }
    const n = await act(() => B.setLayout(layout)); if (n) toast(`บันทึกผังแล้ว ${fmt(n)} ที่นั่ง`);
  };
  $('resetOk').onchange = () => ($('resetBtn').disabled = !$('resetOk').checked);
  $('resetBtn').onclick = async () => { if (await act(() => B.reset(), 'ล้างการลงทะเบียนแล้ว')) { $('resetOk').checked = false; $('resetBtn').disabled = true; } };
  $('demoArrive').onclick = () => act(() => B.simulate(25), 'จำลองแขกมาถึง 25 คนแล้ว');

  window.addEventListener('hashchange', route);
  $('logout').onclick = async () => { if (DEMO) { try { sessionStorage.removeItem('royal-demo-me'); } catch (e) {} } else await SupaBackend.signOut(); location.hash = ''; location.reload(); };
  $('reloadBtn').onclick = () => location.reload();
  $('slipBack').onclick = closeSlip;
  document.querySelectorAll('.zoom [data-z]').forEach((b) => (b.onclick = () => {
    const d = +b.dataset.z; const cur = parseFloat($('seats').style.zoom) || 1;
    zoom = d === 0 ? null : Math.min(2.4, Math.max(0.35, cur * (d > 0 ? 1.25 : 0.8))); applyZoom();
  }));
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (zoom == null) applyZoom(); if (!isSheet()) closeSlip(); }, 150); });
}

/* ================================================================ PWA */
let installEvt = null;
function setupPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; toast('ติดตั้งแอปแล้ว เปิดจากหน้าจอโฮมได้เลย'); });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone;
  if (ios) $('installBtn').hidden = false;
  $('installBtn').onclick = async () => {
    if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; }
    else toast('iPhone/iPad: แตะปุ่มแชร์ ⬆︎ ใน Safari แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”');
  };
}
// จอแสดงผล (Onboard): กันจอดับระหว่างเปิดผังที่นั่ง
let wake = null;
async function keepAwake() {
  try {
    const want = can('viewer') && document.visibilityState === 'visible' && currentView() === 'seats';
    if (want && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); }
    if (!want && wake) { await wake.release(); wake = null; }
  } catch (e) { /* not allowed */ }
}

/* ================================================================ version check */
let ver = null;
async function checkVersion() {
  try { const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return; const v = (await r.json()).version;
    if (ver == null) ver = v; else if (v !== ver) $('verBanner').hidden = false; } catch (e) { /* offline or file:// */ }
}

/* ================================================================ start */
async function start() {
  $('login').hidden = true; $('app').hidden = false;
  $('whoName').textContent = `${S.me.name} · ${ROLE_LABEL[S.me.role]}`;
  try { await B.load(); } catch (e) { toast('โหลดข้อมูลไม่สำเร็จ: ' + e.message, true); }
  B.subscribe();
  route(); keepAwake();
  document.addEventListener('visibilitychange', keepAwake); window.addEventListener('hashchange', keepAwake);
  checkVersion(); setInterval(checkVersion, 60000);
}
// "Counter 1" → counter1@STAFF_DOMAIN ; ใส่อีเมลเต็มก็ได้
function toEmail(v) {
  v = String(v || '').trim();
  if (v.includes('@')) return v.toLowerCase();
  return v.toLowerCase().replace(/\s+/g, '') + '@' + (CFG.STAFF_DOMAIN || 'khonperformance.com');
}
function loadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
}
async function init() {
  if (DEMO && !window.DEMO_DATA) { try { await loadScript('demo-data.js'); } catch (e) { /* demo data missing */ } }
  document.title = CFG.EVENT_NAME ? CFG.EVENT_NAME : document.title;
  $('eventName').textContent = $('loginTitle').textContent = CFG.EVENT_NAME || 'ระบบลงทะเบียนรอบเสด็จ';
  $('venue').textContent = $('loginVenue').textContent = (CFG.VENUE || '') + (DEMO ? ' · โหมดสาธิต ข้อมูลสมมุติ' : '');
  wire(); setupPwa();
  if (DEMO) {
    const me = sget(sessionStorage, 'royal-demo-me', null);
    if (me) { S.me = me; return start(); }
    $('login').hidden = false; $('loginDemo').hidden = false;
    document.querySelectorAll('#loginDemo [data-role]').forEach((b) => (b.onclick = () => {
      S.me = { name: $('demoName').value.trim() || ROLE_LABEL[b.dataset.role], role: b.dataset.role };
      sset(sessionStorage, 'royal-demo-me', S.me); start();
    }));
    return;
  }
  if (!window.supabase) { $('login').hidden = false; $('loginForm').hidden = false; $('loginErr').hidden = false; $('loginErr').textContent = 'โหลดไลบรารี Supabase ไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วรีเฟรช'; return; }
  SupaBackend.client();
  const showForm = (msg) => { $('login').hidden = false; $('loginForm').hidden = false; $('loginErr').hidden = !msg; $('loginErr').textContent = msg || ''; };
  const enter = async () => { try { S.me = await SupaBackend.staff(); await start(); } catch (e) { await SupaBackend.signOut(); showForm(e.message); } };
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault(); $('loginBtn').disabled = true;
    try { await SupaBackend.signIn(toEmail($('email').value), $('password').value); await enter(); }
    catch (err) { showForm(err.message); } finally { $('loginBtn').disabled = false; }
  };
  if (await SupaBackend.session()) await enter(); else showForm();
}
init();
})();
