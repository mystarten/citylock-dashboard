// Calcul du score SEO : fonction pure, testable sans réseau.
// Entrée : données déjà mesurées (voir test/score.test.js pour un exemple).

const LOCAL_BUSINESS_TYPES = new Set([
  'LocalBusiness', 'Locksmith', 'HomeAndConstructionBusiness', 'ProfessionalService', 'Store',
]);
const OFFTOPIC_TOKENS = new Set(['demo', 'test', 'sample', 'exemple', 'lorem', 'ipsum', 'hello', 'bonjour', 'brouillon', 'draft']);
const OFFTOPIC_TITLES = /(hello world|bonjour tout le monde|page d['’]exemple|sample page|lorem ipsum)/i;

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b === 0 ? 100 : Math.round((a / b) * 100));
const sample = (arr, n = 10) => arr.slice(0, n);

function pageProblems(pages, test) {
  const bad = [];
  for (const p of pages) {
    const why = test(p);
    if (why) bad.push({ url: p.url, why });
  }
  return bad;
}

function isOffTopic(url, title) {
  let path = '';
  try { path = new URL(url).pathname; } catch { path = url; }
  const tokens = path.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hit = tokens.find((t) => OFFTOPIC_TOKENS.has(t));
  if (hit) return `adresse contenant « ${hit} »`;
  if (title && OFFTOPIC_TITLES.test(title)) return `titre « ${title} »`;
  return null;
}

function computeScore(d) {
  const pages = d.pages || [];
  const n = pages.length;
  const criteria = [];

  const add = (c) => criteria.push({ details: [], ...c, points: c.points == null ? null : r1(c.points) });

  // 1. Titre
  const titleCount = {};
  pages.forEach((p) => { if (p.title) titleCount[p.title] = (titleCount[p.title] || 0) + 1; });
  const titleBad = pageProblems(pages, (p) => {
    if (!p.title) return 'titre absent';
    if (p.title.length < 30 || p.title.length > 60) return `titre de ${p.title.length} caractères`;
    if (titleCount[p.title] > 1) return 'titre en double';
    return null;
  });
  add({
    id: 'title', label: 'Balise title (présente, 30 à 60 caractères, unique)', max: 10,
    points: n ? 10 * (n - titleBad.length) / n : 0,
    measured: `${n - titleBad.length} page(s) conforme(s) sur ${n}`,
    details: sample(titleBad),
    explanation: titleBad.length
      ? 'Un titre clair et propre à chaque page aide les moteurs et les visiteurs. Réécrivez les titres listés : 30 à 60 caractères, différents sur chaque page.'
      : 'Tous les titres respectent la longueur et sont uniques. Rien à faire.',
  });

  // 2. Meta description
  const metaBad = pageProblems(pages, (p) => {
    const l = (p.metaDescription || '').length;
    if (!l) return 'meta description absente';
    if (l < 120 || l > 160) return `meta description de ${l} caractères`;
    return null;
  });
  add({
    id: 'meta', label: 'Meta description (120 à 160 caractères)', max: 10,
    points: n ? 10 * (n - metaBad.length) / n : 0,
    measured: `${n - metaBad.length} page(s) conforme(s) sur ${n}`,
    details: sample(metaBad),
    explanation: metaBad.length
      ? 'La meta description est le texte affiché sous le lien dans les résultats de recherche. Rédigez-en une de 120 à 160 caractères pour chaque page listée.'
      : 'Toutes les meta descriptions ont la bonne longueur. Rien à faire.',
  });

  // 3. H1
  const h1Bad = pageProblems(pages, (p) => (p.h1Count === 1 ? null : `${p.h1Count} balise(s) H1`));
  add({
    id: 'h1', label: 'Exactement un H1 par page', max: 10,
    points: n ? 10 * (n - h1Bad.length) / n : 0,
    measured: `${n - h1Bad.length} page(s) conforme(s) sur ${n}`,
    details: sample(h1Bad),
    explanation: h1Bad.length
      ? 'Chaque page doit avoir un seul titre principal (H1). Ajoutez-le s\'il manque, transformez les H1 en trop en sous-titres (H2).'
      : 'Chaque page a un seul H1. Rien à faire.',
  });

  // 4. Images avec alt
  const imgTotal = pages.reduce((s, p) => s + (p.images ? p.images.total : 0), 0);
  const imgAlt = pages.reduce((s, p) => s + (p.images ? p.images.withAlt : 0), 0);
  const altBad = pages
    .filter((p) => p.images && p.images.total > p.images.withAlt)
    .map((p) => ({ url: p.url, why: `${p.images.total - p.images.withAlt} image(s) sans texte alternatif` }));
  add({
    id: 'alt', label: 'Images avec texte alternatif', max: 10,
    points: imgTotal ? 10 * imgAlt / imgTotal : 10,
    measured: imgTotal ? `${imgAlt} image(s) sur ${imgTotal} avec alt (${pct(imgAlt, imgTotal)} %)` : 'aucune image trouvée',
    details: sample(altBad),
    explanation: imgAlt < imgTotal
      ? 'Le texte alternatif décrit l\'image pour les personnes malvoyantes et les moteurs. Renseignez-le dans la médiathèque WordPress pour les images listées.'
      : 'Toutes les images ont un texte alternatif. Rien à faire.',
  });

  // 5. LocalBusiness sur l'accueil
  const home = pages.find((p) => p.isHome);
  const hasLB = !!(home && (home.jsonLdTypes || []).some((t) => LOCAL_BUSINESS_TYPES.has(t)));
  add({
    id: 'localbusiness', label: 'Données structurées LocalBusiness sur l\'accueil', max: 10,
    points: hasLB ? 10 : 0,
    measured: hasLB ? 'présentes' : (home ? 'absentes' : 'page d\'accueil inaccessible'),
    explanation: hasLB
      ? 'Les informations de l\'entreprise sont lisibles par les moteurs. Rien à faire.'
      : 'Ajoutez les données structurées LocalBusiness (nom, adresse, téléphone, zone desservie) sur la page d\'accueil, avec un plugin SEO ou un bloc JSON-LD.',
  });

  // 6. Liens internes cassés
  const lk = d.links || { checked: 0, broken: [] };
  add({
    id: 'broken', label: 'Liens internes cassés (réponse différente de 200)', max: 10,
    points: lk.checked ? 10 * (lk.checked - lk.broken.length) / lk.checked : 10,
    measured: `${lk.broken.length} lien(s) cassé(s) sur ${lk.checked} vérifié(s)${lk.truncated ? ' (vérification limitée)' : ''}`,
    details: sample(lk.broken.map((b) => ({ url: b.url, why: `réponse ${b.status || 'sans réponse'}` }))),
    explanation: lk.broken.length
      ? 'Un lien cassé donne une mauvaise impression et fait perdre des visiteurs. Corrigez ou supprimez les liens listés, ou mettez une redirection.'
      : 'Aucun lien interne cassé parmi ceux vérifiés. Rien à faire.',
  });

  // 7. Pages orphelines
  const orphans = d.orphans || [];
  const orphanBase = d.sitemapCount || n;
  add({
    id: 'orphans', label: 'Aucune page orpheline (page du plan du site non liée depuis une autre page)', max: 10,
    points: orphanBase ? 10 * (orphanBase - orphans.length) / orphanBase : 10,
    measured: `${orphans.length} page(s) orpheline(s) sur ${orphanBase}`,
    details: sample(orphans.map((u) => ({ url: u, why: 'aucun lien interne ne pointe vers elle' }))),
    explanation: orphans.length
      ? 'Une page que personne ne lie est difficile à découvrir. Ajoutez un lien vers chaque page listée depuis une page pertinente (menu, article, page de service).'
      : 'Toutes les pages du plan du site sont reliées entre elles. Rien à faire.',
  });

  // 8. Contenu mince
  const thin = pageProblems(pages, (p) => (p.words < 300 ? `${p.words} mots` : null));
  add({
    id: 'thin', label: 'Pages à contenu mince (moins de 300 mots)', max: 10,
    points: n ? 10 * (n - thin.length) / n : 0,
    measured: `${thin.length} page(s) de moins de 300 mots sur ${n}`,
    details: sample(thin),
    explanation: thin.length
      ? 'Une page très courte répond rarement à la question du visiteur. Étoffez les pages listées avec du contenu utile et concret, ou regroupez-les.'
      : 'Aucune page n\'est trop courte. Rien à faire.',
  });

  // 9. robots.txt
  add({
    id: 'robots', label: 'Plan du site déclaré dans robots.txt', max: 5,
    points: d.robotsHasSitemap ? 5 : 0,
    measured: d.robotsHasSitemap ? 'déclaré' : 'non déclaré',
    explanation: d.robotsHasSitemap
      ? 'Le fichier robots.txt indique le plan du site. Rien à faire.'
      : 'Ajoutez une ligne « Sitemap: https://citylock.fr/sitemap_index.xml » dans robots.txt (réglage du plugin SEO).',
  });

  // 10. Pages hors sujet
  const off = (d.sitemapUrls || []).map((u) => {
    const pg = pages.find((p) => p.url === u);
    const why = isOffTopic(u, pg && pg.title);
    return why ? { url: u, why } : null;
  }).filter(Boolean);
  add({
    id: 'offtopic', label: 'Aucune page hors sujet ou de démonstration dans le plan du site', max: 5,
    points: off.length ? 0 : 5,
    measured: `${off.length} page(s) suspecte(s)`,
    details: sample(off),
    explanation: off.length
      ? 'Des pages d\'exemple ou de test ne servent à rien et diluent le site. Supprimez-les ou passez-les en « noindex ». Seuls les motifs évidents (demo, test, exemple, hello world...) sont détectés.'
      : 'Aucune page de démonstration évidente. Rien à faire.',
  });

  // 11. Vitesse mobile
  const sp = d.speed;
  if (sp && typeof sp.score === 'number') {
    const pts = sp.score >= 90 ? 10 : sp.score >= 50 ? 5 : 0;
    add({
      id: 'speed', label: 'Vitesse mobile (PageSpeed Insights, accueil)', max: 10, points: pts,
      measured: `score performance mobile : ${Math.round(sp.score)}/100`,
      explanation: pts === 10
        ? 'Le site est rapide sur mobile. Rien à faire.'
        : 'Allégez les images, limitez les plugins et activez un cache pour dépasser 90. Le rapport PageSpeed détaille les causes.',
    });
  } else {
    add({
      id: 'speed', label: 'Vitesse mobile (PageSpeed Insights, accueil)', max: 10, points: null, notMeasured: true,
      measured: 'non mesuré',
      explanation: sp && sp.error
        ? `Mesure impossible : ${sp.error}. Ce critère n'est pas compté dans le score.`
        : 'Aucune clé PageSpeed fournie. Ce critère n\'est pas compté dans le score.',
    });
  }

  const counted = criteria.filter((c) => !c.notMeasured);
  const maxCounted = counted.reduce((s, c) => s + c.max, 0);
  const total = counted.reduce((s, c) => s + c.points, 0);
  const score = maxCounted ? Math.round((total / maxCounted) * 100) : 0;

  const improvements = counted
    .filter((c) => c.points < c.max)
    .map((c) => ({ id: c.id, label: c.label, gain: r1(c.max - c.points), explanation: c.explanation }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 5);

  return { score, points: r1(total), maxCounted, criteria, improvements };
}

module.exports = { computeScore, isOffTopic };
