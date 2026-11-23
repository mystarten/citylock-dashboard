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
    assert.ok(defs.systemPrompt.includes('N\'invente JAMAIS') && defs.maxLength === 6000);
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
    assert.ok(req.j.messages[0].content.includes('N\'invente JAMAIS'));               // consignes d'origine

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
