// Publication automatique et journal des publications.
// Désactivée par défaut. Un article n'est publié automatiquement que si TOUTES les conditions sont réunies ;
// le texte réellement présent sur le site est relu juste avant de publier.
const crypto = require('crypto');
const store = require('./store');
const wp = require('./wp');
const rules = require('./rules');
const log = require('./log');
const { isSimulated } = require('./config');

const DAY = 86400000;

// Lundi (date Paris, au format AAAA-MM-JJ) de la semaine de `date` : sert à compter les publications par semaine.
function weekKey(date) {
  const [y, m, d] = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(date).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

const scheduledAt = (a, s) => new Date(new Date(a.wpSentAt || a.createdAt).getTime() + s.autoPublishDelayDays * DAY);

// Raisons pour lesquelles l'article n'est pas publiable automatiquement (vide = tout est bon localement).
function localReasons(a, s, now) {
  const r = [];
  if (s.publishMode !== 'automatique') r.push('le mode automatique n\'est pas activé');
  if (s.publishPaused) r.push('les publications sont suspendues (« Tout arrêter »)');
  if (!a.autoScheduled || !a.autoEpoch || a.autoEpoch !== s.autoEpoch) r.push('l\'article n\'a pas été créé pendant la période actuelle du mode automatique');
  if (a.autoCancelled) r.push('la publication automatique a été annulée pour cet article');
  if (a.status !== 'brouillon_wp' || !a.wpId) r.push('l\'article n\'est pas un brouillon sur le site');
  if (a.simulated) r.push('article de démonstration');
  if (a.essai) r.push('article marqué « essai »');
  if (a.siteDirty) r.push('des modifications ne sont pas encore envoyées sur le site');
  const c = rules.checkArticle(a);
  for (const i of c.issues) if (i.blocking) r.push(i.message);
  if (now < scheduledAt(a, s)) r.push(`la date de publication prévue n'est pas atteinte (${scheduledAt(a, s).toISOString().slice(0, 10)})`);
  return r;
}

const getLog = () => store.getPublications();
function logPublication(a, by, now = new Date()) {
  const entry = { id: crypto.randomUUID(), at: now.toISOString(), title: a.title, url: a.wpLink || '', by, articleId: a.id, ...(a.simulated ? { simulated: true } : {}) };
  store.savePublications([...getLog(), entry].slice(-500));
  log.info(`Publication (${by}) : « ${a.title} » ${a.wpLink || ''}`);
  return entry;
}

const autoPublishedThisWeek = (now) => getLog().filter((e) => e.by === 'automatique' && !e.simulated && weekKey(new Date(e.at)) === weekKey(now)).length;

// Passe en revue les brouillons programmés et publie ceux qui remplissent toutes les conditions.
// Les réglages sont relus avant CHAQUE publication : « Tout arrêter » agit immédiatement.
async function tick({ now = new Date() } = {}) {
  const out = { published: [], skipped: [], reason: '' };
  const s0 = store.getSettings();
  if (s0.publishMode !== 'automatique') { out.reason = 'mode'; return out; }
  if (s0.publishPaused) { out.reason = 'pause'; return out; }
  if (isSimulated()) { out.reason = 'demonstration'; return out; }

  let done = autoPublishedThisWeek(now);
  const candidates = store.getArticles().filter((a) => a.autoScheduled && a.status === 'brouillon_wp').sort((x, y) => scheduledAt(x, s0) - scheduledAt(y, s0));
  for (const c of candidates) {
    const s = store.getSettings();
    if (s.publishMode !== 'automatique' || s.publishPaused) { out.reason = 'pause'; break; }
    if (done >= s.autoPublishMaxPerWeek) { out.reason = 'plafond'; break; }
    const a = store.getArticles().find((x) => x.id === c.id);
    if (!a) continue;
    const local = localReasons(a, s, now);
    if (local.length) { out.skipped.push({ id: a.id, title: a.title, reasons: local }); continue; }

    // Le texte qui serait publié est celui du SITE : on le contrôle lui aussi.
    let live;
    try { live = await wp.getContent(a.wpId); } catch (e) { out.skipped.push({ id: a.id, title: a.title, reasons: ['le site n\'a pas répondu'] }); continue; }
    const liveIssues = rules.checkArticle({ ...a, htmlContent: live, faitsAVerifier: [] }).issues.filter((i) => i.blocking);
    if (liveIssues.length) { out.skipped.push({ id: a.id, title: a.title, reasons: liveIssues.map((i) => `texte sur le site : ${i.message}`) }); continue; }

    // Dernière vérification juste avant de publier (annulation ou pause pendant le contrôle).
    const s2 = store.getSettings();
    const a2 = store.getArticles().find((x) => x.id === c.id);
    if (s2.publishMode !== 'automatique' || s2.publishPaused || !a2 || a2.autoCancelled || a2.siteDirty || a2.status !== 'brouillon_wp') { out.skipped.push({ id: a.id, title: a.title, reasons: ['annulé ou suspendu pendant la vérification'] }); continue; }
    try {
      const r = await wp.publish(a2.wpId);
      Object.assign(a2, { status: 'publie', wpLink: r.link || a2.wpLink, publishedAt: now.toISOString(), publishedBy: 'automatique' });
      store.saveArticle(a2);
      logPublication(a2, 'automatique', now);
      done += 1;
      out.published.push({ id: a2.id, title: a2.title, url: a2.wpLink });
    } catch (e) {
      log.error(`Publication automatique échouée pour « ${a.title} »`, e);
      out.skipped.push({ id: a.id, title: a.title, reasons: [e.message] });
    }
  }
  return out;
}

module.exports = { weekKey, scheduledAt, localReasons, logPublication, autoPublishedThisWeek, getLog, tick };
