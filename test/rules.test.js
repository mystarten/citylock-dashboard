const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rules-'));
process.env.SESSION_SECRET = 'secret-de-test-0123456789abcdef';

const rules = require('../lib/rules');
const ai = require('../lib/ai');
const DEFAULT_RULES = require('../lib/defaultRules');

const words = (n) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');

test('comptage des mots : les blocs HTML ne se collent pas, les balises en ligne non plus', () => {
  assert.strictEqual(rules.countWords('<h2>Un titre</h2><p>un deux trois.</p><p>quatre cinq.</p><ul><li>six</li><li>sept</li></ul>'), 9);
  assert.strictEqual(rules.countWords('<p><strong>mot</strong>s</p>'), 1);
  assert.strictEqual(rules.countWords('<table><tr><td>a</td><td>b</td></tr></table>'), 2);
  assert.strictEqual(rules.countWords('<p>un&nbsp;deux — trois</p>'), 3); // le tiret seul n'est pas un mot
});

test('longueur : la plage 600 à 900 est respectée aux bornes', () => {
  for (const [n, ok] of [[126, false], [599, false], [600, true], [750, true], [900, true], [901, false]]) {
    const c = rules.checkArticle({ title: 'T', htmlContent: `<p>${words(n)}</p>`, faitsAVerifier: [] });
    assert.strictEqual(c.inRange, ok, `${n} mots`);
    assert.strictEqual(c.issues.some((i) => i.code === 'length'), !ok);
  }
});

test('mots interdits : détectés (féminin, pluriel, 100%), sans faux positifs', () => {
  const found = (t) => rules.findForbidden(t);
  assert.deepStrictEqual(found('Le meilleur choix, la meilleure offre, les meilleurs prix'), ['meilleur']);
  assert.deepStrictEqual(found('Notre leader du marché'), ['leader']);
  assert.deepStrictEqual(found('une alarme certifiée'), ['certifié']);
  assert.deepStrictEqual(found('matériel garanti ou garantie'), ['garanti']);
  assert.deepStrictEqual(found('offre à 100 % et 100% fiable'), ['100 %']);
  assert.deepStrictEqual(found('protégé à vie'), ['à vie']);
  assert.deepStrictEqual(found('une solution révolutionnaire'), ['révolutionnaire']);
  assert.deepStrictEqual(found('un système sans risque'), ['sans risque']);
  assert.deepStrictEqual(found('garantir la sécurité, un meilleurement, 1100 %, la vie, le risque'), []);
  // le titre et les méta sont contrôlés aussi
  const c = rules.checkArticle({ title: 'La meilleure alarme', metaTitle: '', metaDescription: '', htmlContent: `<p>${words(650)}</p>`, faitsAVerifier: [] });
  assert.ok(c.issues.some((i) => i.code === 'forbidden') && c.blocking);
});

test('marqueur de source, faits à vérifier, tirets et flèches', () => {
  const base = { title: 'T', metaTitle: '', metaDescription: '', htmlContent: `<p>${words(650)}</p>`, faitsAVerifier: [] };
  assert.strictEqual(rules.checkArticle(base).blocking, false);
  const m = rules.checkArticle({ ...base, htmlContent: base.htmlContent + '<p>Chiffre [SOURCE A VERIFIER] ici.</p>' });
  assert.ok(m.issues.some((i) => i.code === 'marker') && m.issues.some((i) => i.code === 'marker_no_fact') && m.blocking);
  const f = rules.checkArticle({ ...base, faitsAVerifier: ['Une statistique'] });
  assert.ok(f.issues.some((i) => i.code === 'facts') && f.blocking);
  assert.strictEqual(rules.checkArticle({ ...base, faitsAVerifier: ['  ', ''] }).blocking, false); // lignes vides ignorées
  const d = rules.checkArticle({ ...base, htmlContent: base.htmlContent + '<p>Voir → plus loin — ici</p>' });
  assert.ok(d.issues.some((i) => i.code === 'dash') && d.blocking === false); // simple remarque
});

test('instruction par défaut : texte fourni, moins de 6000 caractères, règles clés, format et longueur dedans', () => {
  assert.ok(DEFAULT_RULES.length < ai.MAX_RULES_LENGTH, `${DEFAULT_RULES.length} caractères`);
  assert.ok(DEFAULT_RULES.startsWith('Tu es rédacteur web pour Citylock, installateur d\'alarmes Ajax sans abonnement à Chatou'));
  for (const phrase of ['06 56 69 60 05 et 01 39 12 46 60', 'du lundi au vendredi, de 9h30 à 19h30', 'Mots interdits : « meilleur », « leader », « certifié », « garanti », « 100 % », « à vie », « révolutionnaire », « sans risque »',
    'Longueur : 600 à 900 mots', 'Un bloc « Questions fréquentes »', 'systeme-dalarme-avec-abonnement/', 'Ne vise jamais « alarme sans abonnement » ou « alarme autonome » comme mot-clé principal.',
    'FORMAT DE RÉPONSE', '"title"', '"htmlContent"', '"faitsAVerifier"', 'entre 600 et 900 mots']) {
    assert.ok(DEFAULT_RULES.includes(phrase), 'manque : ' + phrase);
  }
  assert.strictEqual(ai.DEFAULT_RULES, DEFAULT_RULES);
  assert.deepStrictEqual(ai.promptProblems(DEFAULT_RULES), []);
});

test('un seul prompt : celui des réglages, rien n\'est ajouté par le code', () => {
  const mine = 'Mon prompt à moi, sans longueur. Réponds en JSON avec title et htmlContent. '.repeat(2);
  assert.strictEqual(ai.buildSystemPrompt({ systemPrompt: `  ${mine}  ` }), mine.trim());
  assert.strictEqual(ai.buildSystemPrompt({}), '');            // pas de repli caché
  assert.strictEqual(ai.buildSystemPrompt({ systemPrompt: '' }), '');
  const user = ai.buildUserPrompt({ keyword: 'serrure', city: 'Chatou' }, { brandName: 'C', zone: 'Z' }, []);
  assert.ok(user.includes('Mot-clé principal : serrure') && user.includes('Ville ciblée : Chatou'));
  assert.ok(!/mots/.test(user), 'la longueur ne vient pas du code : ' + user);
  assert.ok(ai.GENERATION_MAX_TOKENS >= 4000);
  // avertissements affichés dans les réglages
  assert.strictEqual(ai.promptProblems('Écris un article. '.repeat(10)).length, 3);
  assert.ok(ai.promptProblems('Réponds en JSON : {"title":"","htmlContent":""}').length === 0);
});

test('limite de sortie suffisante, tableaux conservés, réponse coupée détectée (faux OpenRouter)', async () => {
  const seen = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push(JSON.parse(b));
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'cut') return res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"title":"Coupé","htmlContent":"<p>début' } }] }));
      const html = `<p>${words(700)}</p><table><thead><tr><th>Critère</th></tr></thead><tbody><tr><td>Valeur</td></tr></tbody></table>`;
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'T', metaTitle: 'M', metaDescription: 'D', slug: 't', htmlContent: html, internalLinkSuggestions: [], faitsAVerifier: [] }) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SIMULATE: 'false', OPENROUTER_BASE_URL: `http://127.0.0.1:${srv.address().port}`, OPENROUTER_API_KEY: 'cle-test-0000', OPENROUTER_MODEL: 'env/modele' });
    const art = await ai.generateArticle({ keyword: 'alarme', city: '' }, { brandName: 'C', zone: 'Z', aiModel: '', systemPrompt: DEFAULT_RULES }, []);
    assert.strictEqual(seen[0].max_tokens, ai.GENERATION_MAX_TOKENS);
    assert.ok(art.wordCount >= 700 && rules.inRange(art.wordCount));
    assert.ok(art.htmlContent.includes('<table>') && art.htmlContent.includes('<td>Valeur</td>'), 'le tableau n\'est pas retiré par le filtre');
    assert.strictEqual(art.modelUsed, 'env/modele');
    await assert.rejects(() => ai.generateArticle({ keyword: 'alarme' }, { brandName: 'C', zone: 'Z', systemPrompt: '' }, []), /Aucune instruction/);
    await assert.rejects(() => ai.generateArticle({ keyword: 'alarme' }, { brandName: 'C', zone: 'Z', systemPrompt: 'Prompt sans le format demandé. '.repeat(5) }, []), /JSON/);
    mode = 'cut';
    await assert.rejects(() => ai.generateArticle({ keyword: 'alarme' }, { brandName: 'C', zone: 'Z', systemPrompt: DEFAULT_RULES }, []), /coupée avant la fin/);
  } finally { Object.assign(process.env, saved); delete process.env.OPENROUTER_BASE_URL; srv.close(); }
});
