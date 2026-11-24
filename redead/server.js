// Read Dead Wikimption — servidor del foro
// Sin dependencias externas: usa los módulos integrados de Node (http, crypto, node:sqlite).
// Requiere Node 22.13 o superior.  Uso:  node server.js   →   http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const CATEGORIES = ['general', 'personajes', 'armas', 'animales', 'historia', 'teorias'];

/* ---------- Base de datos ---------- */
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(ROOT, 'data', 'foro.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS topics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    title      TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_topics_cat ON topics(category);
  CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts(topic_id);
`);

/* ---------- Utilidades ---------- */
const hashPassword = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
};

const readJson = (req) => new Promise((resolve, reject) => {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return reject({ status: 415, error: 'Se requiere JSON.' });
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > 20_000) { reject({ status: 413, error: 'Mensaje demasiado largo.' }); req.destroy(); }
    else chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
    catch { reject({ status: 400, error: 'JSON no válido.' }); }
  });
});

const getCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
};
const currentUser = (req) => {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.created_at > datetime('now', '-30 days')`).get(token) || null;
};
const sessionCookie = (token, maxAge) =>
  `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------- API ---------- */
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const user = currentUser(req);
  const need = () => { if (!user) throw { status: 401, error: 'Debes iniciar sesión.' }; };

  if (route === 'GET /api/me') return send(res, 200, { user });

  if (route === 'POST /api/register') {
    const { username, password } = await readJson(req);
    const name = clean(username, 20);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw { status: 400, error: 'Usuario de 3 a 20 caracteres: letras, números o guion bajo.' };
    if (typeof password !== 'string' || password.length < 8 || password.length > 100) throw { status: 400, error: 'La contraseña debe tener al menos 8 caracteres.' };
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw { status: 409, error: 'Ese nombre de usuario ya existe.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, pass_hash, salt) VALUES (?, ?, ?)')
      .run(name, hashPassword(password, salt), salt);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, lastInsertRowid);
    return send(res, 201, { user: { id: Number(lastInsertRowid), username: name } }, { 'Set-Cookie': sessionCookie(token, 2592000) });
  }

  if (route === 'POST /api/login') {
    const { username, password } = await readJson(req);
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(clean(username, 20));
    const ok = row && typeof password === 'string' &&
      crypto.timingSafeEqual(Buffer.from(hashPassword(password, row.salt), 'hex'), Buffer.from(row.pass_hash, 'hex'));
    if (!ok) throw { status: 401, error: 'Usuario o contraseña incorrectos.' };
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, row.id);
    return send(res, 200, { user: { id: row.id, username: row.username } }, { 'Set-Cookie': sessionCookie(token, 2592000) });
  }

  if (route === 'POST /api/logout') {
    const token = getCookie(req, 'sid');
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (route === 'GET /api/topics') {
    const cat = url.searchParams.get('category');
    const where = CATEGORIES.includes(cat) ? 'WHERE t.category = ?' : '';
    const rows = db.prepare(`
      SELECT t.id, t.category, t.title, t.created_at, u.username AS author,
             (SELECT COUNT(*) FROM posts p WHERE p.topic_id = t.id) - 1 AS replies,
             (SELECT MAX(created_at) FROM posts p WHERE p.topic_id = t.id) AS last_activity
      FROM topics t JOIN users u ON u.id = t.user_id ${where}
      ORDER BY last_activity DESC LIMIT 100`).all(...(where ? [cat] : []));
    return send(res, 200, { topics: rows });
  }

  if (route === 'POST /api/topics') {
    need();
    const { category, title, body } = await readJson(req);
    const t = clean(title, 120), b = clean(body, 5000);
    if (!CATEGORIES.includes(category)) throw { status: 400, error: 'Categoría no válida.' };
    if (t.length < 4) throw { status: 400, error: 'El título debe tener al menos 4 caracteres.' };
    if (b.length < 2) throw { status: 400, error: 'Escribe un mensaje.' };
    const { lastInsertRowid: id } = db.prepare('INSERT INTO topics (category, title, user_id) VALUES (?, ?, ?)').run(category, t, user.id);
    db.prepare('INSERT INTO posts (topic_id, user_id, body) VALUES (?, ?, ?)').run(id, user.id, b);
    return send(res, 201, { id: Number(id) });
  }

  let m = url.pathname.match(/^\/api\/topics\/(\d+)(\/posts)?$/);
  if (m) {
    const id = Number(m[1]);
    const topic = db.prepare(`SELECT t.id, t.category, t.title, t.created_at, u.username AS author
                              FROM topics t JOIN users u ON u.id = t.user_id WHERE t.id = ?`).get(id);
    if (!topic) throw { status: 404, error: 'Tema no encontrado.' };

    if (req.method === 'GET' && !m[2]) {
      const posts = db.prepare(`SELECT p.id, p.body, p.created_at, u.username AS author
                                FROM posts p JOIN users u ON u.id = p.user_id
                                WHERE p.topic_id = ? ORDER BY p.id`).all(id);
      return send(res, 200, { topic, posts });
    }
    if (req.method === 'POST' && m[2]) {
      need();
      const b = clean((await readJson(req)).body, 5000);
      if (b.length < 2) throw { status: 400, error: 'Escribe un mensaje.' };
      db.prepare('INSERT INTO posts (topic_id, user_id, body) VALUES (?, ?, ?)').run(id, user.id, b);
      return send(res, 201, { ok: true });
    }
  }
  throw { status: 404, error: 'Ruta no encontrada.' };
}

/* ---------- Archivos estáticos ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const BLOCKED = new Set(['server.js', 'package.json']);

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || top === 'data' || top.startsWith('.') || BLOCKED.has(top) || !TYPES[path.extname(file)]) {
    res.writeHead(404); return res.end('No encontrado');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
    res.end(buf);
  });
}

/* ---------- Servidor ---------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, url);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (e && e.status) send(res, e.status, { error: e.error });
    else { console.error(e); send(res, 500, { error: 'Error interno del servidor.' }); }
  }
}).listen(PORT, () => console.log(`Read Dead Wikimption → http://localhost:${PORT}`));
