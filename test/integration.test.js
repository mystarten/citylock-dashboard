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
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK' })).status, 200);

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

    // Aucun secret dans le front
    for (const f of ['index.html', 'app.js']) {
      const txt = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
      assert.ok(!/OPENROUTER|WP_APP_PASSWORD|sk-or-/.test(txt));
    }
  } finally { s.close(); }
});
