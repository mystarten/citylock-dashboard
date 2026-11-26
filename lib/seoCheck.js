// Contrôle SEO d'un article : ce que contient réellement le site (ou, avant l'envoi, le texte local).
// Fonction pure : testée sans réseau.
const cheerio = require('cheerio');
const rules = require('./rules');

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function countOccurrences(text, keyword) {
  const k = norm(keyword);
  if (!k) return 0;
  const t = ` ${norm(text)} `;
  let n = 0, i = 0;
  while ((i = t.indexOf(` ${k} `, i)) !== -1) { n += 1; i += k.length + 1; }
  return n;
}

// Compte les liens : internes (adresse du site ou commençant par « / »), externes (autre site).
function linkCounts(html, siteUrl) {
  const $ = cheerio.load(`<div>${html || ''}</div>`, null, false);
  const host = (() => { try { return new URL(siteUrl).host; } catch { return ''; } })();
  let internal = 0, external = 0;
  $('a[href]').each((_, el) => {
    const h = String($(el).attr('href') || '').trim();
    if (h.startsWith('/') && !h.startsWith('//')) internal += 1;
    else if (/^https?:\/\//i.test(h)) { let hh = ''; try { hh = new URL(h).host; } catch { /* lien invalide */ } if (host && hh === host) internal += 1; else external += 1; }
  });
  return { internal, external };
}

// expected = l'article de l'outil ; live = { slug, meta (ou null si le site ne l'expose pas), content } ; siteUrl = adresse du site.
function analyze(expected, live, siteUrl) {
  const keyword = expected.focusKeyphrase || expected.keyword || '';
  const html = live.content || expected.htmlContent || '';
  const text = rules.htmlToText(html);
  const items = [];
  const add = (id, label, value, ok, detail) => items.push({ id, label, value: value === '' || value == null ? 'manquant' : String(value), ok: !!ok, detail: detail || '' });

  const metaReadable = live.meta !== null && live.meta !== undefined;
  const yk = metaReadable ? String(live.meta._yoast_wpseo_focuskw || '') : '';
  const yt = metaReadable ? String(live.meta._yoast_wpseo_title || '') : '';
  const yd = metaReadable ? String(live.meta._yoast_wpseo_metadesc || '') : '';
  const unreadable = 'Le site ne renvoie pas les champs Yoast : extrait de code Yoast absent (Réglages, Connexions).';

  add('keyword', 'Mot-clé principal (Yoast)', yk, metaReadable && norm(yk) === norm(keyword) && !!yk, metaReadable ? (yk ? (norm(yk) === norm(keyword) ? '' : `Attendu : « ${keyword} ».`) : 'Aucun mot-clé principal dans Yoast.') : unreadable);
  const seoBase = (yt || '').replace(/\s*%%sep%%\s*%%sitename%%\s*$/, '');
  add('seoTitle', 'Titre SEO (Yoast)', yt, metaReadable && !!yt && seoBase.length <= 50 && norm(seoBase).startsWith(norm(keyword)), metaReadable ? (yt ? `${seoBase.length} caractères hors nom du site (50 maximum), commence par le mot-clé : ${norm(seoBase).startsWith(norm(keyword)) ? 'oui' : 'non'}.` : 'Aucun titre SEO dans Yoast.') : unreadable);
  add('meta', 'Méta description (Yoast)', yd, metaReadable && yd.length >= 130 && yd.length <= 155 && norm(yd).includes(norm(keyword)), metaReadable ? (yd ? `${yd.length} caractères (130 à 155 attendus), mot-clé dedans : ${norm(yd).includes(norm(keyword)) ? 'oui' : 'non'}.` : 'Aucune méta description dans Yoast.') : unreadable);
  add('slug', 'Adresse de la page (slug)', live.slug, !!live.slug && norm(live.slug.replace(/-/g, ' ')).includes(norm(keyword)), live.slug ? (norm(live.slug.replace(/-/g, ' ')).includes(norm(keyword)) ? '' : 'Le mot-clé n\'apparaît pas dans l\'adresse.') : 'Adresse manquante.');

  const lc = linkCounts(html, siteUrl);
  add('internal', 'Liens internes', lc.internal, lc.internal >= 2, lc.internal >= 2 ? '' : '2 liens internes au minimum.');
  add('external', 'Liens externes', lc.external, lc.external === 1, lc.external === 1 ? '' : 'Un seul lien externe est attendu (site du fabricant).');

  const occ = countOccurrences(`${text}`, keyword);
  add('occurrences', 'Occurrences du mot-clé dans le texte', occ, occ >= 6 && occ <= 10, occ >= 6 && occ <= 10 ? '' : '6 à 10 occurrences attendues.');

  add('inTitle', 'Mot-clé au début du titre', norm(expected.title).startsWith(norm(keyword)) ? 'oui' : 'non', norm(expected.title).startsWith(norm(keyword)), `Titre : ${String(expected.title || '').length} caractères (60 maximum).`);
  const firstP = (cheerio.load(`<div>${html}</div>`, null, false)('p').first().text() || '');
  const firstSentence = firstP.split(/(?<=[.!?])\s/)[0] || '';
  add('intro', 'Mot-clé dans la première phrase', norm(firstSentence).includes(norm(keyword)) ? 'oui' : 'non', norm(firstSentence).includes(norm(keyword)), '');
  const $h = cheerio.load(`<div>${html}</div>`, null, false);
  const h2 = $h('h2').map((_, e) => $h(e).text()).get();
  const h2k = h2.filter((t) => norm(t).includes(norm(keyword))).length;
  add('h2', 'Intertitres (H2) avec le mot-clé', `${h2k} sur ${h2.length}`, h2.length >= 3 && h2.length <= 5 && h2k * 2 >= h2.length, '3 à 5 H2, dont la moitié avec le mot-clé.');

  const bad = items.filter((i) => !i.ok);
  return { items, ok: bad.length === 0, missing: bad.length, keyword };
}

module.exports = { analyze, countOccurrences, linkCounts, norm };
