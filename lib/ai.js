// Génération d'articles via OpenRouter (ou simulation).
const cheerio = require('cheerio');
const log = require('./log');

const TIMEOUT_MS = 90000;
const ALLOWED_TAGS = new Set(['h2', 'h3', 'p', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'br', 'blockquote']);

const SYSTEM_PROMPT = `Tu es rédacteur web pour une entreprise locale de sécurité. Tu respectes TOUTES les règles suivantes, sans exception.

1. Écris en français, avec des phrases courtes, un ton direct et concret.
2. N'invente JAMAIS de chiffres, de prix, de délais, de témoignages ou de statistiques. Si un fait n'est pas fourni dans la demande, ne l'écris pas. Pour un chiffre du secteur, écris le marqueur [SOURCE A VERIFIER] à l'endroit du chiffre, et ajoute une ligne dans la liste "faitsAVerifier".
3. Ne promets JAMAIS un classement ou un résultat.
4. Structure : un titre (H1) fourni dans le champ "title" (ne l'inclus pas dans htmlContent), des intertitres H2 dans htmlContent, une introduction de 2 phrases qui contient le mot-clé principal, 600 à 900 mots au total.
5. Pas de tirets cadratins, pas de flèches, pas de listes de phrases creuses.
6. Termine par un appel à l'action vers la prise de contact, sans pression.
7. Réponds uniquement par un objet JSON valide, sans texte autour, avec exactement ces clés :
   "title" (string), "metaTitle" (string, 60 caractères maximum), "metaDescription" (string, 155 caractères maximum), "slug" (string, minuscules et tirets), "htmlContent" (string, HTML limité aux balises h2, h3, p, ul, ol, li, a, strong, em), "internalLinkSuggestions" (liste de pages du site à lier, choisies uniquement parmi les pages fournies), "faitsAVerifier" (liste de strings : tout fait, chiffre ou affirmation à contrôler par un humain).

Faits que tu peux utiliser : uniquement ceux donnés dans la demande de l'utilisateur. L'entreprise installe des alarmes Ajax sans abonnement. Rien d'autre sur l'entreprise ne doit être affirmé.`;

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

async function generateArticle(topic, settings, pages = []) {
  if (process.env.SIMULATE === 'true') return normalizeArticle(simulated(topic, settings));
  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!key || !model) throw new Error('OPENROUTER_API_KEY ou OPENROUTER_MODEL manquant.');

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.5, max_tokens: 4000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(topic, settings, pages) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'OpenRouter a mis trop de temps à répondre.' : 'OpenRouter est injoignable.');
  }
  if (!res.ok) {
    log.error(`OpenRouter a répondu ${res.status}`);
    throw new Error(`OpenRouter a refusé la demande (code ${res.status}).`);
  }
  const j = await res.json();
  let content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof content !== 'string') throw new Error('Réponse OpenRouter vide.');
  content = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw;
  try { raw = JSON.parse(content); } catch { throw new Error('Le modèle n\'a pas renvoyé un JSON valide.'); }
  return normalizeArticle(raw);
}

module.exports = { generateArticle, normalizeArticle, SYSTEM_PROMPT, sanitizeHtml };
