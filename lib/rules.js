// Règles de contrôle d'un article : longueur, mots interdits, marqueurs de source, tirets et flèches.
// Fonctions pures (aucun réseau, aucun fichier) : elles servent à la génération, à la modification
// manuelle, à l'envoi vers WordPress et à la publication automatique.

const MIN_WORDS = 700;
const MAX_WORDS = 900;
const MARKER = '[SOURCE A VERIFIER]';

// Transforme du HTML en texte brut. Les balises de bloc (p, h2, li, td...) deviennent des espaces :
// sans cela, « fin.</p><p>Début » serait compté comme un seul mot.
function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*(script|style)[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\/?\s*(p|h[1-6]|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|br|div|section)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, '\'')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(html) {
  return htmlToText(html).split(' ').filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

const DEFAULT_LIMITS = { min: MIN_WORDS, max: MAX_WORDS };
const inRange = (words, limits = DEFAULT_LIMITS) => words >= limits.min && words <= limits.max;

// Mots interdits par les instructions. On reconnaît aussi le féminin et le pluriel, mais pas les mots voisins
// (« garantie » est signalé, « garantir » ne l'est pas ; les bornes tiennent compte des lettres accentuées).
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const FORBIDDEN = [
  ['meilleur', 'meilleur(?:e|s|es)?'],
  ['leader', 'leaders?'],
  ['certifié', 'certifi(?:é|ée|és|ées)'],
  ['garanti', 'garanti(?:e|s|es)?'],
  ['100 %', '100\\s*%'],
  ['à vie', 'à\\s+vie'],
  ['révolutionnaire', 'révolutionnaires?'],
  ['sans risque', 'sans\\s+risques?'],
  ['haut de gamme', 'haut(?:e|s|es)?\\s+de\\s+gamme'],
  ['performant', 'performant(?:e|s|es)?'],
  ['fiabilité', 'fiabilités?'],
  ['spécialiste', 'spécialistes?'],
  ['efficacement', 'efficacement'],
].map(([label, re]) => ({ label, re: new RegExp(`${L}${re}${R}`, 'iu') }));

function findForbidden(text) {
  const t = String(text || '');
  return FORBIDDEN.filter((f) => f.re.test(t)).map((f) => f.label);
}

const plural = (n, one, many) => (n > 1 ? many : one);

// Contrôle complet. `blocking` = problèmes qui interdisent la publication automatique.
function checkArticle(a, limits = DEFAULT_LIMITS) {
  const html = a.htmlContent || '';
  const text = htmlToText(html);
  const scanned = [a.title, a.metaTitle, a.metaDescription, text].filter(Boolean).join(' \n ');
  const words = countWords(html);
  const facts = (a.faitsAVerifier || []).filter((f) => String(f).trim());
  const issues = [];

  if (!inRange(words, limits)) issues.push({ code: 'length', blocking: true, message: `Longueur hors de la plage demandée : ${words} mots (attendu ${limits.min} à ${limits.max}).` });

  const forbidden = findForbidden(scanned);
  if (forbidden.length) issues.push({ code: 'forbidden', blocking: true, words: forbidden, message: `${plural(forbidden.length, 'Mot interdit présent', 'Mots interdits présents')} : ${forbidden.map((w) => `« ${w} »`).join(', ')}.` });

  const markers = scanned.split(MARKER).length - 1;
  if (markers) issues.push({ code: 'marker', blocking: true, message: `${markers} ${plural(markers, 'marqueur', 'marqueurs')} ${MARKER} à remplacer par une vraie source (ou à supprimer avec sa phrase).` });
  if (markers && !facts.length) issues.push({ code: 'marker_no_fact', blocking: false, message: `Le marqueur ${MARKER} est présent mais absent de la liste des faits à vérifier.` });

  if (facts.length) issues.push({ code: 'facts', blocking: true, message: `${facts.length} ${plural(facts.length, 'fait à vérifier', 'faits à vérifier')} dans la liste.` });

  if (/[—→⇒➜➔]|->|=>/.test(scanned)) issues.push({ code: 'dash', blocking: false, message: 'Tiret cadratin ou flèche détecté : à remplacer par des deux-points ou des virgules.' });
  if (/\d+\s?(€|euros?)/i.test(text)) issues.push({ code: 'price', blocking: false, message: 'Un prix apparaît dans le texte : vérifiez qu\'il est justifié par un fait fourni.' });
  if (a.metaTitle && a.metaTitle.length > 60) issues.push({ code: 'meta_title', blocking: false, message: `Titre pour Google trop long (${a.metaTitle.length} caractères, 60 maximum).` });
  if (a.metaDescription && a.metaDescription.length > 155) issues.push({ code: 'meta_description', blocking: false, message: `Description pour Google trop longue (${a.metaDescription.length} caractères, 155 maximum).` });

  return { words, inRange: inRange(words, limits), limits, issues, blocking: issues.some((i) => i.blocking) };
}

module.exports = { MIN_WORDS, MAX_WORDS, DEFAULT_LIMITS, MARKER, htmlToText, countWords, inRange, findForbidden, checkArticle };
