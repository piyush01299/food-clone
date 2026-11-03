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
  if (m === 'POST' && p === '/api/orders') {
    const { items, address, coupon } = await body(req);
    if (!Array.isArray(items) || !items.length) return fail(res, 400, 'Cart khali hai');
    if (!address || String(address).trim().length < 5) return fail(res, 400, 'Delivery address likhein');
    let subtotal = 0; const lines = [];
    for (const it of items) { // price hamesha server par se, client par bharosa nahi
      const rest = db.restaurants.find(r => r.id === it.rid);
      const dish = rest && rest.menu.find(d => d.name === it.name);
      const qty = Math.floor(Number(it.qty));
      if (!dish || !(qty >= 1 && qty <= 20)) return fail(res, 400, 'Cart mein galat item hai');
      subtotal += dish.price * qty; lines.push({ restaurant: rest.name, name: dish.name, price: dish.price, qty });
    }
    const c = applyCoupon(coupon, subtotal);
    if (c.error) return fail(res, 400, c.error);
    const order = { id: db.orders.length + 1001, userId: user.id, userName: user.name, items: lines, subtotal, discount: c.discount, coupon: c.code || null,
      total: subtotal - c.discount, address: String(address).slice(0, 200), status: 'Placed', createdAt: new Date().toISOString() };
    db.orders.push(order); save(); return send(res, 201, order);
  }
  if (m === 'GET' && p === '/api/orders') return send(res, 200, db.orders.filter(o => o.userId === user.id).reverse());

  if (p.startsWith('/api/admin/')) {
    if (!user.isAdmin) return fail(res, 403, 'Sirf admin ke liye');
    if (m === 'GET' && p === '/api/admin/orders') return send(res, 200, [...db.orders].reverse());
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
    const sm = p.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
    if (m === 'POST' && sm) {
      const o = db.orders.find(x => x.id === Number(sm[1])), { status } = await body(req);
      if (!o || !['Placed', 'Preparing', 'Out for delivery', 'Delivered'].includes(status)) return fail(res, 400, 'Galat order ya status');
      o.status = status; save(); return send(res, 200, o);
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
