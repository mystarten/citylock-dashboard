const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
process.env.DASHBOARD_USER = 'laurent-test';
process.env.DASHBOARD_PASSWORD = 'mdp-de-test-123';
process.env.SESSION_SECRET = 'secret-de-test-0123456789abcdef';
process.env.SIMULATE = 'true';
delete process.env.PAGESPEED_API_KEY;

const { create } = require('./fake-site');
const audit = require('../lib/audit');
const wp = require('../lib/wp');
const ai = require('../lib/ai');
const log = require('../lib/log');
const http = require('http');
const server = require('../server');

// Texte de n mots répartis en paragraphes (sans aucun mot interdit).
const bodyWords = (n) => Array.from({ length: Math.ceil(n / 40) }, (_, i) => `<p>${Array.from({ length: Math.min(40, n - i * 40) }, (__, j) => `mot${i * 40 + j}`).join(' ')}</p>`).join('');
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

test('audit complet sur un faux site', async () => {
  const fake = create();
  const s = await listen(fake.app);
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    const r = await audit.runAudit('test', { baseUrl: url, noSave: true });
    const c = (id) => r.criteria.find((x) => x.id === id);
    assert.strictEqual(c('localbusiness').points, 10);
    assert.strictEqual(c('robots').points, 5);
    assert.strictEqual(c('offtopic').points, 0);
    assert.strictEqual(c('speed').notMeasured, true);
    assert.ok(c('broken').measured.includes('2 lien(s) cassé(s)'), c('broken').measured); // /gone/ et /lien-mort/
    assert.deepStrictEqual(c('orphans').details.map((d) => new URL(d.url).pathname).sort(), ['/gone/', '/orphan/']);
    assert.ok(c('h1').points < 10 && c('thin').points < 10 && c('title').points < 10);
    assert.ok(r.score >= 0 && r.score <= 100);
    console.log('  score faux site :', r.score, '| mesures :', r.criteria.map((x) => `${x.id}=${x.points}`).join(' '));
  } finally { s.close(); }
});

test('client WordPress réel contre faux WP : catégorie, brouillon, publication, suppression', async () => {
  const fake = create();
  const s = await listen(fake.app);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SIMULATE: 'false', WP_BASE_URL: `http://127.0.0.1:${s.address().port}`, WP_USER: 'laurent', WP_APP_PASSWORD: 'abcd efgh' });
    const cat = await wp.ensureBlogCategory();
    assert.strictEqual(cat, 7);
    assert.strictEqual(await wp.ensureBlogCategory(), 7); // pas de doublon
    assert.strictEqual(fake.wpCats.length, 1);
    const post = await wp.createDraft({ title: 'T', htmlContent: '<p>x</p>', slug: 't', metaDescription: 'd' }, cat);
    assert.strictEqual(fake.wpPosts.get(post.id).status, 'draft');
    await wp.publish(post.id);
    await assert.rejects(() => wp.deleteDraft(post.id), /plus un brouillon/); // refuse de supprimer un article publié
    const p2 = await wp.createDraft({ title: 'T2', htmlContent: '<p>x</p>', slug: 't2', metaDescription: 'd' }, cat);
    await wp.deleteDraft(p2.id);
    assert.ok(!fake.wpPosts.has(p2.id));
    const me = await wp.testConnection();
    assert.deepStrictEqual([me.name, me.canEdit, me.canPublish], ['Laurent', true, true]);
    const p3 = await wp.createDraft({ title: 'T3', htmlContent: '<p>Chiffre [SOURCE A VERIFIER]</p>', slug: 't3', metaDescription: 'd' }, cat);
    assert.ok((await wp.getContent(p3.id)).includes('[SOURCE A VERIFIER]'));
    process.env.WP_APP_PASSWORD = 'mauvais';
    await assert.rejects(() => wp.ensureBlogCategory(), /401/);
  } finally { Object.assign(process.env, saved); s.close(); }
});

test('API : auth, validation, lot simulé, brouillon, publication, suppression', async () => {
  const s = await listen(server);
  const base = `http://127.0.0.1:${s.address().port}`;
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json };
  };
  try {
    assert.strictEqual((await call('GET', '/api/settings')).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'laurent-test', password: 'faux' })).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'autre', password: 'mdp-de-test-123' })).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123' }, { 'X-Requested-With': 'x' })).status, 403); // CSRF
    assert.strictEqual((await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123', remember: true })).status, 200);

    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 9, zone: 'a', brandName: 'b' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 'x', zone: 'a', brandName: 'b' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 2, zone: '', brandName: 'b' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', autoDraft: false })).status, 200);
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 2, zone: 'a', brandName: 'b', autoDraft: 'oui' })).status, 400);

    assert.strictEqual((await call('POST', '/api/topics', { keyword: '  ' })).status, 400);
    for (const kw of ['alarme sans abonnement', 'alarme Ajax', 'installation alarme']) assert.strictEqual((await call('POST', '/api/topics', { keyword: kw, city: 'Chatou' })).status, 201);
    assert.strictEqual((await call('POST', '/api/topics', { keyword: 'alarme Ajax', city: 'Chatou' })).status, 409);

    // Lot : fréquence 2 pour 3 sujets => 2 articles maximum
    assert.strictEqual((await call('POST', '/api/articles/batch')).status, 202);
    for (let i = 0; i < 50; i++) { if (!(await call('GET', '/api/articles/batch/status')).json.running) break; await new Promise((r) => setTimeout(r, 100)); }
    let list = (await call('GET', '/api/articles')).json;
    assert.strictEqual(list.length, 2);
    assert.strictEqual((await call('POST', '/api/articles/batch')).status, 409); // lot complet
    const a = list[0];
    assert.ok(a.faitsAVerifier.length && a.htmlContent.includes('[SOURCE A VERIFIER]'));

    // Publication impossible avant l'envoi en brouillon et sans validation
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/publish`, { validated: true })).status, 409);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/send`)).status, 200);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/send`)).status, 409);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/publish`, {})).status, 400);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/publish`, { validated: true })).status, 200);
    assert.strictEqual((await call('DELETE', `/api/articles/${a.id}`)).status, 409); // publié : suppression refusée
    assert.strictEqual((await call('DELETE', `/api/articles/${list[1].id}`)).status, 200);
    assert.strictEqual((await call('GET', '/api/articles')).json.length, 1);

    // Modèle et consignes modifiables depuis les réglages
    const base = { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', autoDraft: true };
    assert.strictEqual((await call('PUT', '/api/settings', { ...base, aiModel: 'modele avec espace' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { ...base, aiModel: 42 })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { ...base, systemPrompt: 'court' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { ...base, systemPrompt: 'x'.repeat(6001) })).status, 400);
    const okSet = await call('PUT', '/api/settings', { ...base, aiModel: ' anthropic/claude-haiku-5-5 ', systemPrompt: 'Consigne personnalisée. '.repeat(10) });
    assert.strictEqual(okSet.status, 200);
    assert.strictEqual(okSet.json.aiModel, 'anthropic/claude-haiku-5-5');
    assert.ok(okSet.json.systemPrompt.startsWith('Consigne personnalisée.'));
    const defs = (await call('GET', '/api/ai/defaults')).json;
    assert.ok(defs.systemPrompt.includes('N\'invente aucun chiffre') && defs.maxLength === 6000);
    // un texte identique à l'original n'est pas enregistré comme personnalisé
    assert.strictEqual((await call('PUT', '/api/settings', { ...base, systemPrompt: defs.systemPrompt })).json.systemPrompt, '');
    assert.strictEqual((await call('PUT', '/api/settings', { ...base, aiModel: '' })).json.aiModel, '');
    assert.strictEqual((await call('GET', '/api/settings')).json.frequency, 2); // les champs absents ne sont pas écrasés

    // Envoi automatique en brouillon : le nouvel article arrive directement au statut brouillon WordPress
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', autoDraft: true })).status, 200);
    assert.strictEqual((await call('POST', '/api/articles/batch')).status, 202);
    for (let i = 0; i < 50; i++) { if (!(await call('GET', '/api/articles/batch/status')).json.running) break; await new Promise((r) => setTimeout(r, 100)); }
    list = (await call('GET', '/api/articles')).json;
    assert.strictEqual(list.length, 2);
    assert.ok(list.some((x) => x.status === 'brouillon_wp' && x.wpId), 'autoDraft : brouillon attendu');
    assert.strictEqual((await call('GET', '/api/wp/test')).json.ok, true);

    // Aucun secret dans le front
    for (const f of ['index.html', 'app.js']) {
      const txt = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
      assert.ok(!/OPENROUTER_API_KEY|WP_APP_PASSWORD|sk-or-v1-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}/.test(txt), 'variable ou clé en clair dans ' + f);
    }
  } finally { s.close(); }
});

test('OpenRouter : le modèle et les consignes des réglages sont bien utilisés (faux serveur local)', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, j });
      if (j.model === 'mauvais/modele') { res.statusCode = 400; return res.end('{"error":"invalid model"}'); }
      const art = { title: 'T', metaTitle: 'M', metaDescription: 'D', slug: 't', htmlContent: '<p>texte</p>', internalLinkSuggestions: [], faitsAVerifier: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: j.max_tokens === 8 ? 'OK' : JSON.stringify(art) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SIMULATE: 'false', OPENROUTER_BASE_URL: `http://127.0.0.1:${srv.address().port}`, OPENROUTER_API_KEY: 'sk-or-test-1234567890', OPENROUTER_MODEL: 'env/modele' });
    const topic = { keyword: 'alarme', city: 'Chatou' };
    const rules = 'MES CONSIGNES A MOI. '.repeat(8);

    await ai.generateArticle(topic, { brandName: 'CITYLOCK', zone: 'Chatou', aiModel: 'anthropic/claude-haiku-5-5', systemPrompt: rules });
    let req = seen.pop();
    assert.strictEqual(req.j.model, 'anthropic/claude-haiku-5-5');                    // modèle des réglages
    assert.ok(req.j.messages[0].content.startsWith('MES CONSIGNES A MOI.'));          // consignes personnalisées
    assert.ok(req.j.messages[0].content.includes('FORMAT DE REPONSE'));               // contrat JSON toujours ajouté
    assert.strictEqual(req.auth, 'Bearer sk-or-test-1234567890');

    await ai.generateArticle(topic, { brandName: 'CITYLOCK', zone: 'Chatou', aiModel: '', systemPrompt: '' });
    req = seen.pop();
    assert.strictEqual(req.j.model, 'env/modele');                                    // repli sur la variable du serveur
    assert.ok(req.j.messages[0].content.includes('N\'invente aucun chiffre'));               // consignes d'origine

    assert.deepStrictEqual(await ai.testModel({ aiModel: '' }), { ok: true, model: 'env/modele' });
    await assert.rejects(() => ai.testModel({ aiModel: 'mauvais/modele' }), /code 400.*Vérifiez l'identifiant du modèle/);
    assert.strictEqual(log.redact('erreur sk-or-test-1234567890 fin'), 'erreur [masqué] fin'); // la clé n'apparaît pas dans les logs
  } finally { Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; srv.close(); }
});

test('clés saisies dans l\'interface : chiffrées, jamais renvoyées, prioritaires, masquées dans les journaux', async () => {
  const secrets = require('../lib/secrets');
  const store = require('../lib/store');
  const saved = { ...process.env };
  const s = await listen(server);
  const base = `http://127.0.0.1:${s.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json, text: JSON.stringify(json) };
  };
  try {
    // chiffrement aller-retour, et illisible sans la bonne clé
    const blob = secrets.encrypt('cle-test-secret-demo-0000');
    assert.ok(!blob.includes('secret-demo') && blob.startsWith('enc1:'));
    assert.strictEqual(secrets.decrypt(blob), 'cle-test-secret-demo-0000');
    const parts = blob.split(':');
    const body = Buffer.from(parts[3], 'base64'); body[0] ^= 0xff; // un octet modifié : l'authentification GCM doit refuser
    assert.strictEqual(secrets.decrypt([parts[0], parts[1], parts[2], body.toString('base64')].join(':')), null);

    assert.strictEqual((await call('PUT', '/api/secrets', { openrouterKey: 'x' })).status, 401); // connexion requise
    await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123' });

    // validation
    assert.strictEqual((await call('PUT', '/api/secrets', {})).status, 400);
    assert.strictEqual((await call('PUT', '/api/secrets', { openrouterKey: 12 })).status, 400);
    assert.strictEqual((await call('PUT', '/api/secrets', { openrouterKey: 'abc\ndef' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/secrets', { wpAppPassword: 'x'.repeat(500) })).status, 400);

    // enregistrement : la valeur n'est JAMAIS renvoyée, ni par la réponse, ni par GET /api/settings, ni par /api/status
    const KEY = 'cle-test-ABCDEFGHIJKLMNOP-1234';
    const put = await call('PUT', '/api/secrets', { openrouterKey: KEY, wpAppPassword: 'abcd efgh ijkl mnop', pagespeedKey: 'pagespeed-test-demo-key', wpUser: 'laurent' });
    assert.strictEqual(put.status, 200);
    for (const r of [put, await call('GET', '/api/settings'), await call('GET', '/api/status'), await call('POST', '/api/topics', { keyword: 'fuite test' })]) {
      assert.ok(!/ABCDEFGHIJKLMNOP|abcd efgh|pagespeed-test-demo|enc1:/.test(r.text), 'une clé a fuité vers le navigateur : ' + r.text.slice(0, 120));
    }
    const st = (await call('GET', '/api/settings')).json;
    assert.deepStrictEqual([st.secrets.openrouterKey.set, st.secrets.openrouterKey.source, st.secrets.openrouterKey.hint, st.wpUser], [true, 'interface', '1234', 'laurent']);
    // sur le disque : chiffrée, pas en clair
    const onDisk = fs.readFileSync(path.join(process.env.DATA_DIR, 'settings.json'), 'utf8');
    assert.ok(!onDisk.includes('ABCDEFGHIJKLMNOP') && !onDisk.includes('abcd efgh') && onDisk.includes('enc1:'));

    // la valeur de l'interface prend le pas sur la variable du serveur ; vide = on efface et on revient au serveur
    process.env.OPENROUTER_API_KEY = 'cle-du-serveur-0000';
    assert.strictEqual(secrets.get('openrouterKey'), KEY);
    await call('PUT', '/api/secrets', { openrouterKey: '' });
    assert.strictEqual(secrets.get('openrouterKey'), 'cle-du-serveur-0000');
    assert.strictEqual((await call('GET', '/api/settings')).json.secrets.openrouterKey.source, 'serveur');

    // les journaux masquent les clés de l'interface
    await call('PUT', '/api/secrets', { openrouterKey: KEY });
    assert.strictEqual(log.redact(`erreur avec ${KEY} et abcd efgh ijkl mnop`), 'erreur avec [masqué] et [masqué]');
    assert.ok(!log.redact('Basic ' + Buffer.from('laurent:abcd efgh ijkl mnop').toString('base64')).includes('bGF1cmVudDph'));

    // mode démonstration réglable depuis l'interface (repli sur SIMULATE du serveur tant qu'on n'y touche pas)
    process.env.SIMULATE = 'true';
    assert.strictEqual((await call('GET', '/api/status')).json.simulate, true);
    const base2 = { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK' };
    assert.strictEqual((await call('PUT', '/api/settings', { ...base2, simulate: 'non' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { ...base2, simulate: false })).status, 200);
    assert.strictEqual((await call('GET', '/api/status')).json.simulate, false);
    assert.strictEqual((await call('PUT', '/api/settings', { ...base2, simulate: true })).json.simulate, true);
  } finally {
    for (const k of ['openrouterKey', 'wpAppPassword', 'pagespeedKey']) secrets.set(k, '');
    const st = store.getSettings(); delete st.simulate; st.wpUser = ''; store.saveSettings(st);
    Object.assign(process.env, saved); s.close();
  }
});

test('WordPress : identifiants de l\'interface utilisés, diagnostic en 2 étapes, HTTPS obligatoire', async () => {
  const secrets = require('../lib/secrets');
  const store = require('../lib/store');
  const fake = create();
  const srv = await listen(fake.app);
  const saved = { ...process.env };
  try {
    delete process.env.WP_USER; delete process.env.WP_APP_PASSWORD;
    Object.assign(process.env, { SIMULATE: 'false', WP_BASE_URL: `http://127.0.0.1:${srv.address().port}` });
    assert.strictEqual(wp.configured(), false);
    await assert.rejects(() => wp.testConnection(), /manquant/); // pas d'identifiants nulle part

    const st = store.getSettings(); st.wpUser = 'laurent'; store.saveSettings(st);
    secrets.set('wpAppPassword', 'abcd efgh');
    assert.strictEqual(wp.configured(), true);
    const r = await wp.testConnection();
    assert.deepStrictEqual([r.ok, r.site, r.name, r.canEdit, r.canPublish], [true, 'Faux site CityLock', 'Laurent', true, true]);

    secrets.set('wpAppPassword', 'mauvais mot de passe');
    await assert.rejects(() => wp.testConnection(), /401.*incorrect/);

    // l'adresse du site ne peut pas être en http (hors machine locale) : les identifiants ne circulent pas en clair
    process.env.WP_BASE_URL = 'http://citylock.fr';
    secrets.set('wpAppPassword', 'abcd efgh');
    await assert.rejects(() => wp.testConnection(), /https/);
  } finally {
    secrets.set('wpAppPassword', ''); const st = store.getSettings(); st.wpUser = ''; store.saveSettings(st);
    Object.assign(process.env, saved); srv.close();
  }
});

// ---------- Parcours réel complet (faux WordPress + faux OpenRouter) : sujets, lot, essai, publication, modes ----------
test('sujets pris en compte, lot réel, essai, publication réelle et garde-fous démonstration/réel', async () => {
  const secrets = require('../lib/secrets');
  const store = require('../lib/store');
  const fake = create();
  const wpSrv = await listen(fake.app);
  const orReqs = [];
  const orSrv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body); orReqs.push(j);
      const short = /Mot-clé principal : article court/.test(j.messages[1].content);
      const art = { title: 'Titre ' + orReqs.length, metaTitle: 'M', metaDescription: 'D', slug: 'titre-' + orReqs.length, htmlContent: (short ? '<p>texte très court</p>' : bodyWords(650)) + '<p>Selon le secteur, [SOURCE A VERIFIER] des cambriolages.</p>', internalLinkSuggestions: [], faitsAVerifier: ['stat'] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(art) } }] }));
    });
  });
  await new Promise((r) => orSrv.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  const app = await listen(server);
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json };
  };
  const waitBatch = async () => { for (let i = 0; i < 80; i++) { if (!(await call('GET', '/api/articles/batch/status')).json.running) return; await new Promise((r) => setTimeout(r, 50)); } };
  try {
    delete process.env.WP_USER; delete process.env.WP_APP_PASSWORD;
    Object.assign(process.env, { SIMULATE: 'false', TRIAL_COOLDOWN_MS: '0', WP_BASE_URL: `http://127.0.0.1:${wpSrv.address().port}`, OPENROUTER_BASE_URL: `http://127.0.0.1:${orSrv.address().port}` });
    // état propre
    store.saveArticles([]);
    const st = store.getSettings(); st.topics = []; st.frequency = 2; st.autoDraft = true; delete st.simulate; st.aiModel = 'anthropic/claude-haiku-5-5'; st.systemPrompt = ''; store.saveSettings(st);
    await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123' });
    await call('PUT', '/api/secrets', { openrouterKey: 'cle-test-or-0000', wpUser: 'laurent', wpAppPassword: 'abcd efgh' });
    for (const [keyword, city] of [['alarme sans abonnement', 'Chatou'], ['alarme Ajax maison', 'Yvelines'], ['installation alarme', '']]) await call('POST', '/api/topics', { keyword, city });

    // 1. le plan annonce les bons sujets, dans l'ordre, limités à la fréquence
    let plan = (await call('GET', '/api/articles/plan')).json;
    assert.deepStrictEqual([plan.remaining, plan.totalTopics, plan.next.map((t) => t.keyword)], [2, 3, ['alarme sans abonnement', 'alarme Ajax maison']]);

    // 2. un article de démonstration existant ne bloque pas le lot réel
    store.saveArticles([{ id: 'demo-1', topicId: 'x', keyword: 'demo', city: '', month: plan.month, status: 'a_relire', simulated: true, title: 'Démo', htmlContent: '<p>x</p>', metaTitle: '', metaDescription: '', slug: 'demo', faitsAVerifier: [], internalLinkSuggestions: [], warnings: [], wordCount: 1, createdAt: new Date().toISOString() }]);
    plan = (await call('GET', '/api/articles/plan')).json;
    assert.strictEqual(plan.remaining, 2);

    // 3. lot réel : les sujets (mot-clé ET ville) sont bien envoyés à l'IA, avec le modèle choisi
    assert.strictEqual((await call('POST', '/api/articles/batch')).status, 202);
    await waitBatch();
    assert.strictEqual(orReqs.length, 2);
    assert.ok(orReqs[0].messages[1].content.includes('Mot-clé principal : alarme sans abonnement') && orReqs[0].messages[1].content.includes('Ville ciblée : Chatou'));
    assert.ok(orReqs[1].messages[1].content.includes('Mot-clé principal : alarme Ajax maison') && orReqs[1].messages[1].content.includes('Ville ciblée : Yvelines'));
    assert.ok(orReqs.every((r) => r.model === 'anthropic/claude-haiku-5-5'));
    let list = (await call('GET', '/api/articles')).json;
    const real = list.filter((a) => !a.simulated);
    assert.deepStrictEqual(real.map((a) => a.status), ['brouillon_wp', 'brouillon_wp']);
    assert.ok(real.every((a) => fake.wpPosts.get(a.wpId).status === 'draft'), 'brouillons réellement créés dans le faux WordPress');
    plan = (await call('GET', '/api/articles/plan')).json;
    assert.deepStrictEqual([plan.remaining, plan.next.length], [0, 0]);
    assert.strictEqual((await call('POST', '/api/articles/batch')).status, 409);

    // 4. essai : rien n'est envoyé à WordPress, le quota n'est pas touché, le prompt est visible
    const postsBefore = fake.wpPosts.size;
    const trial = await call('POST', '/api/articles/test', { keyword: 'serrure connectée', city: 'Sartrouville' });
    assert.strictEqual(trial.status, 200);
    assert.ok(trial.json.sent.user.includes('Mot-clé principal : serrure connectée') && trial.json.sent.user.includes('Ville ciblée : Sartrouville'));
    assert.ok(trial.json.sent.system.includes('N\'invente aucun chiffre') && trial.json.sent.system.includes('FORMAT DE REPONSE'));
    assert.strictEqual(trial.json.sent.model, 'anthropic/claude-haiku-5-5');
    assert.strictEqual(fake.wpPosts.size, postsBefore);
    assert.strictEqual((await call('GET', '/api/articles')).json.length, list.length);
    assert.strictEqual((await call('POST', '/api/articles/test', {})).status, 400);
    assert.strictEqual((await call('POST', '/api/articles/test', { topicId: 'inconnu' })).status, 404);
    const topicTrial = await call('POST', '/api/articles/test', { topicId: (await call('GET', '/api/settings')).json.topics[2].id });
    assert.ok(topicTrial.json.sent.user.includes('Mot-clé principal : installation alarme') && !topicTrial.json.sent.user.includes('Ville ciblée'));
    // garder l'essai : il devient un article normal (et part en brouillon), une seule fois
    const kept = await call('POST', '/api/articles/test/keep', { trialId: topicTrial.json.trialId });
    assert.strictEqual(kept.json.article.status, 'brouillon_wp');
    assert.strictEqual((await call('POST', '/api/articles/test/keep', { trialId: topicTrial.json.trialId })).status, 404);
    // longueur : un article hors de 600 à 900 mots n'est PAS envoyé automatiquement, et l'envoi manuel exige une confirmation
    const shortTrial = await call('POST', '/api/articles/test', { keyword: 'article court' });
    assert.ok(shortTrial.json.check.words < 600 && shortTrial.json.check.inRange === false);
    assert.ok(shortTrial.json.check.issues.some((i) => i.code === 'length'));
    const postsBeforeShort = fake.wpPosts.size;
    const shortKept = await call('POST', '/api/articles/test/keep', { trialId: shortTrial.json.trialId });
    assert.deepStrictEqual([shortKept.json.article.status, shortKept.json.autoDraftSkipped, fake.wpPosts.size], ['a_relire', 'length', postsBeforeShort]);
    const sendNo = await call('POST', `/api/articles/${shortKept.json.article.id}/send`);
    assert.deepStrictEqual([sendNo.status, sendNo.json.code, fake.wpPosts.size], [409, 'out_of_range', postsBeforeShort]);
    assert.strictEqual((await call('POST', `/api/articles/${shortKept.json.article.id}/send`, { confirmOutOfRange: true })).status, 200);
    assert.strictEqual(fake.wpPosts.size, postsBeforeShort + 1);
    await call('DELETE', `/api/articles/${shortKept.json.article.id}`);

    // limites : cadence et plafond journalier
    process.env.TRIAL_COOLDOWN_MS = '60000';
    assert.strictEqual((await call('POST', '/api/articles/test', { keyword: 'x' })).status, 429);
    process.env.TRIAL_COOLDOWN_MS = '0'; process.env.TRIALS_PER_DAY = '1';
    assert.strictEqual((await call('POST', '/api/articles/test', { keyword: 'x' })).status, 429);
    delete process.env.TRIALS_PER_DAY;

    // 5. publication réelle : refusée tant que le marqueur reste dans WordPress, puis vraie publication
    list = (await call('GET', '/api/articles')).json;
    const target = list.find((a) => !a.simulated && a.status === 'brouillon_wp');
    assert.strictEqual((await call('POST', `/api/articles/${target.id}/publish`, { validated: true })).status, 409);
    assert.strictEqual(fake.wpPosts.get(target.wpId).status, 'draft');
    fake.wpPosts.get(target.wpId).content = '<p>Texte corrigé avec une vraie source.</p>';
    assert.strictEqual((await call('POST', `/api/articles/${target.id}/publish`, {})).status, 400);
    const pub = await call('POST', `/api/articles/${target.id}/publish`, { validated: true });
    assert.strictEqual(pub.status, 200);
    assert.strictEqual(fake.wpPosts.get(target.wpId).status, 'publish', 'publié pour de vrai dans WordPress');

    // 6. garde-fous : un article de démonstration ne touche jamais WordPress en mode réel
    assert.strictEqual((await call('POST', '/api/articles/demo-1/send')).status, 409);
    const wpCallsBefore = fake.wpPosts.size;
    assert.strictEqual((await call('DELETE', '/api/articles/demo-1')).status, 200);
    assert.strictEqual(fake.wpPosts.size, wpCallsBefore);
    store.saveArticles([...store.getArticles(), { id: 'demo-2', topicId: null, keyword: 'd', city: '', month: plan.month, status: 'brouillon_wp', wpId: 900001, simulated: true, title: 'd', htmlContent: '<p>x</p>', metaTitle: '', metaDescription: '', slug: 'd', faitsAVerifier: [], internalLinkSuggestions: [], warnings: [], wordCount: 1, createdAt: new Date().toISOString() }]);
    assert.strictEqual((await call('POST', '/api/articles/demo-2/publish', { validated: true })).status, 409);
    assert.strictEqual((await call('POST', '/api/articles/purge-demo')).json.removed, 1);

    // 7. en mode démonstration, un VRAI brouillon ne peut être ni publié ni supprimé pour de faux
    const draftReal = list.find((a) => !a.simulated && a.status === 'brouillon_wp' && a.id !== target.id);
    await call('PUT', '/api/settings', { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', simulate: true });
    assert.strictEqual((await call('GET', '/api/status')).json.simulate, true);
    assert.strictEqual((await call('POST', `/api/articles/${draftReal.id}/publish`, { validated: true })).status, 409);
    assert.strictEqual((await call('DELETE', `/api/articles/${draftReal.id}`)).status, 409);
    assert.strictEqual(fake.wpPosts.get(draftReal.wpId).status, 'draft', 'rien n\'a été publié par erreur');
    // en démonstration, l'essai est marqué comme tel, et « garder » refuse si le mode change entre-temps
    const demoTrial = await call('POST', '/api/articles/test', { keyword: 'essai démo' });
    assert.strictEqual(demoTrial.json.simulated, true);
    await call('PUT', '/api/settings', { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', simulate: false });
    assert.strictEqual((await call('POST', '/api/articles/test/keep', { trialId: demoTrial.json.trialId })).status, 409);
  } finally {
    for (const k of ['openrouterKey', 'wpAppPassword', 'pagespeedKey']) secrets.set(k, '');
    const st = store.getSettings(); delete st.simulate; st.wpUser = ''; st.aiModel = ''; st.topics = []; store.saveSettings(st);
    Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; delete process.env.TRIAL_COOLDOWN_MS; delete process.env.TRIALS_PER_DAY;
    app.close(); wpSrv.close(); orSrv.close();
  }
});

test('score : critère « entreprise locale » explicite, progression et export CSV', async () => {
  const store = require('../lib/store');
  const { computeScore } = require('../lib/scoring');
  // le constat dit ce qui a réellement été trouvé et précise que ce n'est pas la fiche Google Business Profile
  const home = { url: 'https://x.test/', isHome: true, title: 'a'.repeat(40), metaDescription: 'm'.repeat(130), h1Count: 1, images: { total: 0, withAlt: 0 }, jsonLdTypes: ['Organization', 'WebSite'], words: 500 };
  const c = computeScore({ pages: [home], sitemapUrls: ['https://x.test/'], sitemapCount: 0, orphans: [], links: { checked: 1, broken: [] }, robotsHasSitemap: true, speed: null }).criteria.find((x) => x.id === 'localbusiness');
  assert.strictEqual(c.points, 0);
  assert.ok(c.measured.includes('Organization, WebSite') && c.explanation.includes('pas votre fiche Google Business Profile'));

  const s = await listen(server);
  const base = `http://127.0.0.1:${s.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return res;
  };
  const savedAudits = store.getAudits();
  try {
    const mk = (date, score, pts) => ({ id: date, date, trigger: 'manuel', pagesCount: 24, score, points: score, maxCounted: 90, improvements: [], criteria: [{ id: 'title', points: pts, max: 10 }, { id: 'speed', points: null, max: 10, notMeasured: true }] });
    store.saveAudits([mk('2026-11-10T08:00:00Z', 60, 5), mk('2026-11-17T08:00:00Z', 68, 7.5)]);
    await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123' });
    const d = await (await call('GET', '/api/audits')).json();
    assert.strictEqual(d.latest.score, 68);
    assert.deepStrictEqual([d.previous.score, d.previous.criteria[0].points], [60, 5]); // de quoi afficher la progression
    const csv = await (await call('GET', '/api/audits/export.csv')).text();
    const lines = csv.replace('\ufeff', '').trim().split('\n');
    assert.strictEqual(lines[0], 'date;score_sur_100;lancement;pages_analysees;title;speed');
    assert.strictEqual(lines[2], '2026-11-17T08:00:00Z;68;manuel;24;7.5;non_mesure');
  } finally { store.saveAudits(savedAudits); s.close(); }
});
