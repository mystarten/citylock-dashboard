// Fiche d'un article : contrôles, état en clair, versions (historique) et champs modifiables.
const crypto = require('crypto');
const rules = require('./rules');

const MAX_VERSIONS = 20;

const parisDate = (iso) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const parisDateTime = (iso) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

// État affiché en haut de l'article, en clair.
function stateOf(a, check) {
  if (a.status === 'publie') return { code: 'publie', tone: 'ok', label: `Publié le ${parisDate(a.publishedAt || a.createdAt)}` };
  if (a.status === 'programme') {
    const late = a.scheduledAt && Date.now() > new Date(a.scheduledAt).getTime() + 15 * 60000;
    return late ? { code: 'programme_retard', tone: 'warn', label: 'Programmé, mais pas encore publié par WordPress' } : { code: 'programme', tone: 'ok', label: `Programmé le ${parisDateTime(a.scheduledAt)}` };
  }
  if (check.blocking) return { code: 'a_verifier', tone: 'warn', label: 'À vérifier avant publication' };
  return { code: 'brouillon', tone: '', label: 'Brouillon, pas encore publié' };
}

// Ce que reçoit le navigateur : la fiche + ses contrôles + son état (jamais l'historique complet).
function view(a, limits) {
  const check = rules.checkArticle(a, limits);
  const { versions, wpSyncHash, ...rest } = a;
  return { ...rest, wordCount: check.words, check, state: stateOf(a, check), versionsCount: (versions || []).length };
}

// Liste des versions pour l'écran de modification (sans le texte complet).
function versionList(a) {
  return (a.versions || []).map((v, index) => ({ index, at: v.at, label: v.label, wordCount: v.wordCount, title: v.title }));
}

const FIELDS = ['title', 'metaTitle', 'metaDescription', 'slug', 'keyword', 'htmlContent', 'faitsAVerifier'];

function snapshot(a) {
  return {
    at: a.versionAt || a.createdAt, label: a.versionLabel || 'Texte généré',
    title: a.title, metaTitle: a.metaTitle, metaDescription: a.metaDescription, slug: a.slug, keyword: a.keyword,
    htmlContent: a.htmlContent, faitsAVerifier: [...(a.faitsAVerifier || [])], wordCount: rules.countWords(a.htmlContent),
  };
}

function pushVersion(a) {
  a.versions = [...(a.versions || []), snapshot(a)].slice(-MAX_VERSIONS);
}

// Applique des champs déjà validés et nettoyés. L'ancien état est conservé dans l'historique.
function applyFields(a, fields, label, limits) {
  pushVersion(a);
  for (const k of FIELDS) if (fields[k] !== undefined) a[k] = fields[k];
  if (fields.keyword !== undefined) a.focusKeyphrase = fields.keyword; // le mot-clé modifié à la main devient celui envoyé à Yoast
  a.wordCount = rules.countWords(a.htmlContent);
  a.warnings = rules.checkArticle(a, limits).issues.map((i) => i.message);
  a.versionAt = new Date().toISOString();
  a.versionLabel = label;
  return a;
}

const sameFields = (a, fields) => FIELDS.every((k) => fields[k] === undefined || JSON.stringify(fields[k]) === JSON.stringify(a[k]));

// Empreinte d'un texte (espaces ignorés), pour détecter une modification faite directement dans WordPress.
const hashContent = (html) => crypto.createHash('sha1').update(String(html || '').replace(/\s+/g, ' ').trim()).digest('hex');

module.exports = { MAX_VERSIONS, FIELDS, stateOf, view, versionList, snapshot, pushVersion, applyFields, sameFields, hashContent };
