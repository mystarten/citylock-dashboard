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

test('limite de réponse très large, et message clair si le modèle répond sans texte', async () => {
  const http = require('http');
  assert.ok(ai.GENERATION_MAX_TOKENS >= 32000);
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SIMULATE: 'false', OPENROUTER_BASE_URL: `http://127.0.0.1:${srv.address().port}`, OPENROUTER_API_KEY: 'cle-test-0000' });
    await assert.rejects(() => ai.generateArticle({ keyword: 'alarme' }, { brandName: 'C', zone: 'Z', aiModel: 'test/sonnet', systemPrompt: require('../lib/defaultRules') }, []), /test\/sonnet.*sans texte.*length.*La clé fonctionne/);
    assert.ok(seen[0].max_tokens >= 32000);
  } finally { Object.assign(process.env, saved); process.env.SIMULATE = 'true'; delete process.env.OPENROUTER_BASE_URL; srv.close(); }
});

test('correction par l\'IA : consigne, modèle Haiku par défaut, historique, retour arrière, SEO avant/après, site mis à jour', async () => {
  const r = await setupReal(server);
  const { call, fake, store, orState } = r;
  try {
    wp._resetYoast(); fake.state.yoast = true;
    const a = r.add(r.make({ keyword: 'alarme maison', title: 'Titre initial', slug: 'alarme-maison-guide', htmlContent: good('alarme maison') + bodyWords(750) }));
    const sent = await call('POST', `/api/articles/${a.id}/send`);
    assert.strictEqual(sent.status, 200);
    // consigne trop courte ; clé OpenRouter manquante géré ailleurs
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/ai-edit`, { instruction: 'x' })).status, 400);
    assert.strictEqual((await call('POST', '/api/articles/inconnu/ai-edit', { instruction: 'Raccourcis l\'introduction.' })).status, 404);

    const n0 = orState.requests.length;
    const e = await call('POST', `/api/articles/${a.id}/ai-edit`, { instruction: 'Raccourcis l\'introduction et ajoute une phrase sur les capteurs.' });
    assert.strictEqual(e.status, 200, JSON.stringify(e.json));
    const req = orState.requests[n0];
    assert.strictEqual(req.model, 'anthropic/claude-haiku-5-5');                       // Haiku par défaut pour la correction
    assert.strictEqual(req.messages[0].content, store.getSettings().editPrompt.trim());  // le prompt de correction des réglages, rien d'ajouté
    assert.ok(req.messages[1].content.includes('MOTCLE : alarme maison') && req.messages[1].content.includes('Raccourcis l\'introduction') && req.messages[1].content.includes('Titre initial'));
    assert.ok(req.max_tokens >= 32000);
    assert.ok(req.messages[0].content.includes('Exactement un lien externe') && req.messages[0].content.includes('MOTCLE apparaît entre 6 et 10 fois'), 'le prompt de correction garde les critères SEO');
    assert.strictEqual(e.json.model, 'anthropic/claude-haiku-5-5');
    assert.ok(e.json.article.title.startsWith('Titre généré'));
    assert.strictEqual(e.json.article.keyword, 'alarme maison');                       // le mot-clé ne change jamais
    assert.strictEqual(e.json.article.slug, 'alarme-maison-guide');                    // l'adresse d'un article déjà sur le site ne change pas
    assert.strictEqual(e.json.siteUpdated, true);
    assert.ok(fake.wpPosts.get(sent.json.wpId).title.startsWith('Titre généré'), 'le site a été mis à jour');
    assert.ok(Array.isArray(e.json.seo.worse) && typeof e.json.seo.before.missing === 'number' && typeof e.json.seo.after.missing === 'number');
    assert.ok(e.json.seo.worse.length > 0 || e.json.seo.after.missing >= 0);
    assert.strictEqual(e.json.article.versionsCount, 1);
    // retour arrière : l'ancien texte revient (et le site aussi)
    const back = await call('POST', `/api/articles/${a.id}/revert`, {});
    assert.strictEqual(back.status, 200, JSON.stringify(back.json));
    assert.strictEqual(back.json.article.title, 'Titre initial');
    assert.strictEqual(fake.wpPosts.get(sent.json.wpId).title, 'Titre initial');
    // article pas encore sur le site : l'adresse proposée par l'IA est appliquée ; article publié : refusé
    const b = r.add(r.make({ slug: 'ancienne-adresse' }));
    const eb = await call('POST', `/api/articles/${b.id}/ai-edit`, { instruction: 'Change le titre.' });
    assert.strictEqual(eb.status, 200);
    assert.ok(eb.json.article.slug.startsWith('titre-'), eb.json.article.slug);
    const c = r.add(r.make({ status: 'publie' }));
    assert.strictEqual((await call('POST', `/api/articles/${c.id}/ai-edit`, { instruction: 'Change le titre.' })).status, 409);
    // même modèle de test et limite journalière
    process.env.WRITES_PER_DAY = '1';
    assert.strictEqual((await call('POST', `/api/articles/${b.id}/ai-edit`, { instruction: 'Change le titre encore.' })).status, 429);
    delete process.env.WRITES_PER_DAY;

    // réglages : prompt de correction (validation) et modèle de correction (testé avant activation)
    assert.strictEqual((await call('PUT', '/api/settings', { editPrompt: 'court' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { editPrompt: 'x'.repeat(6001) })).status, 400);
    const ok = await call('PUT', '/api/settings', { editPrompt: 'Prompt de correction personnalisé, répond en JSON avec title et htmlContent. '.repeat(2) });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.json.editPromptProblems, []);
    assert.strictEqual((await call('PUT', '/api/settings', { editPrompt: 'Prompt sans le format demandé du tout. '.repeat(4) })).json.editPromptProblems.length, 3);
    const defs = (await call('GET', '/api/ai/defaults')).json;
    assert.deepStrictEqual([defs.activeEditModel, defs.editPrompt.includes('FORMAT DE RÉPONSE')], ['anthropic/claude-haiku-5-5', true]);
    await new Promise((x) => setTimeout(x, 2100));
    const m = await call('POST', '/api/ai/model', { model: 'autre/modele-correction', target: 'edit' });
    assert.deepStrictEqual([m.json.ok, store.getSettings().editModel, store.getSettings().aiModel], [true, 'autre/modele-correction', 'test/modele']);
    assert.strictEqual((await call('GET', '/api/ai/defaults')).json.activeEditModel, 'autre/modele-correction');
  } finally { delete process.env.WRITES_PER_DAY; const st = r.store.getSettings(); st.editModel = ''; r.store.saveSettings(st); r.stop(); }
});

test('délai de génération : 5 minutes, message clair si le délai est dépassé', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ai.js'), 'utf8');
  assert.ok(/const TIMEOUT_MS = 300000;/.test(src), 'le délai doit laisser 5 minutes à un modèle qui réfléchit');
  assert.ok(src.includes('OpenRouter a mis trop de temps à envoyer la réponse'), 'le délai dépassé pendant la lecture de la réponse est nommé clairement');
});

test('texte autour du JSON : l\'article est quand même lu ; erreur inattendue en français', async () => {
  const http = require('http');
  const art = { title: 'Titre', metaTitle: 'M', metaDescription: 'D', slug: 't', htmlContent: bodyWords(750), internalLinkSuggestions: [], faitsAVerifier: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Voici votre article :\n```json\n' + JSON.stringify(art) + '\n```\nBonne lecture !' } }] })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SIMULATE: 'false', OPENROUTER_BASE_URL: `http://127.0.0.1:${srv.address().port}`, OPENROUTER_API_KEY: 'cle-test-0000' });
    const out = await ai.generateArticle({ keyword: 'alarme' }, { brandName: 'C', zone: 'Z', aiModel: 'test/m', systemPrompt: require('../lib/defaultRules') }, []);
    assert.strictEqual(out.title, 'Titre');
  } finally { Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; srv.close(); }
});

test('bilan du mois et retour en brouillon d\'un article publié (faux WordPress)', async () => {
  const r = await setupReal(server);
  const { call, fake, store } = r;
  try {
    const m0 = (await call('GET', '/api/month')).json;
    assert.strictEqual(m0.published, 0);
    const pub = r.add(r.make({ keyword: 'alarme maison', htmlContent: good('alarme maison') + bodyWords(750) }));
    const p = await call('POST', `/api/articles/${pub.id}/publish`, { validated: true });
    assert.strictEqual(p.status, 200, JSON.stringify(p.json));
    const m1 = (await call('GET', '/api/month')).json;
    assert.strictEqual(m1.published, 1, 'publié ce mois-ci compté');
    // refusé sans confirmation, puis remis en brouillon sur le site
    assert.strictEqual((await call('POST', `/api/articles/${pub.id}/unpublish`, {})).status, 400);
    const back = await call('POST', `/api/articles/${pub.id}/unpublish`, { confirmed: true });
    assert.strictEqual(back.status, 200, JSON.stringify(back.json));
    assert.strictEqual(back.json.status, 'brouillon_wp');
    assert.strictEqual(fake.wpPosts.get(p.json.wpId).status, 'draft', 'le site repasse en brouillon');
    assert.strictEqual((await call('POST', `/api/articles/${pub.id}/unpublish`, { confirmed: true })).status, 409);
    assert.strictEqual((await call('GET', '/api/month')).json.published, 0);
    // le journal garde la trace
    assert.ok((await call('GET', '/api/publications')).json.some((e) => e.kind === 'annulation'));
  } finally { r.stop(); }
});
