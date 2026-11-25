// Génération d'articles via OpenRouter (ou simulation).
const cheerio = require('cheerio');
const log = require('./log');
const secrets = require('./secrets');
const { isSimulated } = require('./config');
const rules = require('./rules');
const DEFAULT_RULES = require('./defaultRules');

const TIMEOUT_MS = 90000;
const ALLOWED_TAGS = new Set(['h2', 'h3', 'p', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'br', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
// Limite de sortie : 900 mots de français en HTML représentent environ 2 500 jetons ; 6 000 laisse une large marge.
const GENERATION_MAX_TOKENS = 6000;

// Instruction de rédaction : texte modifiable depuis les Réglages (valeur par défaut : lib/defaultRules.js).

// Format de réponse : TOUJOURS ajouté par le code, non modifiable (le serveur en a besoin pour lire l'article).
const OUTPUT_CONTRACT = `FORMAT DE REPONSE (obligatoire) : réponds uniquement par un objet JSON valide, sans texte autour, avec exactement ces clés :
"title" (string), "metaTitle" (string, 60 caractères maximum), "metaDescription" (string, 155 caractères maximum), "slug" (string, minuscules et tirets), "htmlContent" (string, HTML limité aux balises h2, h3, p, ul, ol, li, a, strong, em, table, thead, tbody, tr, th, td), "internalLinkSuggestions" (liste de pages du site à lier, choisies uniquement parmi les pages fournies), "faitsAVerifier" (liste de strings : tout fait, chiffre ou affirmation à contrôler par un humain).
LONGUEUR (obligatoire) : le champ htmlContent contient entre ${rules.MIN_WORDS} et ${rules.MAX_WORDS} mots de texte (hors balises). Un texte plus court est refusé : écris l'article en entier.`;

const MAX_RULES_LENGTH = 6000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,98}$/;

function effectiveRules(settings) {
  const custom = settings && typeof settings.systemPrompt === 'string' ? settings.systemPrompt.trim() : '';
  return custom || DEFAULT_RULES;
}
function buildSystemPrompt(settings) {
  return `${effectiveRules(settings)}\n\n${OUTPUT_CONTRACT}`;
}
function effectiveModel(settings) {
  const m = settings && typeof settings.aiModel === 'string' ? settings.aiModel.trim() : '';
  return m || process.env.OPENROUTER_MODEL || '';
}

function buildUserPrompt(topic, settings, pages) {
  const lines = [
    `Entreprise : ${settings.brandName}`,
    `Offre : installation d'alarmes Ajax sans abonnement`,
    `Zone desservie : ${settings.zone}`,
    `Mot-clé principal : ${topic.keyword}`,
  ];
  if (topic.city) lines.push(`Ville ciblée : ${topic.city}`);
  lines.push(pages.length
    ? `Pages du site utilisables pour les liens internes :\n${pages.map((p) => `- ${p}`).join('\n')}`
    : 'Aucune liste de pages du site n\'est disponible : laisse internalLinkSuggestions vide.');
  lines.push(`Longueur exigée : entre ${rules.MIN_WORDS} et ${rules.MAX_WORDS} mots dans htmlContent (vise environ 750 mots).`);
  lines.push('Rédige l\'article.');
  return lines.join('\n');
}

function sanitizeHtml(html) {
  const $ = cheerio.load(`<div id="root">${html}</div>`, null, false);
  $('script, style, iframe, object, embed, form, link, meta').remove();
  $('#root *').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) { $(el).replaceWith($(el).contents()); return; }
    const attrs = { ...el.attribs };
    for (const a of Object.keys(attrs)) $(el).removeAttr(a);
    if (tag === 'a' && /^(https?:\/\/|\/)/i.test(attrs.href || '')) $(el).attr('href', attrs.href);
  });
  return $('#root').html().trim();
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, max = 20) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, max) : []);

function normalizeArticle(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Réponse du modèle invalide (pas un objet JSON).');
  const title = str(raw.title, 200);
  const html = typeof raw.htmlContent === 'string' ? sanitizeHtml(raw.htmlContent) : '';
  if (!title || !html) throw new Error('Réponse du modèle incomplète (titre ou contenu manquant).');
  const metaTitle = str(raw.metaTitle, 300);
  const metaDescription = str(raw.metaDescription, 500);
  const faits = strList(raw.faitsAVerifier || raw['faitsA verifier'] || raw.faits_a_verifier);
  const draft = { title, metaTitle, metaDescription, htmlContent: html, faitsAVerifier: faits };
  const check = rules.checkArticle(draft);
  const wordCount = check.words;
  const warnings = check.issues.map((i) => i.message);

  return {
    title, metaTitle, metaDescription,
    slug: slugify(raw.slug || title),
    htmlContent: html,
    internalLinkSuggestions: strList(raw.internalLinkSuggestions),
    faitsAVerifier: faits, warnings, wordCount,
  };
}

function simulated(topic, settings) {
  const kw = topic.keyword + (topic.city ? ` à ${topic.city}` : '');
  const para = 'Ceci est un texte de démonstration. Il sert uniquement à tester le tableau de bord, sans aucun appel à OpenRouter. Il n\'apporte aucune information réelle sur le sujet et ne doit jamais être publié tel quel. ';
  const block = (n) => `<p>${para.repeat(n)}</p>`;
  return {
    title: `Article de test : ${kw}`,
    metaTitle: `${kw} : article de test`.slice(0, 60),
    metaDescription: `Texte de démonstration sur ${kw}, généré sans appel externe pour tester le tableau de bord.`.slice(0, 155),
    slug: slugify(`test ${kw}`),
    htmlContent: `<p>${kw} : voici une introduction de test. Elle contient le mot-clé principal.</p>` +
      `<h2>Que faut-il savoir en premier ?</h2>${block(4)}` +
      `<h2>Comment comparer les solutions ?</h2>${block(3)}<table><thead><tr><th>Critère</th><th>Exemple</th></tr></thead><tbody><tr><td>Texte</td><td>Démonstration</td></tr></tbody></table>` +
      `<h2>Que dit le secteur ?</h2><p>Selon le secteur, [SOURCE A VERIFIER] des cambriolages ont lieu en journée. ${para.repeat(3)}</p>` +
      `<h2>Questions fréquentes</h2>${block(3)}${block(3)}` +
      `<p>Pour poser une question ou demander un devis, ${settings.brandName} répond du lundi au vendredi.</p>`,
    internalLinkSuggestions: [],
    faitsAVerifier: ['Statistique sur les cambriolages en journée (marqueur [SOURCE A VERIFIER])'],
  };
}

const baseUrl = () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// Erreur avec une « raison simple » (une phrase, sans jargon) que l'interface peut afficher telle quelle.
const aiError = (message, simple) => Object.assign(new Error(message), { simple });

async function callOpenRouter({ model, messages, maxTokens, json, timeout = TIMEOUT_MS }) {
  const key = secrets.get('openrouterKey');
  if (!key) throw aiError('La clé OpenRouter est manquante. Saisissez-la dans Réglages, Connexions.', 'la clé OpenRouter est manquante (Réglages, Connexions)');
  if (!model) throw aiError('Aucun modèle choisi. Indiquez-en un dans Réglages, Rédaction.', 'aucun identifiant de modèle n\'est indiqué');
  let res;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.5, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}), messages }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw e.name === 'TimeoutError'
      ? aiError('OpenRouter a mis trop de temps à répondre.', 'OpenRouter a mis trop de temps à répondre')
      : aiError('OpenRouter est injoignable.', 'OpenRouter est injoignable pour le moment');
  }
  if (!res.ok) {
    log.error(`OpenRouter a répondu ${res.status} (modèle ${model})`);
    const simple = res.status === 401 ? 'la clé OpenRouter est refusée'
      : res.status === 402 ? 'le crédit OpenRouter est épuisé'
      : res.status === 400 || res.status === 404 ? 'l\'identifiant du modèle est inconnu ou ce modèle n\'est plus disponible'
      : res.status === 429 ? 'trop de demandes en même temps, réessayez dans une minute'
      : `OpenRouter a répondu avec une erreur (code ${res.status})`;
    const hint = res.status === 400 || res.status === 404 ? ' Vérifiez l\'identifiant du modèle dans Réglages, Rédaction.' : res.status === 401 ? ' Vérifiez la clé OpenRouter.' : res.status === 402 ? ' Le crédit OpenRouter est peut-être épuisé.' : '';
    throw aiError(`OpenRouter a refusé la demande (code ${res.status}).${hint}`, simple);
  }
  const j = await res.json();
  const choice = j && j.choices && j.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || !content.trim()) throw aiError('Réponse OpenRouter vide.', 'le modèle a répondu par un message vide');
  return { content, finishReason: (choice && (choice.finish_reason || choice.native_finish_reason)) || '' };
}

async function generateArticle(topic, settings, pages = []) {
  if (isSimulated()) return { ...normalizeArticle(simulated(topic, settings)), modelUsed: 'démonstration' };
  const model = effectiveModel(settings);
  const { content: raw0, finishReason } = await callOpenRouter({
    model, maxTokens: GENERATION_MAX_TOKENS, json: true,
    messages: [
      { role: 'system', content: buildSystemPrompt(settings) },
      { role: 'user', content: buildUserPrompt(topic, settings, pages) },
    ],
  });
  const content = raw0.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw;
  try { raw = JSON.parse(content); } catch {
    if (finishReason === 'length') throw new Error('La réponse du modèle a été coupée avant la fin (limite de longueur atteinte). Réessayez, ou choisissez un autre modèle dans Réglages, Rédaction.');
    throw new Error('Le modèle n\'a pas renvoyé un JSON valide. Réessayez, ou choisissez un autre modèle dans Réglages, Rédaction.');
  }
  return { ...normalizeArticle(raw), modelUsed: model };
}

// Petit appel de contrôle (quelques mots) pour vérifier la clé et l'identifiant du modèle avant un lot.
async function testModel(settings, modelOverride) {
  const model = modelOverride !== undefined ? String(modelOverride).trim() || (process.env.OPENROUTER_MODEL || '') : effectiveModel(settings);
  if (isSimulated()) return { ok: true, simulated: true, model: model || '(démonstration)' };
  await callOpenRouter({ model, maxTokens: 8, json: false, timeout: 30000, messages: [{ role: 'user', content: 'Réponds par le seul mot : OK' }] });
  return { ok: true, model };
}

// Ce qui est (ou serait, en mode démonstration) envoyé à l'IA : pour que l'utilisateur puisse vérifier lui-même.
function previewPrompt(topic, settings, pages = []) {
  return { model: effectiveModel(settings) || '', system: buildSystemPrompt(settings), user: buildUserPrompt(topic, settings, pages) };
}

module.exports = { slugify, GENERATION_MAX_TOKENS, generateArticle, testModel, previewPrompt, buildUserPrompt, normalizeArticle, sanitizeHtml, buildSystemPrompt, effectiveModel, DEFAULT_RULES, MAX_RULES_LENGTH, MODEL_PATTERN };
