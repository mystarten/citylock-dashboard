const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-edit-'));
process.env.DASHBOARD_USER = 'laurent-test';
process.env.DASHBOARD_PASSWORD = 'mdp-de-test-123';
process.env.SESSION_SECRET = 'secret-de-test-0123456789abcdef';
process.env.SIMULATE = 'true';
process.env.TRIAL_COOLDOWN_MS = '0';

const { listen, client, bodyWords } = require('./helpers');
const { create } = require('./fake-site');
const store = require('../lib/store');
const secrets = require('../lib/secrets');
const server = require('../server');

// Prépare : faux WordPress + faux OpenRouter, mode réel, un article « à relire » ou « brouillon ».
async function setup() {
  const fake = create();
  const wpSrv = await listen(fake.app);
  let n = 0;
  const orSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      n += 1;
      const art = { title: `Titre généré ${n}`, metaTitle: 'M', metaDescription: 'D', slug: `titre-${n}`, htmlContent: bodyWords(650), internalLinkSuggestions: [], faitsAVerifier: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(art) } }] }));
    });
  });
  await new Promise((r) => orSrv.listen(0, '127.0.0.1', r));
  const app = await listen(server);
  const call = await client(app);
  const saved = { ...process.env };
  delete process.env.WP_USER; delete process.env.WP_APP_PASSWORD;
  Object.assign(process.env, { SIMULATE: 'false', WP_BASE_URL: `http://127.0.0.1:${wpSrv.address().port}`, OPENROUTER_BASE_URL: `http://127.0.0.1:${orSrv.address().port}` });
  secrets.set('openrouterKey', 'cle-test-or-0000'); secrets.set('wpAppPassword', 'abcd efgh');
  const st = store.getSettings(); st.wpUser = 'laurent'; st.aiModel = 'test/modele'; st.autoDraft = false; st.topics = []; store.saveSettings(st);
  store.saveArticles([]);
  const make = (extra = {}) => ({ id: 'art-' + Math.random().toString(36).slice(2), topicId: null, keyword: 'alarme maison', city: 'Chatou', month: '2026-11', createdAt: new Date().toISOString(), status: 'a_relire', wpId: null, wpLink: null, simulated: false,
    title: 'Titre initial', metaTitle: 'M', metaDescription: 'D', slug: 'titre-initial', htmlContent: bodyWords(650), internalLinkSuggestions: [], faitsAVerifier: [], warnings: [], wordCount: 650, versionAt: new Date().toISOString(), versionLabel: 'Texte généré', ...extra });
  const add = (a) => { store.saveArticles([...store.getArticles(), a]); return a; };
  const stop = () => {
    secrets.set('openrouterKey', ''); secrets.set('wpAppPassword', '');
    const s2 = store.getSettings(); delete s2.simulate; s2.wpUser = ''; s2.aiModel = ''; store.saveSettings(s2);
    Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; app.close(); wpSrv.close(); orSrv.close();
  };
  return { fake, call, make, add, stop };
}

test('modification manuelle : champs enregistrés, texte nettoyé, contrôles recalculés sans bloquer', async () => {
  const { call, make, add, stop } = await setup();
  try {
    const a = add(make());
    // problèmes volontaires : mot interdit, marqueur, texte court. L'enregistrement n'est PAS bloqué.
    const r = await call('PUT', `/api/articles/${a.id}`, {
      title: 'La meilleure alarme', metaTitle: 'Titre Google', metaDescription: 'Description', slug: 'Mon Adresse é!', keyword: 'alarme sans fil',
      htmlContent: '<h2>Court</h2><p>Une alarme <script>alert(1)</script>garantie. [SOURCE A VERIFIER]</p><p><a href="javascript:alert(1)" onclick="x()">piège</a> <a href="https://exemple.fr/page" target="_blank">ok</a> <a href="/page-interne/">interne</a></p>',
      faitsAVerifier: 'Un fait à vérifier\n\n  Un autre fait  ',
    });
    assert.strictEqual(r.status, 200);
    const art = r.json.article;
    assert.deepStrictEqual([art.title, art.slug, art.keyword], ['La meilleure alarme', 'mon-adresse-e', 'alarme sans fil']);
    assert.deepStrictEqual(art.faitsAVerifier, ['Un fait à vérifier', 'Un autre fait']);
    assert.ok(!art.htmlContent.includes('<script') && !art.htmlContent.includes('javascript:') && !art.htmlContent.includes('onclick'));
    assert.ok(art.htmlContent.includes('href="https://exemple.fr/page"') && art.htmlContent.includes('href="/page-interne/"') && !art.htmlContent.includes('target='));
    const codes = art.check.issues.map((i) => i.code);
    for (const c of ['length', 'forbidden', 'marker', 'facts']) assert.ok(codes.includes(c), 'contrôle manquant : ' + c);
    assert.strictEqual(art.state.label, 'À vérifier avant publication');
    assert.strictEqual(r.json.siteUpdated, false); // pas encore sur le site : rien à mettre à jour
    // validation
    assert.strictEqual((await call('PUT', `/api/articles/${a.id}`, { title: '   ' })).status, 400);
    assert.strictEqual((await call('PUT', `/api/articles/${a.id}`, { keyword: '' })).status, 400);
    assert.strictEqual((await call('PUT', `/api/articles/${a.id}`, { htmlContent: 12 })).status, 400);
    assert.strictEqual((await call('PUT', `/api/articles/${a.id}`, { htmlContent: '<script>x</script>' })).status, 400);
    assert.strictEqual((await call('PUT', `/api/articles/${a.id}`, { htmlContent: 'x'.repeat(60001) })).status, 400);
    assert.strictEqual((await call('PUT', '/api/articles/inconnu', { title: 'x' })).status, 404);
    // un article corrigé redevient « brouillon » (plus de problème bloquant)
    const ok = await call('PUT', `/api/articles/${a.id}`, { title: 'Alarme sans fil : le guide', htmlContent: bodyWords(700), faitsAVerifier: [] });
    assert.deepStrictEqual([ok.json.article.check.blocking, ok.json.article.state.label], [false, 'Brouillon, pas encore publié']);
  } finally { stop(); }
});

test('historique : chaque enregistrement garde la version précédente, retour arrière sans rien perdre', async () => {
  const { call, make, add, stop } = await setup();
  try {
    const a = add(make({ title: 'Version 0' }));
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/revert`, {})).status, 409); // rien avant
    await call('PUT', `/api/articles/${a.id}`, { title: 'Version 1' });
    await call('PUT', `/api/articles/${a.id}`, { title: 'Version 2' });
    const sameAgain = await call('PUT', `/api/articles/${a.id}`, { title: 'Version 2' });
    assert.strictEqual(sameAgain.json.unchanged, true); // pas de version inutile
    let v = (await call('GET', `/api/articles/${a.id}/versions`)).json.versions;
    assert.deepStrictEqual(v.map((x) => x.title), ['Version 0', 'Version 1']);
    assert.strictEqual(v[0].label, 'Texte généré');
    assert.strictEqual((await call('GET', `/api/articles/${a.id}`)).json.versionsCount, 2);
    // « Revenir à la version précédente » : on retrouve la version 1, et la version 2 est gardée
    const back = await call('POST', `/api/articles/${a.id}/revert`, {});
    assert.strictEqual(back.json.article.title, 'Version 1');
    v = (await call('GET', `/api/articles/${a.id}/versions`)).json.versions;
    assert.deepStrictEqual(v.map((x) => x.title), ['Version 0', 'Version 2']);
    // on peut restaurer une version plus ancienne par son numéro
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/revert`, { index: 0 })).json.article.title, 'Version 0');
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/revert`, { index: 99 })).status, 400);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/revert`, { index: 'x' })).status, 400);
    // l'historique est limité à 20 versions
    for (let i = 0; i < 25; i++) await call('PUT', `/api/articles/${a.id}`, { title: `Boucle ${i}` });
    assert.strictEqual((await call('GET', `/api/articles/${a.id}`)).json.versionsCount, 20);
  } finally { stop(); }
});

test('le texte modifié est celui qui part en brouillon, et le brouillon du site suit les modifications', async () => {
  const { fake, call, make, add, stop } = await setup();
  try {
    const a = add(make({ title: 'Avant', htmlContent: bodyWords(650) }));
    await call('PUT', `/api/articles/${a.id}`, { title: 'Titre corrigé', htmlContent: bodyWords(700) + '<p>Phrase ajoutée à la main.</p>' });
    const sent = await call('POST', `/api/articles/${a.id}/send`);
    assert.strictEqual(sent.status, 200);
    const post = fake.wpPosts.get(sent.json.wpId);
    assert.strictEqual(post.title, 'Titre corrigé');
    assert.ok(post.content.includes('Phrase ajoutée à la main.'), 'le texte modifié est celui envoyé');
    // article déjà sur le site : une modification met aussi le brouillon à jour (jamais son statut)
    const r = await call('PUT', `/api/articles/${a.id}`, { htmlContent: bodyWords(700) + '<p>Seconde correction.</p>' });
    assert.deepStrictEqual([r.json.siteUpdated, r.json.syncError, post.status], [true, '', 'draft']);
    assert.ok(post.content.includes('Seconde correction.') && !post.content.includes('Phrase ajoutée'));
    // le retour arrière met lui aussi le site à jour
    await call('POST', `/api/articles/${a.id}/revert`, {});
    assert.ok(post.content.includes('Phrase ajoutée à la main.') && !post.content.includes('Seconde correction.'));
  } finally { stop(); }
});

test('modification faite directement dans WordPress : on ne l\'écrase pas sans confirmation', async () => {
  const { fake, call, make, add, stop } = await setup();
  try {
    const a = add(make({ title: 'Titre A' }));
    const sent = (await call('POST', `/api/articles/${a.id}/send`)).json;
    const post = fake.wpPosts.get(sent.wpId);
    post.content = '<p>Laurent a corrigé ce texte directement dans WordPress.</p>';
    const refused = await call('PUT', `/api/articles/${a.id}`, { title: 'Titre B' });
    assert.deepStrictEqual([refused.status, refused.json.code], [409, 'wp_changed']);
    assert.strictEqual((await call('GET', `/api/articles/${a.id}`)).json.title, 'Titre A', 'rien n\'a été enregistré');
    assert.ok(post.content.includes('Laurent a corrigé'), 'le texte de Laurent est intact');
    const forced = await call('PUT', `/api/articles/${a.id}`, { title: 'Titre B', force: true });
    assert.strictEqual(forced.status, 200);
    assert.strictEqual(post.title, 'Titre B');
    assert.ok(!post.content.includes('Laurent a corrigé'), 'écrasé après confirmation');
  } finally { stop(); }
});

test('panne WordPress pendant l\'enregistrement : texte gardé ici, publication bloquée jusqu\'à la mise à jour', async () => {
  const { fake, call, make, add, stop } = await setup();
  try {
    const a = add(make());
    const sent = (await call('POST', `/api/articles/${a.id}/send`)).json;
    const post = fake.wpPosts.get(sent.wpId);
    post.content = post.content; // état de départ
    fake.state.failWrites = true;
    const r = await call('PUT', `/api/articles/${a.id}`, { htmlContent: bodyWords(700) + '<p>Modif pendant la panne.</p>' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.syncError && r.json.siteUpdated === false);
    assert.strictEqual(r.json.article.siteDirty, true);
    assert.ok(r.json.article.htmlContent.includes('Modif pendant la panne.'), 'le texte n\'est pas perdu');
    // publier maintenant enverrait l'ancien texte : refusé
    const blocked = await call('POST', `/api/articles/${a.id}/publish`, { validated: true });
    assert.deepStrictEqual([blocked.status, blocked.json.code, post.status], [409, 'site_dirty', 'draft']);
    // le site revient : un nouvel enregistrement (même texte) réessaie la mise à jour
    fake.state.failWrites = false;
    const retry = await call('PUT', `/api/articles/${a.id}`, { htmlContent: bodyWords(700) + '<p>Modif pendant la panne.</p>' });
    assert.deepStrictEqual([retry.json.siteUpdated, retry.json.article.siteDirty], [true, false]);
    assert.ok(post.content.includes('Modif pendant la panne.'));
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/publish`, { validated: true })).status, 200);
    assert.strictEqual(post.status, 'publish');
  } finally { stop(); }
});

test('régénérer : même sujet, ancien texte gardé, longueur corrigée, limiteur respecté', async () => {
  const { call, make, add, stop } = await setup();
  try {
    const a = add(make({ htmlContent: '<p>texte beaucoup trop court</p>', title: 'Trop court' }));
    assert.strictEqual((await call('GET', `/api/articles/${a.id}`)).json.check.inRange, false);
    const r = await call('POST', `/api/articles/${a.id}/regenerate`, {});
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.article.check.inRange && r.json.article.title.startsWith('Titre généré'));
    assert.deepStrictEqual([r.json.article.keyword, r.json.article.city, r.json.article.modelUsed], ['alarme maison', 'Chatou', 'test/modele']);
    const v = (await call('GET', `/api/articles/${a.id}/versions`)).json.versions;
    assert.deepStrictEqual([v.length, v[0].title], [1, 'Trop court']); // l'ancien texte est retrouvable
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/revert`, {})).json.article.title, 'Trop court');
    // limiteur : une régénération compte comme un essai (cadence)
    process.env.TRIAL_COOLDOWN_MS = '60000';
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/regenerate`, {})).status, 429);
    process.env.TRIAL_COOLDOWN_MS = '0';
  } finally { stop(); }
});

test('aperçu et gardes : texte publié ou article de l\'autre mode non modifiable, aperçu sans enregistrement', async () => {
  const { call, make, add, stop } = await setup();
  try {
    const pub = add(make({ status: 'publie', publishedAt: new Date().toISOString(), wpId: 5 }));
    assert.strictEqual((await call('PUT', `/api/articles/${pub.id}`, { title: 'x' })).status, 409);
    assert.strictEqual((await call('POST', `/api/articles/${pub.id}/regenerate`, {})).status, 409);
    // aperçu : texte nettoyé + contrôles, rien d'enregistré
    const p = await call('POST', '/api/preview', { title: 'Le leader', htmlContent: '<p onclick="x()">Bonjour <script>1</script><a href="https://a.fr">lien</a></p>', faitsAVerifier: 'a\nb' });
    assert.ok(!p.json.html.includes('script') && !p.json.html.includes('onclick') && p.json.html.includes('href="https://a.fr"'));
    assert.deepStrictEqual([p.json.check.words, p.json.check.issues.some((i) => i.code === 'forbidden'), p.json.check.issues.some((i) => i.code === 'facts')], [2, true, true]);
    assert.strictEqual((await call('POST', '/api/preview', { htmlContent: 5 })).status, 400);
    // un vrai brouillon du site ne se modifie pas pendant que le mode démonstration est actif
    const draft = add(make({ status: 'brouillon_wp', wpId: 77, wpSyncHash: 'x' }));
    await call('PUT', '/api/settings', { frequency: 2, zone: 'Z', brandName: 'B', simulate: true });
    assert.strictEqual((await call('PUT', `/api/articles/${draft.id}`, { title: 'Modif en démo' })).status, 409);
    assert.strictEqual(store.getArticles().find((x) => x.id === draft.id).title, 'Titre initial');
  } finally { stop(); }
});
