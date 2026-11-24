// Read Dead Wikimption — lógica del foro (se comunica con server.js)
const CATEGORIES = {
  general: 'General', personajes: 'Personajes', armas: 'Armas',
  animales: 'Animales', historia: 'Historia', teorias: 'Teorías',
};
const $ = (id) => document.getElementById(id);
const state = { user: null, category: '', mode: 'login', topicId: null };

/* ---------- Utilidades ---------- */
async function api(url, method = 'GET', data) {
  const res = await fetch(url, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Error de conexión con el servidor.');
  return json;
}
// Las fechas de SQLite vienen en UTC: "YYYY-MM-DD HH:MM:SS"
const fmtDate = (s) => new Date(s.replace(' ', 'T') + 'Z')
  .toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // textContent evita inyección de HTML
  return n;
};

/* ---------- Sesión ---------- */
function renderUser() {
  $('guest-view').hidden = !!state.user;
  $('user-view').hidden = !state.user;
  if (state.user) $('user-name').textContent = state.user.username;
  $('reply-form').hidden = !state.user || state.topicId === null;
  $('reply-login').hidden = !!state.user || state.topicId === null;
  if (!state.user) $('topic-form').hidden = true;
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.mode = tab.dataset.mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  $('auth-submit').textContent = state.mode === 'login' ? 'Entrar' : 'Crear cuenta';
  $('auth-pass').autocomplete = state.mode === 'login' ? 'current-password' : 'new-password';
  $('auth-error').textContent = '';
}));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit'); btn.disabled = true; $('auth-error').textContent = '';
  try {
    const { user } = await api(`/api/${state.mode}`, 'POST', {
      username: $('auth-user').value, password: $('auth-pass').value,
    });
    state.user = user; $('auth-form').reset(); renderUser();
  } catch (err) { $('auth-error').textContent = err.message; }
  btn.disabled = false;
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', 'POST', {}).catch(() => {});
  state.user = null; renderUser();
});

/* ---------- Categorías ---------- */
function renderCategories() {
  const nav = $('categories'); nav.replaceChildren();
  const make = (key, label) => {
    const b = el('button', state.category === key ? 'active' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => { state.category = key; location.hash = ''; showList(); });
    nav.append(b);
  };
  make('', 'Todos los temas');
  Object.entries(CATEGORIES).forEach(([k, v]) => make(k, v));

  const select = $('topic-cat'); select.replaceChildren();
  Object.entries(CATEGORIES).forEach(([k, v]) => {
    const o = el('option', '', v); o.value = k; select.append(o);
  });
}

/* ---------- Lista de temas ---------- */
async function showList() {
  state.topicId = null;
  $('thread-view').hidden = true; $('list-view').hidden = false;
  renderCategories(); renderUser();
  $('list-title').textContent = state.category ? CATEGORIES[state.category] : 'Todos los temas';
  const list = $('topic-list'); list.replaceChildren();
  try {
    const { topics } = await api('/api/topics' + (state.category ? `?category=${state.category}` : ''));
    $('empty-msg').hidden = topics.length > 0;
    topics.forEach((t) => {
      const li = el('li'); const a = el('a'); a.href = `#tema-${t.id}`;
      const info = el('div');
      info.append(el('span', 'badge', CATEGORIES[t.category] || t.category), el('div', 'topic-title', t.title),
        el('div', 'topic-meta', `por ${t.author} · ${fmtDate(t.created_at)}`));
      const r = el('div', 'replies', String(t.replies)); r.append(el('small', '', t.replies === 1 ? 'respuesta' : 'respuestas'));
      a.append(info, r); li.append(a); list.append(li);
    });
  } catch (err) { $('empty-msg').hidden = false; $('empty-msg').textContent = err.message; }
}

$('new-topic-btn').addEventListener('click', () => {
  if (!state.user) { $('auth-user').focus(); $('auth-error').textContent = 'Inicia sesión para crear un tema.'; return; }
  $('topic-form').hidden = false;
  if (state.category) $('topic-cat').value = state.category;
  $('topic-title').focus();
});
$('cancel-topic').addEventListener('click', () => { $('topic-form').hidden = true; });

$('topic-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('topic-error').textContent = '';
  try {
    const { id } = await api('/api/topics', 'POST', {
      category: $('topic-cat').value, title: $('topic-title').value, body: $('topic-body').value,
    });
    $('topic-form').reset(); $('topic-form').hidden = true;
    location.hash = `#tema-${id}`;
  } catch (err) { $('topic-error').textContent = err.message; }
});

/* ---------- Hilo ---------- */
async function showThread(id) {
  state.topicId = id;
  $('list-view').hidden = true; $('thread-view').hidden = false; renderUser();
  const box = $('posts'); box.replaceChildren();
  try {
    const { topic, posts } = await api(`/api/topics/${id}`);
    $('thread-title').textContent = topic.title;
    $('thread-meta').textContent = `${CATEGORIES[topic.category] || topic.category} · abierto por ${topic.author} · ${fmtDate(topic.created_at)}`;
    posts.forEach((p) => {
      const post = el('article', 'post');
      const who = el('div', 'post-author'); who.append(el('strong', '', p.author), el('span', '', fmtDate(p.created_at)));
      post.append(who, el('div', 'post-body', p.body)); box.append(post);
    });
  } catch (err) {
    $('thread-title').textContent = 'Tema no disponible'; $('thread-meta').textContent = err.message;
  }
}

$('reply-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('reply-error').textContent = '';
  try {
    await api(`/api/topics/${state.topicId}/posts`, 'POST', { body: $('reply-body').value });
    $('reply-form').reset(); showThread(state.topicId);
  } catch (err) { $('reply-error').textContent = err.message; }
});

/* ---------- Navegación por hash ---------- */
function route() {
  const m = location.hash.match(/^#tema-(\d+)$/);
  if (m) showThread(Number(m[1])); else showList();
}
window.addEventListener('hashchange', route);

(async () => {
  try { state.user = (await api('/api/me')).user; } catch { state.user = null; }
  route();
})();
