// Exploration du site (sitemap + accueil), mesures, puis calcul du score.
const cheerio = require('cheerio');
const store = require('./store');
const log = require('./log');
const { computeScore } = require('./scoring');

const UA = 'CityLockAuditBot/1.0 (audit SEO interne)';
const MAX_PAGES = 150;
const MAX_SUBSITEMAPS = 20;
const MAX_LINK_CHECKS = 300;
const state = { running: false, startedAt: null, lastError: null };

async function get(url, { readBody = true, timeout = 15000 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    let text = '';
    if (readBody) text = (await res.text()).slice(0, 3_000_000);
    else if (res.body) await res.body.cancel().catch(() => {});
    return { status: res.status, finalUrl: res.url, text, type: res.headers.get('content-type') || '' };
  } catch (e) {
    return { status: 0, finalUrl: url, text: '', type: '', error: e.name === 'TimeoutError' ? 'délai dépassé' : 'erreur réseau' };
  }
}

async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const hostKey = (h) => h.toLowerCase().replace(/^www\./, '');
function keyOf(u) {
  const x = new URL(u);
  return hostKey(x.hostname) + (x.pathname.replace(/\/+$/, '') || '/');
}
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));

async function readSitemaps(base) {
  const root = await get(`${base}/sitemap_index.xml`);
  if (root.status !== 200) throw new Error(`Plan du site inaccessible (${base}/sitemap_index.xml, réponse ${root.status || root.error}).`);
  let urls = [];
  let truncated = false;
  if (/<sitemapindex/i.test(root.text)) {
    let subs = locs(root.text);
    if (subs.length > MAX_SUBSITEMAPS) { subs = subs.slice(0, MAX_SUBSITEMAPS); truncated = true; }
    for (const s of subs) {
      const r = await get(s);
      if (r.status === 200) urls.push(...locs(r.text));
      else log.warn(`Sous-plan du site inaccessible : ${s} (${r.status})`);
    }
  } else {
    urls = locs(root.text);
  }
  urls = [...new Set(urls)];
  if (urls.length > MAX_PAGES) { urls = urls.slice(0, MAX_PAGES); truncated = true; }
  return { urls, truncated };
}

function analysePage(url, html, baseHost, isHome) {
  const $ = cheerio.load(html);
  const title = ($('head > title').first().text() || $('title').first().text()).trim().replace(/\s+/g, ' ');
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const h1Count = $('h1').length;
  const imgs = $('img');
  let withAlt = 0;
  imgs.each((_, el) => { if (($(el).attr('alt') || '').trim()) withAlt += 1; });

  const jsonLdTypes = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(collect);
    const t = node['@type'];
    (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => jsonLdTypes.push(String(x)));
    if (node['@graph']) collect(node['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { collect(JSON.parse($(el).contents().text())); } catch { /* JSON-LD invalide : ignoré */ }
  });

  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    try {
      const u = new URL(href, url);
      if (!/^https?:$/.test(u.protocol) || hostKey(u.hostname) !== baseHost) return;
      if (/\/(wp-admin|wp-json|feed|xmlrpc\.php|wp-login\.php)/.test(u.pathname)) return;
      u.hash = '';
      links.add(u.toString());
    } catch { /* lien invalide */ }
  });

  const body = $('main').length ? $('main').first() : $('article').length ? $('article').first() : $('body').clone();
  body.find('script, style, noscript, nav, header, footer').remove();
  const words = body.text().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  return { url, isHome, title, metaDescription, h1Count, images: { total: imgs.length, withAlt }, jsonLdTypes, words, links: [...links] };
}

async function pageSpeed(url, key) {
  if (!key) return null;
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) return { error: `PageSpeed a répondu ${res.status}` };
    const j = await res.json();
    const s = j && j.lighthouseResult && j.lighthouseResult.categories && j.lighthouseResult.categories.performance;
    return s && typeof s.score === 'number' ? { score: s.score * 100 } : { error: 'réponse PageSpeed inattendue' };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'PageSpeed trop long à répondre' : 'PageSpeed injoignable' };
  }
}

async function measure(baseUrl, { pagespeedKey } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const baseHost = hostKey(new URL(base).hostname);
  const { urls: sitemapUrls, truncated } = await readSitemaps(base);
  const homeKey = keyOf(base + '/');
  const toCrawl = [...sitemapUrls];
  if (!toCrawl.some((u) => keyOf(u) === homeKey)) toCrawl.unshift(base + '/');

  const statuses = new Map(); // keyOf -> {url,status}
  const pages = [];
  const results = await pMap(toCrawl, 5, async (u) => {
    const r = await get(u);
    return { u, r };
  });
  for (const { u, r } of results) {
    statuses.set(keyOf(u), { url: u, status: r.status });
    if (r.status === 200 && /html/i.test(r.type)) pages.push(analysePage(u, r.text, baseHost, keyOf(u) === homeKey));
  }
  if (!pages.length) throw new Error('Aucune page exploitable trouvée : audit annulé.');

  // Orphelines : pages du plan du site non liées depuis une AUTRE page explorée (accueil exclue).
  const linkedFrom = new Map();
  for (const p of pages) for (const l of p.links) {
    const k = keyOf(l);
    if (k !== keyOf(p.url)) (linkedFrom.get(k) || linkedFrom.set(k, new Set()).get(k)).add(p.url);
  }
  const sitemapPages = sitemapUrls.filter((u) => keyOf(u) !== homeKey);
  const orphans = sitemapPages.filter((u) => !linkedFrom.has(keyOf(u)));

  // Liens cassés : pages du plan du site + liens internes trouvés.
  const targets = new Map();
  for (const p of pages) for (const l of p.links) if (!targets.has(keyOf(l))) targets.set(keyOf(l), l);
  for (const u of sitemapUrls) if (!targets.has(keyOf(u))) targets.set(keyOf(u), u);
  let keys = [...targets.keys()];
  let linksTruncated = false;
  if (keys.length > MAX_LINK_CHECKS) { keys = keys.slice(0, MAX_LINK_CHECKS); linksTruncated = true; }
  const broken = [];
  await pMap(keys, 5, async (k) => {
    let st = statuses.get(k);
    if (!st) {
      const r = await get(targets.get(k), { readBody: false });
      st = { url: targets.get(k), status: r.status };
      statuses.set(k, st);
    }
    if (st.status !== 200) broken.push({ url: st.url, status: st.status });
  });

  const robots = await get(`${base}/robots.txt`);
  const robotsHasSitemap = robots.status === 200 && /^\s*sitemap:\s*\S+/im.test(robots.text);
  const speed = await pageSpeed(base + '/', pagespeedKey);

  return {
    pages, sitemapUrls, sitemapCount: sitemapPages.length, orphans,
    links: { checked: keys.length, broken, truncated: linksTruncated },
    robotsHasSitemap, speed, truncated,
  };
}

async function runAudit(trigger = 'manuel', opts = {}) {
  if (state.running) throw new Error('Un audit est déjà en cours.');
  const baseUrl = opts.baseUrl || process.env.WP_BASE_URL;
  if (!baseUrl) throw new Error('WP_BASE_URL n\'est pas défini.');
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.lastError = null;
  try {
    log.info(`Audit SEO démarré (${trigger})`);
    const data = await measure(baseUrl, { pagespeedKey: opts.pagespeedKey !== undefined ? opts.pagespeedKey : process.env.PAGESPEED_API_KEY });
    const result = computeScore(data);
    const entry = {
      id: Date.now().toString(36),
      date: new Date().toISOString(),
      trigger,
      pagesCount: data.pages.length,
      truncated: data.truncated,
      sitemapUrls: data.sitemapUrls,
      ...result,
    };
    if (!opts.noSave) {
      const audits = store.getAudits();
      audits.push(entry);
      store.saveAudits(audits.slice(-104)); // 2 ans d'historique hebdomadaire
    }
    log.info(`Audit terminé : ${entry.score}/100 sur ${entry.pagesCount} page(s)`);
    return entry;
  } catch (e) {
    state.lastError = e.message;
    log.error('Audit en échec', e);
    throw e;
  } finally {
    state.running = false;
  }
}

module.exports = { runAudit, status: () => ({ ...state }), measure };
