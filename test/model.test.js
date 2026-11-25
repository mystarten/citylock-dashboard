const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-model-'));
process.env.DASHBOARD_USER = 'laurent-test';
process.env.DASHBOARD_PASSWORD = 'mdp-de-test-123';
process.env.SESSION_SECRET = 'secret-de-test-0123456789abcdef';
process.env.SIMULATE = 'true';
process.env.TRIAL_COOLDOWN_MS = '0';

const { listen, client, bodyWords } = require('./helpers');
const store = require('../lib/store');
const secrets = require('../lib/secrets');
const ai = require('../lib/ai');
const server = require('../server');

// Faux OpenRouter : le comportement dépend du nom du modèle demandé.
function fakeOpenRouter(seen) {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); seen.push(j);
      const code = { 'inconnu/modele': 404, 'cle/refusee': 401, 'credit/epuise': 402, 'trop/de-demandes': 429 }[j.model];
      if (code) { res.statusCode = code; return res.end('{}'); }
      res.setHeader('Content-Type', 'application/json');
      const art = { title: 'Titre', metaTitle: 'M', metaDescription: 'D', slug: 't', htmlContent: bodyWords(650), internalLinkSuggestions: [], faitsAVerifier: [] };
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: j.max_tokens === 8 ? 'OK' : JSON.stringify(art) } }] }));
    });
  });
}

test('changement de modèle : testé avant activation, modèle actuel conservé en cas d\'échec', async () => {
  const seen = [];
  const or = fakeOpenRouter(seen);
  await new Promise((r) => or.listen(0, '127.0.0.1', r));
  const app = await listen(server);
  const call = await client(app);
  const saved = { ...process.env };
  const activeInSettings = () => { const s = store.getSettings(); return [s.aiModel, s.aiModelPrevious]; };
  const wait = () => new Promise((r) => setTimeout(r, 2100)); // pause anti-spam de 2 secondes entre deux tests
  try {
    Object.assign(process.env, { SIMULATE: 'false', OPENROUTER_BASE_URL: `http://127.0.0.1:${or.address().port}`, OPENROUTER_MODEL: 'env/modele' });
    secrets.set('openrouterKey', 'cle-test-or-0000');
    const st = store.getSettings(); st.aiModel = 'ancien/modele'; st.aiModelPrevious = ''; store.saveSettings(st);

    // 1. un modèle inconnu : message clair, l'ancien reste actif
    const bad = (await call('POST', '/api/ai/model', { model: 'inconnu/modele' })).json;
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.message, 'Ce modèle n\'a pas répondu : l\'identifiant du modèle est inconnu ou ce modèle n\'est plus disponible. Le modèle actuel est conservé : ancien/modele.');
    assert.deepStrictEqual(activeInSettings(), ['ancien/modele', '']);
    assert.strictEqual((await call('GET', '/api/ai/defaults')).json.activeModel, 'ancien/modele');
    // ...et la rédaction continue avec l'ancien modèle
    seen.length = 0;
    await ai.generateArticle({ keyword: 'alarme' }, store.getSettings(), []);
    assert.strictEqual(seen[0].model, 'ancien/modele');

    // 2. clé refusée, puis crédit épuisé : raisons simples, rien n'est activé
    await wait();
    const r401 = (await call('POST', '/api/ai/model', { model: 'cle/refusee' })).json;
    assert.deepStrictEqual([r401.ok, r401.reason], [false, 'la clé OpenRouter est refusée']);
    await wait();
    const r402 = (await call('POST', '/api/ai/model', { model: 'credit/epuise' })).json;
    assert.deepStrictEqual([r402.ok, r402.reason], [false, 'le crédit OpenRouter est épuisé']);
    assert.deepStrictEqual(activeInSettings(), ['ancien/modele', '']);

    // 3. un modèle qui répond : activé, l'ancien est gardé comme « précédent »
    await wait();
    const good = (await call('POST', '/api/ai/model', { model: '  nouveau/modele  ' })).json;
    assert.deepStrictEqual([good.ok, good.message, good.active], [true, 'Modèle activé : nouveau/modele', 'nouveau/modele']);
    assert.deepStrictEqual(activeInSettings(), ['nouveau/modele', 'ancien/modele']);
    seen.length = 0;
    await ai.generateArticle({ keyword: 'alarme' }, store.getSettings(), []);
    assert.strictEqual(seen[0].model, 'nouveau/modele');
    const defs = (await call('GET', '/api/ai/defaults')).json;
    assert.deepStrictEqual([defs.activeModel, defs.previousModel], ['nouveau/modele', 'ancien/modele']);

    // 4. revenir au modèle précédent passe aussi par le test
    await wait();
    assert.strictEqual((await call('POST', '/api/ai/model', { model: 'ancien/modele' })).json.ok, true);
    assert.deepStrictEqual(activeInSettings(), ['ancien/modele', 'nouveau/modele']);

    // 5. vide = modèle du serveur (OPENROUTER_MODEL), testé lui aussi ; sans modèle du serveur : refusé
    await wait();
    const toEnv = (await call('POST', '/api/ai/model', { model: '' })).json;
    assert.deepStrictEqual([toEnv.ok, toEnv.active, store.getSettings().aiModel], [true, 'env/modele', '']);
    delete process.env.OPENROUTER_MODEL;
    await wait();
    const none = (await call('POST', '/api/ai/model', { model: '' })).json;
    assert.deepStrictEqual([none.ok, none.reason], [false, 'aucun identifiant de modèle n\'est indiqué']);
    process.env.OPENROUTER_MODEL = 'env/modele';

    // 6. format invalide : refusé avant tout appel ; la sauvegarde des réglages ne peut pas contourner le test
    assert.strictEqual((await call('POST', '/api/ai/model', { model: 'modele avec espace' })).status, 400);
    assert.strictEqual((await call('POST', '/api/ai/model', { model: 42 })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { frequency: 2, zone: 'Z', brandName: 'B', aiModel: 'pirate/non-teste' })).json.aiModel, '');

    // 7. mode démonstration : aucun appel, rien n'est changé
    const callsBefore = seen.length;
    await call('PUT', '/api/settings', { frequency: 2, zone: 'Z', brandName: 'B', simulate: true });
    const demo = (await call('POST', '/api/ai/model', { model: 'autre/modele' })).json;
    assert.deepStrictEqual([demo.ok, demo.simulated, seen.length], [false, true, callsBefore]);
    assert.ok(demo.message.includes('Mode démonstration'));
    assert.strictEqual(store.getSettings().aiModel, '');
  } finally {
    secrets.set('openrouterKey', ''); const st = store.getSettings(); delete st.simulate; st.aiModel = ''; store.saveSettings(st);
    Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; app.close(); or.close();
  }
});

test('chaque article généré porte le nom du modèle qui l\'a rédigé', async () => {
  const seen = [];
  const or = fakeOpenRouter(seen);
  await new Promise((r) => or.listen(0, '127.0.0.1', r));
  const app = await listen(server);
  const call = await client(app);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SIMULATE: 'false', WRITE_COOLDOWN_MS: '0', OPENROUTER_BASE_URL: `http://127.0.0.1:${or.address().port}`, OPENROUTER_MODEL: 'env/modele' });
    secrets.set('openrouterKey', 'cle-test-or-0000');
    store.saveArticles([]);
    const st = store.getSettings(); st.aiModel = 'anthropic/claude-haiku-5-5'; store.saveSettings(st);
    const t = await call('POST', '/api/write/one', { keyword: 'serrure' });
    assert.strictEqual(t.json.article.modelUsed, 'anthropic/claude-haiku-5-5');
    const kept = t.json.article;
    assert.strictEqual((await call('GET', `/api/articles/${kept.id}`)).json.modelUsed, 'anthropic/claude-haiku-5-5');
    // le modèle change : l'ancien article garde SON modèle, le nouveau porte le nouveau
    const s2 = store.getSettings(); s2.aiModel = ''; store.saveSettings(s2);
    const t2 = await call('POST', '/api/write/one', { keyword: 'serrure 2' });
    assert.strictEqual(t2.json.article.modelUsed, 'env/modele');
    assert.strictEqual((await call('GET', `/api/articles/${kept.id}`)).json.modelUsed, 'anthropic/claude-haiku-5-5');
    // en démonstration : marqué comme tel
    await call('PUT', '/api/settings', { simulate: true });
    assert.strictEqual((await call('POST', '/api/write/one', { keyword: 'démo' })).json.article.modelUsed, 'démonstration');
  } finally {
    secrets.set('openrouterKey', ''); const st = store.getSettings(); delete st.simulate; st.aiModel = ''; store.saveSettings(st);
    Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; delete process.env.WRITE_COOLDOWN_MS; app.close(); or.close();
  }
});
