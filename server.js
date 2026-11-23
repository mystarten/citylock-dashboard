// Tableau de bord CityLock : serveur Express minimal.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cron = require('node-cron');

const log = require('./lib/log');
const store = require('./lib/store');
const auth = require('./lib/auth');
const ai = require('./lib/ai');
const wp = require('./lib/wp');
const audit = require('./lib/audit');

// --- Configuration obligatoire ---
if (!process.env.DASHBOARD_USER || !process.env.DASHBOARD_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  console.error('DASHBOARD_USER, DASHBOARD_PASSWORD et SESSION_SECRET (16 caractères minimum) sont obligatoires. Voir .env.example.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

// Protection CSRF simple : toute requête qui modifie quelque chose doit porter cet en-tête.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'citylock') return res.status(403).json({ error: 'Requête refusée.' });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  log.error(`${req.method} ${req.path}`, e);
  res.status(e.httpStatus || 500).json({ error: e.httpStatus ? e.message : (e.message || 'Erreur interne.') });
});
const fail = (status, message) => Object.assign(new Error(message), { httpStatus: status });

// --- Session ---
app.get('/api/session', (req, res) => res.json({ authenticated: auth.isAuthenticated(req), simulate: process.env.SIMULATE === 'true' }));
app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const r = auth.login(req, res, b.username, b.password, b.remember === true);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { auth.logout(res); res.json({ ok: true }); });

app.use('/api', auth.requireAuth);

// --- Etat de configuration (jamais les valeurs) ---
app.get('/api/status', (req, res) => res.json({
  simulate: process.env.SIMULATE === 'true',
  openrouter: !!(process.env.OPENROUTER_API_KEY && ai.effectiveModel(store.getSettings())),
  openrouterKey: !!process.env.OPENROUTER_API_KEY,
  wordpress: !!(process.env.WP_BASE_URL && process.env.WP_USER && process.env.WP_APP_PASSWORD),
  pagespeed: !!process.env.PAGESPEED_API_KEY,
  siteUrl: process.env.WP_BASE_URL || '',
  supportContact: process.env.SUPPORT_CONTACT || '',
}));

// --- Réglages ---
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '');

app.get('/api/settings', (req, res) => res.json(store.getSettings()));

app.put('/api/settings', wrap((req, res) => {
  const b = req.body || {};
  const freq = Number(b.frequency);
  if (!Number.isInteger(freq) || freq < 1 || freq > 8) throw fail(400, 'La fréquence doit être un nombre entier entre 1 et 8.');
  const zone = clean(b.zone, 80);
  const brandName = clean(b.brandName, 60);
  if (!zone || !brandName) throw fail(400, 'La zone desservie et le nom commercial sont obligatoires.');
  if (b.autoDraft !== undefined && typeof b.autoDraft !== 'boolean') throw fail(400, 'Réglage invalide.');
  let aiModel, systemPrompt;
  if (b.aiModel !== undefined) {
    if (typeof b.aiModel !== 'string') throw fail(400, 'Modèle invalide.');
    aiModel = b.aiModel.trim();
    if (aiModel && !ai.MODEL_PATTERN.test(aiModel)) throw fail(400, 'Identifiant de modèle invalide. Copiez-le tel quel depuis openrouter.ai/models (exemple : anthropic/claude-haiku-5-5), sans espace.');
  }
  if (b.systemPrompt !== undefined) {
    if (typeof b.systemPrompt !== 'string') throw fail(400, 'Consignes invalides.');
    systemPrompt = b.systemPrompt.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (systemPrompt.length > ai.MAX_RULES_LENGTH) throw fail(400, `Les consignes sont trop longues (maximum ${ai.MAX_RULES_LENGTH} caractères).`);
    if (systemPrompt && systemPrompt.length < 80) throw fail(400, 'Les consignes sont trop courtes pour être utiles. Videz le champ pour revenir au texte d\'origine.');
    if (systemPrompt === ai.DEFAULT_RULES.trim()) systemPrompt = ''; // identique à l'original : on n'enregistre rien
  }
  const s = store.getSettings();
  Object.assign(s, { frequency: freq, zone, brandName });
  if (typeof b.autoDraft === 'boolean') s.autoDraft = b.autoDraft;
  if (aiModel !== undefined) s.aiModel = aiModel;
  if (systemPrompt !== undefined) s.systemPrompt = systemPrompt;
  store.saveSettings(s);
  res.json(s);
}));

app.post('/api/topics', wrap((req, res) => {
  const keyword = clean(req.body && req.body.keyword, 100);
  const city = clean(req.body && req.body.city, 60);
  if (!keyword) throw fail(400, 'Le mot-clé principal est obligatoire.');
  const s = store.getSettings();
  if (s.topics.length >= 50) throw fail(400, 'Maximum 50 sujets.');
  if (s.topics.some((t) => t.keyword.toLowerCase() === keyword.toLowerCase() && (t.city || '').toLowerCase() === city.toLowerCase())) throw fail(409, 'Ce sujet existe déjà.');
  s.topics.push({ id: crypto.randomUUID(), keyword, city });
  store.saveSettings(s);
  res.status(201).json(s);
}));

app.delete('/api/topics/:id', wrap((req, res) => {
  const s = store.getSettings();
  s.topics = s.topics.filter((t) => t.id !== req.params.id);
  store.saveSettings(s);
  res.json(s);
}));

app.get('/api/ai/defaults', (req, res) => res.json({ systemPrompt: ai.DEFAULT_RULES, maxLength: ai.MAX_RULES_LENGTH, envModel: process.env.OPENROUTER_MODEL || '' }));

let lastAiTest = 0;
app.post('/api/ai/test', wrap(async (req, res) => {
  if (Date.now() - lastAiTest < 5000) throw fail(429, 'Patientez quelques secondes avant de retester.');
  lastAiTest = Date.now();
  res.json(await ai.testModel(store.getSettings()));
}));

app.get('/api/wp/test', wrap(async (req, res) => res.json(await wp.testConnection())));

app.post('/api/category/ensure', wrap(async (req, res) => {
  const id = await wp.ensureBlogCategory();
  const s = store.getSettings();
  s.blogCategoryId = id;
  store.saveSettings(s);
  res.json({ id });
}));

// --- Articles ---
const monthNow = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const batch = { running: false, total: 0, done: 0, errors: [] };
const articleView = (a) => a;
async function pushDraft(a) {
  const s = store.getSettings();
  let cat = s.blogCategoryId;
  if (!cat) { cat = await wp.ensureBlogCategory(); s.blogCategoryId = cat; store.saveSettings(s); }
  const post = await wp.createDraft(a, cat);
  Object.assign(a, { status: 'brouillon_wp', wpId: post.id, wpLink: post.link });
}
const wpReady = () => process.env.SIMULATE === 'true' || !!(process.env.WP_BASE_URL && process.env.WP_USER && process.env.WP_APP_PASSWORD);
const findArticle = (id) => {
  const list = store.getArticles();
  const a = list.find((x) => x.id === id);
  if (!a) throw fail(404, 'Article introuvable.');
  return { list, a };
};

app.get('/api/articles', (req, res) => res.json(store.getArticles().map(articleView).reverse()));

app.post('/api/articles/batch', wrap((req, res) => {
  if (batch.running) throw fail(409, 'Un lot est déjà en cours de rédaction.');
  const s = store.getSettings();
  const month = monthNow();
  const articles = store.getArticles();
  const already = articles.filter((a) => a.month === month);
  const remaining = s.frequency - already.length;
  if (remaining <= 0) throw fail(409, `Le lot du mois est complet (${already.length} article(s) pour une fréquence de ${s.frequency}). Supprimez un article ou augmentez la fréquence.`);
  const usedTopics = new Set(already.map((a) => a.topicId));
  const todo = s.topics.filter((t) => !usedTopics.has(t.id)).slice(0, remaining);
  if (!todo.length) throw fail(400, 'Aucun sujet validé disponible. Ajoutez des sujets dans l\'écran Réglages.');
  if (process.env.SIMULATE !== 'true') {
    if (!process.env.OPENROUTER_API_KEY) throw fail(400, 'La clé OpenRouter n\'est pas configurée (OPENROUTER_API_KEY, à saisir dans l\'hébergeur).');
    if (!ai.effectiveModel(s)) throw fail(400, 'Aucun modèle OpenRouter choisi. Indiquez-en un dans Réglages, Rédaction automatique.');
  }

  Object.assign(batch, { running: true, total: todo.length, done: 0, errors: [] });
  res.status(202).json({ started: todo.length });

  (async () => {
    const audits = store.getAudits();
    const last = audits[audits.length - 1];
    const pages = last && last.sitemapUrls ? last.sitemapUrls.slice(0, 40) : [];
    for (const topic of todo) {
      try {
        const art = await ai.generateArticle(topic, s, pages);
        const rec = {
          id: crypto.randomUUID(), topicId: topic.id, keyword: topic.keyword, city: topic.city, month,
          createdAt: new Date().toISOString(), status: 'a_relire', wpId: null, wpLink: null,
          simulated: process.env.SIMULATE === 'true', ...art,
        };
        if (s.autoDraft && wpReady()) {
          try { await pushDraft(rec); } catch (e) {
            log.error(`Envoi automatique en brouillon échoué pour « ${topic.keyword} »`, e);
            batch.errors.push(`${topic.keyword} : rédigé, mais l'envoi dans WordPress a échoué (${e.message}). Vous pouvez le renvoyer à la main.`);
          }
        }
        const list = store.getArticles();
        list.push(rec);
        store.saveArticles(list);
      } catch (e) {
        log.error(`Génération échouée pour « ${topic.keyword} »`, e);
        batch.errors.push(`${topic.keyword} : ${e.message}`);
      }
      batch.done += 1;
    }
    batch.running = false;
  })().catch((e) => { log.error('Lot en échec', e); batch.running = false; });
}));

app.get('/api/articles/batch/status', (req, res) => res.json(batch));

app.post('/api/articles/:id/send', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status !== 'a_relire') throw fail(409, 'Cet article a déjà été envoyé à WordPress.');
  await pushDraft(a);
  store.saveArticles(list);
  res.json(a);
}));

app.post('/api/articles/:id/publish', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (!req.body || req.body.validated !== true) throw fail(400, 'Vous devez confirmer « J\'ai relu et validé ».');
  if (a.status !== 'brouillon_wp') throw fail(409, 'Envoyez d\'abord l\'article en brouillon WordPress.');
  // Garde-fou : on relit le texte réellement présent dans WordPress (il a pu être corrigé là-bas).
  if (process.env.SIMULATE !== 'true') {
    const live = await wp.getContent(a.wpId);
    if (live.includes('[SOURCE A VERIFIER]')) throw fail(409, 'Le texte contient encore « [SOURCE A VERIFIER] ». Remplacez ce marqueur par une vraie source (ou supprimez la phrase) dans WordPress, puis réessayez.');
  }
  const r = await wp.publish(a.wpId);
  Object.assign(a, { status: 'publie', wpLink: r.link || a.wpLink, publishedAt: new Date().toISOString() });
  store.saveArticles(list);
  res.json(a);
}));

app.delete('/api/articles/:id', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est publié : supprimez-le directement dans WordPress.');
  if (a.status === 'brouillon_wp' && a.wpId) await wp.deleteDraft(a.wpId);
  store.saveArticles(list.filter((x) => x.id !== a.id));
  res.json({ ok: true });
}));

// --- Audit ---
app.get('/api/audits', (req, res) => {
  const audits = store.getAudits();
  const latest = audits[audits.length - 1] || null;
  res.json({
    latest,
    history: audits.map((a) => ({ id: a.id, date: a.date, score: a.score, trigger: a.trigger })),
    status: audit.status(),
  });
});

app.post('/api/audit/run', wrap((req, res) => {
  if (audit.status().running) throw fail(409, 'Un audit est déjà en cours.');
  audit.runAudit('manuel').catch(() => {});
  res.status(202).json({ started: true });
}));

// --- Démarrage ---
const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  // Tâche planifiée : lundi 8 h, Europe/Paris.
  cron.schedule('0 8 * * 1', () => { audit.runAudit('hebdomadaire').catch(() => {}); }, { timezone: 'Europe/Paris' });
  app.listen(port, () => log.info(`Tableau de bord CityLock sur le port ${port}${process.env.SIMULATE === 'true' ? ' (MODE SIMULATION)' : ''}`));
}
module.exports = app;
