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
    err.wpCode = data && data.code;
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

// ---------- Yoast : mot-clé principal, titre SEO, méta description ----------
// WordPress n'accepte ces champs par l'API que si un petit extrait de code les expose (voir README). Sans lui, on envoie
// le reste normalement : un premier refus « meta » est mémorisé, et on réessaie de temps en temps.
const YOAST_KEYS = ['_yoast_wpseo_focuskw', '_yoast_wpseo_title', '_yoast_wpseo_metadesc'];
const yoast = { ok: null, at: 0 };
// Titre Yoast : titre SEO + variables Yoast (séparateur et nom du site), comme dans l'éditeur.
const yoastMeta = (a) => ({ _yoast_wpseo_focuskw: a.focusKeyphrase || a.keyword || '', _yoast_wpseo_title: `${a.metaTitle || a.title} %%sep%% %%sitename%%`, _yoast_wpseo_metadesc: a.metaDescription || '' });
const isMetaRejection = (e) => e && e.status === 400 && (e.wpCode === 'rest_additional_properties_forbidden' || /meta/i.test(e.message));

async function writePost(path, body, article) {
  if (yoast.ok !== false || Date.now() - yoast.at > 10 * 60000) {
    try {
      const post = await wp('POST', path, { ...body, meta: yoastMeta(article) });
      yoast.ok = true; yoast.at = Date.now();
      return { post, yoast: true };
    } catch (e) {
      if (!isMetaRejection(e)) throw e;
      yoast.ok = false; yoast.at = Date.now();
    }
  }
  return { post: await wp('POST', path, body), yoast: false };
}

// Le site accepte-t-il les champs Yoast ? (lecture du schéma de l'API, sans rien modifier)
async function yoastStatus() {
  if (simulate()) return { known: false, ok: false, simulated: true };
  try {
    const r = await fetch(`${base()}/wp-json/wp/v2/posts`, { method: 'OPTIONS', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = await r.json();
    const props = (j && j.schema && j.schema.properties && j.schema.properties.meta && j.schema.properties.meta.properties) || {};
    yoast.ok = YOAST_KEYS.every((k) => k in props); yoast.at = Date.now();
    return { known: true, ok: yoast.ok };
  } catch { return { known: yoast.ok !== null, ok: yoast.ok === true }; }
}

const postBody = (a, extra = {}) => ({ title: a.title, content: a.htmlContent, slug: a.slug, excerpt: a.metaDescription, ...extra });
const gmt = (date) => new Date(date).toISOString().slice(0, 19); // format attendu par WordPress (heure UTC, sans fuseau)
const fakeLink = (id) => `${process.env.WP_BASE_URL || 'https://citylock.fr'}/?p=${id}&simulation=1`;

async function createDraft(article, categoryId) {
  if (simulate()) { const id = ++simCounter; return { id, link: fakeLink(id), yoast: false }; }
  const { post, yoast: y } = await writePost('/posts', postBody(article, { status: 'draft', categories: categoryId ? [categoryId] : undefined }), article);
  return { id: post.id, link: post.link, yoast: y };
}

// Programme l'article : WordPress le publiera tout seul à la date indiquée (crée le brouillon si besoin).
async function schedule(article, when, categoryId) {
  if (simulate()) { const id = article.wpId || ++simCounter; return { id, link: fakeLink(id), yoast: false }; }
  const body = postBody(article, { status: 'future', date_gmt: gmt(when), categories: !article.wpId && categoryId ? [categoryId] : undefined });
  const { post, yoast: y } = await writePost(article.wpId ? `/posts/${article.wpId}` : '/posts', body, article);
  return { id: post.id, link: post.link, yoast: y };
}

// Annule la programmation : l'article redevient un brouillon.
async function unschedule(id) {
  if (simulate()) return;
  await wp('POST', `/posts/${id}`, { status: 'draft' });
}

// Publie tout de suite. Un article programmé garde sa date future : on la ramène à maintenant, sinon WordPress le reprogrammerait.
async function publish(id, opts = {}) {
  if (simulate()) return { link: fakeLink(id) };
  const post = await wp('POST', `/posts/${id}`, { status: 'publish', ...(opts.resetDate ? { date_gmt: gmt(new Date()) } : {}) });
  return { link: post.link };
}

// Met à jour le texte d'un brouillon (ou d'un article programmé) déjà présent sur le site, sans changer son statut.
async function updateDraft(id, article) {
  if (simulate()) return { yoast: false };
  const { yoast: y } = await writePost(`/posts/${id}`, postBody(article), article);
  return { yoast: y };
}

// Relit l'article tel qu'il est sur le site (adresse, champs Yoast, texte), pour contrôler ce qui y est réellement.
async function readBack(id) {
  const post = await wp('GET', `/posts/${id}?context=edit&_fields=slug,status,link,meta,content`);
  return { slug: post.slug || '', status: post.status, link: post.link, meta: (post.meta && typeof post.meta === 'object' && !Array.isArray(post.meta)) ? post.meta : null, content: (post.content && (post.content.raw || post.content.rendered)) || '' };
}

// Statut actuel sur le site (publish, future, draft...), pour suivre les articles programmés.
async function getStatus(id) {
  const post = await wp('GET', `/posts/${id}?context=edit&_fields=status,link`);
  return { status: post.status, link: post.link };
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

module.exports = { YOAST_KEYS, yoastStatus, ensureBlogCategory, createDraft, schedule, unschedule, publish, updateDraft, getStatus, readBack, deleteDraft, testConnection, getContent, simulate, configured, _resetYoast: () => { yoast.ok = null; yoast.at = 0; } };
