// Swaadly backend - sirf Node.js built-in modules, koi npm install nahi chahiye
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, stored) => {
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash(pw, salt).split(':')[1], 'hex'), Buffer.from(h, 'hex'));
};

function seed() {
  const r = (id, name, cuisine, rating, time, emoji, bg, menu) =>
    ({ id, name, cuisine, rating, time, emoji, bg, menu: menu.map(([n, p]) => ({ name: n, price: p })) });
  return {
    users: [{ id: 1, name: 'Admin', email: 'admin@swaadly.com', pass: hash('admin123'), isAdmin: true }],
    sessions: {}, orders: [],
    coupons: [
      { code: 'WELCOME50', type: 'flat', value: 50, min: 200, text: '₹50 off, minimum order ₹200' },
      { code: 'FOOD10', type: 'percent', value: 10, max: 100, min: 0, text: '10% off, maximum ₹100' }
    ],
    restaurants: [
      r(1, 'Punjabi Tadka', 'North Indian', 4.4, 30, '🍛', '#ffe3d6', [['Butter Chicken', 320], ['Dal Makhani', 220], ['Garlic Naan', 50], ['Paneer Tikka', 260]]),
      r(2, 'Pizza Junction', 'Pizza', 4.1, 25, '🍕', '#fff0c9', [['Margherita', 199], ['Farmhouse', 329], ['Garlic Bread', 120]]),
      r(3, 'Biryani House', 'Biryani', 4.6, 35, '🍚', '#e6f3d4', [['Chicken Biryani', 280], ['Veg Biryani', 220], ['Raita', 40]]),
      r(4, 'Burger Barn', 'Burger', 3.9, 20, '🍔', '#ffe0e0', [['Aloo Tikki Burger', 99], ['Chicken Burger', 149], ['French Fries', 89]]),
      r(5, 'South Spice', 'South Indian', 4.5, 28, '🥞', '#e0eefb', [['Masala Dosa', 110], ['Idli Sambar', 80], ['Filter Coffee', 50]]),
      r(6, 'Meetha Ghar', 'Desserts', 4.3, 22, '🍰', '#f5e1f7', [['Gulab Jamun', 90], ['Brownie', 130], ['Rasmalai', 110]])
    ]
  };
}
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = seed(); }
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
save();

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });
const body = req => new Promise((ok, no) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('Galat JSON')); } });
});
const authUser = req => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const id = db.sessions[t];
  return db.users.find(u => u.id === id);
};
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, isAdmin: !!u.isAdmin });
const newSession = u => { const t = crypto.randomBytes(24).toString('hex'); db.sessions[t] = u.id; save(); return { token: t, user: publicUser(u) }; };

function applyCoupon(code, subtotal) {
  if (!code) return { discount: 0 };
  const c = db.coupons.find(x => x.code === String(code).toUpperCase());
  if (!c) return { error: 'Ye coupon code galat hai' };
  if (subtotal < c.min) return { error: `Is coupon ke liye kam se kam ₹${c.min} ka order chahiye` };
  let d = c.type === 'flat' ? c.value : Math.floor(subtotal * c.value / 100);
  if (c.max) d = Math.min(d, c.max);
  return { discount: Math.min(d, subtotal), code: c.code };
}

// Order ka total hamesha items se dobara calculate hota hai (purane orders ke liye bhi sahi rahe)
const orderTotal = o => {
  const subtotal = o.items.reduce((s, i) => s + i.price * i.qty, 0);
  return { subtotal, total: Math.max(0, subtotal - (o.discount || 0) + (o.tax || 0) + (o.deliveryFee || 0) + (o.tip || 0)) };
};
const withTotals = o => ({ ...o, ...orderTotal(o) });
const addMinutes = (min, from = Date.now()) => new Date(from + min * 60000).toISOString();

const TAX_RATE = 0.05, DELIVERY_FEE = 30, FREE_DELIVERY_ABOVE = 300, MAX_TIP = 500; // apne hisaab se badlein

// Cart ka poora hisaab server par: items, coupon, tax, delivery fee, tip, ETA, suggestions
function priceCart(items, coupon, tip) {
  if (!Array.isArray(items) || !items.length) return { error: 'Cart khali hai' };
  let subtotal = 0, etaMin = 0; const lines = [], rids = new Set();
  for (const it of items) { // price hamesha server par se, client par bharosa nahi
    const rest = db.restaurants.find(r => r.id === it.rid);
    const dish = rest && rest.menu.find(d => d.name === it.name);
    const qty = Math.floor(Number(it.qty));
    if (!dish || !(qty >= 1 && qty <= 20)) return { error: 'Cart mein galat item hai' };
    rids.add(rest.id); etaMin = Math.max(etaMin, Number(rest.time) || 30);
    subtotal += dish.price * qty; lines.push({ restaurant: rest.name, name: dish.name, price: dish.price, qty });
  }
  const c = applyCoupon(coupon, subtotal);
  if (c.error) return { error: c.error };
  const taxable = subtotal - c.discount;
  const tax = Math.round(taxable * TAX_RATE * 100) / 100;
  const freeDelivery = subtotal >= FREE_DELIVERY_ABOVE;
  const deliveryFee = freeDelivery ? 0 : DELIVERY_FEE;
  const tipAmt = Math.min(MAX_TIP, Math.max(0, Math.floor(Number(tip) || 0)));
  const inCart = new Set(items.map(i => i.rid + '|' + i.name));
  const suggestions = [];
  for (const rid of rids) {
    const rest = db.restaurants.find(r => r.id === rid);
    for (const d of rest.menu) if (!inCart.has(rid + '|' + d.name) && suggestions.length < 3) suggestions.push({ rid, restaurant: rest.name, name: d.name, price: d.price });
  }
  return {
    lines, subtotal, discount: c.discount, coupon: c.code || null, tax, deliveryFee, tip: tipAmt,
    total: Math.round((taxable + tax + deliveryFee + tipAmt) * 100) / 100,
    savings: c.discount + (freeDelivery ? DELIVERY_FEE : 0),           // discount + free delivery ki bachat
    freeDeliveryLeft: freeDelivery ? 0 : FREE_DELIVERY_ABOVE - subtotal, // free delivery ke liye aur kitna add karein
    etaMinutes: etaMin + 10, estimatedDelivery: addMinutes(etaMin + 10), suggestions
  };
}

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  if (m === 'GET' && p === '/api/restaurants') return send(res, 200, db.restaurants);
  if (m === 'GET' && p === '/api/coupons') return send(res, 200, db.coupons);

  if (m === 'POST' && p === '/api/signup') {
    const { name, email, password } = await body(req);
    if (!name || !email || !password || password.length < 6) return fail(res, 400, 'Naam, email aur 6+ akshar ka password dein');
    if (db.users.some(u => u.email === email.toLowerCase())) return fail(res, 409, 'Ye email pehle se registered hai');
    const u = { id: Date.now(), name: String(name).slice(0, 60), email: email.toLowerCase(), pass: hash(password), isAdmin: false };
    db.users.push(u); return send(res, 201, newSession(u));
  }
  if (m === 'POST' && p === '/api/login') {
    const { email, password } = await body(req);
    const u = db.users.find(x => x.email === String(email || '').toLowerCase());
    if (!u || !verify(String(password || ''), u.pass)) return fail(res, 401, 'Email ya password galat hai');
    return send(res, 200, newSession(u));
  }

  const user = authUser(req);
  if (!user) return fail(res, 401, 'Pehle login karein');
  if (m === 'GET' && p === '/api/me') return send(res, 200, publicUser(user));

  if (m === 'POST' && p === '/api/coupon/check') {
    const { code, subtotal } = await body(req);
    const r = applyCoupon(code, Number(subtotal) || 0);
    return r.error ? fail(res, 400, r.error) : send(res, 200, r);
  }
  if (m === 'POST' && p === '/api/cart/quote') { // cart ka live bill: har +/- ya tip badalne par call karein
    const { items, coupon, tip } = await body(req);
    const q = priceCart(items, coupon, tip);
    return q.error ? fail(res, 400, q.error) : send(res, 200, q);
  }
  if (m === 'POST' && p === '/api/orders') {
    const { items, address, coupon, tip, instructions } = await body(req);
    if (!address || String(address).trim().length < 5) return fail(res, 400, 'Delivery address likhein');
    const q = priceCart(items, coupon, tip);
    if (q.error) return fail(res, 400, q.error);
    const order = { id: db.orders.length + 1001, userId: user.id, userName: user.name, items: q.lines, subtotal: q.subtotal, discount: q.discount, coupon: q.coupon,
      tax: q.tax, deliveryFee: q.deliveryFee, tip: q.tip, total: q.total, instructions: String(instructions || '').slice(0, 200) || null,
      address: String(address).slice(0, 200), status: 'Placed', createdAt: new Date().toISOString(),
      etaMinutes: q.etaMinutes, estimatedDelivery: q.estimatedDelivery };
    db.orders.push(order); save(); return send(res, 201, order);
  }
  if (m === 'GET' && p === '/api/orders') return send(res, 200, db.orders.filter(o => o.userId === user.id).reverse().map(withTotals));

  const cm = p.match(/^\/api\/orders\/(\d+)\/cancel$/);
  if (m === 'POST' && cm) {
    const o = db.orders.find(x => x.id === Number(cm[1]) && x.userId === user.id);
    if (!o) return fail(res, 404, 'Order nahi mila');
    if (o.status !== 'Placed') return fail(res, 400, 'Order ab cancel nahi ho sakta, restaurant ne ise shuru kar diya hai');
    const { reason } = await body(req);
    o.status = 'Cancelled'; o.cancelledAt = new Date().toISOString(); o.cancelReason = String(reason || '').slice(0, 200) || null;
    o.estimatedDelivery = null; o.etaMinutes = null; save(); return send(res, 200, withTotals(o));
  }

  if (p.startsWith('/api/admin/')) {
    if (!user.isAdmin) return fail(res, 403, 'Sirf admin ke liye');
    if (m === 'GET' && p === '/api/admin/orders') return send(res, 200, [...db.orders].reverse().map(withTotals));
    if (m === 'GET' && p === '/api/admin/summary') {
      const done = db.orders.filter(o => o.status === 'Delivered').map(withTotals);
      const all = db.orders.map(withTotals), live = all.filter(o => o.status !== 'Cancelled');
      return send(res, 200, {
        orders: live.length,                                   // cancelled order count nahi hote
        totalSales: live.reduce((s, o) => s + o.total, 0),     // cancelled ka paisa sales mein nahi judta
        deliveredSales: done.reduce((s, o) => s + o.total, 0),
        pending: live.filter(o => o.status !== 'Delivered').length,
        cancelled: all.length - live.length,
        cancelledValue: all.filter(o => o.status === 'Cancelled').reduce((s, o) => s + o.total, 0)
      });
    }
    if (m === 'POST' && p === '/api/admin/restaurants') {
      const b = await body(req);
      if (!b.name || !b.cuisine) return fail(res, 400, 'Naam aur cuisine zaroori hai');
      const r = { id: Date.now(), name: b.name, cuisine: b.cuisine, rating: 4.0, time: Number(b.time) || 30, emoji: b.emoji || '🍽️', bg: '#f1f1f1', menu: [] };
      db.restaurants.push(r); save(); return send(res, 201, r);
    }
    if (m === 'POST' && p === '/api/admin/dishes') {
      const { rid, name, price } = await body(req);
      const r = db.restaurants.find(x => x.id === Number(rid));
      if (!r || !name || !(Number(price) > 0)) return fail(res, 400, 'Restaurant, dish ka naam aur price sahi dein');
      r.menu.push({ name, price: Number(price) }); save(); return send(res, 201, r);
    }
    if (m === 'POST' && p === '/api/admin/coupons') {
      const b = await body(req);
      if (!b.code || !['flat', 'percent'].includes(b.type) || !(Number(b.value) > 0)) return fail(res, 400, 'Code, type aur value sahi dein');
      db.coupons.push({ code: String(b.code).toUpperCase(), type: b.type, value: Number(b.value), min: Number(b.min) || 0, max: Number(b.max) || undefined,
        text: `${b.type === 'flat' ? '₹' + b.value : b.value + '%'} off` });
      save(); return send(res, 201, db.coupons);
    }
    const em = p.match(/^\/api\/admin\/orders\/(\d+)\/eta$/);
    if (m === 'POST' && em) {
      const o = db.orders.find(x => x.id === Number(em[1])), { minutes } = await body(req);
      if (!o || ['Delivered', 'Cancelled'].includes(o.status) || !(Number(minutes) >= 0 && Number(minutes) <= 300)) return fail(res, 400, 'Galat order ya minutes (0-300)');
      o.etaMinutes = Number(minutes); o.estimatedDelivery = addMinutes(o.etaMinutes); save(); return send(res, 200, withTotals(o));
    }
    const sm = p.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
    if (m === 'POST' && sm) {
      const o = db.orders.find(x => x.id === Number(sm[1])), b0 = await body(req), { status } = b0;
      if (!o || !['Placed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled'].includes(status)) return fail(res, 400, 'Galat order ya status');
      if (['Delivered', 'Cancelled'].includes(o.status)) return fail(res, 400, `${o.status} order ka status ab nahi badal sakta`);
      const b = b0;
      o.status = status;
      if (status === 'Cancelled') { o.cancelledAt = new Date().toISOString(); o.cancelReason = String(b.reason || '').slice(0, 200) || null; o.estimatedDelivery = null; o.etaMinutes = null; }
      else if (status === 'Delivered') { o.deliveredAt = new Date().toISOString(); o.estimatedDelivery = o.deliveredAt; o.etaMinutes = 0; }
      else if (Number(b.minutes) >= 0 && b.minutes !== undefined) { o.etaMinutes = Number(b.minutes); o.estimatedDelivery = addMinutes(o.etaMinutes); }
      else if (status === 'Out for delivery') { o.etaMinutes = 15; o.estimatedDelivery = addMinutes(15); }
      save(); return send(res, 200, withTotals(o));
    }
  }
  fail(res, 404, 'Ye API nahi mili');
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { fail(res, 400, e.message || 'Kuch galat hua'); }
}).listen(PORT, () => console.log(`Swaadly chal raha hai: http://localhost:${PORT}`));
