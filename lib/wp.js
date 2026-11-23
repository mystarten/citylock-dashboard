// Client WordPress REST (mot de passe d'application) ou simulation.
const log = require('./log');
const store = require('./store');
const secrets = require('./secrets');
const { isSimulated } = require('./config');

const TIMEOUT_MS = 20000;
const simulate = isSimulated;
let simCounter = 900000;

// L'adresse du site vient UNIQUEMENT du serveur (WP_BASE_URL) : elle n'est pas modifiable depuis l'interface,
// pour que personne ne puisse rediriger les identifiants WordPress vers un autre site.
function base() {
  const b = (process.env.WP_BASE_URL || '').replace(/\/+$/, '');
  if (!b) throw new Error('L\'adresse du site (WP_BASE_URL) n\'est pas définie sur le serveur.');
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(b);
  if (!/^https:\/\//.test(b) && !local) throw new Error('WP_BASE_URL doit commencer par https:// (les identifiants ne doivent pas circuler en clair).');
  return b;
}

function creds() {
  return { user: (store.getSettings().wpUser || '').trim() || process.env.WP_USER || '', pass: secrets.get('wpAppPassword') };
}

const configured = () => {
  const c = creds();
  return !!(process.env.WP_BASE_URL && c.user && c.pass);
};

async function wp(method, path, body) {
  const b = base();
  const { user, pass } = creds();
  if (!user || !pass) throw new Error('Identifiant ou mot de passe d\'application WordPress manquant. Renseignez-les dans Réglages, Connexions.');
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  let res;
  try {
    res = await fetch(`${b}/wp-json/wp/v2${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'WordPress a mis trop de temps à répondre.' : 'WordPress est injoignable.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) {
    log.error(`WordPress ${method} ${path} : ${res.status} ${data && data.code ? data.code : ''}`);
    const hint = res.status === 401 ? ' Identifiant ou mot de passe d\'application incorrect : recréez le mot de passe dans WordPress (Utilisateurs, Profil).'
      : res.status === 403 ? ' Ce compte n\'a pas le droit de faire cette action (il faut le rôle Auteur ou Éditeur), ou une extension de sécurité bloque l\'API.'
      : res.status === 404 ? ' Adresse introuvable : l\'API WordPress est peut-être désactivée.' : '';
    const err = new Error(`WordPress a refusé la demande (code ${res.status}${data && data.code ? ', ' + data.code : ''}).${hint}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ensureBlogCategory() {
  if (simulate()) return 9001;
  const list = await wp('GET', '/categories?per_page=100&search=Blog&_fields=id,name,slug');
  const found = (list || []).find((c) => c.slug === 'blog' || String(c.name).toLowerCase() === 'blog');
  if (found) return found.id;
  const created = await wp('POST', '/categories', { name: 'Blog', slug: 'blog' });
  return created.id;
}

async function createDraft(article, categoryId) {
  if (simulate()) {
    const id = ++simCounter;
    return { id, link: `${process.env.WP_BASE_URL || 'https://citylock.fr'}/?p=${id}&simulation=1` };
  }
  const post = await wp('POST', '/posts', {
    title: article.title,
    content: article.htmlContent,
    slug: article.slug,
    excerpt: article.metaDescription,
    status: 'draft',
    categories: categoryId ? [categoryId] : undefined,
  });
  return { id: post.id, link: post.link };
}

async function publish(id) {
  if (simulate()) return { link: `${process.env.WP_BASE_URL || 'https://citylock.fr'}/?p=${id}&simulation=1` };
  const post = await wp('POST', `/posts/${id}`, { status: 'publish' });
  return { link: post.link };
}

// Supprime uniquement un brouillon : refuse si l'article n'est plus au statut « draft ».
async function deleteDraft(id) {
  if (simulate()) return;
  let post;
  try { post = await wp('GET', `/posts/${id}?context=edit&_fields=id,status`); } catch (e) { if (e.status === 404) return; throw e; }
  if (post.status !== 'draft') throw new Error(`Cet article n'est plus un brouillon dans WordPress (statut : ${post.status}). Supprimez-le directement dans WordPress.`);
  await wp('DELETE', `/posts/${id}?force=true`);
}

async function testConnection() {
  if (simulate()) return { ok: true, simulated: true, name: 'Simulation', canEdit: true, canPublish: true };
  const b = base();
  // Étape 1 : le site répond-il et son API est-elle ouverte ? (sans identifiants)
  let siteName = '';
  try {
    const r = await fetch(`${b}/wp-json/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw Object.assign(new Error(`L'API WordPress ne répond pas correctement (code ${r.status}). Une extension de sécurité la bloque peut-être.`), { step: 1 });
    siteName = (await r.json()).name || '';
  } catch (e) {
    if (e.step) throw e;
    throw Object.assign(new Error('Le site est injoignable depuis le serveur (réseau, pare-feu ou API désactivée).'), { step: 1 });
  }
  // Étape 2 : les identifiants sont-ils acceptés, et que peut faire ce compte ?
  const me = await wp('GET', '/users/me?context=edit&_fields=name,capabilities');
  const caps = (me && me.capabilities) || {};
  return { ok: true, site: siteName, name: me.name || '', canEdit: !!caps.edit_posts, canPublish: !!caps.publish_posts };
}

// Texte actuel de l'article dans WordPress (peut avoir été modifié depuis l'envoi).
async function getContent(id) {
  const post = await wp('GET', `/posts/${id}?context=edit&_fields=content`);
  return (post && post.content && (post.content.raw || post.content.rendered)) || '';
}

module.exports = { ensureBlogCategory, createDraft, publish, deleteDraft, testConnection, getContent, simulate, configured };
