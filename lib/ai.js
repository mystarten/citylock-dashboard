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

// Le prompt système est UNIQUEMENT celui enregistré dans Réglages, Rédaction : le code n'y ajoute rien.
// (Le texte d'origine est dans lib/defaultRules.js ; il sert à l'installation et au bouton « Rétablir ».)

const MAX_RULES_LENGTH = 6000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,98}$/;

const limitsOf = (settings) => ({ min: (settings && settings.minWords) || rules.MIN_WORDS, max: (settings && settings.maxWords) || rules.MAX_WORDS });

function buildSystemPrompt(settings) {
  return settings && typeof settings.systemPrompt === 'string' ? settings.systemPrompt.trim() : '';
}

// Problèmes visibles dans le prompt : sans format de réponse, les articles ne pourraient pas être lus.
function promptProblems(prompt) {
  const p = String(prompt || '');
  const out = [];
  if (!/json/i.test(p)) out.push('Le mot « JSON » n\'apparaît pas : le modèle ne sait pas qu\'il doit répondre au format JSON.');
  for (const k of ['title', 'htmlContent']) if (!p.includes(k)) out.push(`La clé « ${k} » n'apparaît pas dans le format de réponse.`);
  return out;
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
    : 'Aucune liste de pages du site n\'est disponible : n\'invente aucune page à relier.');
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
    if (tag === 'a') {
      const h = String(attrs.href || '').trim();
      if (/^(https?:\/\/|\/(?!\/))/i.test(h)) $(el).attr('href', h);
      else if (/^[a-z0-9][a-z0-9\-_/.%]*\/?$/i.test(h) && !/^[a-z]+:/i.test(h)) $(el).attr('href', '/' + h); // « page/ » sans « / » initial : lien du site
    }
  });
  return $('#root').html().trim();
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, max = 20) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, max) : []);

const formatError = (detail = '') => aiError(`${detail ? detail + ' ' : ''}La réponse du modèle n'est pas au format attendu (JSON avec title, htmlContent...). Vérifiez la partie « format de réponse » de vos instructions (Réglages, Rédaction), ou changez de modèle.`, 'la réponse n\'a pas le format demandé');

function normalizeArticle(raw, limits) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw formatError();
  const title = str(raw.title, 200);
  const html = typeof raw.htmlContent === 'string' ? sanitizeHtml(raw.htmlContent) : '';
  if (!title || !html) throw formatError('Il manque « title » ou « htmlContent » dans la réponse du modèle.');
  const metaTitle = str(raw.metaTitle, 300);
  const metaDescription = str(raw.metaDescription, 500);
  const faits = strList(raw.faitsAVerifier || raw['faitsA verifier'] || raw.faits_a_verifier);
  const draft = { title, metaTitle, metaDescription, htmlContent: html, faitsAVerifier: faits };
  const check = rules.checkArticle(draft, limits);
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
    const hint = res.status === 400 || res.status === 404 ? ' Vérifiez l\'identifiant du modèle dans Réglages, Rédaction (et, pour les instructions, la présence du mot « JSON »).' : res.status === 401 ? ' Vérifiez la clé OpenRouter.' : res.status === 402 ? ' Le crédit OpenRouter est peut-être épuisé.' : '';
    throw aiError(`OpenRouter a refusé la demande (code ${res.status}).${hint}`, simple);
  }
  const j = await res.json();
  const choice = j && j.choices && j.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || !content.trim()) throw aiError('Réponse OpenRouter vide.', 'le modèle a répondu par un message vide');
  return { content, finishReason: (choice && (choice.finish_reason || choice.native_finish_reason)) || '' };
}

async function generateArticle(topic, settings, pages = []) {
  const limits = limitsOf(settings);
  if (isSimulated()) return { ...normalizeArticle(simulated(topic, settings), limits), modelUsed: 'démonstration' };
  const system = buildSystemPrompt(settings);
  if (!system) throw aiError('Aucune instruction de rédaction n\'est enregistrée. Allez dans Réglages, Rédaction et cliquez sur « Rétablir le texte d\'origine ».', 'aucune instruction de rédaction enregistrée');
  if (!/json/i.test(system)) throw aiError('Vos instructions ne parlent pas du format JSON : le modèle ne saurait pas dans quel format répondre. Ajoutez la partie « format de réponse » (Réglages, Rédaction), ou cliquez sur « Rétablir le texte d\'origine ».', 'les instructions ne demandent pas le format JSON');
  const model = effectiveModel(settings);
  const { content: raw0, finishReason } = await callOpenRouter({
    model, maxTokens: GENERATION_MAX_TOKENS, json: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: buildUserPrompt(topic, settings, pages) },
    ],
  });
  const content = raw0.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw;
  try { raw = JSON.parse(content); } catch {
    if (finishReason === 'length') throw aiError('La réponse du modèle a été coupée avant la fin (limite de longueur atteinte). Réessayez, ou choisissez un autre modèle dans Réglages, Rédaction.', 'la réponse a été coupée avant la fin');
    throw formatError();
  }
  return { ...normalizeArticle(raw, limits), modelUsed: model };
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

module.exports = { slugify, promptProblems, GENERATION_MAX_TOKENS, generateArticle, testModel, previewPrompt, buildUserPrompt, normalizeArticle, sanitizeHtml, buildSystemPrompt, effectiveModel, DEFAULT_RULES, MAX_RULES_LENGTH, MODEL_PATTERN };
