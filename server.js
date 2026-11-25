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
const secrets = require('./lib/secrets');
const { isSimulated } = require('./lib/config');
const rules = require('./lib/rules');
const arts = require('./lib/articles');

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
  res.status(e.httpStatus || 500).json({ error: e.httpStatus ? e.message : (e.message || 'Erreur interne.'), ...(e.code ? { code: e.code } : {}) });
});
const fail = (status, message, code) => Object.assign(new Error(message), { httpStatus: status, ...(code ? { code } : {}) });

// --- Session ---
app.get('/api/session', (req, res) => res.json({ authenticated: auth.isAuthenticated(req), simulate: isSimulated() }));
app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const r = auth.login(req, res, b.username, b.password, b.remember === true);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { auth.logout(res); res.json({ ok: true }); });

app.use('/api', auth.requireAuth);

// --- Etat de configuration (jamais les valeurs) ---
app.get('/api/status', (req, res) => {
  const st = secrets.status();
  const set = store.getSettings();
  res.json({
    simulate: isSimulated(),
    simulateFromSettings: typeof set.simulate === 'boolean',
    openrouter: !!(secrets.get('openrouterKey') && ai.effectiveModel(set)),
    wordpress: wp.configured(),
    pagespeed: st.pagespeedKey.set,
    siteUrl: process.env.WP_BASE_URL || '',
    supportContact: process.env.SUPPORT_CONTACT || '',
  });
});

// --- Réglages ---
// Ce que le navigateur reçoit : jamais les clés, seulement leur état.
function publicSettings(s = store.getSettings()) {
  const { secrets: _hidden, ...rest } = s;
  return { ...rest, wpUser: (s.wpUser || '').trim(), secrets: secrets.status() };
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '');

app.get('/api/settings', (req, res) => res.json(publicSettings()));

app.put('/api/settings', wrap((req, res) => {
  const b = req.body || {};
  const freq = Number(b.frequency);
  if (!Number.isInteger(freq) || freq < 1 || freq > 8) throw fail(400, 'La fréquence doit être un nombre entier entre 1 et 8.');
  const zone = clean(b.zone, 80);
  const brandName = clean(b.brandName, 60);
  if (!zone || !brandName) throw fail(400, 'La zone desservie et le nom commercial sont obligatoires.');
  if (b.autoDraft !== undefined && typeof b.autoDraft !== 'boolean') throw fail(400, 'Réglage invalide.');
  if (b.simulate !== undefined && typeof b.simulate !== 'boolean') throw fail(400, 'Réglage invalide.');
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
  if (typeof b.simulate === 'boolean') s.simulate = b.simulate;
  if (aiModel !== undefined) s.aiModel = aiModel;
  if (systemPrompt !== undefined) s.systemPrompt = systemPrompt;
  store.saveSettings(s);
  res.json(publicSettings(s));
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
  res.status(201).json(publicSettings(s));
}));

app.delete('/api/topics/:id', wrap((req, res) => {
  const s = store.getSettings();
  s.topics = s.topics.filter((t) => t.id !== req.params.id);
  store.saveSettings(s);
  res.json(publicSettings(s));
}));

// Clés et identifiants : on peut les remplacer ou les effacer (chaîne vide), jamais les relire.
const SECRET_LIMITS = { openrouterKey: 400, wpAppPassword: 120, pagespeedKey: 200 };
app.put('/api/secrets', wrap((req, res) => {
  const b = req.body || {};
  const clean1 = (v, max, label) => {
    if (typeof v !== 'string') throw fail(400, `${label} : valeur invalide.`);
    const t = v.trim();
    if (t.length > max) throw fail(400, `${label} : valeur trop longue.`);
    if (/[\u0000-\u001f\u007f]/.test(t)) throw fail(400, `${label} : caractères non autorisés (ne collez que la clé, sans retour à la ligne).`);
    return t;
  };
  const labels = { openrouterKey: 'Clé OpenRouter', wpAppPassword: 'Mot de passe d\'application', pagespeedKey: 'Clé PageSpeed' };
  const updates = {};
  for (const name of Object.keys(SECRET_LIMITS)) if (b[name] !== undefined) updates[name] = clean1(b[name], SECRET_LIMITS[name], labels[name]);
  let wpUser;
  if (b.wpUser !== undefined) wpUser = clean1(b.wpUser, 100, 'Identifiant WordPress');
  if (!Object.keys(updates).length && wpUser === undefined) throw fail(400, 'Rien à enregistrer.');
  for (const [name, v] of Object.entries(updates)) secrets.set(name, v);
  if (wpUser !== undefined) { const s = store.getSettings(); s.wpUser = wpUser; store.saveSettings(s); }
  log.info('Clés ou identifiants modifiés depuis l\'interface (valeurs non journalisées)');
  res.json(publicSettings());
}));

app.get('/api/ai/defaults', (req, res) => res.json({ systemPrompt: ai.DEFAULT_RULES, maxLength: ai.MAX_RULES_LENGTH, envModel: process.env.OPENROUTER_MODEL || '' }));

let lastAiTest = 0;
app.post('/api/ai/test', wrap(async (req, res) => {
  if (Date.now() - lastAiTest < 2000) throw fail(429, 'Patientez quelques secondes avant de retester.');
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
const batch = { running: false, total: 0, done: 0, errors: [], notes: [] };
const articleView = (a) => arts.view(a);

// Quota et sujets : on ne compte que les articles du mode en cours (démonstration ou réel),
// pour que des articles de démonstration ne bloquent jamais le premier vrai lot.
function planNow() {
  const s = store.getSettings();
  const month = monthNow();
  const mode = isSimulated();
  const already = store.getArticles().filter((a) => a.month === month && !!a.simulated === mode);
  const remaining = Math.max(0, s.frequency - already.length);
  const used = new Set(already.map((a) => a.topicId));
  const available = s.topics.filter((t) => !used.has(t.id));
  return {
    month, simulate: mode, frequency: s.frequency, already: already.length, remaining,
    totalTopics: s.topics.length, availableTopics: available.length,
    next: available.slice(0, remaining).map((t) => ({ id: t.id, keyword: t.keyword, city: t.city })),
  };
}
const modeName = (sim) => (sim ? 'démonstration' : 'réel');
function assertSameMode(a, action) {
  if (!!a.simulated !== isSimulated()) throw fail(409, `Cet article a été créé en mode ${modeName(!!a.simulated)}. Repassez en mode ${modeName(!!a.simulated)} (Réglages, Connexions) pour le ${action}, ou supprimez-le.`);
}
const lastAuditPages = () => { const a = store.getAudits(); const l = a[a.length - 1]; return l && l.sitemapUrls ? l.sitemapUrls.slice(0, 40) : []; };
const makeRecord = (topic, art, month) => {
  const mode = store.getSettings().publishMode;
  return {
    id: crypto.randomUUID(), topicId: topic.id || null, keyword: topic.keyword, city: topic.city || '', month,
    createdAt: new Date().toISOString(), status: 'a_relire', wpId: null, wpLink: null, simulated: isSimulated(),
    essai: mode === 'essai', autoScheduled: mode === 'automatique', versionAt: new Date().toISOString(), versionLabel: 'Texte généré',
    ...art,
  };
};
// L'envoi automatique en brouillon est toujours actif en mode automatique (on ne publie que ce qui est déjà sur le site).
const sendsAutomatically = (s) => s.autoDraft || s.publishMode === 'automatique';
const confirmLength = (a, req) => {
  const c = rules.checkArticle(a);
  if (!c.inRange && !(req.body && req.body.confirmOutOfRange === true)) {
    throw fail(409, `Cet article compte ${c.words} mots (attendu ${rules.MIN_WORDS} à ${rules.MAX_WORDS}). Confirmez pour continuer quand même, ou régénérez-le.`, 'out_of_range');
  }
};
async function pushDraft(a) {
  const s = store.getSettings();
  let cat = s.blogCategoryId;
  if (!cat) { cat = await wp.ensureBlogCategory(); s.blogCategoryId = cat; store.saveSettings(s); }
  const post = await wp.createDraft(a, cat);
  Object.assign(a, { status: 'brouillon_wp', wpId: post.id, wpLink: post.link, wpSentAt: new Date().toISOString(), siteDirty: false });
  a.wpSyncHash = await liveHash(a);
}
// Empreinte du texte tel que WordPress l'a enregistré (au besoin celle de notre texte).
async function liveHash(a) {
  try { return arts.hashContent(a.simulated || isSimulated() ? a.htmlContent : await wp.getContent(a.wpId)); } catch { return arts.hashContent(a.htmlContent); }
}
const wpReady = () => isSimulated() || wp.configured();
const findArticle = (id) => {
  const list = store.getArticles();
  const a = list.find((x) => x.id === id);
  if (!a) throw fail(404, 'Article introuvable.');
  return { list, a };
};

app.get('/api/articles', (req, res) => res.json(store.getArticles().map(articleView).reverse()));
app.get('/api/articles/plan', (req, res) => res.json(planNow()));

// Supprime les articles de démonstration (localement seulement : ils n'existent pas vraiment sur le site).
app.post('/api/articles/purge-demo', wrap((req, res) => {
  const list = store.getArticles();
  const keep = list.filter((a) => !a.simulated);
  store.saveArticles(keep);
  res.json({ removed: list.length - keep.length });
}));

app.post('/api/articles/batch', wrap((req, res) => {
  if (batch.running) throw fail(409, 'Un lot est déjà en cours de rédaction.');
  const s = store.getSettings();
  const month = monthNow();
  const pl = planNow();
  if (pl.remaining <= 0) throw fail(409, `Le lot du mois est complet (${pl.already} article(s) pour une fréquence de ${s.frequency}). Supprimez un article ou augmentez la fréquence.`);
  const todo = pl.next;
  if (!todo.length) throw fail(400, pl.totalTopics ? 'Tous vos sujets ont déjà été utilisés ce mois-ci. Ajoutez de nouveaux sujets dans Réglages.' : 'Aucun sujet validé disponible. Ajoutez des sujets dans Réglages.');
  if (!isSimulated()) {
    if (!secrets.get('openrouterKey')) throw fail(400, 'La clé OpenRouter n\'est pas configurée. Saisissez-la dans Réglages, Rédaction.');
    if (!ai.effectiveModel(s)) throw fail(400, 'Aucun modèle OpenRouter choisi. Indiquez-en un dans Réglages, Rédaction automatique.');
  }

  Object.assign(batch, { running: true, total: todo.length, done: 0, errors: [], notes: [] });
  res.status(202).json({ started: todo.length });

  (async () => {
    const pages = lastAuditPages();
    for (const topic of todo) {
      try {
        const art = await ai.generateArticle(topic, s, pages);
        const rec = makeRecord(topic, art, month);
        const chk = rules.checkArticle(rec);
        if (sendsAutomatically(s) && wpReady() && !chk.inRange) {
          rec.autoDraftSkipped = 'length';
          batch.notes.push(`« ${topic.keyword} » : ${chk.words} mots (attendu ${rules.MIN_WORDS} à ${rules.MAX_WORDS}). Il n'a pas été envoyé sur le site : régénérez-le ou confirmez l'envoi.`);
        } else if (sendsAutomatically(s) && wpReady()) {
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

// Doit rester APRÈS les routes fixes (/plan, /batch/status, /test...) : « :id » intercepterait leur nom.
app.get('/api/articles/:id', wrap((req, res) => res.json(articleView(findArticle(req.params.id).a))));

// Essai de rédaction : un article « pour voir », sans envoi à WordPress ni utilisation du quota,
// tant qu'on ne clique pas sur « Garder ». Limité : 1 essai toutes les 3 secondes, 10 par jour.
let pendingTrial = null;
let lastTrialAt = 0;
const trialCount = { day: '', n: 0 };
const trialsPerDay = () => Number(process.env.TRIALS_PER_DAY) || 10;
const trialCooldown = () => (process.env.TRIAL_COOLDOWN_MS !== undefined ? Number(process.env.TRIAL_COOLDOWN_MS) : 3000);
const parisDay = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());

app.post('/api/articles/test', wrap(async (req, res) => {
  const b = req.body || {};
  const s = store.getSettings();
  let topic;
  if (b.topicId) {
    topic = s.topics.find((t) => t.id === b.topicId);
    if (!topic) throw fail(404, 'Sujet introuvable : il a peut-être été supprimé.');
  } else {
    const keyword = clean(b.keyword, 100);
    if (!keyword) throw fail(400, 'Choisissez un sujet de la liste ou saisissez un mot-clé.');
    topic = { id: null, keyword, city: clean(b.city, 60) };
  }
  if (!isSimulated()) {
    if (!secrets.get('openrouterKey')) throw fail(400, 'La clé OpenRouter n\'est pas configurée. Saisissez-la dans Réglages, Rédaction.');
    if (!ai.effectiveModel(s)) throw fail(400, 'Aucun modèle OpenRouter choisi. Indiquez-en un dans Réglages, Rédaction.');
  }
  if (Date.now() - lastTrialAt < trialCooldown()) throw fail(429, 'Patientez quelques secondes avant un nouvel essai.');
  const day = parisDay();
  if (trialCount.day !== day) { trialCount.day = day; trialCount.n = 0; }
  if (trialCount.n >= trialsPerDay()) throw fail(429, `Limite de ${trialsPerDay()} essais par jour atteinte (pour limiter les appels payants). Réessayez demain.`);
  lastTrialAt = Date.now();
  trialCount.n += 1;

  const pages = lastAuditPages();
  const sent = ai.previewPrompt(topic, s, pages);
  const article = await ai.generateArticle(topic, s, pages);
  pendingTrial = { id: crypto.randomUUID(), topic, article, simulated: isSimulated() };
  res.json({ trialId: pendingTrial.id, topic, article, check: rules.checkArticle(article), simulated: pendingTrial.simulated, sent, trialsLeft: trialsPerDay() - trialCount.n });
}));

app.post('/api/articles/test/keep', wrap(async (req, res) => {
  const t = pendingTrial;
  if (!t || !req.body || t.id !== req.body.trialId) throw fail(404, 'Cet essai n\'est plus disponible. Relancez-le.');
  if (!!t.simulated !== isSimulated()) throw fail(409, 'Le mode (démonstration ou réel) a changé depuis cet essai : relancez-le.');
  const s = store.getSettings();
  const rec = makeRecord(t.topic, t.article, monthNow());
  let autoDraftError = '';
  const chk = rules.checkArticle(rec);
  if (sendsAutomatically(s) && wpReady() && !chk.inRange) rec.autoDraftSkipped = 'length';
  else if (sendsAutomatically(s) && wpReady()) {
    try { await pushDraft(rec); } catch (e) { log.error('Envoi automatique de l\'essai échoué', e); autoDraftError = e.message; }
  }
  const list = store.getArticles();
  list.push(rec);
  store.saveArticles(list);
  pendingTrial = null;
  res.json({ article: articleView(rec), autoDraftError, autoDraftSkipped: rec.autoDraftSkipped || '' });
}));

app.post('/api/articles/:id/send', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status !== 'a_relire') throw fail(409, 'Cet article a déjà été envoyé à WordPress.');
  assertSameMode(a, 'envoyer');
  confirmLength(a, req);
  await pushDraft(a);
  store.saveArticles(list);
  res.json(articleView(a));
}));

app.post('/api/articles/:id/publish', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (!req.body || req.body.validated !== true) throw fail(400, 'Vous devez confirmer « J\'ai relu et validé ».');
  if (a.status !== 'brouillon_wp') throw fail(409, 'Envoyez d\'abord l\'article en brouillon WordPress.');
  assertSameMode(a, 'publier');
  confirmLength(a, req);
  // Garde-fou : on relit le texte réellement présent dans WordPress (il a pu être corrigé là-bas).
  if (!isSimulated()) {
    const live = await wp.getContent(a.wpId);
    if (live.includes('[SOURCE A VERIFIER]')) throw fail(409, 'Le texte contient encore « [SOURCE A VERIFIER] ». Remplacez ce marqueur par une vraie source (ou supprimez la phrase) dans WordPress, puis réessayez.');
  }
  const r = await wp.publish(a.wpId);
  Object.assign(a, { status: 'publie', wpLink: r.link || a.wpLink, publishedAt: new Date().toISOString() });
  store.saveArticles(list);
  res.json(articleView(a));
}));

app.delete('/api/articles/:id', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est publié : supprimez-le directement dans WordPress.');
  // Un article de démonstration n'existe pas sur le site : on ne touche jamais à WordPress pour lui.
  if (a.status === 'brouillon_wp' && a.wpId && !a.simulated) { assertSameMode(a, 'supprimer sur le site'); await wp.deleteDraft(a.wpId); }
  store.saveArticles(list.filter((x) => x.id !== a.id));
  res.json({ ok: true });
}));

// --- Audit ---
app.get('/api/audits', (req, res) => {
  const audits = store.getAudits();
  const latest = audits[audits.length - 1] || null;
  const previous = audits.length > 1 ? audits[audits.length - 2] : null;
  res.json({
    latest,
    previous: previous ? { id: previous.id, date: previous.date, score: previous.score, criteria: previous.criteria.map((c) => ({ id: c.id, points: c.points, max: c.max })) } : null,
    history: audits.map((a) => ({ id: a.id, date: a.date, score: a.score, trigger: a.trigger })),
    status: audit.status(),
  });
});

// Export de l'historique : pour garder une trace durable même sans disque persistant.
app.get('/api/audits/export.csv', (req, res) => {
  const audits = store.getAudits();
  const ids = audits.length ? audits[audits.length - 1].criteria.map((c) => c.id) : [];
  const rows = [['date', 'score_sur_100', 'lancement', 'pages_analysees', ...ids]];
  for (const a of audits) rows.push([a.date, a.score, a.trigger, a.pagesCount, ...ids.map((id) => { const c = a.criteria.find((x) => x.id === id); return c ? (c.points == null ? 'non_mesure' : c.points) : ''; })]);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="historique-score-seo.csv"' });
  res.send('\ufeff' + rows.map((r) => r.join(';')).join('\n') + '\n');
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
  app.listen(port, () => log.info(`Tableau de bord CityLock sur le port ${port}${isSimulated() ? ' (MODE SIMULATION)' : ''}`));
}
module.exports = app;
