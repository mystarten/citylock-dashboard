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

test('API : auth, validation, un article, planning, programmation, publication, suppression (mode démonstration)', async () => {
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
  const saved = { ...process.env };
  try {
    process.env.WRITE_COOLDOWN_MS = '0';
    assert.strictEqual((await call('GET', '/api/settings')).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'laurent-test', password: 'faux' })).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'autre', password: 'mdp-de-test-123' })).status, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123' }, { 'X-Requested-With': 'x' })).status, 403); // CSRF
    assert.strictEqual((await call('POST', '/api/login', { username: 'laurent-test', password: 'mdp-de-test-123', remember: true })).status, 200);

    // réglages : le prompt est obligatoire et vient d'ici ; longueurs cohérentes
    const set0 = (await call('GET', '/api/settings')).json;
    assert.ok(set0.systemPrompt.includes('FORMAT DE RÉPONSE') && set0.systemPrompt.includes('entre 600 et 900 mots'), 'le prompt d\'origine est enregistré dans les réglages au premier lancement');
    assert.deepStrictEqual([set0.minWords, set0.maxWords, set0.promptProblems], [600, 900, []]);
    assert.strictEqual((await call('PUT', '/api/settings', { zone: '' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { systemPrompt: 'court' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { systemPrompt: '' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { systemPrompt: 'x'.repeat(6001) })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { minWords: 900, maxWords: 600 })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { minWords: 'x' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { simulate: 'oui' })).status, 400);
    const mine = 'Consigne personnalisée sans le format. '.repeat(5);
    const putMine = await call('PUT', '/api/settings', { systemPrompt: mine });
    assert.strictEqual(putMine.status, 200);
    assert.strictEqual(putMine.json.systemPrompt, mine.trim());
    assert.strictEqual(putMine.json.promptProblems.length, 3, 'avertissement : pas de JSON, ni title ni htmlContent');
    const defs = (await call('GET', '/api/ai/defaults')).json;
    assert.ok(defs.systemPrompt.includes('N\'invente aucun chiffre') && defs.maxLength === 6000);
    assert.strictEqual((await call('PUT', '/api/settings', { systemPrompt: defs.systemPrompt })).json.systemPrompt, defs.systemPrompt); // « rétablir »
    // le modèle ne peut PAS être changé par la sauvegarde des réglages
    assert.strictEqual((await call('PUT', '/api/settings', { aiModel: 'pirate/modele-non-teste' })).json.aiModel, '');
    assert.strictEqual((await call('GET', '/api/settings')).json.zone, 'Chatou, Yvelines'); // les champs absents ne sont pas écrasés

    assert.strictEqual((await call('POST', '/api/topics', { keyword: '  ' })).status, 400);
    for (const kw of ['alarme sans abonnement', 'alarme Ajax', 'installation alarme']) assert.strictEqual((await call('POST', '/api/topics', { keyword: kw, city: 'Chatou' })).status, 201);
    assert.strictEqual((await call('POST', '/api/topics', { keyword: 'alarme Ajax', city: 'Chatou' })).status, 409);

    // Mode « Un article »
    assert.strictEqual((await call('POST', '/api/write/one', {})).status, 400);
    assert.strictEqual((await call('POST', '/api/write/one', { topicId: 'inconnu' })).status, 404);
    const one = await call('POST', '/api/write/one', { keyword: 'alarme maison', city: 'Chatou' });
    assert.strictEqual(one.status, 200);
    const a = one.json.article;
    assert.deepStrictEqual([a.status, a.simulated, a.state.label], ['a_relire', true, 'À vérifier avant publication']);
    assert.ok(a.faitsAVerifier.length && a.htmlContent.includes('[SOURCE A VERIFIER]'));
    assert.ok(a.check.inRange && a.check.words >= 600, 'article de démonstration dans la plage');

    // Programmer : refusé tant que la date, la longueur et le marqueur ne sont pas réglés
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/schedule`, {})).status, 400);                               // pas de date
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/schedule`, { date: '2020-01-01' })).status, 400);           // passée
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/schedule`, { date: '2099-01-01' })).status, 400);           // trop lointaine
    const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/schedule`, { date: future })).status, 409);                 // marqueur de source
    const fixed = await call('PUT', `/api/articles/${a.id}`, { htmlContent: bodyWords(300), faitsAVerifier: [] });
    assert.strictEqual(fixed.status, 200);
    const short = await call('POST', `/api/articles/${a.id}/schedule`, { date: future });
    assert.deepStrictEqual([short.status, short.json.code], [409, 'out_of_range']);                                              // 300 mots
    await call('PUT', `/api/articles/${a.id}`, { htmlContent: bodyWords(700) });
    const sched = await call('POST', `/api/articles/${a.id}/schedule`, { date: future, time: '10:30' });
    assert.strictEqual(sched.status, 200);
    assert.strictEqual(sched.json.status, 'programme');
    assert.ok(sched.json.state.label.startsWith('Programmé le '));
    assert.ok(sched.json.scheduledAt && sched.json.wpId);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/send`)).status, 409);       // déjà sur le site
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/unschedule`)).json.status, 'brouillon_wp');
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/unschedule`)).status, 409);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/schedule`, { date: future })).status, 200);
    assert.strictEqual((await call('POST', `/api/articles/${a.id}/publish`, {})).status, 400);                                  // validation obligatoire
    const pub = await call('POST', `/api/articles/${a.id}/publish`, { validated: true });
    assert.deepStrictEqual([pub.status, pub.json.status, pub.json.publishedBy], [200, 'publie', 'manuel']);
    assert.strictEqual((await call('DELETE', `/api/articles/${a.id}`)).status, 409);                                            // publié : suppression refusée
    const journal = (await call('GET', '/api/publications')).json;
    assert.deepStrictEqual(journal.map((e) => e.kind).slice(0, 3), ['publication', 'programmation', 'annulation']);

    // Envoi simple en brouillon, date prévue, suppression
    const two = (await call('POST', '/api/write/one', { topicId: (await call('GET', '/api/settings')).json.topics[0].id })).json.article;
    assert.strictEqual((await call('POST', `/api/articles/${two.id}/send`)).json.status, 'brouillon_wp');
    assert.strictEqual((await call('PUT', `/api/articles/${two.id}/planned`, { plannedDate: 'pas une date' })).status, 400);
    assert.strictEqual((await call('PUT', `/api/articles/${two.id}/planned`, { plannedDate: future })).json.plannedDate, future);
    assert.strictEqual((await call('DELETE', `/api/articles/${two.id}`)).status, 200);

    // Ce qui part à l'IA est visible
    const prev = await call('POST', '/api/write/preview', { keyword: 'serrure', city: 'Sartrouville' });
    assert.ok(prev.json.sent.user.includes('Mot-clé principal : serrure') && prev.json.sent.system.includes('N\'invente aucun chiffre'));

    // Mode « Plusieurs articles » : validation du planning
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual((await call('POST', '/api/write/plan', { months: 7, perMonth: 2, startDate: future })).status, 400);
    assert.strictEqual((await call('POST', '/api/write/plan', { months: 2, perMonth: 4, startDate: future })).status, 400);
    assert.strictEqual((await call('POST', '/api/write/plan', { months: 2, perMonth: 2, startDate: '2020-01-01' })).status, 400);
    assert.strictEqual((await call('POST', '/api/write/plan', { months: 2, perMonth: 2 })).status, 400);
    const plan = await call('POST', '/api/write/plan', { months: 2, perMonth: 2, startDate: future });
    assert.strictEqual(plan.status, 200);
    assert.strictEqual(plan.json.items.length, 4);
    assert.strictEqual(plan.json.missing, 1, '3 sujets pour 4 articles : une ligne à compléter à la main');
    assert.strictEqual((await call('POST', '/api/write/batch', { items: plan.json.items })).status, 400); // ligne sans mot-clé
    plan.json.items[3].keyword = 'serrure connectée';
    assert.ok(plan.json.items.every((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.plannedDate)));
    assert.deepStrictEqual(plan.json.items.map((i) => i.plannedDate), [...plan.json.items.map((i) => i.plannedDate)].sort());
    assert.ok(today <= plan.json.items[0].plannedDate);

    // Rédaction du planning en arrière-plan : des brouillons datés, rien sur le site
    assert.strictEqual((await call('POST', '/api/write/batch', { items: [] })).status, 400);
    assert.strictEqual((await call('POST', '/api/write/batch', { items: [{ keyword: 'x', plannedDate: '2020-01-01' }] })).status, 400);
    assert.strictEqual((await call('POST', '/api/write/batch', { items: plan.json.items })).status, 202);
    for (let i = 0; i < 50; i++) { if (!(await call('GET', '/api/write/status')).json.running) break; await new Promise((r) => setTimeout(r, 100)); }
    const st = (await call('GET', '/api/write/status')).json;
    assert.deepStrictEqual([st.total, st.done, st.errors.length], [4, 4, 0]);
    assert.strictEqual(st.notes.length, 0);
    const list = (await call('GET', '/api/articles')).json;
    assert.strictEqual(list.filter((x) => x.plannedDate).length, 4);
    assert.ok(list.every((x) => x.status !== 'programme'));

    // « Programmer tout » : ceux qui ont un souci sont laissés de côté, avec la raison
    const all = (await call('POST', '/api/articles/schedule-all', {})).json;
    assert.deepStrictEqual([all.scheduled.length, all.skipped.length], [0, 4]);
    assert.ok(all.skipped[0].reasons.some((r) => /marqueur/.test(r)), 'marqueur de source : jamais programmé automatiquement');
    // on corrige deux articles, puis on programme
    for (const x of list.slice(0, 2)) await call('PUT', `/api/articles/${x.id}`, { htmlContent: bodyWords(700), faitsAVerifier: [] });
    const all2 = (await call('POST', '/api/articles/schedule-all', {})).json;
    assert.deepStrictEqual([all2.scheduled.length, all2.skipped.length], [2, 2]);
    assert.ok((await call('GET', '/api/articles')).json.filter((x) => x.status === 'programme').length === 2);

    // Limite journalière
    process.env.WRITES_PER_DAY = '1';
    assert.strictEqual((await call('POST', '/api/write/one', { keyword: 'x' })).status, 429);
    delete process.env.WRITES_PER_DAY;

    assert.strictEqual((await call('GET', '/api/wp/test')).json.ok, true);
    // Aucun secret dans le front
    for (const f of ['index.html', 'app.js']) {
      const txt = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
      assert.ok(!/OPENROUTER_API_KEY|WP_APP_PASSWORD|sk-or-v1-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}/.test(txt), 'variable ou clé en clair dans ' + f);
    }
  } finally { Object.assign(process.env, saved); delete process.env.WRITE_COOLDOWN_MS; s.close(); }
});

test('OpenRouter : le modèle et le prompt des réglages sont utilisés tels quels (faux serveur local)', async () => {
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
    const prompt = 'MES CONSIGNES A MOI. Réponds en JSON avec title et htmlContent. '.repeat(3);

    await ai.generateArticle(topic, { brandName: 'CITYLOCK', zone: 'Chatou', aiModel: 'anthropic/claude-haiku-5-5', systemPrompt: prompt });
    const req = seen.pop();
    assert.strictEqual(req.j.model, 'anthropic/claude-haiku-5-5');                    // modèle des réglages
    assert.strictEqual(req.j.messages[0].content, prompt.trim());                     // le prompt des réglages, rien d'ajouté ni de retiré
    assert.strictEqual(req.auth, 'Bearer sk-or-test-1234567890');

    await ai.generateArticle(topic, { brandName: 'CITYLOCK', zone: 'Chatou', aiModel: '', systemPrompt: prompt });
    assert.strictEqual(seen.pop().j.model, 'env/modele');                             // repli sur la variable du serveur

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
test('mode réel : sujets pris en compte, planning rédigé, programmation sur WordPress, garde-fous démonstration/réel', async () => {
  const { setupReal } = require('./helpers');
  const r = await setupReal(server);
  const { call, fake, store, orState } = r;
  process.env.WRITE_COOLDOWN_MS = '0';
  try {
    store.saveSettings({ ...store.getSettings(), topics: [
      { id: 't1', keyword: 'alarme sans abonnement', city: 'Chatou' },
      { id: 't2', keyword: 'alarme Ajax maison', city: 'Yvelines' },
      { id: 't3', keyword: 'installation alarme', city: '' },
    ] });
    const future = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

    // 1. un article : le sujet ET la ville partent à l'IA, avec le modèle et le prompt des réglages
    const one = await call('POST', '/api/write/one', { topicId: 't1' });
    assert.strictEqual(one.status, 200);
    const req0 = orState.requests[0];
    assert.ok(req0.messages[1].content.includes('Mot-clé principal : alarme sans abonnement') && req0.messages[1].content.includes('Ville ciblée : Chatou'));
    assert.strictEqual(req0.model, 'test/modele');
    assert.strictEqual(req0.messages[0].content, store.getSettings().systemPrompt.trim());
    assert.ok(one.json.article.check.inRange && one.json.article.check.words === 650);
    assert.strictEqual(fake.wpPosts.size, 0, 'rien sur le site tant que vous ne l\'avez pas décidé');

    // 2. planning de 2 mois, 2 articles par mois : les sujets tournent, les dates sont celles proposées
    const plan = await call('POST', '/api/write/plan', { months: 2, perMonth: 2, startDate: future(3) });
    assert.deepStrictEqual(plan.json.items.slice(0, 3).map((i) => i.keyword), ['alarme sans abonnement', 'alarme Ajax maison', 'installation alarme']);
    assert.strictEqual(plan.json.missing, 1);
    const chosen = plan.json.items.map((it, i) => (i === 1 ? { ...it, plannedDate: future(40) } : i === 3 ? { ...it, keyword: 'serrure connectée' } : it)); // l'utilisateur change une date et complète la dernière ligne
    assert.strictEqual((await call('POST', '/api/write/batch', { items: chosen })).status, 202);
    for (let i = 0; i < 80; i++) { if (!(await call('GET', '/api/write/status')).json.running) break; await new Promise((x) => setTimeout(x, 50)); }
    assert.strictEqual(orState.calls, 5); // 1 article + 4 du planning
    let list = (await call('GET', '/api/articles')).json;
    assert.strictEqual(list.length, 5);
    assert.ok(list.filter((a) => a.plannedDate).some((a) => a.plannedDate === future(40)), 'la date choisie est conservée');
    assert.strictEqual(fake.wpPosts.size, 0, 'la rédaction du planning n\'envoie RIEN sur le site');

    // 3. programmer tout : sur le faux WordPress, statut « future » à la date choisie (heure de Paris -> UTC)
    const all = (await call('POST', '/api/articles/schedule-all', {})).json;
    assert.deepStrictEqual([all.scheduled.length, all.skipped.length], [4, 0]);
    const posts = [...fake.wpPosts.values()];
    assert.ok(posts.length === 4 && posts.every((p) => p.status === 'future' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(p.date_gmt)));
    const sched = (await call('GET', '/api/articles')).json.filter((a) => a.status === 'programme');
    assert.strictEqual(sched.length, 4);
    for (const a of sched) assert.ok(new Date(a.scheduledAt).getUTCHours() >= 7 && new Date(a.scheduledAt).getUTCHours() <= 8, 'publication à 9 h, heure de Paris');

    // 4. WordPress publie tout seul : le tableau de bord s'en aperçoit (sans rien publier lui-même)
    const target = sched[0];
    fake.wpPosts.get(target.wpId).status = 'publish';
    process.env.SYNC_MIN_INTERVAL_MS = '0';
    store.saveArticle({ ...store.getArticles().find((a) => a.id === target.id), scheduledAt: new Date(Date.now() - 3600000).toISOString() });
    list = (await call('GET', '/api/articles')).json;
    assert.deepStrictEqual([list.find((a) => a.id === target.id).status, list.find((a) => a.id === target.id).publishedBy], ['publie', 'programmation']);
    delete process.env.SYNC_MIN_INTERVAL_MS;

    // 5. annuler une programmation : l'article redevient brouillon sur le site
    const other = sched[1];
    assert.strictEqual((await call('POST', `/api/articles/${other.id}/unschedule`)).json.status, 'brouillon_wp');
    assert.strictEqual(fake.wpPosts.get(other.wpId).status, 'draft');

    // 6. publier un article programmé : la date future est ramenée à maintenant
    const third = sched[2];
    const pub = await call('POST', `/api/articles/${third.id}/publish`, { validated: true });
    assert.strictEqual(pub.status, 200);
    const p3 = fake.wpPosts.get(third.wpId);
    assert.strictEqual(p3.status, 'publish');
    assert.ok(Math.abs(new Date(p3.date_gmt + 'Z').getTime() - Date.now()) < 60000, 'date remise à maintenant');

    // 7. article trop court : ni envoi, ni programmation sans confirmation ; pas d'envoi automatique
    const shortOne = await call('POST', '/api/write/one', { keyword: 'article court' });
    assert.ok(shortOne.json.article.check.words < 600 && shortOne.json.article.check.issues.some((i) => i.code === 'length'));
    const before = fake.wpPosts.size;
    assert.deepStrictEqual([(await call('POST', `/api/articles/${shortOne.json.article.id}/send`)).json.code, fake.wpPosts.size], ['out_of_range', before]);
    assert.strictEqual((await call('POST', `/api/articles/${shortOne.json.article.id}/schedule`, { date: future(5) })).json.code, 'out_of_range');
    assert.strictEqual((await call('POST', `/api/articles/${shortOne.json.article.id}/send`, { confirmOutOfRange: true })).status, 200);

    // 8. marqueur de source : refusé même après envoi si le texte du site le contient
    const markerArt = r.add(r.make({ htmlContent: bodyWords(650) + '<p>Selon [SOURCE A VERIFIER] des cambriolages.</p>' }));
    assert.strictEqual((await call('POST', `/api/articles/${markerArt.id}/schedule`, { date: future(5) })).json.code, 'marker');
    assert.strictEqual((await call('PUT', `/api/articles/${markerArt.id}`, { htmlContent: bodyWords(650) })).status, 200);
    assert.strictEqual((await call('POST', `/api/articles/${markerArt.id}/schedule`, { date: future(5) })).status, 200);

    // 9. garde-fous : un article de démonstration ne touche jamais WordPress en mode réel
    const demo = r.add(r.make({ simulated: true }));
    assert.strictEqual((await call('POST', `/api/articles/${demo.id}/send`)).status, 409);
    const wpBefore = fake.wpPosts.size;
    assert.strictEqual((await call('DELETE', `/api/articles/${demo.id}`)).status, 200);
    assert.strictEqual(fake.wpPosts.size, wpBefore);
    assert.strictEqual((await call('POST', '/api/articles/purge-demo')).json.removed, 0);

    // 10. en mode démonstration, un VRAI article de WordPress ne peut être ni publié ni supprimé pour de faux
    const draftReal = (await call('GET', '/api/articles')).json.find((a) => a.id === other.id);
    await call('PUT', '/api/settings', { simulate: true });
    assert.strictEqual((await call('POST', `/api/articles/${draftReal.id}/publish`, { validated: true })).status, 409);
    assert.strictEqual((await call('DELETE', `/api/articles/${draftReal.id}`)).status, 409);
    assert.strictEqual(fake.wpPosts.get(draftReal.wpId).status, 'draft', 'rien n\'a été publié par erreur');
    await call('PUT', '/api/settings', { simulate: false });
  } finally { delete process.env.WRITE_COOLDOWN_MS; delete process.env.SYNC_MIN_INTERVAL_MS; r.stop(); }
});

test('Yoast : champs envoyés si le site les accepte, repli sans erreur sinon, état visible', async () => {
  const { setupReal } = require('./helpers');
  const r = await setupReal(server);
  const { call, fake, store } = r;
  try {
    wp._resetYoast();
    // extrait de code non installé : le brouillon part quand même, sans Yoast
    const a = r.add(r.make({ keyword: 'alarme sans fil', metaTitle: 'Titre SEO', metaDescription: 'Description SEO' }));
    assert.deepStrictEqual((await call('GET', '/api/wp/yoast')).json, { known: true, ok: false });
    const sent = await call('POST', `/api/articles/${a.id}/send`);
    assert.strictEqual(sent.status, 200);
    assert.strictEqual(sent.json.yoast, false);
    assert.strictEqual(fake.wpPosts.get(sent.json.wpId).meta, undefined);

    // extrait installé : mot-clé principal, titre SEO et description arrivent dans Yoast
    fake.state.yoast = true; wp._resetYoast();
    assert.deepStrictEqual((await call('GET', '/api/wp/yoast')).json, { known: true, ok: true });
    const b = r.add(r.make({ keyword: 'alarme sans fil', metaTitle: 'Titre SEO', metaDescription: 'Description SEO' }));
    const sentB = await call('POST', `/api/articles/${b.id}/send`);
    assert.strictEqual(sentB.json.yoast, true);
    assert.deepStrictEqual(fake.wpPosts.get(sentB.json.wpId).meta, { _yoast_wpseo_focuskw: 'alarme sans fil', _yoast_wpseo_title: 'Titre SEO', _yoast_wpseo_metadesc: 'Description SEO' });
    // une modification met aussi Yoast à jour
    await call('PUT', `/api/articles/${b.id}`, { metaDescription: 'Nouvelle description', keyword: 'alarme maison' });
    const m = fake.wpPosts.get(sentB.json.wpId).meta;
    assert.deepStrictEqual([m._yoast_wpseo_metadesc, m._yoast_wpseo_focuskw], ['Nouvelle description', 'alarme maison']);
    // et la programmation aussi
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    assert.strictEqual((await call('POST', `/api/articles/${b.id}/schedule`, { date: future })).json.yoast, true);
    // le site perd l'extrait de code : repli sans erreur
    fake.state.yoast = false; wp._resetYoast();
    const c = r.add(r.make());
    assert.strictEqual((await call('POST', `/api/articles/${c.id}/send`)).status, 200);
  } finally { r.stop(); }
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
