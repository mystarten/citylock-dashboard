// Génération d'articles via OpenRouter (ou simulation).
const cheerio = require('cheerio');
const log = require('./log');
const secrets = require('./secrets');
const { isSimulated } = require('./config');

const TIMEOUT_MS = 90000;
const ALLOWED_TAGS = new Set(['h2', 'h3', 'p', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'br', 'blockquote']);

// Consignes de rédaction : texte modifiable depuis les Réglages (valeur par défaut ci-dessous).
const DEFAULT_RULES = `Tu es rédacteur web pour une entreprise locale de sécurité. Tu respectes TOUTES les règles suivantes, sans exception.

1. Écris en français, avec des phrases courtes, un ton direct et concret.
2. N'invente JAMAIS de chiffres, de prix, de délais, de témoignages ou de statistiques. Si un fait n'est pas fourni dans la demande, ne l'écris pas. Pour un chiffre du secteur, écris le marqueur [SOURCE A VERIFIER] à l'endroit du chiffre, et ajoute une ligne dans la liste "faitsAVerifier".
3. Ne promets JAMAIS un classement ou un résultat.
4. Structure : un titre (H1) fourni dans le champ "title" (ne l'inclus pas dans htmlContent), des intertitres H2 dans htmlContent, une introduction de 2 phrases qui contient le mot-clé principal, 600 à 900 mots au total.
5. Pas de tirets cadratins, pas de flèches, pas de listes de phrases creuses.
6. Termine par un appel à l'action vers la prise de contact, sans pression.

Faits que tu peux utiliser : uniquement ceux donnés dans la demande de l'utilisateur. L'entreprise installe des alarmes Ajax sans abonnement. Rien d'autre sur l'entreprise ne doit être affirmé.`;

// Format de réponse : TOUJOURS ajouté par le code, non modifiable (le serveur en a besoin pour lire l'article).
const OUTPUT_CONTRACT = `FORMAT DE REPONSE (obligatoire) : réponds uniquement par un objet JSON valide, sans texte autour, avec exactement ces clés :
"title" (string), "metaTitle" (string, 60 caractères maximum), "metaDescription" (string, 155 caractères maximum), "slug" (string, minuscules et tirets), "htmlContent" (string, HTML limité aux balises h2, h3, p, ul, ol, li, a, strong, em), "internalLinkSuggestions" (liste de pages du site à lier, choisies uniquement parmi les pages fournies), "faitsAVerifier" (liste de strings : tout fait, chiffre ou affirmation à contrôler par un humain).`;

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
  const text = cheerio.load(`<div>${html}</div>`)('div').text();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const warnings = [];
  if (metaTitle.length > 60) warnings.push(`Meta titre trop long (${metaTitle.length} caractères, max 60).`);
  if (metaDescription.length > 155) warnings.push(`Meta description trop longue (${metaDescription.length} caractères, max 155).`);
  if (wordCount < 600 || wordCount > 900) warnings.push(`Longueur hors consigne : ${wordCount} mots (attendu 600 à 900).`);
  if (/[—–→⇒➜➔]|->|=>/.test(`${title} ${html}`)) warnings.push('Tiret cadratin ou flèche détecté : à retirer à la relecture.');
  if (/\d+\s?(€|euros?|%)/i.test(text)) warnings.push('Un prix ou pourcentage apparaît dans le texte : vérifier qu\'il est justifié.');
  if (text.includes('[SOURCE A VERIFIER]') && !faits.length) warnings.push('Marqueur [SOURCE A VERIFIER] présent mais absent de la liste des faits à vérifier.');

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
  const para = 'Ceci est un texte de simulation. Il sert uniquement à tester le tableau de bord, sans appel à OpenRouter. ';
  return {
    title: `Article de test : ${kw}`,
    metaTitle: `${kw} : article de test`.slice(0, 60),
    metaDescription: `Texte de simulation sur ${kw}, généré sans appel externe pour tester le tableau de bord.`.slice(0, 155),
    slug: slugify(`test ${kw}`),
    htmlContent: `<p>${kw} : voici une introduction de test. Elle contient le mot-clé.</p><h2>Premier point</h2><p>${para.repeat(3)}</p>` +
      `<h2>Deuxième point</h2><p>Selon le secteur, [SOURCE A VERIFIER] des cambriolages ont lieu en journée. ${para.repeat(2)}</p>` +
      `<h2>Nous contacter</h2><p>Si vous avez une question, ${settings.brandName} peut vous répondre.</p>`,
    internalLinkSuggestions: [],
    faitsAVerifier: ['Statistique sur les cambriolages en journée (marqueur [SOURCE A VERIFIER])'],
  };
}

const baseUrl = () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

async function callOpenRouter({ model, messages, maxTokens, json, timeout = TIMEOUT_MS }) {
  const key = secrets.get('openrouterKey');
  if (!key) throw new Error('La clé OpenRouter est manquante. Saisissez-la dans Réglages, Rédaction.');
  if (!model) throw new Error('Aucun modèle choisi. Indiquez-en un dans les Réglages.');
  let res;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.5, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}), messages }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'OpenRouter a mis trop de temps à répondre.' : 'OpenRouter est injoignable.');
  }
  if (!res.ok) {
    log.error(`OpenRouter a répondu ${res.status} (modèle ${model})`);
    const hint = res.status === 400 || res.status === 404 ? ' Vérifiez l\'identifiant du modèle dans les Réglages.' : res.status === 401 ? ' Vérifiez la clé OpenRouter.' : res.status === 402 ? ' Le crédit OpenRouter est peut-être épuisé.' : '';
    throw new Error(`OpenRouter a refusé la demande (code ${res.status}).${hint}`);
  }
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Réponse OpenRouter vide.');
  return content;
}

async function generateArticle(topic, settings, pages = []) {
  if (isSimulated()) return normalizeArticle(simulated(topic, settings));
  let content = await callOpenRouter({
    model: effectiveModel(settings), maxTokens: 4000, json: true,
    messages: [
      { role: 'system', content: buildSystemPrompt(settings) },
      { role: 'user', content: buildUserPrompt(topic, settings, pages) },
    ],
  });
  content = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw;
  try { raw = JSON.parse(content); } catch { throw new Error('Le modèle n\'a pas renvoyé un JSON valide. Essayez un autre modèle dans les Réglages.'); }
  return normalizeArticle(raw);
}

// Petit appel de contrôle (quelques mots) pour vérifier la clé et l'identifiant du modèle avant un lot.
async function testModel(settings) {
  const model = effectiveModel(settings);
  if (isSimulated()) return { ok: true, simulated: true, model: model || '(simulation)' };
  await callOpenRouter({ model, maxTokens: 8, json: false, timeout: 30000, messages: [{ role: 'user', content: 'Réponds par le seul mot : OK' }] });
  return { ok: true, model };
}

// Ce qui est (ou serait, en mode démonstration) envoyé à l'IA : pour que l'utilisateur puisse vérifier lui-même.
function previewPrompt(topic, settings, pages = []) {
  return { model: effectiveModel(settings) || '', system: buildSystemPrompt(settings), user: buildUserPrompt(topic, settings, pages) };
}

module.exports = { generateArticle, testModel, previewPrompt, buildUserPrompt, normalizeArticle, sanitizeHtml, buildSystemPrompt, effectiveModel, DEFAULT_RULES, MAX_RULES_LENGTH, MODEL_PATTERN };
