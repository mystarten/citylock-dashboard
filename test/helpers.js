// Outils partagés par les tests d'API : serveur sur un port libre, client avec connexion, texte de n mots.
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

// Client HTTP déjà connecté (cookie conservé). Retourne { status, json }.
async function client(server, { user = 'laurent-test', password = 'mdp-de-test-123' } = {}) {
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, extraHeaders = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* pas de corps */ }
    return { status: res.status, json };
  };
  await call('POST', '/api/login', { username: user, password });
  return call;
}

// Texte de n mots en paragraphes de 40 mots (aucun mot interdit).
const bodyWords = (n) => Array.from({ length: Math.ceil(n / 40) }, (_, i) => `<p>${Array.from({ length: Math.min(40, n - i * 40) }, (__, j) => `mot${i * 40 + j}`).join(' ')}</p>`).join('');

// Faux WordPress + faux OpenRouter + mode réel + connexion. À appeler APRÈS avoir défini les variables d'environnement du test.
// Le faux OpenRouter renvoie un article de 650 mots, ou de 3 mots si le sujet est « article court ».
async function setupReal(server) {
  const http = require('http');
  const { create } = require('./fake-site');
  const store = require('../lib/store');
  const secrets = require('../lib/secrets');
  const fake = create();
  const wpSrv = await listen(fake.app);
  const state = { calls: 0, requests: [] };
  const orSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); state.calls += 1; state.requests.push(j);
      const short = /Mot-clé principal : article court/.test((j.messages[1] || {}).content || '');
      const art = { title: `Titre généré ${state.calls}`, metaTitle: 'M', metaDescription: 'D', slug: `titre-${state.calls}`, htmlContent: short ? '<p>trois petits mots</p>' : bodyWords(650), internalLinkSuggestions: [], faitsAVerifier: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: j.max_tokens === 8 ? 'OK' : JSON.stringify(art) } }] }));
    });
  });
  await new Promise((r) => orSrv.listen(0, '127.0.0.1', r));
  const app = await listen(server);
  const call = await client(app);
  const saved = { ...process.env };
  delete process.env.WP_USER; delete process.env.WP_APP_PASSWORD;
  Object.assign(process.env, { SIMULATE: 'false', WP_BASE_URL: `http://127.0.0.1:${wpSrv.address().port}`, OPENROUTER_BASE_URL: `http://127.0.0.1:${orSrv.address().port}` });
  secrets.set('openrouterKey', 'cle-test-or-0000'); secrets.set('wpAppPassword', 'abcd efgh');
  const st = store.getSettings();
  Object.assign(st, { wpUser: 'laurent', aiModel: 'test/modele', autoDraft: false, topics: [], publishMode: 'brouillon', autoEpoch: '', publishPaused: false, autoPublishDelayDays: 3, autoPublishMaxPerWeek: 2, frequency: 8 });
  delete st.simulate;
  store.saveSettings(st);
  store.saveArticles([]); store.savePublications([]);
  const make = (extra = {}) => ({ id: 'art-' + Math.random().toString(36).slice(2), topicId: null, keyword: 'alarme maison', city: 'Chatou', month: '2026-11', createdAt: new Date().toISOString(), status: 'a_relire', wpId: null, wpLink: null, simulated: false,
    title: 'Titre initial', metaTitle: 'M', metaDescription: 'D', slug: 'titre-initial', htmlContent: bodyWords(650), internalLinkSuggestions: [], faitsAVerifier: [], warnings: [], wordCount: 650, versionAt: new Date().toISOString(), versionLabel: 'Texte généré', ...extra });
  const add = (a) => { store.saveArticles([...store.getArticles(), a]); return a; };
  // Un brouillon réellement présent sur le faux site (envoyé par l'API), puis ajusté pour le scénario.
  const siteDraft = async (extra = {}, { sentDaysAgo = 5, scheduled = true } = {}) => {
    const a = add(make(extra));
    const sent = await call('POST', `/api/articles/${a.id}/send`, { confirmOutOfRange: true });
    if (sent.status !== 200) throw new Error('envoi impossible : ' + JSON.stringify(sent.json));
    const rec = store.getArticles().find((x) => x.id === a.id);
    rec.wpSentAt = new Date(Date.now() - sentDaysAgo * 86400000).toISOString();
    if (scheduled) { rec.autoScheduled = true; rec.autoEpoch = store.getSettings().autoEpoch; }
    Object.assign(rec, extra.after || {});
    store.saveArticle(rec);
    return { rec, post: fake.wpPosts.get(rec.wpId) };
  };
  const stop = () => {
    secrets.set('openrouterKey', ''); secrets.set('wpAppPassword', '');
    const s2 = store.getSettings(); delete s2.simulate; Object.assign(s2, { wpUser: '', aiModel: '', publishMode: 'brouillon', autoEpoch: '', publishPaused: false }); store.saveSettings(s2);
    Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; app.close(); wpSrv.close(); orSrv.close();
  };
  return { fake, call, make, add, siteDraft, stop, orState: state, store };
}

module.exports = { listen, client, bodyWords, setupReal };
