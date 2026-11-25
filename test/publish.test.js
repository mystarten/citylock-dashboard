const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-publish-'));
process.env.DASHBOARD_USER = 'laurent-test';
process.env.DASHBOARD_PASSWORD = 'mdp-de-test-123';
process.env.SESSION_SECRET = 'secret-de-test-0123456789abcdef';
process.env.SIMULATE = 'true';
process.env.TRIAL_COOLDOWN_MS = '0';

const { bodyWords, setupReal } = require('./helpers');
const store = require('../lib/store');
const wp = require('../lib/wp');
const publishing = require('../lib/publishing');
const server = require('../server');

const BASE = { frequency: 8, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK' };
const enableAuto = (call) => call('PUT', '/api/settings', { ...BASE, publishMode: 'automatique', confirmAutomatic: true });

test('par défaut : « brouillon seulement », automatique désactivé, rien ne se publie seul', async () => {
  const { call, siteDraft, fake, stop } = await setupReal(server);
  try {
    const s = (await call('GET', '/api/settings')).json;
    assert.deepStrictEqual([s.publishMode, s.publishPaused, s.autoPublishDelayDays, s.autoPublishMaxPerWeek], ['brouillon', false, 3, 2]);
    const { rec, post } = await siteDraft({}, { sentDaysAgo: 30 });
    const r = await publishing.tick();
    assert.deepStrictEqual([r.reason, r.published.length, post.status, rec.status], ['mode', 0, 'draft', 'brouillon_wp']);
    assert.strictEqual((await call('POST', '/api/publish/auto/run')).json.reason, 'mode');
  } finally { stop(); }
});

test('activer le mode automatique exige la confirmation de l\'avertissement ; réglages validés', async () => {
  const { call, stop } = await setupReal(server);
  try {
    assert.strictEqual((await call('PUT', '/api/settings', { ...BASE, publishMode: 'inconnu' })).status, 400);
    const noConfirm = await call('PUT', '/api/settings', { ...BASE, publishMode: 'automatique' });
    assert.deepStrictEqual([noConfirm.status, noConfirm.json.code], [400, 'confirm_automatic']);
    assert.ok(noConfirm.json.error.includes('Les articles seront publiés sans relecture. Laurent doit avoir donné son accord écrit.'));
    assert.strictEqual((await call('PUT', '/api/settings', { ...BASE, publishMode: 'automatique', confirmAutomatic: 'oui' })).status, 400); // « vrai » uniquement
    assert.strictEqual((await call('GET', '/api/settings')).json.publishMode, 'brouillon');
    const ok = await enableAuto(call);
    assert.deepStrictEqual([ok.status, ok.json.publishMode], [200, 'automatique']);
    // passer en « essai » puis revenir exige de nouveau la confirmation
    assert.strictEqual((await call('PUT', '/api/settings', { ...BASE, publishMode: 'essai' })).json.publishMode, 'essai');
    assert.strictEqual((await call('PUT', '/api/settings', { ...BASE, publishMode: 'automatique' })).status, 400);
    // délai et plafond : entiers bornés
    for (const bad of [{ autoPublishDelayDays: 0 }, { autoPublishDelayDays: 31 }, { autoPublishDelayDays: 2.5 }, { autoPublishDelayDays: '3' }, { autoPublishMaxPerWeek: 0 }, { autoPublishMaxPerWeek: 15 }]) {
      assert.strictEqual((await call('PUT', '/api/settings', { ...BASE, ...bad })).status, 400, JSON.stringify(bad));
    }
    const set = (await call('PUT', '/api/settings', { ...BASE, autoPublishDelayDays: 5, autoPublishMaxPerWeek: 1 })).json;
    assert.deepStrictEqual([set.autoPublishDelayDays, set.autoPublishMaxPerWeek], [5, 1]);
  } finally { stop(); }
});

test('publication automatique : chaque condition manquante empêche la publication', async () => {
  const { call, siteDraft, fake, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const cases = [
      ['des faits restent à vérifier', { faitsAVerifier: ['Une statistique'] }, /fait/],
      ['texte trop court (599 mots)', { htmlContent: bodyWords(599) }, /Longueur hors de la plage demandée/],
      ['texte trop long (901 mots)', { htmlContent: bodyWords(901) }, /Longueur hors de la plage demandée/],
      ['mot interdit', { htmlContent: bodyWords(650) + '<p>Une alarme garantie.</p>' }, /interdit/],
      ['marqueur de source', { htmlContent: bodyWords(650) + '<p>Chiffre [SOURCE A VERIFIER].</p>' }, /marqueur/],
      ['article marqué essai', { essai: true }, /essai/],
      ['publication annulée', { autoCancelled: true }, /annulée/],
      ['modification pas encore envoyée sur le site', { siteDirty: true }, /pas encore envoyées/],
    ];
    for (const [label, patch, re] of cases) {
      // le texte d'origine (propre) est envoyé sur le site ; on ne change que la fiche locale ensuite
      const { rec, post } = await siteDraft({}, { sentDaysAgo: 10 });
      Object.assign(rec, patch); store.saveArticle(rec);
      const r = await publishing.tick();
      const sk = r.skipped.find((x) => x.id === rec.id);
      assert.ok(sk && sk.reasons.some((m) => re.test(m)), `${label} : raisons = ${JSON.stringify(sk)}`);
      assert.strictEqual(post.status, 'draft', label);
      store.saveArticles(store.getArticles().filter((x) => x.id !== rec.id)); // nettoyage
    }
    assert.strictEqual(publishing.getLog().length, 0, 'aucune publication enregistrée');

    // délai d'attente : pas avant 3 jours
    const young = await siteDraft({}, { sentDaysAgo: 1 });
    const r1 = await publishing.tick();
    assert.ok(r1.skipped.find((x) => x.id === young.rec.id).reasons.some((m) => /date de publication prévue/.test(m)));
    assert.strictEqual(young.post.status, 'draft');
    // ...mais une fois le délai passé (3 jours), elle part
    const r2 = await publishing.tick({ now: new Date(Date.now() + 3 * 86400000) });
    assert.strictEqual(r2.published.length, 1);
    assert.strictEqual(young.post.status, 'publish');
  } finally { stop(); }
});

test('publication automatique : cas qui réussit, journal complet, article marqué', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const { rec, post } = await siteDraft({ title: 'Guide complet' }, { sentDaysAgo: 4 });
    const r = await publishing.tick();
    assert.deepStrictEqual([r.published.length, post.status], [1, 'publish']);
    const art = (await call('GET', `/api/articles/${rec.id}`)).json;
    assert.deepStrictEqual([art.status, art.publishedBy, art.state.label.startsWith('Publié le ')], ['publie', 'automatique', true]);
    const journal = (await call('GET', '/api/publications')).json;
    assert.strictEqual(journal.length, 1);
    assert.deepStrictEqual([journal[0].title, journal[0].by, journal[0].articleId], ['Guide complet', 'automatique', rec.id]);
    assert.ok(!Number.isNaN(Date.parse(journal[0].at)) && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(journal[0].at), 'date et heure');
    assert.ok(journal[0].url.includes(`?p=${rec.wpId}`) || journal[0].url.startsWith('http'), 'adresse (URL)');
    // une seconde vérification ne republie pas
    assert.strictEqual((await publishing.tick()).published.length, 0);
  } finally { stop(); }
});

test('le texte réellement présent sur le site est contrôlé juste avant de publier', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const a = await siteDraft({}, { sentDaysAgo: 5 });
    a.post.content = bodyWords(650) + '<p>Laurent a ajouté : le meilleur choix.</p>'; // modifié directement dans WordPress
    let r = await publishing.tick();
    assert.ok(r.skipped[0].reasons.some((m) => /texte sur le site.*interdit/.test(m)));
    a.post.content = bodyWords(650) + '<p>[SOURCE A VERIFIER]</p>';
    r = await publishing.tick();
    assert.ok(r.skipped[0].reasons.some((m) => /texte sur le site.*marqueur/.test(m)));
    a.post.content = bodyWords(100); // trop court
    r = await publishing.tick();
    assert.ok(r.skipped[0].reasons.some((m) => /texte sur le site.*Longueur/.test(m)));
    assert.strictEqual(a.post.status, 'draft');
    a.post.content = bodyWords(700); // corrigé : OK
    assert.strictEqual((await publishing.tick()).published.length, 1);
    assert.strictEqual(a.post.status, 'publish');
  } finally { stop(); }
});

test('limite par semaine : 2 par défaut, la suite attend la semaine suivante', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const drafts = [];
    for (let i = 0; i < 3; i++) drafts.push(await siteDraft({ title: `Article ${i}` }, { sentDaysAgo: 10 - i }));
    const base = new Date(Date.now() + 20 * 86400000);
    const r = await publishing.tick({ now: base });
    assert.deepStrictEqual([r.published.length, r.reason], [2, 'plafond']);
    assert.deepStrictEqual(drafts.map((d) => d.post.status), ['publish', 'publish', 'draft']);
    // même semaine : toujours rien
    assert.strictEqual((await publishing.tick({ now: new Date(base.getTime() + 3600000) })).published.length, 0);
    // semaine suivante : le troisième part
    const next = await publishing.tick({ now: new Date(base.getTime() + 7 * 86400000) });
    assert.strictEqual(next.published.length, 1);
    assert.strictEqual(drafts[2].post.status, 'publish');
    // le plafond est réglable
    await call('PUT', '/api/settings', { ...BASE, autoPublishMaxPerWeek: 1 });
    assert.strictEqual((await call('GET', '/api/settings')).json.autoPublishMaxPerWeek, 1);
  } finally { stop(); }
});

test('semaines calculées à l\'heure de Paris (lundi à dimanche)', () => {
  const k = (iso) => publishing.weekKey(new Date(iso));
  assert.strictEqual(k('2026-11-23T10:00:00Z'), '2026-11-23');      // lundi
  assert.strictEqual(k('2026-11-29T22:30:00Z'), '2026-11-23');      // dimanche 23 h 30 à Paris : même semaine
  assert.strictEqual(k('2026-11-29T23:30:00Z'), '2026-11-30');      // lundi 0 h 30 à Paris : semaine suivante
  assert.strictEqual(k('2026-07-05T21:30:00Z'), '2026-06-29');      // été (UTC+2) : dimanche 5 juillet 23 h 30 à Paris : encore la semaine du 29 juin
  assert.strictEqual(k('2026-07-05T22:30:00Z'), '2026-07-06');      // lundi 6 juillet 0 h 30 à Paris : semaine suivante
});

test('« Tout arrêter » : effet immédiat, même pendant une vérification ; reprise possible', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const a = await siteDraft({}, { sentDaysAgo: 10 });
    const b = await siteDraft({}, { sentDaysAgo: 9 });
    assert.strictEqual((await call('POST', '/api/publish/pause', { paused: 'oui' })).status, 400);
    assert.strictEqual((await call('POST', '/api/publish/pause', { paused: true })).json.publishPaused, true);
    let r = await publishing.tick();
    assert.deepStrictEqual([r.reason, r.published.length, a.post.status, b.post.status], ['pause', 0, 'draft', 'draft']);
    // reprise
    await call('POST', '/api/publish/pause', { paused: false });
    // pause déclenchée PENDANT la vérification du premier article : ni le premier ni le suivant ne partent
    const original = wp.getContent;
    let calls = 0;
    wp.getContent = async (id) => { const t = await original(id); calls += 1; if (calls === 1) { const s = store.getSettings(); s.publishPaused = true; store.saveSettings(s); } return t; };
    try { r = await publishing.tick(); } finally { wp.getContent = original; }
    assert.deepStrictEqual([r.published.length, a.post.status, b.post.status], [0, 'draft', 'draft']);
    assert.ok(r.skipped.some((x) => x.reasons.some((m) => /suspendu/.test(m))));
    // reprise : les deux partent
    await call('POST', '/api/publish/pause', { paused: false });
    assert.strictEqual((await publishing.tick()).published.length, 2);
  } finally { stop(); }
});

test('annulation par article pendant le délai d\'attente', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const a = await siteDraft({}, { sentDaysAgo: 10 });
    const view = (await call('GET', `/api/articles/${a.rec.id}`)).json;
    assert.deepStrictEqual([view.auto.active, view.auto.cancelled, typeof view.auto.scheduledAt], [true, false, 'string']);
    const c = await call('POST', `/api/articles/${a.rec.id}/cancel-auto`, {});
    assert.strictEqual(c.json.auto.cancelled, true);
    assert.strictEqual((await publishing.tick()).published.length, 0);
    assert.strictEqual(a.post.status, 'draft');
    await call('POST', `/api/articles/${a.rec.id}/cancel-auto`, { cancelled: false }); // on peut reprogrammer
    assert.strictEqual((await publishing.tick()).published.length, 1);
    assert.strictEqual((await call('POST', '/api/articles/inconnu/cancel-auto', {})).status, 404);
  } finally { stop(); }
});

test('réactiver le mode automatique ne publie jamais d\'anciens brouillons', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const old = await siteDraft({}, { sentDaysAgo: 30 });
    await call('PUT', '/api/settings', { ...BASE, publishMode: 'brouillon' });
    await enableAuto(call);                                   // nouvelle activation : nouvelle période
    const r = await publishing.tick();
    assert.deepStrictEqual([r.published.length, old.post.status], [0, 'draft']);
    assert.ok(r.skipped[0].reasons.some((m) => /période actuelle/.test(m)));
    // un article créé APRÈS la réactivation, lui, est concerné
    const fresh = await siteDraft({}, { sentDaysAgo: 5 });
    assert.strictEqual((await publishing.tick()).published.length, 1);
    assert.deepStrictEqual([fresh.post.status, old.post.status], ['publish', 'draft']);
  } finally { stop(); }
});

test('mode démonstration : la vérification ne publie rien', async () => {
  const { call, siteDraft, stop } = await setupReal(server);
  try {
    await enableAuto(call);
    const a = await siteDraft({}, { sentDaysAgo: 10 });
    await call('PUT', '/api/settings', { ...BASE, simulate: true });
    const r = await publishing.tick();
    assert.deepStrictEqual([r.reason, r.published.length, a.post.status], ['demonstration', 0, 'draft']);
  } finally { stop(); }
});

test('lot en mode automatique : envoi sur le site obligatoire, mais jamais hors plage', async () => {
  const { call, stop, fake } = await setupReal(server);
  try {
    await enableAuto(call);
    const st = store.getSettings(); st.autoDraft = false; st.frequency = 2;
    st.topics = [{ id: 't1', keyword: 'alarme maison', city: 'Chatou' }, { id: 't2', keyword: 'article court', city: '' }]; store.saveSettings(st);
    assert.strictEqual((await call('POST', '/api/articles/batch')).status, 202);
    for (let i = 0; i < 80; i++) { if (!(await call('GET', '/api/articles/batch/status')).json.running) break; await new Promise((r) => setTimeout(r, 50)); }
    const list = (await call('GET', '/api/articles')).json;
    const normal = list.find((a) => a.keyword === 'alarme maison');
    const court = list.find((a) => a.keyword === 'article court');
    assert.deepStrictEqual([normal.status, normal.auto.active, normal.autoScheduled], ['brouillon_wp', true, true]); // envoyé malgré l'envoi auto désactivé
    assert.strictEqual(fake.wpPosts.get(normal.wpId).status, 'draft');
    assert.deepStrictEqual([court.status, court.autoDraftSkipped], ['a_relire', 'length']);       // hors plage : pas envoyé
    assert.strictEqual((await call('GET', '/api/articles/batch/status')).json.notes.length, 1);
    const r = await publishing.tick({ now: new Date(Date.now() + 4 * 86400000) });
    assert.deepStrictEqual([r.published.length, fake.wpPosts.get(normal.wpId).status], [1, 'publish']);
    assert.strictEqual(store.getArticles().find((a) => a.id === court.id).status, 'a_relire');
  } finally { stop(); }
});

test('mode « essai » : articles marqués, préfixe sur le site, confirmation avant publication, liste des essais', async () => {
  const { call, stop, fake } = await setupReal(server);
  try {
    await call('PUT', '/api/settings', { ...BASE, publishMode: 'essai', autoDraft: true });
    const st = store.getSettings(); st.frequency = 2; st.autoDraft = true; st.topics = [{ id: 't1', keyword: 'alarme maison', city: 'Chatou' }]; store.saveSettings(st);
    await call('POST', '/api/articles/batch');
    for (let i = 0; i < 80; i++) { if (!(await call('GET', '/api/articles/batch/status')).json.running) break; await new Promise((r) => setTimeout(r, 50)); }
    const a = (await call('GET', '/api/articles')).json[0];
    assert.deepStrictEqual([a.essai, a.status, a.autoScheduled], [true, 'brouillon_wp', false]);
    const post = fake.wpPosts.get(a.wpId);
    assert.ok(post.title.startsWith('[ESSAI] '), 'préfixe visible dans WordPress : ' + post.title);
    // « liste de tous les essais en cours »
    const essais = (await call('GET', '/api/articles')).json.filter((x) => x.essai && x.status !== 'publie');
    assert.strictEqual(essais.length, 1);
    // jamais publié par la vérification automatique
    assert.strictEqual((await publishing.tick({ now: new Date(Date.now() + 90 * 86400000) })).published.length, 0);
    // publication manuelle : confirmation « essai » exigée, puis le préfixe disparaît
    const no = await call('POST', `/api/articles/${a.id}/publish`, { validated: true });
    assert.deepStrictEqual([no.status, no.json.code, post.status], [409, 'essai', 'draft']);
    const yes = await call('POST', `/api/articles/${a.id}/publish`, { validated: true, confirmEssai: true });
    assert.strictEqual(yes.status, 200);
    assert.deepStrictEqual([post.status, post.title.startsWith('[ESSAI]')], ['publish', false]);
    assert.strictEqual(yes.json.publishedBy, 'manuel');
    const journal = (await call('GET', '/api/publications')).json;
    assert.deepStrictEqual([journal.length, journal[0].by, journal[0].title], [1, 'manuel', a.title]);
  } finally { stop(); }
});

test('mode « brouillon seulement » : jamais de publication sans clic, même avec tous les délais passés', async () => {
  const { call, stop, fake } = await setupReal(server);
  try {
    const st = store.getSettings(); st.frequency = 2; st.autoDraft = true; st.topics = [{ id: 't1', keyword: 'alarme maison', city: 'Chatou' }]; store.saveSettings(st);
    await call('POST', '/api/articles/batch');
    for (let i = 0; i < 80; i++) { if (!(await call('GET', '/api/articles/batch/status')).json.running) break; await new Promise((r) => setTimeout(r, 50)); }
    const a = (await call('GET', '/api/articles')).json[0];
    assert.deepStrictEqual([a.essai, a.autoScheduled, a.status], [false, false, 'brouillon_wp']);
    assert.ok(!fake.wpPosts.get(a.wpId).title.startsWith('[ESSAI]'));
    assert.strictEqual((await publishing.tick({ now: new Date(Date.now() + 365 * 86400000) })).published.length, 0);
    assert.strictEqual(fake.wpPosts.get(a.wpId).status, 'draft');
  } finally { stop(); }
});
