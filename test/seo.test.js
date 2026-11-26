const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-seo-'));
process.env.DASHBOARD_USER = 'laurent-test';
process.env.DASHBOARD_PASSWORD = 'mdp-de-test-123';
process.env.SESSION_SECRET = 'secret-de-test-0123456789abcdef';
process.env.SIMULATE = 'true';
process.env.WRITE_COOLDOWN_MS = '0';

const { bodyWords, setupReal } = require('./helpers');
const seo = require('../lib/seoCheck');
const ai = require('../lib/ai');
const rules = require('../lib/rules');
const wp = require('../lib/wp');
const server = require('../server');

const good = (kw) => `<p>Votre ${kw} compte. Suite du texte.</p><h2>Quelle ${kw} choisir ?</h2><h2>Comment poser une ${kw} ?</h2><h2>Autre question</h2>` +
  `<p>${Array.from({ length: 5 }, () => kw).join(' et ')} <a href="/choisir-alarme-sans-abonnement/systeme-dalarme-sans-abonnement/">alarme sans abonnement</a> <a href="/choisir-alarme-sans-abonnement/systeme-dalarme-avec-abonnement/">alarme avec abonnement</a> <a href="https://ajax.systems/">Ajax Systems</a></p>`;

test('contrôle SEO : tout bon, puis chaque défaut signalé en rouge', () => {
  const kw = 'alarme maison';
  const a = { title: 'Alarme maison : le guide', keyword: kw, focusKeyphrase: kw, htmlContent: good(kw) };
  const meta = { _yoast_wpseo_focuskw: kw, _yoast_wpseo_title: 'Alarme maison : le guide %%sep%% %%sitename%%', _yoast_wpseo_metadesc: 'Alarme maison à Chatou : les points à comparer avant de choisir votre installation. Appelez-nous ou demandez un devis, sans engagement ni pression.' };
  const r = seo.analyze(a, { slug: 'alarme-maison-guide', meta, content: a.htmlContent }, 'https://citylock.fr');
  assert.ok(meta._yoast_wpseo_metadesc.length >= 130 && meta._yoast_wpseo_metadesc.length <= 155, 'méta de test : ' + meta._yoast_wpseo_metadesc.length);
  assert.deepStrictEqual(r.items.filter((i) => !i.ok).map((i) => i.id), [], JSON.stringify(r.items.filter((i) => !i.ok)));
  assert.strictEqual(r.ok, true);
  // champs Yoast non renvoyés par le site : rouge avec la raison
  const r2 = seo.analyze(a, { slug: 'alarme-maison-guide', meta: null, content: a.htmlContent }, 'https://citylock.fr');
  assert.deepStrictEqual(r2.items.filter((i) => !i.ok).map((i) => i.id), ['keyword', 'seoTitle', 'meta']);
  assert.ok(r2.items[0].detail.includes('extrait de code Yoast absent'));
  // méta trop courte, slug sans mot-clé, pas assez de liens, un lien externe de trop, mot-clé trop rare
  const bad = { title: 'Guide complet', keyword: kw, htmlContent: '<p>Texte sans rien.</p><h2>Titre</h2><a href="https://a.fr/">a</a><a href="https://b.fr/">b</a>' };
  const r3 = seo.analyze(bad, { slug: 'guide', meta: { _yoast_wpseo_focuskw: kw, _yoast_wpseo_title: 'x', _yoast_wpseo_metadesc: 'trop court' }, content: bad.htmlContent }, 'https://citylock.fr');
  const ko = r3.items.filter((i) => !i.ok).map((i) => i.id);
  for (const id of ['seoTitle', 'meta', 'slug', 'internal', 'external', 'occurrences', 'inTitle', 'intro', 'h2']) assert.ok(ko.includes(id), 'devrait être rouge : ' + id);
  assert.strictEqual(r3.items.find((i) => i.id === 'meta').value, 'trop court');
  assert.ok(r3.items.find((i) => i.id === 'meta').detail.includes('10 caractères'));
  // comptage des occurrences : sans accent, sans casse, mot entier
  assert.strictEqual(seo.countOccurrences('Alarme Maison, alarme maison. Des alarmes maisons. ALARME  MAISON', 'alarme maison'), 3);
});

test('format de réponse étendu : focusKeyphrase, seoTitle, imageAlt ; lien externe en nouvel onglet', () => {
  const art = ai.normalizeArticle({ title: 'T', focusKeyphrase: ' alarme maison ', seoTitle: 'Alarme maison : guide', metaDescription: 'D', slug: 'Alarme Maison', imageAlt: 'Une alarme maison', htmlContent: bodyWords(30) + '<p><a href="https://ajax.systems/" onclick="x()">Ajax</a> <a href="choisir/page/">i</a> <a href="//evil.fr">e</a></p>', faitsAVerifier: [] }, { min: 1, max: 9999 });
  assert.deepStrictEqual([art.focusKeyphrase, art.metaTitle, art.imageAlt, art.slug], ['alarme maison', 'Alarme maison : guide', 'Une alarme maison', 'alarme-maison']);
  assert.ok(art.htmlContent.includes('<a href="https://ajax.systems/" target="_blank" rel="noopener noreferrer">Ajax</a>'));
  assert.ok(art.htmlContent.includes('href="/choisir/page/"') && !art.htmlContent.includes('evil.fr') && !art.htmlContent.includes('onclick'));
});

test('mots interdits ajoutés : haut de gamme, performant, fiabilité, spécialiste, efficacement', () => {
  for (const t of ['un produit haut de gamme', 'des alarmes performantes', 'la fiabilité du système', 'un spécialiste', 'protège efficacement']) assert.strictEqual(rules.findForbidden(t).length, 1, t);
  assert.deepStrictEqual(rules.findForbidden('une alarme efficace et fiable'), []);
});

test('contrôle SEO sur le site, publication directe, planning par nombre d\'articles (faux WordPress)', async () => {
  const r = await setupReal(server);
  const { call, fake, store } = r;
  try {
    wp._resetYoast();
    fake.state.yoast = true;
    store.saveSettings({ ...store.getSettings(), topics: [{ id: 't1', keyword: 'alarme maison', city: 'Chatou' }] });
    // article envoyé en brouillon : relu sur le site
    const a = r.add(r.make({ keyword: 'alarme maison', title: 'Alarme maison : le guide', metaTitle: 'Alarme maison : le guide', metaDescription: 'Alarme maison à Chatou : les points à comparer avant de choisir votre installation. Appelez-nous ou demandez un devis, sans engagement ni pression.', slug: 'alarme-maison-guide', htmlContent: good('alarme maison') + bodyWords(750) }));
    const sent = await call('POST', `/api/articles/${a.id}/send`);
    assert.strictEqual(sent.status, 200);
    const rep = (await call('GET', `/api/articles/${a.id}/seo`)).json;
    assert.strictEqual(rep.source, 'site');
    assert.deepStrictEqual(rep.items.find((i) => i.id === 'keyword').value, 'alarme maison');
    assert.strictEqual(rep.items.find((i) => i.id === 'meta').ok, true);
    assert.strictEqual(rep.items.find((i) => i.id === 'internal').value, '2');
    // sans l'extrait Yoast : rouge
    fake.state.yoast = false; wp._resetYoast();
    const b = r.add(r.make({ keyword: 'alarme maison' }));
    await call('POST', `/api/articles/${b.id}/send`);
    const repB = (await call('GET', `/api/articles/${b.id}/seo`)).json;
    assert.strictEqual(repB.source, 'site');
    assert.ok(repB.items.find((i) => i.id === 'keyword').ok === false && repB.missing >= 3);
    // article pas encore envoyé : contrôle local
    const c = r.add(r.make());
    assert.strictEqual((await call('GET', `/api/articles/${c.id}/seo`)).json.source, 'local');

    // publication directe d'un article pas encore envoyé : créé puis publié
    const d = r.add(r.make({ keyword: 'alarme garage' }));
    const before = fake.wpPosts.size;
    const pub = await call('POST', `/api/articles/${d.id}/publish`, { validated: true });
    assert.deepStrictEqual([pub.status, pub.json.status, fake.wpPosts.size], [200, 'publie', before + 1]);
    assert.strictEqual(fake.wpPosts.get(pub.json.wpId).status, 'publish');
    // ...mais pas avec un marqueur de source, ni sans validation
    const e = r.add(r.make({ htmlContent: bodyWords(750) + '<p>[SOURCE A VERIFIER]</p>' }));
    assert.strictEqual((await call('POST', `/api/articles/${e.id}/publish`, { validated: true })).json.code, 'marker');
    assert.strictEqual((await call('POST', `/api/articles/${e.id}/publish`, {})).status, 400);
    assert.strictEqual(fake.wpPosts.size, before + 1);

    // planning par nombre d'articles : 5 articles, un tous les 3 jours, 1 sujet enregistré
    const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const plan = (await call('POST', '/api/write/plan', { count: 5, spacingDays: 3, startDate: future })).json;
    assert.strictEqual(plan.items.length, 5);
    assert.deepStrictEqual([plan.items[0].keyword, plan.items[1].keyword, plan.missing], ['alarme maison', '', 4]);
    assert.strictEqual(new Date(plan.items[4].plannedDate + 'T00:00:00Z') - new Date(plan.items[0].plannedDate + 'T00:00:00Z'), 12 * 86400000);
    assert.strictEqual((await call('POST', '/api/write/plan', { count: 21, startDate: future })).status, 400);
    assert.strictEqual((await call('POST', '/api/write/plan', { count: 0, startDate: future })).status, 400);

    // programmation à 10 h (heure de Paris) par défaut
    const f = r.add(r.make());
    const sr = await call('POST', `/api/articles/${f.id}/schedule`, { date: future });
    assert.strictEqual(sr.status, 200, JSON.stringify(sr.json));
    const s = sr.json;
    const h = parseInt(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date(s.scheduledAt)), 10);
    assert.strictEqual(h, 10);
  } finally { r.stop(); }
});
