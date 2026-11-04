// ============================================================================
//  Swaadly PRO - ek hi file mein poora food-delivery app (backend + frontend)
//  Sirf Node.js (v18+) ke built-in modules. Koi npm install nahi.
//
//  Chalane ke liye:   node server.js
//  Settings (env):    PORT, DATA_DIR, ADMIN_EMAIL, ADMIN_PASSWORD,
//                     UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (online storage),
//                     TAX_RATE, DELIVERY_FEE, FREE_DELIVERY_ABOVE, MAX_TIP, MIN_ORDER, SESSION_DAYS
// ============================================================================
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const env = process.env, num = (k, d) => (env[k] !== undefined && env[k] !== '' && !isNaN(+env[k]) ? +env[k] : d);

const CFG = {
  PORT: num('PORT', 3000), TAX_RATE: num('TAX_RATE', 0.05), DELIVERY_FEE: num('DELIVERY_FEE', 30),
  FREE_DELIVERY_ABOVE: num('FREE_DELIVERY_ABOVE', 300), MAX_TIP: num('MAX_TIP', 500), MIN_ORDER: num('MIN_ORDER', 0),
  SESSION_DAYS: num('SESSION_DAYS', 30), ADMIN_EMAIL: (env.ADMIN_EMAIL || 'admin@swaadly.com').toLowerCase(),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || 'admin123'
};
const DB_FILE = path.join(env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');
const STATUSES = ['Placed', 'Preparing', 'Out for delivery', 'Delivered'];
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- Passwords
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  return crypto.timingSafeEqual(Buffer.from(hash(pw, salt).split(':')[1], 'hex'), Buffer.from(h, 'hex'));
};

// ---------------------------------------------------------------- Seed data
function seed() {
  const r = (id, name, cuisine, rating, time, emoji, bg, menu) => ({ id, name, cuisine, rating, baseRating: rating, time, emoji, bg, open: true, reviews: [],
    menu: menu.map(([n, p, nv]) => ({ name: n, price: p, veg: nv !== 'N', available: true })) });
  return {
    users: [{ id: 1, name: 'Admin', email: CFG.ADMIN_EMAIL, pass: hash(CFG.ADMIN_PASSWORD), isAdmin: true, favorites: [], createdAt: new Date().toISOString() }],
    sessions: {}, orders: [], nextOrderId: 1001,
    coupons: [
      { code: 'WELCOME50', type: 'flat', value: 50, min: 200, text: '₹50 off, minimum order ₹200', firstOrderOnly: true, active: true, used: 0 },
      { code: 'FOOD10', type: 'percent', value: 10, max: 100, min: 0, text: '10% off, maximum ₹100', active: true, used: 0 }
    ],
    restaurants: [
      r(1, 'Punjabi Tadka', 'North Indian', 4.4, 30, '🍛', '#ffe3d6', [['Butter Chicken', 320, 'N'], ['Dal Makhani', 220], ['Garlic Naan', 50], ['Paneer Tikka', 260]]),
      r(2, 'Pizza Junction', 'Pizza', 4.1, 25, '🍕', '#fff0c9', [['Margherita', 199], ['Farmhouse', 329], ['Garlic Bread', 120]]),
      r(3, 'Biryani House', 'Biryani', 4.6, 35, '🍚', '#e6f3d4', [['Chicken Biryani', 280, 'N'], ['Veg Biryani', 220], ['Raita', 40]]),
      r(4, 'Burger Barn', 'Burger', 3.9, 20, '🍔', '#ffe0e0', [['Aloo Tikki Burger', 99], ['Chicken Burger', 149, 'N'], ['French Fries', 89]]),
      r(5, 'South Spice', 'South Indian', 4.5, 28, '🥞', '#e0eefb', [['Masala Dosa', 110], ['Idli Sambar', 80], ['Filter Coffee', 50]]),
      r(6, 'Meetha Ghar', 'Desserts', 4.3, 22, '🍰', '#f5e1f7', [['Gulab Jamun', 90], ['Brownie', 130], ['Rasmalai', 110]])
    ]
  };
}
// purane db ko naye features ke layak bana deta hai (data kabhi nahi mitata)
function migrate(d) {
  d.users ||= []; d.orders ||= []; d.coupons ||= []; d.restaurants ||= []; d.sessions ||= {};
  const now = Date.now();
  for (const [t, v] of Object.entries(d.sessions)) if (typeof v === 'number') d.sessions[t] = { uid: v, exp: now + CFG.SESSION_DAYS * 864e5 };
  for (const u of d.users) { u.favorites ||= []; u.createdAt ||= new Date().toISOString(); }
  for (const r of d.restaurants) { r.open ??= true; r.baseRating ??= r.rating; r.reviews ||= []; for (const m of r.menu) { m.veg ??= true; m.available ??= true; } }
  for (const c of d.coupons) { c.used ??= 0; c.active ??= true; }
  for (const o of d.orders) o.history ||= [{ status: o.status, at: o.createdAt }];
  d.nextOrderId ||= Math.max(1000, ...d.orders.map(o => o.id)) + 1;
  return d;
}

// ---------------------------------------------------------------- Storage: Redis ya local file
const REDIS_URL = env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = env.UPSTASH_REDIS_REST_TOKEN, KEY = 'swaadly_db';
const redis = async cmd => {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw Object.assign(new Error('Database error: ' + (j.error || r.status)), { status: 500 });
  return j.result;
};
const storeGet = async () => { if (REDIS_URL) return await redis(['GET', KEY]); try { return fs.readFileSync(DB_FILE, 'utf8'); } catch { return null; } };
const storeSet = async text => {
  if (REDIS_URL) return redis(['SET', KEY, text]);
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, DB_FILE); // atomic: beech mein crash ho to bhi file na bigde
};
let db, chain = Promise.resolve();
const save = () => { const p = chain.then(() => storeSet(JSON.stringify(db))); chain = p.catch(e => log('SAVE FAIL', e.message)); return p; }; // writes line se chalte hain

// ---------------------------------------------------------------- HTTP helpers
const send = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });
const body = req => new Promise((ok, no) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e6) { no(Object.assign(new Error('Request bahut badi hai'), { status: 413 })); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('Galat JSON')); } });
});
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const buckets = new Map();
const limited = (key, max, win) => { const n = Date.now(); let b = buckets.get(key); if (!b || b.reset < n) { b = { n: 0, reset: n + win }; buckets.set(key, b); } return ++b.n > max; };
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k);
  let ch = false; for (const [t, s] of Object.entries(db?.sessions || {})) if (s.exp < n) { delete db.sessions[t]; ch = true; } if (ch) save(); }, 60e3).unref();

const authUser = req => {
  const t = (req.headers.authorization || '').replace('Bearer ', ''), s = db.sessions[t];
  if (!s || s.exp < Date.now()) return null;
  const u = db.users.find(x => x.id === s.uid); if (u) req.token = t; return u;
};
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, isAdmin: !!u.isAdmin, favorites: u.favorites || [], lastAddress: u.lastAddress || '' });
const newSession = async u => { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = { uid: u.id, exp: Date.now() + CFG.SESSION_DAYS * 864e5 }; await save(); return { token: t, user: publicUser(u) }; };
const pubRest = r => ({ ...r, reviews: undefined, baseRating: undefined, reviewCount: r.reviews.length });
const round2 = n => Math.round(n * 100) / 100, addMinutes = (min, from = Date.now()) => new Date(from + min * 60000).toISOString();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------- Coupons, pricing
function applyCoupon(code, subtotal, user) {
  if (!code) return { discount: 0 };
  const c = db.coupons.find(x => x.code === String(code).toUpperCase());
  if (!c || c.active === false) return { error: 'Ye coupon code galat hai' };
  if (c.expires && new Date(c.expires).getTime() + 864e5 < Date.now()) return { error: 'Ye coupon expire ho chuka hai' };
  if (c.limit && c.used >= c.limit) return { error: 'Ye coupon poora use ho chuka hai' };
  if (c.firstOrderOnly && user && db.orders.some(o => o.userId === user.id && o.status !== 'Cancelled')) return { error: 'Ye coupon sirf pehle order par chalta hai' };
  if (subtotal < c.min) return { error: `Is coupon ke liye kam se kam ₹${c.min} ka order chahiye` };
  let d = c.type === 'flat' ? c.value : Math.floor(subtotal * c.value / 100);
  if (c.max) d = Math.min(d, c.max);
  return { discount: Math.min(d, subtotal), code: c.code };
}
const orderTotal = o => { // purane orders ke liye bhi total sahi rahe
  const subtotal = o.items.reduce((s, i) => s + i.price * i.qty, 0);
  return { subtotal, total: round2(Math.max(0, subtotal - (o.discount || 0) + (o.tax || 0) + (o.deliveryFee || 0) + (o.tip || 0))) };
};
const withTotals = o => ({ ...o, ...orderTotal(o) });

// Cart ka poora hisaab server par: items, coupon, tax, delivery fee, tip, ETA, suggestions
function priceCart(items, coupon, tip, user) {
  if (!Array.isArray(items) || !items.length || items.length > 50) return { error: 'Cart khali hai' };
  let subtotal = 0, etaMin = 0; const lines = [], rids = new Set();
  for (const it of items) { // price hamesha server par se, client par bharosa nahi
    const rest = db.restaurants.find(r => r.id === it.rid), dish = rest && rest.menu.find(d => d.name === it.name), qty = Math.floor(Number(it.qty));
    if (!dish || !(qty >= 1 && qty <= 20)) return { error: 'Cart mein galat item hai' };
    if (!rest.open) return { error: `${rest.name} abhi band hai` };
    if (dish.available === false) return { error: `${dish.name} abhi available nahi hai` };
    rids.add(rest.id); etaMin = Math.max(etaMin, Number(rest.time) || 30);
    subtotal += dish.price * qty; lines.push({ rid: rest.id, restaurant: rest.name, name: dish.name, price: dish.price, qty, veg: dish.veg !== false });
  }
  if (subtotal < CFG.MIN_ORDER) return { error: `Kam se kam ₹${CFG.MIN_ORDER} ka order chahiye` };
  const c = applyCoupon(coupon, subtotal, user); if (c.error) return { error: c.error };
  const taxable = subtotal - c.discount, tax = round2(taxable * CFG.TAX_RATE);
  const free = subtotal >= CFG.FREE_DELIVERY_ABOVE, deliveryFee = free ? 0 : CFG.DELIVERY_FEE;
  const tipAmt = Math.min(CFG.MAX_TIP, Math.max(0, Math.floor(Number(tip) || 0)));
  const inCart = new Set(items.map(i => i.rid + '|' + i.name)), suggestions = [];
  for (const rid of rids) for (const d of db.restaurants.find(r => r.id === rid).menu)
    if (d.available !== false && !inCart.has(rid + '|' + d.name) && suggestions.length < 3) suggestions.push({ rid, restaurant: db.restaurants.find(r => r.id === rid).name, name: d.name, price: d.price });
  return { lines, subtotal, discount: c.discount, coupon: c.code || null, tax, deliveryFee, tip: tipAmt, total: round2(taxable + tax + deliveryFee + tipAmt),
    savings: c.discount + (free ? CFG.DELIVERY_FEE : 0), freeDeliveryLeft: free ? 0 : CFG.FREE_DELIVERY_ABOVE - subtotal,
    etaMinutes: etaMin + 10, estimatedDelivery: addMinutes(etaMin + 10), suggestions };
}
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const pushHistory = (o, status) => o.history.push({ status, at: new Date().toISOString() });
const findDish = (rid, name) => { const r = db.restaurants.find(x => x.id === Number(rid)); return [r, r && r.menu.find(d => d.name === name)]; };

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const m = req.method, p = url.pathname, ip = ipOf(req);
  if (limited('api:' + ip, 300, 60e3)) return fail(res, 429, 'Bahut zyada requests, thodi der baad try karein');

  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  if (m === 'GET' && p === '/api/config') return send(res, 200, { taxRate: CFG.TAX_RATE, deliveryFee: CFG.DELIVERY_FEE, freeDeliveryAbove: CFG.FREE_DELIVERY_ABOVE, maxTip: CFG.MAX_TIP, minOrder: CFG.MIN_ORDER });
  if (m === 'GET' && p === '/api/restaurants') return send(res, 200, db.restaurants.map(pubRest));
  if (m === 'GET' && p === '/api/coupons') return send(res, 200, db.coupons.filter(c => c.active !== false && !(c.expires && new Date(c.expires).getTime() + 864e5 < Date.now()) && !(c.limit && c.used >= c.limit)));
  const rv = p.match(/^\/api\/restaurants\/(\d+)\/reviews$/);
  if (m === 'GET' && rv) { const r = db.restaurants.find(x => x.id === Number(rv[1])); return r ? send(res, 200, [...r.reviews].reverse().slice(0, 20)) : fail(res, 404, 'Restaurant nahi mili'); }

  if (m === 'POST' && p === '/api/signup') {
    if (limited('signup:' + ip, 10, 3600e3)) return fail(res, 429, 'Bahut zyada signup, baad mein try karein');
    const { name, email, password } = await body(req), em = String(email || '').trim().toLowerCase();
    if (!name || !EMAIL.test(em) || typeof password !== 'string' || password.length < 6) return fail(res, 400, 'Naam, sahi email aur 6+ akshar ka password dein');
    if (db.users.some(u => u.email === em)) return fail(res, 409, 'Ye email pehle se registered hai');
    const u = { id: Date.now(), name: String(name).trim().slice(0, 60), email: em, pass: hash(password), isAdmin: false, favorites: [], createdAt: new Date().toISOString() };
    db.users.push(u); return send(res, 201, await newSession(u));
  }
  if (m === 'POST' && p === '/api/login') {
    if (limited('login:' + ip, 15, 15 * 60e3)) return fail(res, 429, 'Bahut zyada koshish, 15 minute baad try karein');
    const { email, password } = await body(req), u = db.users.find(x => x.email === String(email || '').trim().toLowerCase());
    if (!u || !verify(String(password || ''), u.pass)) return fail(res, 401, 'Email ya password galat hai');
    return send(res, 200, await newSession(u));
  }

  const user = authUser(req);
  if (!user) return fail(res, 401, 'Pehle login karein');
  if (m === 'GET' && p === '/api/me') return send(res, 200, publicUser(user));
  if (m === 'POST' && p === '/api/logout') { delete db.sessions[req.token]; await save(); return send(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/api/me/password') {
    const { current, next } = await body(req);
    if (!verify(String(current || ''), user.pass)) return fail(res, 400, 'Purana password galat hai');
    if (typeof next !== 'string' || next.length < 6) return fail(res, 400, 'Naya password 6+ akshar ka hona chahiye');
    user.pass = hash(next);
    for (const [t, s] of Object.entries(db.sessions)) if (s.uid === user.id && t !== req.token) delete db.sessions[t]; // baaki devices logout
    await save(); return send(res, 200, { ok: true });
  }
  const fv = p.match(/^\/api\/favorites\/(\d+)$/);
  if (m === 'POST' && fv) {
    const id = Number(fv[1]); if (!db.restaurants.some(r => r.id === id)) return fail(res, 404, 'Restaurant nahi mili');
    user.favorites = user.favorites.includes(id) ? user.favorites.filter(x => x !== id) : [...user.favorites, id];
    await save(); return send(res, 200, { favorites: user.favorites });
  }
  if (m === 'POST' && rv) {
    const r = db.restaurants.find(x => x.id === Number(rv[1])); if (!r) return fail(res, 404, 'Restaurant nahi mili');
    const { stars, comment } = await body(req), s = Math.floor(Number(stars));
    if (!(s >= 1 && s <= 5)) return fail(res, 400, 'Rating 1 se 5 ke beech dein');
    if (!db.orders.some(o => o.userId === user.id && o.status === 'Delivered' && o.items.some(i => i.rid === r.id || i.restaurant === r.name))) return fail(res, 403, 'Review ke liye pehle is restaurant se order receive karein');
    const rec = { userId: user.id, userName: user.name, stars: s, comment: String(comment || '').slice(0, 300), at: new Date().toISOString() }, i = r.reviews.findIndex(x => x.userId === user.id);
    if (i >= 0) r.reviews[i] = rec; else r.reviews.push(rec);
    r.rating = Math.round(((r.baseRating * 5 + r.reviews.reduce((a, x) => a + x.stars, 0)) / (5 + r.reviews.length)) * 10) / 10;
    await save(); return send(res, 200, pubRest(r));
  }

  if (m === 'POST' && p === '/api/coupon/check') {
    const { code, subtotal } = await body(req), r = applyCoupon(code, Number(subtotal) || 0, user);
    return r.error ? fail(res, 400, r.error) : send(res, 200, r);
  }
  if (m === 'POST' && p === '/api/cart/quote') { // live bill: har +/- ya tip badalne par
    const { items, coupon, tip } = await body(req), q = priceCart(items, coupon, tip, user);
    return q.error ? fail(res, 400, q.error) : send(res, 200, q);
  }
  if (m === 'POST' && p === '/api/orders') {
    const { items, address, coupon, tip, instructions, paymentMethod } = await body(req);
    if (!address || String(address).trim().length < 5) return fail(res, 400, 'Delivery address likhein');
    if (!['COD', 'UPI', 'CARD'].includes(paymentMethod)) return fail(res, 400, 'Payment ka tareeka chunein');
    const q = priceCart(items, coupon, tip, user); if (q.error) return fail(res, 400, q.error);
    const now = new Date().toISOString();
    const order = { id: db.nextOrderId++, userId: user.id, userName: user.name, items: q.lines, subtotal: q.subtotal, discount: q.discount, coupon: q.coupon,
      tax: q.tax, deliveryFee: q.deliveryFee, tip: q.tip, total: q.total, paymentMethod, paymentStatus: paymentMethod === 'COD' ? 'Delivery par dena hai' : 'Paid (demo)',
      instructions: String(instructions || '').slice(0, 200) || null, address: String(address).trim().slice(0, 200), status: 'Placed', createdAt: now,
      etaMinutes: q.etaMinutes, estimatedDelivery: q.estimatedDelivery, history: [{ status: 'Placed', at: now }] };
    if (q.coupon) { const c = db.coupons.find(x => x.code === q.coupon); if (c) c.used = (c.used || 0) + 1; }
    user.lastAddress = order.address; db.orders.push(order); await save(); return send(res, 201, order);
  }
  if (m === 'GET' && p === '/api/orders') return send(res, 200, db.orders.filter(o => o.userId === user.id).reverse().map(withTotals));
  const om = p.match(/^\/api\/orders\/(\d+)$/);
  if (m === 'GET' && om) { const o = db.orders.find(x => x.id === Number(om[1]) && (x.userId === user.id || user.isAdmin)); return o ? send(res, 200, withTotals(o)) : fail(res, 404, 'Order nahi mila'); }
  const cm = p.match(/^\/api\/orders\/(\d+)\/cancel$/);
  if (m === 'POST' && cm) {
    const o = db.orders.find(x => x.id === Number(cm[1]) && x.userId === user.id);
    if (!o) return fail(res, 404, 'Order nahi mila');
    if (o.status !== 'Placed') return fail(res, 400, 'Order ab cancel nahi ho sakta, restaurant ne ise shuru kar diya hai');
    const { reason } = await body(req);
    cancelOrder(o, reason); await save(); return send(res, 200, withTotals(o));
  }

  if (p.startsWith('/api/admin/')) {
    if (!user.isAdmin) return fail(res, 403, 'Sirf admin ke liye');
    return admin(req, res, url);
  }
  fail(res, 404, 'Ye API nahi mili');
}
function cancelOrder(o, reason) {
  o.status = 'Cancelled'; o.cancelledAt = new Date().toISOString(); o.cancelReason = String(reason || '').slice(0, 200) || null; o.estimatedDelivery = null; o.etaMinutes = null;
  pushHistory(o, 'Cancelled');
  if (o.coupon) { const c = db.coupons.find(x => x.code === o.coupon); if (c && c.used > 0) c.used--; }
}

async function admin(req, res, url) {
  const m = req.method, p = url.pathname, ok = obj => send(res, 200, obj), made = obj => send(res, 201, obj);
  if (m === 'GET' && p === '/api/admin/orders') {
    const st = url.searchParams.get('status'), q = (url.searchParams.get('q') || '').toLowerCase();
    return ok(db.orders.filter(o => (!st || o.status === st) && (!q || String(o.id).includes(q) || o.userName.toLowerCase().includes(q) || o.address.toLowerCase().includes(q))).reverse().map(withTotals));
  }
  if (m === 'GET' && p === '/api/admin/orders.csv') {
    const head = ['Order', 'Date', 'Customer', 'Items', 'Subtotal', 'Discount', 'Tax', 'Delivery', 'Tip', 'Total', 'Payment', 'Status', 'Address'];
    const rows = db.orders.map(withTotals).map(o => [o.id, o.createdAt, o.userName, o.items.map(i => i.name + ' x' + i.qty).join('; '), o.subtotal, o.discount, o.tax || 0, o.deliveryFee || 0, o.tip || 0, o.total, o.paymentMethod || '', o.status, o.address]);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="swaadly-orders.csv"' });
    return res.end('\ufeff' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n'));
  }
  if (m === 'GET' && p === '/api/admin/summary') {
    const all = db.orders.map(withTotals), live = all.filter(o => o.status !== 'Cancelled'), done = live.filter(o => o.status === 'Delivered');
    const days = {}; for (let i = 6; i >= 0; i--) days[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] = { date: '', orders: 0, sales: 0 };
    for (const o of live) { const d = days[o.createdAt.slice(0, 10)]; if (d) { d.orders++; d.sales = round2(d.sales + o.total); } }
    const dish = {}; for (const o of live) for (const i of o.items) { const x = dish[i.name] ||= { name: i.name, qty: 0, revenue: 0 }; x.qty += i.qty; x.revenue += i.qty * i.price; }
    const sales = round2(live.reduce((s, o) => s + o.total, 0));
    return ok({ orders: live.length, totalSales: sales, deliveredSales: round2(done.reduce((s, o) => s + o.total, 0)), avgOrder: live.length ? round2(sales / live.length) : 0,
      pending: live.filter(o => o.status !== 'Delivered').length, cancelled: all.length - live.length, cancelledValue: round2(all.filter(o => o.status === 'Cancelled').reduce((s, o) => s + o.total, 0)),
      customers: db.users.filter(u => !u.isAdmin).length, topDishes: Object.values(dish).sort((a, b) => b.qty - a.qty).slice(0, 5),
      last7Days: Object.entries(days).map(([date, v]) => ({ ...v, date })) });
  }
  if (m === 'GET' && p === '/api/admin/users') return ok(db.users.map(u => ({ ...publicUser(u), createdAt: u.createdAt, orders: db.orders.filter(o => o.userId === u.id).length })));
  if (m === 'GET' && p === '/api/admin/coupons') return ok(db.coupons);
  if (m === 'GET' && p === '/api/admin/backup') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="swaadly-backup.json"' });
    return res.end(JSON.stringify({ ...db, sessions: undefined, users: db.users.map(u => ({ ...u, pass: undefined })) }, null, 2));
  }

  if (m === 'POST' && p === '/api/admin/restaurants') {
    const b = await body(req); if (!b.name || !b.cuisine) return fail(res, 400, 'Naam aur cuisine zaroori hai');
    const r = { id: Date.now(), name: String(b.name).slice(0, 60), cuisine: String(b.cuisine).slice(0, 40), rating: 4.0, baseRating: 4.0, time: Number(b.time) || 30, emoji: b.emoji || '🍽️', bg: '#f1f1f1', open: true, reviews: [], menu: [] };
    db.restaurants.push(r); await save(); return made(pubRest(r));
  }
  const ru = p.match(/^\/api\/admin\/restaurants\/(\d+)\/(update|delete)$/);
  if (m === 'POST' && ru) {
    const i = db.restaurants.findIndex(x => x.id === Number(ru[1])); if (i < 0) return fail(res, 404, 'Restaurant nahi mili');
    if (ru[2] === 'delete') { db.restaurants.splice(i, 1); await save(); return ok({ ok: true }); }
    const b = await body(req), r = db.restaurants[i];
    if (b.name) r.name = String(b.name).slice(0, 60); if (b.cuisine) r.cuisine = String(b.cuisine).slice(0, 40); if (b.emoji) r.emoji = String(b.emoji).slice(0, 8);
    if (Number(b.time) > 0) r.time = Number(b.time); if (typeof b.open === 'boolean') r.open = b.open;
    await save(); return ok(pubRest(r));
  }
  if (m === 'POST' && p === '/api/admin/dishes') {
    const { rid, name, price, veg } = await body(req), r = db.restaurants.find(x => x.id === Number(rid));
    if (!r || !name || !(Number(price) > 0)) return fail(res, 400, 'Restaurant, dish ka naam aur price sahi dein');
    if (r.menu.some(d => d.name === name)) return fail(res, 409, 'Ye dish pehle se menu mein hai');
    r.menu.push({ name: String(name).slice(0, 80), price: Number(price), veg: veg !== false, available: true }); await save(); return made(pubRest(r));
  }
  if (m === 'POST' && p === '/api/admin/dishes/update') {
    const b = await body(req), [r, d] = findDish(b.rid, b.name); if (!d) return fail(res, 404, 'Dish nahi mili');
    if (b.price !== undefined) { if (!(Number(b.price) > 0)) return fail(res, 400, 'Price sahi dein'); d.price = Number(b.price); }
    if (typeof b.available === 'boolean') d.available = b.available; if (typeof b.veg === 'boolean') d.veg = b.veg;
    if (b.newName && b.newName !== d.name) { if (r.menu.some(x => x.name === b.newName)) return fail(res, 409, 'Is naam ki dish pehle se hai'); d.name = String(b.newName).slice(0, 80); }
    await save(); return ok(pubRest(r));
  }
  if (m === 'POST' && p === '/api/admin/dishes/delete') {
    const { rid, name } = await body(req), r = db.restaurants.find(x => x.id === Number(rid)), j = r ? r.menu.findIndex(d => d.name === name) : -1;
    if (j < 0) return fail(res, 404, 'Dish nahi mili'); r.menu.splice(j, 1); await save(); return ok({ ok: true });
  }
  if (m === 'POST' && p === '/api/admin/coupons') {
    const b = await body(req), code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(code) || !['flat', 'percent'].includes(b.type) || !(Number(b.value) > 0)) return fail(res, 400, 'Code (3-20 akshar), type aur value sahi dein');
    if (b.type === 'percent' && Number(b.value) > 100) return fail(res, 400, 'Percent 100 se zyada nahi ho sakta');
    if (db.coupons.some(c => c.code === code)) return fail(res, 409, 'Ye coupon code pehle se hai');
    const c = { code, type: b.type, value: Number(b.value), min: Number(b.min) || 0, max: Number(b.max) || undefined, limit: Number(b.limit) || undefined, expires: b.expires || undefined,
      firstOrderOnly: !!b.firstOrderOnly, active: true, used: 0, text: `${b.type === 'flat' ? '₹' + b.value : b.value + '%'} off${Number(b.min) ? ', minimum ₹' + b.min : ''}` };
    db.coupons.push(c); await save(); return made(db.coupons);
  }
  const cu = p.match(/^\/api\/admin\/coupons\/([^/]+)\/(toggle|delete)$/);
  if (m === 'POST' && cu) {
    const i = db.coupons.findIndex(c => c.code === decodeURIComponent(cu[1]).toUpperCase()); if (i < 0) return fail(res, 404, 'Coupon nahi mila');
    if (cu[2] === 'delete') db.coupons.splice(i, 1); else db.coupons[i].active = db.coupons[i].active === false;
    await save(); return ok(db.coupons);
  }
  const em = p.match(/^\/api\/admin\/orders\/(\d+)\/eta$/);
  if (m === 'POST' && em) {
    const o = db.orders.find(x => x.id === Number(em[1])), { minutes } = await body(req);
    if (!o || ['Delivered', 'Cancelled'].includes(o.status) || !(Number(minutes) >= 0 && Number(minutes) <= 300)) return fail(res, 400, 'Galat order ya minutes (0-300)');
    o.etaMinutes = Number(minutes); o.estimatedDelivery = addMinutes(o.etaMinutes); await save(); return ok(withTotals(o));
  }
  const sm = p.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
  if (m === 'POST' && sm) {
    const o = db.orders.find(x => x.id === Number(sm[1])), b = await body(req), status = b.status;
    if (!o || ![...STATUSES, 'Cancelled'].includes(status)) return fail(res, 400, 'Galat order ya status');
    if (['Delivered', 'Cancelled'].includes(o.status)) return fail(res, 400, `${o.status} order ka status ab nahi badal sakta`);
    if (status !== 'Cancelled' && STATUSES.indexOf(status) < STATUSES.indexOf(o.status)) return fail(res, 400, 'Status peeche nahi ja sakta');
    if (status === 'Cancelled') cancelOrder(o, b.reason);
    else {
      if (status !== o.status) { o.status = status; pushHistory(o, status); }
      if (status === 'Delivered') { o.deliveredAt = new Date().toISOString(); o.estimatedDelivery = o.deliveredAt; o.etaMinutes = 0; if (o.paymentMethod === 'COD') o.paymentStatus = 'Paid (cash)'; }
      else if (b.minutes !== undefined && Number(b.minutes) >= 0) { o.etaMinutes = Number(b.minutes); o.estimatedDelivery = addMinutes(o.etaMinutes); }
      else if (status === 'Out for delivery') { o.etaMinutes = 15; o.estimatedDelivery = addMinutes(15); }
    }
    await save(); return ok(withTotals(o));
  }
  fail(res, 404, 'Ye API nahi mili');
}

// ---------------------------------------------------------------- Frontend (andar hi band hai)
const PAGES = {"index.html":"<!DOCTYPE html>\n<html lang=\"hi\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Swaadly – Food Delivery</title><link rel=\"stylesheet\" href=\"style.css\"></head>\n<body>\n<header class=\"top\">\n  <div class=\"brand\">swaadly</div>\n  <nav class=\"tabs\"><button data-v=\"home\">Restaurants</button><button data-v=\"orders\">Meri orders</button><button data-v=\"admin\" id=\"adminTab\" class=\"hidden\">Admin</button></nav>\n  <input id=\"search\" type=\"search\" placeholder=\"Restaurant ya dish search karein…\">\n  <button id=\"themeBtn\" class=\"ghost\" aria-label=\"Theme badlein\">🌓</button>\n  <button id=\"authBtn\" class=\"ghost\">Login</button>\n  <button id=\"cartBtn\" class=\"primary\">Cart (<span id=\"cartCount\">0</span>)</button>\n</header>\n<main id=\"view\"></main>\n\n<aside id=\"cart\" class=\"panel hidden\">\n  <div class=\"row\"><h2>Aapka cart</h2><button id=\"closeCart\" class=\"ghost\">Band karein</button></div>\n  <div id=\"cartItems\" class=\"grow\"></div>\n  <div class=\"coupon\"><input id=\"coupon\" placeholder=\"Coupon code (jaise WELCOME50)\"><button id=\"applyCoupon\" class=\"ghost\">Lagayein</button></div>\n  <p id=\"couponMsg\" class=\"note\"></p>\n  <div class=\"row tipRow\"><span class=\"note\">Tip:</span><span id=\"tipChips\"></span></div>\n  <input id=\"address\" placeholder=\"Delivery address\">\n  <input id=\"instructions\" placeholder=\"Delivery instructions (optional)\" maxlength=\"200\">\n  <div class=\"sum\" id=\"sum\"></div>\n  <button id=\"checkout\" class=\"primary wide\">Order place karein</button>\n</aside>\n\n<div id=\"modal\" class=\"modal hidden\"><div class=\"box\">\n  <h2 id=\"mTitle\">Login</h2>\n  <input id=\"mName\" placeholder=\"Aapka naam\"><input id=\"mEmail\" type=\"email\" placeholder=\"Email\"><input id=\"mPass\" type=\"password\" placeholder=\"Password (kam se kam 6 akshar)\">\n  <p id=\"mErr\" class=\"err\"></p>\n  <button id=\"mGo\" class=\"primary wide\">Login karein</button>\n  <p class=\"note\"><a href=\"#\" id=\"mSwitch\">Naya account banayein</a> · <a href=\"#\" id=\"mClose\">Band karein</a></p>\n</div></div>\n<div id=\"payModal\" class=\"modal hidden\"><div class=\"box\">\n  <h2>Payment</h2>\n  <p class=\"note\">Demo hai: asli paise nahi kategi aur card ki details kahin save ya server par nahi bheji jaati.</p>\n  <div class=\"row\" id=\"payTabs\"><button data-m=\"UPI\" class=\"chip on\">UPI</button><button data-m=\"CARD\" class=\"chip\">Card</button><button data-m=\"COD\" class=\"chip\">Cash on delivery</button></div>\n  <div id=\"pUPI\"><input id=\"upiId\" placeholder=\"UPI ID (jaise naam@upi)\"></div>\n  <div id=\"pCARD\" class=\"hidden\"><input id=\"cardNo\" inputmode=\"numeric\" placeholder=\"Card number (test: 4242 4242 4242 4242)\" maxlength=\"19\">\n    <div class=\"coupon\"><input id=\"cardExp\" placeholder=\"MM/YY\" maxlength=\"5\"><input id=\"cardCvv\" type=\"password\" inputmode=\"numeric\" placeholder=\"CVV\" maxlength=\"3\"></div></div>\n  <p id=\"pCOD\" class=\"note hidden\">Order milne par delivery partner ko cash ya UPI se payment karein.</p>\n  <p id=\"payErr\" class=\"err\"></p>\n  <button id=\"payGo\" class=\"primary wide\">Pay karein</button>\n  <p class=\"note\"><a href=\"#\" id=\"payClose\">Wapas jayein</a></p>\n</div></div>\n<div id=\"toast\" class=\"toast hidden\"></div>\n<script src=\"app.js\"></script></body></html>\n","style.css":":root{--red:#e23744;--ink:#1c1c1c;--muted:#6b6b6b;--bg:#fff8f5;--card:#fff;--line:#ecdcd5;--green:#267e3e;--chip:#ffe3d6}\n[data-theme=dark]{--ink:#f1ece9;--muted:#a79f9b;--bg:#161312;--card:#211d1c;--line:#3a3331;--chip:#4a2c26}\n*{box-sizing:border-box}body{margin:0;font-family:Georgia,serif;background:var(--bg);color:var(--ink)}\nbutton,input,select{font:inherit;color:inherit}input,select{padding:9px 12px;border:1px solid var(--line);border-radius:8px;width:100%;margin:4px 0;background:var(--card)}\nbutton{cursor:pointer;border-radius:8px;padding:9px 14px;border:1px solid var(--line);background:var(--card)}button:disabled{opacity:.6;cursor:not-allowed}\na{color:var(--red)}.primary{background:var(--red);color:#fff;border-color:var(--red)}.ghost{background:var(--card)}.wide{width:100%;margin-top:8px}.sm{padding:3px 9px;font-size:.85rem}\n.top{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 20px;background:var(--card);border-bottom:1px solid var(--line)}\n.brand{font-size:1.5rem;font-weight:bold;font-style:italic;color:var(--red)}\n.tabs{display:flex;gap:4px}.tabs button{border:0;background:none}.tabs .on{color:var(--red);font-weight:bold;border-bottom:2px solid var(--red);border-radius:0}\n#search{flex:1;min-width:160px;width:auto;margin:0}\nmain{max-width:1000px;margin:auto;padding:20px}\nh1{font-size:clamp(1.7rem,5vw,2.6rem);margin:8px 0}\n.chips{display:flex;gap:8px;overflow-x:auto;padding:8px 0;align-items:center}.chip{border-radius:20px;white-space:nowrap}.chip.on{background:var(--red);color:#fff;border-color:var(--red)}\n.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.toolbar select{width:auto}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}\n.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;cursor:pointer;position:relative}.card.closed{opacity:.55}\n.pic{height:120px;display:grid;place-items:center;font-size:3.4rem;color:#000}.body{padding:12px 14px}.body h3{margin:0 0 4px}\n.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:.9rem}.rating{background:var(--green);color:#fff;border-radius:6px;padding:1px 7px}\n.heart{position:absolute;top:8px;right:8px;border-radius:50%;width:34px;height:34px;padding:0;font-size:1.1rem}\n.box,.menu,.item,.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}\n.menu{grid-column:1/-1;margin:0}.dish,.line,.row{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}\n.dish,.line{padding:9px 0;border-top:1px solid var(--line)}.dish.off{opacity:.5}\n.dish button{border-color:var(--red);color:var(--red)}\n.vd{display:inline-block;width:11px;height:11px;border:1.5px solid var(--green);margin-right:6px;position:relative;vertical-align:middle}.vd:after{content:\"\";position:absolute;inset:2px;border-radius:50%;background:var(--green)}.vd.nv{border-color:#b3261e}.vd.nv:after{background:#b3261e}\n.panel{position:fixed;right:0;top:0;bottom:0;width:min(400px,100%);background:var(--card);border-left:1px solid var(--line);padding:16px;z-index:10;display:flex;flex-direction:column;overflow:auto}\n.grow{flex:1;overflow:auto;min-height:90px}.coupon{display:flex;gap:6px}.coupon input,.coupon button{margin:4px 0}\n.line button{width:26px;height:26px;padding:0;border-radius:50%}.sum div{display:flex;justify-content:space-between;padding:2px 0}\n.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin:4px 0}.bar i{display:block;height:100%;background:var(--green)}\n.sug{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.sug button{font-size:.85rem;padding:4px 10px}\n.modal{position:fixed;inset:0;background:#0007;z-index:30;display:grid;place-items:center}.modal .box{width:min(380px,92%)}\n.note{color:var(--muted);font-size:.9rem;margin:4px 0}.err{color:var(--red);min-height:1.2em;margin:4px 0}.ok{color:var(--green)}\n.badge{display:inline-block;padding:2px 10px;border-radius:12px;background:var(--chip);font-size:.85rem}.badge.Delivered{background:#d9f2df;color:#155d2a}.badge.Cancelled{background:#eee;color:#555;text-decoration:line-through}\n.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:10px 18px;border-radius:8px;z-index:40}\n.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}\n.stat{margin:0;text-align:center}.stat b{display:block;font-size:1.4rem;color:var(--red)}\n.chart{display:flex;gap:6px;align-items:flex-end;height:110px;margin-top:8px}.chart div{flex:1;background:var(--red);border-radius:4px 4px 0 0;min-height:2px;position:relative}.chart small{position:absolute;bottom:-18px;left:0;right:0;text-align:center;font-size:.7rem;color:var(--muted)}\n.tl{font-size:.82rem;color:var(--muted);margin:4px 0}.tabsub{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}\n.hidden{display:none!important}:focus-visible{outline:2px solid var(--red);outline-offset:2px}\n","app.js":"const LS = { get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };\nconst state = { rests: [], filter: 'All', q: '', sort: 'rating', veg: false, fav: false, open: null, view: 'home', cart: LS.get('cart', {}), coupon: '', tip: 0, quote: null, quoteErr: '',\n  user: null, token: LS.get('token', ''), mode: 'login', cfg: { deliveryFee: 30, freeDeliveryAbove: 300, maxTip: 500 }, adminFilter: '', adminQ: '' };\nconst $ = id => document.getElementById(id);\nconst esc = s => String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst inr = n => '₹' + (Math.round(n * 100) / 100);\nconst toast = m => { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2400); };\nconst fmtT = iso => new Date(iso).toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' });\n\nasync function api(path, method = 'GET', data, raw) {\n  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: data ? JSON.stringify(data) : undefined });\n  if (raw && r.ok) return r.blob();\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok) { if (r.status === 401 && state.user) { clearAuth(); toast('Session khatam, dobara login karein'); } throw new Error(j.error || 'Kuch galat hua'); }\n  return j;\n}\nconst needLogin = () => { if (state.user) return false; openModal(); return true; };\nfunction clearAuth() { state.token = ''; state.user = null; LS.del('token'); if (state.view !== 'home') state.view = 'home'; updateAuth(); render(); }\n\n/* ---------- Theme ---------- */\nconst setTheme = t => { document.documentElement.dataset.theme = t; LS.set('theme', t); };\nsetTheme(LS.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));\n$('themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');\n\n/* ---------- Auth ---------- */\nfunction openModal() { $('modal').classList.remove('hidden'); setMode(state.mode); }\nfunction setMode(m) {\n  state.mode = m; $('mErr').textContent = '';\n  $('mTitle').textContent = m === 'login' ? 'Login' : 'Naya account';\n  $('mName').classList.toggle('hidden', m === 'login');\n  $('mGo').textContent = m === 'login' ? 'Login karein' : 'Account banayein';\n  $('mSwitch').textContent = m === 'login' ? 'Naya account banayein' : 'Pehle se account hai? Login';\n}\n$('mSwitch').onclick = e => { e.preventDefault(); setMode(state.mode === 'login' ? 'signup' : 'login'); };\n$('mClose').onclick = e => { e.preventDefault(); $('modal').classList.add('hidden'); };\n['mEmail', 'mPass', 'mName'].forEach(id => $(id).onkeydown = e => { if (e.key === 'Enter') $('mGo').click(); });\n$('mGo').onclick = async () => {\n  try {\n    const r = await api(state.mode === 'login' ? '/login' : '/signup', 'POST', { email: $('mEmail').value, password: $('mPass').value, name: $('mName').value });\n    state.token = r.token; state.user = r.user; LS.set('token', r.token); $('mPass').value = '';\n    $('modal').classList.add('hidden'); afterLogin(); toast('Namaste, ' + r.user.name + '!'); render(); refreshQuote();\n  } catch (e) { $('mErr').textContent = e.message; }\n};\nfunction afterLogin() { updateAuth(); if (state.user.lastAddress && !$('address').value) $('address').value = state.user.lastAddress; }\n$('authBtn').onclick = async () => {\n  if (!state.user) return openModal();\n  const choice = prompt('1 = Logout\\n2 = Password badlein\\n(number likhein)', '1');\n  if (choice === '2') {\n    const current = prompt('Purana password:'), next = current && prompt('Naya password (6+ akshar):');\n    if (!next) return;\n    try { await api('/me/password', 'POST', { current, next }); toast('Password badal gaya'); } catch (e) { toast(e.message); }\n  } else if (choice === '1') { try { await api('/logout', 'POST', {}); } catch {} clearAuth(); state.quote = null; renderCart(); toast('Logout ho gaye'); }\n};\nfunction updateAuth() {\n  $('authBtn').textContent = state.user ? `Account (${state.user.name.split(' ')[0]})` : 'Login';\n  $('adminTab').classList.toggle('hidden', !(state.user && state.user.isAdmin));\n}\n\n/* ---------- Views ---------- */\ndocument.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { if (b.dataset.v !== 'home' && needLogin()) return; state.view = b.dataset.v; render(); });\n$('search').oninput = e => { state.q = e.target.value; if (state.view === 'home') renderHome(); };\nlet poll;\nasync function render() {\n  clearInterval(poll);\n  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === state.view));\n  try {\n    if (state.view === 'home') return renderHome();\n    if (state.view === 'orders') { await renderOrders(); poll = setInterval(() => state.view === 'orders' && renderOrders().catch(() => {}), 20000); return; }\n    if (state.view === 'admin') return await renderAdmin();\n  } catch (e) { $('view').innerHTML = `<p class=\"err\">${esc(e.message)}</p>`; }\n}\nconst vd = v => `<span class=\"vd ${v === false ? 'nv' : ''}\" title=\"${v === false ? 'Non-veg' : 'Veg'}\"></span>`;\n\nfunction renderHome() {\n  const cuisines = ['All', ...new Set(state.rests.map(r => r.cuisine))], q = state.q.toLowerCase(), favs = state.user?.favorites || [];\n  let rows = state.rests.filter(r => (state.filter === 'All' || r.cuisine === state.filter) && (!state.fav || favs.includes(r.id)) &&\n    (!q || r.name.toLowerCase().includes(q) || r.menu.some(m => m.name.toLowerCase().includes(q))));\n  rows.sort((a, b) => state.sort === 'time' ? a.time - b.time : state.sort === 'name' ? a.name.localeCompare(b.name) : b.rating - a.rating);\n  $('view').innerHTML = `<h1>Bhookh lagi hai? Order karo.</h1>\n    <div class=\"chips\">${cuisines.map(c => `<button class=\"chip ${c === state.filter ? 'on' : ''}\" data-c=\"${esc(c)}\">${esc(c)}</button>`).join('')}</div>\n    <div class=\"toolbar\"><select id=\"sortSel\"><option value=\"rating\">Rating ↓</option><option value=\"time\">Sabse tez</option><option value=\"name\">Naam A-Z</option></select>\n      <button class=\"chip ${state.veg ? 'on' : ''}\" id=\"vegBtn\">🟢 Sirf Veg</button><button class=\"chip ${state.fav ? 'on' : ''}\" id=\"favBtn\">❤ Favourites</button></div><br>\n    <div class=\"grid\">${rows.length ? rows.map(r => `\n      <div class=\"card ${r.open ? '' : 'closed'}\" data-id=\"${r.id}\"><button class=\"heart\" data-fav=\"${r.id}\" aria-label=\"Favourite\">${favs.includes(r.id) ? '❤️' : '🤍'}</button>\n      <div class=\"pic\" style=\"background:${esc(r.bg)}\">${esc(r.emoji)}</div>\n      <div class=\"body\"><h3>${esc(r.name)}${r.open ? '' : ' <small>(band hai)</small>'}</h3><div class=\"meta\"><span>${esc(r.cuisine)} • ${r.time} min</span><span class=\"rating\">${r.rating} ★${r.reviewCount ? ` (${r.reviewCount})` : ''}</span></div></div></div>\n      ${r.id === state.open ? menuHtml(r) : ''}`).join('') : '<p>Kuch nahi mila. Koi aur naam ya filter try karein.</p>'}</div>`;\n  $('sortSel').value = state.sort; $('sortSel').onchange = e => { state.sort = e.target.value; renderHome(); };\n  $('vegBtn').onclick = () => { state.veg = !state.veg; renderHome(); }; $('favBtn').onclick = () => { if (needLogin()) return; state.fav = !state.fav; renderHome(); };\n  $('view').querySelectorAll('.chip[data-c]').forEach(b => b.onclick = () => { state.filter = b.dataset.c; state.open = null; renderHome(); });\n  $('view').querySelectorAll('.card').forEach(c => c.onclick = () => { const id = +c.dataset.id; state.open = state.open === id ? null : id; renderHome(); });\n  $('view').querySelectorAll('[data-fav]').forEach(b => b.onclick = async e => {\n    e.stopPropagation(); if (needLogin()) return;\n    try { state.user.favorites = (await api('/favorites/' + b.dataset.fav, 'POST', {})).favorites; renderHome(); } catch (er) { toast(er.message); }\n  });\n  $('view').querySelectorAll('[data-add]').forEach(b => b.onclick = () => { const [rid, i] = b.dataset.add.split('|'), r = state.rests.find(x => x.id == rid); addToCart(r, r.menu[i]); });\n  $('view').querySelectorAll('[data-rev]').forEach(b => b.onclick = async () => {\n    try { const list = await api(`/restaurants/${b.dataset.rev}/reviews`); alert(list.length ? list.map(x => `${'★'.repeat(x.stars)} ${x.userName}${x.comment ? ': ' + x.comment : ''}`).join('\\n') : 'Abhi koi review nahi.'); } catch (e) { toast(e.message); }\n  });\n}\nfunction menuHtml(r) {\n  const items = r.menu.map((d, i) => [d, i]).filter(([d]) => !state.veg || d.veg !== false);\n  return `<div class=\"menu\"><div class=\"row\"><h2>${esc(r.name)} ka menu</h2><button class=\"sm\" data-rev=\"${r.id}\">Reviews dekhein</button></div>${!r.open ? '<p class=\"err\">Ye restaurant abhi band hai.</p>' : ''}\n    ${items.length ? items.map(([d, i]) => `<div class=\"dish ${d.available === false ? 'off' : ''}\"><span>${vd(d.veg)}${esc(d.name)} – ₹${d.price}</span>${d.available === false ? '<small>Khatam</small>' : r.open ? `<button data-add=\"${r.id}|${i}\">Add karein</button>` : ''}</div>`).join('') : '<p class=\"note\">Koi dish nahi mili.</p>'}</div>`;\n}\n\nasync function renderOrders() {\n  const orders = await api('/orders'), fin = ['Delivered', 'Cancelled'];\n  $('view').innerHTML = `<h1>Meri orders</h1>` + (orders.length ? orders.map(o => {\n    const eta = o.estimatedDelivery && !fin.includes(o.status) ? `<p class=\"note\">⏱ Delivery ~ ${fmtT(o.estimatedDelivery)} (${Math.max(0, Math.round((new Date(o.estimatedDelivery) - Date.now()) / 60000))} min mein)</p>` : '';\n    return `<div class=\"item\"><div class=\"row\"><strong>Order #${o.id}</strong><span class=\"badge ${o.status}\">${esc(o.status)}</span></div>\n    <p class=\"note\">${new Date(o.createdAt).toLocaleString('hi-IN')} • ${esc(o.address)}</p>${eta}\n    <p class=\"note\">Payment: ${esc({ UPI: 'UPI', CARD: 'Card', COD: 'Cash on delivery' }[o.paymentMethod] || '-')} • ${esc(o.paymentStatus || '')}</p>\n    ${o.instructions ? `<p class=\"note\">📝 ${esc(o.instructions)}</p>` : ''}\n    <p class=\"tl\">${(o.history || []).map(h => `${esc(h.status)} ${fmtT(h.at)}`).join(' → ')}</p>\n    ${o.items.map(i => `<div class=\"row\"><span>${vd(i.veg)}${esc(i.name)} × ${i.qty}</span><span>₹${i.price * i.qty}</span></div>`).join('')}\n    ${o.discount ? `<div class=\"row ok\"><span>Coupon ${esc(o.coupon)}</span><span>−₹${o.discount}</span></div>` : ''}\n    ${o.tax ? `<div class=\"row\"><span>GST</span><span>${inr(o.tax)}</span></div>` : ''}${o.deliveryFee ? `<div class=\"row\"><span>Delivery</span><span>₹${o.deliveryFee}</span></div>` : ''}${o.tip ? `<div class=\"row\"><span>Tip</span><span>₹${o.tip}</span></div>` : ''}\n    <div class=\"row\"><strong>Total</strong><strong>${inr(o.total)}</strong></div>\n    <div class=\"row\" style=\"margin-top:8px\"><button class=\"sm\" data-re=\"${o.id}\">🔁 Dobara order</button>\n      ${o.status === 'Placed' ? `<button class=\"sm\" data-cx=\"${o.id}\">Cancel karein</button>` : ''}\n      ${o.status === 'Delivered' ? [...new Set(o.items.map(i => i.rid))].filter(Boolean).map(rid => `<button class=\"sm\" data-rate=\"${rid}\">⭐ ${esc(state.rests.find(r => r.id === rid)?.name || 'Rate')} ko rate karein</button>`).join('') : ''}</div></div>`;\n  }).join('') : '<p>Abhi tak koi order nahi. Restaurants se order karein.</p>');\n  const byId = id => orders.find(o => o.id == id);\n  $('view').querySelectorAll('[data-re]').forEach(b => b.onclick = () => {\n    let n = 0; for (const i of byId(b.dataset.re).items) { const r = state.rests.find(x => x.id === i.rid) || state.rests.find(x => x.name === i.restaurant), d = r?.menu.find(x => x.name === i.name); if (d && d.available !== false && r.open) { addToCart(r, d, i.qty, true); n++; } }\n    toast(n ? n + ' item cart mein daale' : 'Ye items ab available nahi hain'); if (n) $('cart').classList.remove('hidden');\n  });\n  $('view').querySelectorAll('[data-cx]').forEach(b => b.onclick = async () => { if (!confirm('Order cancel karna hai?')) return; try { await api(`/orders/${b.dataset.cx}/cancel`, 'POST', { reason: prompt('Wajah (optional):') || '' }); toast('Order cancel ho gaya'); renderOrders(); } catch (e) { toast(e.message); } });\n  $('view').querySelectorAll('[data-rate]').forEach(b => b.onclick = async () => {\n    const stars = prompt('Rating dein (1 se 5):'); if (!stars) return;\n    try { await api(`/restaurants/${b.dataset.rate}/reviews`, 'POST', { stars, comment: prompt('Kuch likhna hai? (optional)') || '' }); await loadRests(); toast('Shukriya! Review save ho gaya'); } catch (e) { toast(e.message); }\n  });\n}\n\n/* ---------- Admin ---------- */\nasync function renderAdmin() {\n  const qs = new URLSearchParams({ status: state.adminFilter, q: state.adminQ });\n  const [sum, orders, coupons, users] = await Promise.all([api('/admin/summary'), api('/admin/orders?' + qs), api('/admin/coupons'), api('/admin/users')]);\n  const st = ['Placed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled'], max = Math.max(1, ...sum.last7Days.map(d => d.sales));\n  $('view').innerHTML = `<h1>Admin panel</h1>\n    <div class=\"stats\">${[['Orders', sum.orders], ['Total sales', inr(sum.totalSales)], ['Delivered sales', inr(sum.deliveredSales)], ['Avg order', inr(sum.avgOrder)], ['Pending', sum.pending], ['Cancelled', sum.cancelled], ['Customers', sum.customers]].map(([k, v]) => `<div class=\"stat\"><b>${v}</b>${k}</div>`).join('')}</div>\n    <div class=\"two\"><div class=\"box\"><h3>Pichhle 7 din ki sales</h3><div class=\"chart\" style=\"margin-bottom:22px\">${sum.last7Days.map(d => `<div style=\"height:${Math.round(d.sales / max * 100)}%\" title=\"${d.date}: ${inr(d.sales)} (${d.orders} orders)\"><small>${d.date.slice(8)}</small></div>`).join('')}</div></div>\n    <div class=\"box\"><h3>Top dishes</h3>${sum.topDishes.length ? sum.topDishes.map(d => `<div class=\"row\"><span>${esc(d.name)}</span><span>${d.qty} × • ${inr(d.revenue)}</span></div>`).join('') : '<p class=\"note\">Abhi data nahi.</p>'}</div></div>\n    <div class=\"row\"><button data-act=\"csv\">⬇ Orders CSV</button><button data-act=\"backup\">⬇ Backup (JSON)</button></div>\n    <div class=\"two\">\n    <div class=\"box\"><h3>Naya restaurant</h3><input id=\"aN\" placeholder=\"Naam\"><input id=\"aC\" placeholder=\"Cuisine\"><input id=\"aE\" placeholder=\"Emoji (🍜)\"><input id=\"aT\" placeholder=\"Delivery time (min)\" type=\"number\"><button class=\"primary wide\" data-act=\"addRest\">Add restaurant</button></div>\n    <div class=\"box\"><h3>Nayi dish</h3><select id=\"dR\">${state.rests.map(r => `<option value=\"${r.id}\">${esc(r.name)}</option>`).join('')}</select><input id=\"dN\" placeholder=\"Dish ka naam\"><input id=\"dP\" placeholder=\"Price (₹)\" type=\"number\"><select id=\"dV\"><option value=\"1\">Veg</option><option value=\"0\">Non-veg</option></select><button class=\"primary wide\" data-act=\"addDish\">Add dish</button></div>\n    <div class=\"box\"><h3>Naya coupon</h3><input id=\"cC\" placeholder=\"Code (jaise DIWALI20)\"><select id=\"cT\"><option value=\"percent\">Percent %</option><option value=\"flat\">Flat ₹</option></select><input id=\"cV\" placeholder=\"Value\" type=\"number\"><input id=\"cM\" placeholder=\"Minimum order (₹)\" type=\"number\"><input id=\"cX\" placeholder=\"Max discount (₹, percent ke liye)\" type=\"number\"><input id=\"cL\" placeholder=\"Total use limit\" type=\"number\"><input id=\"cE\" type=\"date\" title=\"Expiry\"><label class=\"note\"><input id=\"cF\" type=\"checkbox\" style=\"width:auto\"> Sirf pehle order par</label><button class=\"primary wide\" data-act=\"addCoupon\">Add coupon</button></div></div>\n    <h2>Coupons</h2>${coupons.map(c => `<div class=\"item\"><div class=\"row\"><span><strong>${esc(c.code)}</strong> – ${esc(c.text)} ${c.expires ? '• expiry ' + esc(c.expires) : ''} • use: ${c.used}${c.limit ? '/' + c.limit : ''} ${c.firstOrderOnly ? '• pehla order' : ''}</span>\n      <span><button class=\"sm\" data-act=\"cpToggle\" data-code=\"${esc(c.code)}\">${c.active === false ? 'Chalu karein' : 'Band karein'}</button> <button class=\"sm\" data-act=\"cpDel\" data-code=\"${esc(c.code)}\">Hatayein</button></span></div></div>`).join('')}\n    <h2>Restaurants aur menu</h2>${state.rests.map(r => `<div class=\"item\"><div class=\"row\"><strong>${esc(r.emoji)} ${esc(r.name)} • ${r.rating}★</strong><span><button class=\"sm\" data-act=\"rToggle\" data-id=\"${r.id}\" data-open=\"${r.open}\">${r.open ? 'Band karein' : 'Khol dein'}</button> <button class=\"sm\" data-act=\"rEdit\" data-id=\"${r.id}\">Edit</button> <button class=\"sm\" data-act=\"rDel\" data-id=\"${r.id}\">Hatayein</button></span></div>\n      ${r.menu.map((d, i) => `<div class=\"row\"><span>${vd(d.veg)}${esc(d.name)} – ₹${d.price}</span><span><button class=\"sm\" data-act=\"dPrice\" data-k=\"${r.id}|${i}\">Price</button> <button class=\"sm\" data-act=\"dAvail\" data-k=\"${r.id}|${i}\">${d.available === false ? 'Wapas laayein' : 'Khatam'}</button> <button class=\"sm\" data-act=\"dDel\" data-k=\"${r.id}|${i}\">Hatayein</button></span></div>`).join('')}</div>`).join('')}\n    <h2>Orders</h2><div class=\"toolbar\"><select id=\"fS\"><option value=\"\">Saare status</option>${st.map(s => `<option ${s === state.adminFilter ? 'selected' : ''}>${s}</option>`).join('')}</select><input id=\"fQ\" placeholder=\"Order #, naam ya address\" value=\"${esc(state.adminQ)}\" style=\"flex:1;width:auto\"><button data-act=\"filter\">Dhundein</button></div>\n    ${orders.length ? orders.map(o => `<div class=\"item\"><div class=\"row\"><strong>#${o.id} – ${esc(o.userName)}</strong><span>${inr(o.total)} • <span class=\"badge ${o.status}\">${esc(o.status)}</span></span></div>\n    <p class=\"note\">${o.items.map(i => esc(i.name) + '×' + i.qty).join(', ')}<br>${esc(o.address)}${o.instructions ? '<br>📝 ' + esc(o.instructions) : ''}<br>${esc(o.paymentMethod || '')} • ${esc(o.paymentStatus || '')}</p>\n    ${['Delivered', 'Cancelled'].includes(o.status) ? '' : `<div class=\"row\"><select data-o=\"${o.id}\">${st.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select><button class=\"sm\" data-act=\"eta\" data-id=\"${o.id}\">ETA badlein</button></div>`}</div>`).join('') : '<p>Koi order nahi mila.</p>'}\n    <h2>Users</h2>${users.map(u => `<div class=\"row note\"><span>${esc(u.name)} • ${esc(u.email)}${u.isAdmin ? ' (admin)' : ''}</span><span>${u.orders} orders</span></div>`).join('')}`;\n  $('view').querySelectorAll('[data-o]').forEach(s => s.onchange = async () => {\n    const b = { status: s.value }; if (s.value === 'Cancelled') b.reason = prompt('Cancel ki wajah:') || ''; else if (s.value !== 'Delivered') { const m = prompt('Delivery kitne minute mein? (khali = default)'); if (m) b.minutes = Number(m); }\n    try { await api(`/admin/orders/${s.dataset.o}/status`, 'POST', b); toast('Status badal gaya'); renderAdmin(); } catch (e) { toast(e.message); renderAdmin(); }\n  });\n}\nconst download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };\nconst dishOf = k => { const [rid, i] = k.split('|'), r = state.rests.find(x => x.id == rid); return [r, r?.menu[i]]; };\nconst adminActs = {\n  csv: () => api('/admin/orders.csv', 'GET', null, true).then(b => download(b, 'swaadly-orders.csv')),\n  backup: () => api('/admin/backup', 'GET', null, true).then(b => download(b, 'swaadly-backup.json')),\n  filter: () => { state.adminFilter = $('fS').value; state.adminQ = $('fQ').value; return 0; },\n  addRest: () => api('/admin/restaurants', 'POST', { name: $('aN').value, cuisine: $('aC').value, emoji: $('aE').value, time: $('aT').value }),\n  addDish: () => api('/admin/dishes', 'POST', { rid: $('dR').value, name: $('dN').value, price: $('dP').value, veg: $('dV').value === '1' }),\n  addCoupon: () => api('/admin/coupons', 'POST', { code: $('cC').value, type: $('cT').value, value: $('cV').value, min: $('cM').value, max: $('cX').value, limit: $('cL').value, expires: $('cE').value, firstOrderOnly: $('cF').checked }),\n  cpToggle: d => api(`/admin/coupons/${encodeURIComponent(d.code)}/toggle`, 'POST', {}),\n  cpDel: d => confirm(d.code + ' hatana hai?') && api(`/admin/coupons/${encodeURIComponent(d.code)}/delete`, 'POST', {}),\n  rToggle: d => api(`/admin/restaurants/${d.id}/update`, 'POST', { open: d.open !== 'true' }),\n  rEdit: d => { const r = state.rests.find(x => x.id == d.id), name = prompt('Naam:', r.name); if (!name) return 0; const time = prompt('Delivery time (min):', r.time); return api(`/admin/restaurants/${d.id}/update`, 'POST', { name, time }); },\n  rDel: d => confirm('Ye restaurant aur uska poora menu hat jayega. Pakka?') && api(`/admin/restaurants/${d.id}/delete`, 'POST', {}),\n  dPrice: d => { const [r, x] = dishOf(d.k), price = prompt(x.name + ' ka naya price (₹):', x.price); return price && api('/admin/dishes/update', 'POST', { rid: r.id, name: x.name, price }); },\n  dAvail: d => { const [r, x] = dishOf(d.k); return api('/admin/dishes/update', 'POST', { rid: r.id, name: x.name, available: x.available === false }); },\n  dDel: d => { const [r, x] = dishOf(d.k); return confirm(x.name + ' hatana hai?') && api('/admin/dishes/delete', 'POST', { rid: r.id, name: x.name }); },\n  eta: async d => { const m = prompt('Delivery kitne minute mein?'); return m && api(`/admin/orders/${d.id}/eta`, 'POST', { minutes: m }); }\n};\ndocument.addEventListener('click', async e => {\n  const b = e.target.closest('[data-act]'); if (!b || !adminActs[b.dataset.act]) return;\n  try { const r = await adminActs[b.dataset.act](b.dataset); if (r === false || r === '' || r === null) return; await loadRests(); if (b.dataset.act !== 'filter') toast('Ho gaya'); render(); } catch (er) { toast(er.message); }\n});\n\n/* ---------- Cart ---------- */\nconst cartList = () => Object.values(state.cart), cartItems = () => cartList().map(i => ({ rid: i.rid, name: i.name, qty: i.qty }));\nconst localSub = () => cartList().reduce((s, i) => s + i.price * i.qty, 0);\nfunction addToCart(r, d, qty = 1, silent) {\n  const k = r.id + '|' + d.name; state.cart[k] = { rid: r.id, name: d.name, price: d.price, veg: d.veg, qty: Math.min(20, (state.cart[k]?.qty || 0) + qty) };\n  refreshQuote(); if (!silent) toast(d.name + ' add hua');\n}\nlet qSeq = 0, qTimer;\nfunction refreshQuote() {\n  LS.set('cart', state.cart); renderCart(); clearTimeout(qTimer);\n  qTimer = setTimeout(async () => {\n    const seq = ++qSeq, items = cartItems();\n    if (!state.user || !items.length) { state.quote = null; state.quoteErr = ''; return renderCart(); }\n    try { const q = await api('/cart/quote', 'POST', { items, coupon: state.coupon, tip: state.tip }); if (seq !== qSeq) return; state.quote = q; state.quoteErr = ''; state.cartSyncPrices(q); }\n    catch (e) {\n      if (seq !== qSeq) return;\n      if (state.coupon) { toast(e.message); state.coupon = ''; $('couponMsg').textContent = ''; return refreshQuote(); }\n      state.quote = null; state.quoteErr = e.message;\n    }\n    renderCart();\n  }, 150);\n}\nstate.cartSyncPrices = q => { for (const l of q.lines) { const c = state.cart[l.rid + '|' + l.name]; if (c) c.price = l.price; } };\nfunction renderCart() {\n  const items = Object.entries(state.cart), q = state.quote, sub = localSub();\n  $('cartItems').innerHTML = (items.length ? items.map(([k, i]) => `<div class=\"line\"><span>${vd(i.veg)}${esc(i.name)}<br><small>₹${i.price}</small></span>\n    <span><button data-k=\"${esc(k)}\" data-d=\"-1\" aria-label=\"Kam karein\">−</button> ${i.qty} <button data-k=\"${esc(k)}\" data-d=\"1\" aria-label=\"Badhayein\">+</button></span></div>`).join('') : '<p>Cart khali hai. Menu se dish add karein.</p>') +\n    (q && q.suggestions.length ? `<p class=\"note\">Saath mein try karein:</p><div class=\"sug\">${q.suggestions.map(s => `<button data-sg=\"${s.rid}|${esc(s.name)}\">+ ${esc(s.name)} ₹${s.price}</button>`).join('')}</div>` : '') +\n    (state.quoteErr ? `<p class=\"err\">${esc(state.quoteErr)}</p>` : '');\n  $('cartItems').querySelectorAll('[data-k]').forEach(b => b.onclick = () => {\n    const it = state.cart[b.dataset.k]; it.qty += +b.dataset.d; if (it.qty <= 0) delete state.cart[b.dataset.k]; if (it.qty > 20) it.qty = 20; refreshQuote();\n  });\n  $('cartItems').querySelectorAll('[data-sg]').forEach(b => b.onclick = () => { const [rid, name] = b.dataset.sg.split('|'), r = state.rests.find(x => x.id == rid), d = r?.menu.find(x => x.name === name); if (d) addToCart(r, d); });\n  $('cartCount').textContent = items.reduce((s, [, i]) => s + i.qty, 0);\n  const cfg = state.cfg, left = Math.max(0, cfg.freeDeliveryAbove - sub);\n  $('tipChips').innerHTML = [0, 20, 50, 100].filter(t => t <= cfg.maxTip).map(t => `<button class=\"chip sm ${state.tip === t ? 'on' : ''}\" data-t=\"${t}\">${t ? '₹' + t : 'Nahi'}</button>`).join(' ');\n  $('tipChips').querySelectorAll('button').forEach(b => b.onclick = () => { state.tip = +b.dataset.t; refreshQuote(); });\n  const nudge = items.length ? (left ? `<div class=\"note\">₹${left} aur add karein, free delivery milegi 🛵</div><div class=\"bar\"><i style=\"width:${Math.min(100, sub / cfg.freeDeliveryAbove * 100)}%\"></i></div>` : '<div class=\"ok\">🎉 Free delivery lag gayi!</div>') : '';\n  $('sum').innerHTML = nudge + (q ? `<div><span>Subtotal</span><span>${inr(q.subtotal)}</span></div>${q.discount ? `<div class=\"ok\"><span>Discount (${esc(q.coupon)})</span><span>−${inr(q.discount)}</span></div>` : ''}\n    <div><span>GST</span><span>${inr(q.tax)}</span></div><div><span>Delivery</span><span>${q.deliveryFee ? inr(q.deliveryFee) : 'FREE'}</span></div>${q.tip ? `<div><span>Tip</span><span>${inr(q.tip)}</span></div>` : ''}\n    <div><strong>Total</strong><strong>${inr(q.total)}</strong></div>${q.savings ? `<div class=\"ok\"><span>Aapki bachat</span><span>${inr(q.savings)}</span></div>` : ''}<div class=\"note\"><span>⏱ Delivery lagbhag ${q.etaMinutes} min</span><span></span></div>`\n    : `<div><strong>Subtotal</strong><strong>${inr(sub)}</strong></div>${items.length && !state.user ? '<div class=\"note\"><span>Poora bill dekhne ke liye login karein</span><span></span></div>' : ''}`);\n}\n$('cartBtn').onclick = () => { $('cart').classList.remove('hidden'); refreshQuote(); };\n$('closeCart').onclick = () => $('cart').classList.add('hidden');\n$('applyCoupon').onclick = async () => {\n  if (needLogin()) return;\n  const m = $('couponMsg'); m.className = 'note';\n  try { const r = await api('/coupon/check', 'POST', { code: $('coupon').value, subtotal: localSub() }); state.coupon = r.code; m.textContent = `${r.code} lag gaya, ${inr(r.discount)} bachat!`; m.classList.add('ok'); refreshQuote(); }\n  catch (e) { m.textContent = e.message; m.classList.add('err'); }\n};\nconst luhn = n => { let s = 0, d = false; for (let i = n.length - 1; i >= 0; i--) { let x = +n[i]; if (d) { x *= 2; if (x > 9) x -= 9; } s += x; d = !d; } return s % 10 === 0; };\nlet payMethod = 'UPI';\nfunction setPay(m) {\n  payMethod = m; $('payErr').textContent = '';\n  document.querySelectorAll('#payTabs button').forEach(b => b.classList.toggle('on', b.dataset.m === m));\n  ['UPI', 'CARD', 'COD'].forEach(x => $('p' + x).classList.toggle('hidden', x !== m));\n  $('payGo').textContent = m === 'COD' ? 'Order confirm karein' : `${inr(state.quote ? state.quote.total : localSub())} pay karein`;\n}\ndocument.querySelectorAll('#payTabs button').forEach(b => b.onclick = () => setPay(b.dataset.m));\n$('cardNo').oninput = e => { e.target.value = e.target.value.replace(/\\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim(); };\n$('cardExp').oninput = e => { let v = e.target.value.replace(/\\D/g, '').slice(0, 4); e.target.value = v.length > 2 ? v.slice(0, 2) + '/' + v.slice(2) : v; };\n$('payClose').onclick = e => { e.preventDefault(); $('payModal').classList.add('hidden'); };\n$('checkout').onclick = async () => {\n  if (needLogin()) return;\n  if (!Object.keys(state.cart).length) return toast('Pehle kuch add karein');\n  if ($('address').value.trim().length < 5) return toast('Delivery address likhein');\n  if (!state.quote) { await new Promise(r => setTimeout(r, 300)); if (!state.quote) return toast(state.quoteErr || 'Bill nahi ban paya, dobara try karein'); }\n  $('payModal').classList.remove('hidden'); setPay(payMethod);\n};\nfunction checkPay() {\n  if (payMethod === 'UPI' && !/^[\\w.\\-]{2,}@[a-zA-Z]{2,}$/.test($('upiId').value.trim())) return 'Sahi UPI ID likhein (jaise naam@upi)';\n  if (payMethod === 'CARD') {\n    const n = $('cardNo').value.replace(/\\s/g, ''), [mm, yy] = $('cardExp').value.split('/').map(Number), now = new Date();\n    if (n.length !== 16 || !luhn(n)) return 'Card number galat hai';\n    if (!(mm >= 1 && mm <= 12) || !(yy >= 0) || (2000 + yy) * 12 + mm < now.getFullYear() * 12 + now.getMonth() + 1) return 'Expiry date galat hai';\n    if (!/^\\d{3}$/.test($('cardCvv').value)) return 'CVV 3 ank ka hona chahiye';\n  }\n  return '';\n}\n$('payGo').onclick = async () => {\n  const err = checkPay(); $('payErr').textContent = err; if (err) return;\n  const btn = $('payGo'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Payment ho rahi hai…';\n  if (payMethod !== 'COD') await new Promise(r => setTimeout(r, 1500)); // demo: asli gateway yahan aayega\n  try {\n    const o = await api('/orders', 'POST', { items: cartItems(), address: $('address').value, instructions: $('instructions').value, coupon: state.coupon, tip: state.tip, paymentMethod: payMethod });\n    state.cart = {}; state.coupon = ''; state.tip = 0; state.quote = null; LS.set('cart', {}); state.user.lastAddress = o.address;\n    ['coupon', 'instructions', 'upiId', 'cardNo', 'cardExp', 'cardCvv'].forEach(id => $(id).value = ''); $('couponMsg').textContent = '';\n    renderCart(); $('payModal').classList.add('hidden'); $('cart').classList.add('hidden');\n    toast(`Order #${o.id} place ho gaya! 🎉 ~${o.etaMinutes} min`); state.view = 'orders'; render();\n  } catch (e) { $('payErr').textContent = e.message; }\n  btn.disabled = false; btn.textContent = label;\n};\n\n/* ---------- Start ---------- */\nasync function loadRests() { state.rests = await api('/restaurants'); }\n(async () => {\n  try { state.cfg = await api('/config'); } catch {}\n  if (state.token) { try { state.user = await api('/me'); afterLogin(); } catch { state.token = ''; LS.del('token'); } }\n  try { await loadRests(); } catch (e) { toast(e.message); }\n  updateAuth(); renderCart(); render(); if (state.user && Object.keys(state.cart).length) refreshQuote();\n})();\n"};
const ROUTES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ASSETS = {};
for (const [name, text] of Object.entries(PAGES)) {
  const raw = Buffer.from(text);
  ASSETS[name] = { raw, gz: zlib.gzipSync(raw), type: types[path.extname(name)], etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"' };
}
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'" };

const server = http.createServer(async (req, res) => {
  const t0 = Date.now(), url = new URL(req.url, 'http://localhost');
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  if (url.pathname.startsWith('/api/')) res.on('finish', () => { if (url.pathname !== '/api/health') log(req.method, url.pathname, res.statusCode, (Date.now() - t0) + 'ms'); });
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const a = ASSETS[ROUTES[url.pathname]];
    if (!a || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end('Not found'); }
    if (req.headers['if-none-match'] === a.etag) { res.writeHead(304); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : gz ? a.gz : a.raw);
  } catch (e) {
    const code = e.status || 400; if (code >= 500) log('ERROR', e.message);
    if (!res.headersSent) fail(res, code, e.message || 'Kuch galat hua'); else res.end();
  }
});

async function shutdown(sig) { log(sig, 'mila, data save karke band ho rahe hain...'); server.close(); try { await chain; } catch {} process.exit(0); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => log('Unhandled:', e && e.message || e));

(async () => {
  try {
    const raw = await storeGet();
    db = migrate(raw ? JSON.parse(raw) : seed());
    await save();
  } catch (e) { // data na mile to naya khali db BANA KAR purana mita na dein: band ho jayein
    console.error('Database se connect nahi ho paya:', e.message); process.exit(1);
  }
  if (!env.ADMIN_PASSWORD && db.users.some(u => u.isAdmin && u.email === CFG.ADMIN_EMAIL && verify('admin123', u.pass)))
    log('WARNING: admin ka password abhi default (admin123) hai. ADMIN_PASSWORD set karein ya login karke badlein.');
  server.listen(CFG.PORT, () => log(`Swaadly PRO chal raha hai: http://localhost:${CFG.PORT} (storage: ${REDIS_URL ? 'Upstash Redis' : 'local file'})`));
})();
