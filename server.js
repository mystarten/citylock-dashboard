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
const dates = require('./lib/dates');
const journal = require('./lib/journal');

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
  return { ...rest, wpUser: (s.wpUser || '').trim(), secrets: secrets.status(), promptProblems: ai.promptProblems(s.systemPrompt) };
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '');

app.get('/api/settings', (req, res) => res.json(publicSettings()));

app.put('/api/settings', wrap((req, res) => {
  const b = req.body || {};
  const s = store.getSettings();
  const zone = b.zone !== undefined ? clean(b.zone, 80) : s.zone;
  const brandName = b.brandName !== undefined ? clean(b.brandName, 60) : s.brandName;
  if (!zone || !brandName) throw fail(400, 'La zone desservie et le nom commercial sont obligatoires.');
  if (b.simulate !== undefined && typeof b.simulate !== 'boolean') throw fail(400, 'Réglage invalide.');
  // Le modèle n'est PAS modifiable ici : il passe par POST /api/ai/model (test avant activation).
  if (b.systemPrompt !== undefined) {
    if (typeof b.systemPrompt !== 'string') throw fail(400, 'Instructions invalides.');
    const p = b.systemPrompt.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (p.length > ai.MAX_RULES_LENGTH) throw fail(400, `Le prompt est trop long (maximum ${ai.MAX_RULES_LENGTH} caractères).`);
    if (p.length < 80) throw fail(400, 'Le prompt est trop court pour être utile (80 caractères minimum). Utilisez « Rétablir le texte d\'origine » pour repartir du texte fourni.');
    s.systemPrompt = p;
  }
  const lim = (v, label) => { if (!Number.isInteger(v) || v < 50 || v > 3000) throw fail(400, `${label} : un nombre entier entre 50 et 3000.`); return v; };
  const minWords = b.minWords !== undefined ? lim(b.minWords, 'Longueur minimale') : s.minWords;
  const maxWords = b.maxWords !== undefined ? lim(b.maxWords, 'Longueur maximale') : s.maxWords;
  if (minWords > maxWords) throw fail(400, 'La longueur minimale ne peut pas dépasser la longueur maximale.');
  Object.assign(s, { zone, brandName, minWords, maxWords });
  if (typeof b.simulate === 'boolean') s.simulate = b.simulate;
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

app.get('/api/ai/defaults', (req, res) => {
  const set = store.getSettings();
  res.json({ systemPrompt: ai.DEFAULT_RULES, maxLength: ai.MAX_RULES_LENGTH, minWords: rules.MIN_WORDS, maxWords: rules.MAX_WORDS, envModel: process.env.OPENROUTER_MODEL || '', activeModel: ai.effectiveModel(set), previousModel: set.aiModelPrevious || '' });
});

let lastAiTest = 0;
const aiCooldown = () => { if (Date.now() - lastAiTest < 2000) throw fail(429, 'Patientez quelques secondes avant de retester.'); lastAiTest = Date.now(); };

app.post('/api/ai/test', wrap(async (req, res) => {
  aiCooldown();
  res.json(await ai.testModel(store.getSettings()));
}));

// Changer de modèle : on le TESTE d'abord, et on ne l'active que si le test réussit.
// En cas d'échec, le modèle actuel est conservé (l'application ne reste jamais sans modèle).
app.post('/api/ai/model', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.model !== 'string') throw fail(400, 'Modèle invalide.');
  const candidate = b.model.trim();
  if (candidate && !ai.MODEL_PATTERN.test(candidate)) throw fail(400, 'Identifiant de modèle invalide. Copiez-le tel quel depuis openrouter.ai/models (exemple : anthropic/claude-haiku-5-5), sans espace.');
  const s = store.getSettings();
  const current = ai.effectiveModel(s);
  if (isSimulated()) {
    return res.json({ ok: false, simulated: true, active: current, message: 'Mode démonstration : aucun test réel n\'est fait, le modèle n\'a pas été changé. Désactivez le mode démonstration (Réglages, Connexions) pour tester et activer un modèle.' });
  }
  aiCooldown();
  let tested;
  try { tested = await ai.testModel(s, candidate); } catch (e) {
    const reason = e.simple || e.message;
    log.warn(`Test du modèle « ${candidate || '(modèle du serveur)'} » échoué : ${reason}`);
    return res.json({ ok: false, active: current, reason, message: `Ce modèle n'a pas répondu : ${reason}. Le modèle actuel est conservé : ${current || 'aucun'}.` });
  }
  if (candidate !== (s.aiModel || '')) { s.aiModelPrevious = s.aiModel || ''; s.aiModel = candidate; store.saveSettings(s); }
  log.info(`Modèle activé : ${tested.model}`);
  res.json({ ok: true, model: tested.model, active: tested.model, message: `Modèle activé : ${tested.model}` });
}));

app.get('/api/wp/test', wrap(async (req, res) => res.json(await wp.testConnection())));

// Yoast : les champs (mot-clé, titre SEO, description) ne sont acceptés par WordPress que si le site les déclare.
app.get('/api/wp/yoast', wrap(async (req, res) => res.json(await wp.yoastStatus())));

app.post('/api/category/ensure', wrap(async (req, res) => {
  const id = await wp.ensureBlogCategory();
  const s = store.getSettings();
  s.blogCategoryId = id;
  store.saveSettings(s);
  res.json({ id });
}));

// --- Articles ---
const batch = { running: false, total: 0, done: 0, errors: [], notes: [] };
const limitsNow = () => { const s = store.getSettings(); return { min: s.minWords || rules.MIN_WORDS, max: s.maxWords || rules.MAX_WORDS }; };
const checkArt = (a) => rules.checkArticle(a, limitsNow());
const articleView = (a) => arts.view(a, limitsNow());

const modeName = (sim) => (sim ? 'démonstration' : 'réel');
function assertSameMode(a, action) {
  if (!!a.simulated !== isSimulated()) throw fail(409, `Cet article a été créé en mode ${modeName(!!a.simulated)}. Repassez en mode ${modeName(!!a.simulated)} (Réglages, Connexions) pour le ${action}, ou supprimez-le.`);
}
const lastAuditPages = () => { const a = store.getAudits(); const l = a[a.length - 1]; return l && l.sitemapUrls ? l.sitemapUrls.slice(0, 40) : []; };
const makeRecord = (topic, art, extra = {}) => ({
  id: crypto.randomUUID(), topicId: topic.id || null, keyword: topic.keyword, city: topic.city || '',
  createdAt: new Date().toISOString(), status: 'a_relire', wpId: null, wpLink: null, simulated: isSimulated(),
  versionAt: new Date().toISOString(), versionLabel: 'Texte généré', ...art, ...extra,
});
const confirmLength = (a, flags) => {
  const c = checkArt(a);
  if (!c.inRange && !(flags && flags.confirmOutOfRange === true)) {
    throw fail(409, `Cet article compte ${c.words} mots (attendu ${c.limits.min} à ${c.limits.max}). Confirmez pour continuer quand même, ou régénérez-le.`, 'out_of_range');
  }
};
// Envoi en brouillon : crée l'article sur le site et note ce que WordPress contient réellement.
async function pushDraft(a) {
  const s = store.getSettings();
  let cat = s.blogCategoryId;
  if (!cat) { cat = await wp.ensureBlogCategory(); s.blogCategoryId = cat; store.saveSettings(s); }
  const post = await wp.createDraft(a, cat);
  Object.assign(a, { status: 'brouillon_wp', wpId: post.id, wpLink: post.link, yoast: !!post.yoast, wpSentAt: new Date().toISOString(), siteDirty: false });
  a.wpSyncHash = await liveHash(a);
}
// Empreinte du texte tel que WordPress l'a enregistré (au besoin celle de notre texte).
async function liveHash(a) {
  try { return arts.hashContent(a.simulated || isSimulated() ? a.htmlContent : await wp.getContent(a.wpId)); } catch { return arts.hashContent(a.htmlContent); }
}
// Le texte a-t-il été modifié directement dans WordPress depuis le dernier envoi ? Retourne un message si le site ne répond pas.
async function assertNoSiteConflict(a, force) {
  if (force || !a.wpSyncHash) return '';
  try {
    if (arts.hashContent(await wp.getContent(a.wpId)) !== a.wpSyncHash) {
      throw fail(409, 'Le texte a été modifié directement dans WordPress depuis le dernier envoi. Enregistrer ici écraserait ces changements. Confirmez pour les écraser.', 'wp_changed');
    }
  } catch (e) { if (e.code === 'wp_changed') throw e; return e.message; }
  return '';
}
const saveArticle = store.saveArticle; // enregistre UN article sur la liste la plus récente (voir lib/store.js)
const findArticle = (id) => {
  const list = store.getArticles();
  const a = list.find((x) => x.id === id);
  if (!a) throw fail(404, 'Article introuvable.');
  return { list, a };
};

// Articles programmés : on demande à WordPress s'il les a publiés (au plus toutes les 2 minutes).
let lastSync = 0;
async function syncScheduled() {
  if (isSimulated() || Date.now() - lastSync < Number(process.env.SYNC_MIN_INTERVAL_MS ?? 120000)) return;
  const due = store.getArticles().filter((a) => a.status === 'programme' && !a.simulated && a.wpId && a.scheduledAt && Date.now() > new Date(a.scheduledAt).getTime() + 2 * 60000);
  if (!due.length) return;
  lastSync = Date.now();
  for (const x of due) {
    try {
      const r = await wp.getStatus(x.wpId);
      const a = store.getArticles().find((y) => y.id === x.id);
      if (!a || a.status !== 'programme') continue;
      if (r.status === 'publish') {
        Object.assign(a, { status: 'publie', publishedAt: a.scheduledAt, wpLink: r.link || a.wpLink, publishedBy: 'programmation' });
        saveArticle(a); journal.logEvent(a, 'publication', { by: 'programmation' }, new Date(a.scheduledAt));
      } else if (r.status === 'draft') { a.status = 'brouillon_wp'; delete a.scheduledAt; saveArticle(a); }
    } catch (e) { log.warn('Suivi d\'un article programmé impossible', e); }
  }
}

app.get('/api/articles', wrap(async (req, res) => { await syncScheduled(); res.json(store.getArticles().map(articleView).reverse()); }));

// Supprime les articles de démonstration (localement seulement : ils n'existent pas vraiment sur le site).
app.post('/api/articles/purge-demo', wrap((req, res) => {
  const list = store.getArticles();
  const keep = list.filter((a) => !a.simulated);
  store.saveArticles(keep);
  res.json({ removed: list.length - keep.length });
}));

app.get('/api/publications', (req, res) => res.json(journal.getLog().slice(-100).reverse()));

// ---------- Rédiger : un article, ou plusieurs ----------
// Un appel payant à la demande : 1 toutes les 3 secondes, 40 articles par jour (garde-fou contre les erreurs et les boucles).
const writeCount = { day: '', n: 0 };
let lastWriteAt = 0;
const writesPerDay = () => Number(process.env.WRITES_PER_DAY) || 40;
const writeCooldown = () => (process.env.WRITE_COOLDOWN_MS !== undefined ? Number(process.env.WRITE_COOLDOWN_MS) : 3000);
const parisDay = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());
function takeWriteSlot(n = 1) {
  if (Date.now() - lastWriteAt < writeCooldown()) throw fail(429, 'Patientez quelques secondes avant une nouvelle rédaction.');
  const day = parisDay();
  if (writeCount.day !== day) { writeCount.day = day; writeCount.n = 0; }
  if (writeCount.n + n > writesPerDay()) throw fail(429, `Limite de ${writesPerDay()} articles rédigés par jour atteinte (pour limiter les appels payants).${n > 1 ? ` Vous en demandez ${n}, il en reste ${Math.max(0, writesPerDay() - writeCount.n)}.` : ''} Réessayez demain.`);
  lastWriteAt = Date.now();
  writeCount.n += n;
}
function assertWriteReady(s) {
  if (isSimulated()) return;
  if (!secrets.get('openrouterKey')) throw fail(400, 'La clé OpenRouter n\'est pas configurée. Saisissez-la dans Réglages, Connexions.');
  if (!ai.effectiveModel(s)) throw fail(400, 'Aucun modèle OpenRouter choisi. Indiquez-en un dans Réglages, Rédaction.');
}
function resolveTopic(b, s) {
  if (b.topicId) {
    const t = s.topics.find((x) => x.id === b.topicId);
    if (!t) throw fail(404, 'Sujet introuvable : il a peut-être été supprimé.');
    return t;
  }
  const keyword = clean(b.keyword, 100);
  if (!keyword) throw fail(400, 'Choisissez un sujet de la liste ou saisissez un mot-clé.');
  return { id: null, keyword, city: clean(b.city, 60) };
}

// Mode « Un article » : rédigé, rangé dans « Articles » (en attente), prêt à être modifié, envoyé ou programmé.
app.post('/api/write/one', wrap(async (req, res) => {
  const s = store.getSettings();
  const topic = resolveTopic(req.body || {}, s);
  assertWriteReady(s);
  takeWriteSlot(1);
  const art = await ai.generateArticle(topic, s, lastAuditPages());
  const rec = makeRecord(topic, art);
  store.saveArticles([...store.getArticles(), rec]);
  res.json({ article: articleView(rec) });
}));

// Ce qui serait envoyé à l'IA pour ce sujet (pour vérifier que le sujet et la ville sont bien pris en compte).
app.post('/api/write/preview', wrap((req, res) => {
  const s = store.getSettings();
  res.json({ sent: ai.previewPrompt(resolveTopic(req.body || {}, s), s, lastAuditPages()), problems: ai.promptProblems(s.systemPrompt) });
}));

// Mode « Plusieurs articles » : propose un planning (sujets de la liste, dans l'ordre, et une date par article).
app.post('/api/write/plan', wrap((req, res) => {
  const b = req.body || {};
  const months = Number(b.months), perMonth = Number(b.perMonth);
  if (!Number.isInteger(months) || months < 1 || months > 6) throw fail(400, 'Le nombre de mois doit être entre 1 et 6.');
  if (!Number.isInteger(perMonth) || perMonth < 1 || perMonth > 3) throw fail(400, 'Le nombre d\'articles par mois doit être entre 1 et 3.');
  if (!dates.isDate(b.startDate)) throw fail(400, 'Choisissez la date du premier article.');
  if (b.startDate < dates.todayParis()) throw fail(400, 'La date du premier article doit être aujourd\'hui ou plus tard.');
  const items = dates.buildPlan({ months, perMonth, startDate: b.startDate, topics: store.getSettings().topics });
  res.json({ items, missing: items.filter((i) => !i.topicId).length });
}));

// Rédige tous les articles du planning, en arrière-plan, en brouillons à relire (rien n'est envoyé sur le site).
app.post('/api/write/batch', wrap((req, res) => {
  if (batch.running) throw fail(409, 'Une rédaction est déjà en cours.');
  const s = store.getSettings();
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 18) throw fail(400, 'Le planning doit contenir de 1 à 18 articles.');
  const today = dates.todayParis(), limit = dates.addDays(today, 400);
  const todo = items.map((it) => {
    const topic = resolveTopic(it || {}, s);
    if (!dates.isDate(it.plannedDate) || it.plannedDate < today || it.plannedDate > limit) throw fail(400, `Date invalide pour « ${topic.keyword} » : choisissez une date entre aujourd'hui et dans 400 jours.`);
    return { topic, plannedDate: it.plannedDate };
  });
  assertWriteReady(s);
  takeWriteSlot(todo.length);
  Object.assign(batch, { running: true, total: todo.length, done: 0, errors: [], notes: [] });
  res.status(202).json({ started: todo.length });

  (async () => {
    const pages = lastAuditPages();
    for (const { topic, plannedDate } of todo) {
      try {
        const art = await ai.generateArticle(topic, s, pages);
        const rec = makeRecord(topic, art, { plannedDate });
        store.saveArticles([...store.getArticles(), rec]);
        const c = checkArt(rec);
        if (!c.inRange) batch.notes.push(`« ${topic.keyword} » : ${c.words} mots (attendu ${c.limits.min} à ${c.limits.max}). À régénérer ou à corriger avant de le programmer.`);
      } catch (e) {
        log.error(`Rédaction échouée pour « ${topic.keyword} »`, e);
        batch.errors.push(`${topic.keyword} : ${e.message}`);
      }
      batch.done += 1;
    }
    batch.running = false;
  })().catch((e) => { log.error('Rédaction en lot en échec', e); batch.running = false; });
}));

app.get('/api/write/status', (req, res) => res.json(batch));

// Doit rester APRÈS les routes fixes de /api/articles/... : « :id » intercepterait leur nom.
app.get('/api/articles/:id', wrap((req, res) => res.json(articleView(findArticle(req.params.id).a))));

// ---------- Modification manuelle, historique, régénération ----------
const lines = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((x) => clean(String(x), 300)).filter(Boolean).slice(0, 30);

// Valide les champs reçus. Seuls les champs présents sont retournés.
function cleanEditFields(b) {
  const f = {};
  if (b.title !== undefined) { f.title = clean(b.title, 200); if (!f.title) throw fail(400, 'Le titre est obligatoire.'); }
  if (b.metaTitle !== undefined) f.metaTitle = clean(b.metaTitle, 300);
  if (b.metaDescription !== undefined) f.metaDescription = clean(b.metaDescription, 500);
  if (b.keyword !== undefined) { f.keyword = clean(b.keyword, 100); if (!f.keyword) throw fail(400, 'Le mot-clé principal est obligatoire.'); }
  if (b.slug !== undefined) f.slug = ai.slugify(String(b.slug)).slice(0, 80);
  if (b.htmlContent !== undefined) {
    if (typeof b.htmlContent !== 'string') throw fail(400, 'Texte invalide.');
    if (b.htmlContent.length > 60000) throw fail(400, 'Le texte est trop long (60 000 caractères maximum).');
    f.htmlContent = ai.sanitizeHtml(b.htmlContent.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''));
    if (!f.htmlContent) throw fail(400, 'Le texte est vide.');
  }
  if (b.faitsAVerifier !== undefined) f.faitsAVerifier = lines(b.faitsAVerifier);
  if (f.slug === '' && f.title) f.slug = ai.slugify(f.title).slice(0, 80);
  return f;
}

// Enregistre un changement (modification, retour arrière, régénération) et, si l'article est déjà un brouillon
// sur le site, met aussi ce brouillon à jour. Sans cela, publier enverrait l'ancien texte.
async function commitEdit(list, a, fields, label, { force = false } = {}) {
  const onSite = ['brouillon_wp', 'programme'].includes(a.status) && !!a.wpId && !a.simulated;
  if (onSite) assertSameMode(a, 'modifier');
  const checkError = onSite ? await assertNoSiteConflict(a, force) : '';
  if (fields) arts.applyFields(a, fields, label, limitsNow());
  let syncError = '';
  if (onSite) {
    if (checkError) { a.siteDirty = true; syncError = checkError; }
    else {
      try { const u = await wp.updateDraft(a.wpId, a); a.yoast = !!u.yoast; a.wpSyncHash = await liveHash(a); a.siteDirty = false; } catch (e) { a.siteDirty = true; syncError = e.message; log.error('Mise à jour du brouillon sur le site échouée', e); }
    }
  }
  saveArticle(a);
  return { article: articleView(a), syncError, siteUpdated: onSite && !syncError };
}

app.put('/api/articles/:id', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est publié : modifiez-le directement dans WordPress.');
  const fields = cleanEditFields(req.body || {});
  const changed = !arts.sameFields(a, fields);
  if (!changed && !a.siteDirty) return res.json({ article: articleView(a), unchanged: true });
  res.json(await commitEdit(list, a, changed ? fields : null, 'Modification manuelle', { force: !!(req.body && req.body.force) }));
}));

app.put('/api/articles/:id/planned', wrap((req, res) => {
  const { a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est déjà publié.');
  const d = req.body && req.body.plannedDate;
  if (d !== '' && !dates.isDate(d)) throw fail(400, 'Date invalide.');
  a.plannedDate = d || undefined;
  saveArticle(a);
  res.json(articleView(a));
}));

app.get('/api/articles/:id/versions', wrap((req, res) => res.json({ versions: arts.versionList(findArticle(req.params.id).a) })));

// Revenir à une version précédente (par défaut la dernière). L'état actuel est gardé dans l'historique : rien n'est perdu.
app.post('/api/articles/:id/revert', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est publié : modifiez-le directement dans WordPress.');
  const versions = a.versions || [];
  if (!versions.length) throw fail(409, 'Il n\'y a pas de version précédente.');
  const idx = req.body && req.body.index !== undefined ? Number(req.body.index) : versions.length - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= versions.length) throw fail(400, 'Version introuvable.');
  const v = versions[idx];
  a.versions = versions.filter((_, i) => i !== idx);
  const fields = { title: v.title, metaTitle: v.metaTitle, metaDescription: v.metaDescription, slug: v.slug, keyword: v.keyword, htmlContent: v.htmlContent, faitsAVerifier: [...v.faitsAVerifier] };
  res.json(await commitEdit(list, a, fields, 'Version restaurée', { force: !!(req.body && req.body.force) }));
}));

// Régénérer : un nouvel article pour le même sujet. L'ancien texte reste dans l'historique.
app.post('/api/articles/:id/regenerate', wrap(async (req, res) => {
  const { list, a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est publié : il ne peut plus être régénéré ici.');
  assertSameMode(a, 'régénérer');
  const s = store.getSettings();
  if (!isSimulated()) {
    if (!secrets.get('openrouterKey')) throw fail(400, 'La clé OpenRouter n\'est pas configurée. Saisissez-la dans Réglages, Connexions.');
    if (!ai.effectiveModel(s)) throw fail(400, 'Aucun modèle OpenRouter choisi. Indiquez-en un dans Réglages, Rédaction.');
  }
  takeWriteSlot(1);
  const art = await ai.generateArticle({ keyword: a.keyword, city: a.city }, s, lastAuditPages());
  a.modelUsed = art.modelUsed;
  a.internalLinkSuggestions = art.internalLinkSuggestions;
  const fields = { title: art.title, metaTitle: art.metaTitle, metaDescription: art.metaDescription, slug: art.slug, htmlContent: art.htmlContent, faitsAVerifier: art.faitsAVerifier };
  res.json(await commitEdit(list, a, fields, 'Régénération', { force: !!(req.body && req.body.force) }));
}));

// Aperçu et contrôle d'un texte en cours d'écriture (rien n'est enregistré).
app.post('/api/preview', wrap((req, res) => {
  const b = req.body || {};
  if (b.htmlContent !== undefined && typeof b.htmlContent !== 'string') throw fail(400, 'Texte invalide.');
  const html = ai.sanitizeHtml(String(b.htmlContent || '').slice(0, 60000));
  const check = checkArt({ title: clean(b.title, 200), metaTitle: clean(b.metaTitle, 300), metaDescription: clean(b.metaDescription, 500), htmlContent: html, faitsAVerifier: lines(b.faitsAVerifier) });
  res.json({ html, check });
}));

app.post('/api/articles/:id/send', wrap(async (req, res) => {
  const { a } = findArticle(req.params.id);
  if (a.status !== 'a_relire') throw fail(409, 'Cet article est déjà sur le site.');
  assertSameMode(a, 'envoyer');
  confirmLength(a, req.body);
  await pushDraft(a);
  saveArticle(a);
  res.json(articleView(a));
}));

// ---------- Programmer : WordPress publie l'article tout seul à la date choisie ----------
const MARKER_MSG = 'Le texte contient encore « [SOURCE A VERIFIER] ». Remplacez ce marqueur par une vraie source (ou supprimez la phrase), puis réessayez.';
function whenOf(body) {
  const b = body || {};
  if (!dates.isDate(b.date)) throw fail(400, 'Choisissez une date de publication.');
  const [hh, mm] = /^\d{2}:\d{2}$/.test(b.time || '') ? b.time.split(':').map(Number) : [9, 0];
  const when = dates.parisToUtc(b.date, hh, mm);
  if (when.getTime() < Date.now() + 5 * 60000) throw fail(400, 'La date de publication doit être dans le futur (au moins 5 minutes).');
  if (when.getTime() > Date.now() + 400 * 86400000) throw fail(400, 'La date de publication est trop lointaine (400 jours au maximum).');
  return when;
}
async function scheduleOne(a, when, flags = {}) {
  if (!['a_relire', 'brouillon_wp', 'programme'].includes(a.status)) throw fail(409, 'Cet article ne peut pas être programmé.');
  assertSameMode(a, 'programmer');
  if (a.siteDirty) throw fail(409, 'Vos dernières modifications ne sont pas encore envoyées sur le site. Ouvrez « Modifier » et enregistrez à nouveau pour réessayer.', 'site_dirty');
  if (a.htmlContent.includes(rules.MARKER)) throw fail(409, MARKER_MSG, 'marker');
  confirmLength(a, flags);
  const others = checkArt(a).issues.filter((i) => i.blocking && i.code !== 'length');
  if (others.length && flags.confirmIssues !== true) throw fail(409, `Cet article a des points à vérifier : ${others.map((i) => i.message).join(' ')} Confirmez pour le programmer quand même.`, 'issues');
  if (a.wpId && !a.simulated) {
    const err = await assertNoSiteConflict(a, flags.force === true);
    if (err) throw new Error(err);
    if (!isSimulated() && (await wp.getContent(a.wpId)).includes(rules.MARKER)) throw fail(409, MARKER_MSG, 'marker');
  }
  const s = store.getSettings();
  let cat = s.blogCategoryId;
  if (!cat && !a.wpId) { cat = await wp.ensureBlogCategory(); s.blogCategoryId = cat; store.saveSettings(s); }
  const post = await wp.schedule(a, when, cat);
  Object.assign(a, { status: 'programme', wpId: post.id, wpLink: post.link, yoast: !!post.yoast, scheduledAt: when.toISOString(), wpSentAt: a.wpSentAt || new Date().toISOString(), siteDirty: false });
  a.wpSyncHash = await liveHash(a);
  saveArticle(a);
  journal.logEvent(a, 'programmation', { forAt: a.scheduledAt });
}

app.post('/api/articles/:id/schedule', wrap(async (req, res) => {
  const { a } = findArticle(req.params.id);
  await scheduleOne(a, whenOf(req.body), req.body || {});
  res.json(articleView(a));
}));

// Programme d'un coup tous les articles prêts qui ont une date prévue. Aucun point à vérifier n'est ignoré :
// un article avec un souci (longueur, mot interdit, source, fait à vérifier) est laissé de côté, avec la raison.
app.post('/api/articles/schedule-all', wrap(async (req, res) => {
  const out = { scheduled: [], skipped: [] };
  const acceptFacts = !!(req.body && req.body.acceptFacts === true);
  const todo = store.getArticles().filter((a) => ['a_relire', 'brouillon_wp'].includes(a.status) && a.plannedDate && !!a.simulated === isSimulated()).sort((x, y) => x.plannedDate.localeCompare(y.plannedDate));
  for (const x of todo) {
    const a = store.getArticles().find((y) => y.id === x.id);
    if (!a) continue;
    // Longueur, mot interdit et marqueur de source : jamais ignorés. Les « faits à vérifier » ne le sont que si vous l'avez confirmé.
    const reasons = checkArt(a).issues.filter((i) => i.blocking && (i.code !== 'facts' || !acceptFacts)).map((i) => i.message);
    if (reasons.length) { out.skipped.push({ id: a.id, title: a.title, reasons }); continue; }
    try {
      await scheduleOne(a, whenOf({ date: a.plannedDate }), { confirmIssues: acceptFacts });
      out.scheduled.push({ id: a.id, title: a.title, at: a.scheduledAt });
    } catch (e) { out.skipped.push({ id: a.id, title: a.title, reasons: [e.message] }); }
  }
  res.json(out);
}));

app.post('/api/articles/:id/unschedule', wrap(async (req, res) => {
  const { a } = findArticle(req.params.id);
  if (a.status !== 'programme') throw fail(409, 'Cet article n\'est pas programmé.');
  assertSameMode(a, 'annuler la programmation');
  if (!a.simulated) await wp.unschedule(a.wpId);
  a.status = 'brouillon_wp'; delete a.scheduledAt;
  saveArticle(a);
  journal.logEvent(a, 'annulation');
  res.json(articleView(a));
}));

app.post('/api/articles/:id/publish', wrap(async (req, res) => {
  const { a } = findArticle(req.params.id);
  if (!req.body || req.body.validated !== true) throw fail(400, 'Vous devez confirmer « J\'ai relu et validé ».');
  if (!['brouillon_wp', 'programme'].includes(a.status)) throw fail(409, 'Envoyez d\'abord l\'article en brouillon WordPress.');
  assertSameMode(a, 'publier');
  if (a.siteDirty) throw fail(409, 'Vos dernières modifications ne sont pas encore envoyées sur le site. Ouvrez « Modifier » et enregistrez à nouveau pour réessayer.', 'site_dirty');
  confirmLength(a, req.body);
  // Garde-fou : on relit le texte réellement présent dans WordPress (il a pu être corrigé là-bas).
  if (!isSimulated() && (await wp.getContent(a.wpId)).includes(rules.MARKER)) throw fail(409, MARKER_MSG, 'marker');
  const r = await wp.publish(a.wpId, { resetDate: a.status === 'programme' });
  Object.assign(a, { status: 'publie', wpLink: r.link || a.wpLink, publishedAt: new Date().toISOString(), publishedBy: 'manuel' });
  delete a.scheduledAt;
  saveArticle(a);
  journal.logEvent(a, 'publication', { by: 'manuel' });
  res.json(articleView(a));
}));

app.delete('/api/articles/:id', wrap(async (req, res) => {
  const { a } = findArticle(req.params.id);
  if (a.status === 'publie') throw fail(409, 'Cet article est publié : supprimez-le directement dans WordPress.');
  // Un article de démonstration n'existe pas sur le site : on ne touche jamais à WordPress pour lui.
  if (['brouillon_wp', 'programme'].includes(a.status) && a.wpId && !a.simulated) { assertSameMode(a, 'supprimer sur le site'); await wp.deleteDraft(a.wpId); }
  store.saveArticles(store.getArticles().filter((x) => x.id !== a.id));
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
  // Articles programmés : on vérifie chaque heure que WordPress les a bien publiés.
  cron.schedule('5 * * * *', () => { syncScheduled().catch((e) => log.error('Suivi des articles programmés échoué', e)); }, { timezone: 'Europe/Paris' });
  // Tâche planifiée : lundi 8 h, Europe/Paris.
  cron.schedule('0 8 * * 1', () => { audit.runAudit('hebdomadaire').catch(() => {}); }, { timezone: 'Europe/Paris' });
  app.listen(port, () => log.info(`Tableau de bord CityLock sur le port ${port}${isSimulated() ? ' (MODE SIMULATION)' : ''}`));
}
module.exports = app;
