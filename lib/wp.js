// Client WordPress REST (mot de passe d'application) ou simulation.
const log = require('./log');

const TIMEOUT_MS = 20000;
const simulate = () => process.env.SIMULATE === 'true';
let simCounter = 900000;

function base() {
  const b = (process.env.WP_BASE_URL || '').replace(/\/+$/, '');
  if (!b || !process.env.WP_USER || !process.env.WP_APP_PASSWORD) throw new Error('WP_BASE_URL, WP_USER ou WP_APP_PASSWORD manquant.');
  return b;
}

async function wp(method, path, body) {
  const b = base();
  const auth = Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
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
    const hint = res.status === 401 || res.status === 403 ? ' Vérifiez l\'identifiant et le mot de passe d\'application.' : '';
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
  const me = await wp('GET', '/users/me?context=edit&_fields=name,capabilities');
  const caps = (me && me.capabilities) || {};
  return { ok: true, name: me.name || '', canEdit: !!caps.edit_posts, canPublish: !!caps.publish_posts };
}

// Texte actuel de l'article dans WordPress (peut avoir été modifié depuis l'envoi).
async function getContent(id) {
  const post = await wp('GET', `/posts/${id}?context=edit&_fields=content`);
  return (post && post.content && (post.content.raw || post.content.rendered)) || '';
}

module.exports = { ensureBlogCategory, createDraft, publish, deleteDraft, testConnection, getContent, simulate };
