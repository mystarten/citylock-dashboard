// Interface CityLock. Aucune clé ici : tout passe par l'API du serveur.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MARKER = '[SOURCE A VERIFIER]';
  const NS = 'http://www.w3.org/2000/svg';

  // ---------- Outils ----------
  const ICONS = {
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h6',
    gauge: 'M12 14l4-4M3.5 18a9.5 9.5 0 1 1 17 0',
    sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4',
    help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    check: 'M5 12l5 5L20 7',
    x: 'M6 6l12 12M18 6L6 18',
    alert: 'M12 8v5M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    plug: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    back: 'M19 12H5M12 19l-7-7 7-7',
    ext: 'M14 3h7v7M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
    trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
    plus: 'M12 5v14M5 12h14',
    refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
    send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  };
  function icon(name, extra) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ic' + (extra ? ' ' + extra : ''));
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name]);
    s.append(p);
    return s;
  }
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  const add = (parent, ...kids) => { parent.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return parent; };
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const monthNow = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
  const plural = (n, one, many) => (n > 1 ? many : one);

  async function api(path, method = 'GET', body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* corps vide */ }
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Votre session a expiré. Reconnectez-vous.'); }
    if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
    return data;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 6500);
  }
  const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  // ---------- Etat ----------
  const S = { settings: null, status: null, articles: [], audits: null, view: 'home', articleId: null, batch: { running: false, done: 0, total: 0, errors: [] }, auditRunning: false };
  let pollTimer = null;

  const NAV = [
    ['home', 'Accueil', 'home'],
    ['articles', 'Articles', 'file'],
    ['score', 'Score du site', 'gauge'],
    ['settings', 'Réglages', 'sliders'],
    ['help', 'Aide', 'help'],
  ];
  const pending = () => S.articles.filter((a) => a.status !== 'publie').length;

  function renderNav() {
    const nav = $('nav');
    nav.replaceChildren(...NAV.map(([id, label, ic]) => {
      const n = id === 'articles' ? pending() : 0;
      return el('button', { type: 'button', class: 'nav-btn' + (S.view === id ? ' active' : ''), 'aria-current': S.view === id ? 'page' : false, onclick: () => go(id) },
        icon(ic), el('span', {}, label), n ? el('span', { class: 'dot' }, n) : null);
    }));
    $('logout').replaceChildren(icon('logout'), el('span', {}, 'Se déconnecter'));
  }

  async function refresh() {
    const [settings, status, articles, audits] = await Promise.all([api('/settings'), api('/status'), api('/articles'), api('/audits')]);
    Object.assign(S, { settings, status, articles, audits });
    S.auditRunning = !!audits.status.running;
    $('sim').classList.toggle('hidden', !status.simulate);
  }

  function go(view, articleId) {
    S.view = view;
    S.articleId = articleId || null;
    window.scrollTo(0, 0);
    render();
    if (view === 'score') watchAudit();
  }

  function render() {
    renderNav();
    const main = $('main');
    main.replaceChildren();
    const views = { home: viewHome, articles: viewArticles, article: viewArticle, score: viewScore, settings: viewSettings, help: viewHelp };
    main.append(...[].concat(views[S.view]()).filter(Boolean));
  }
  const head = (title, sub, right) => el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, title), sub ? el('p', { class: 'muted' }, sub) : null), right || null);

  // ---------- Accueil ----------
  function viewHome() {
    const s = S.settings;
    const used = S.articles.filter((a) => a.month === monthNow()).length;
    const latest = S.audits.latest;
    const toReview = S.articles.filter((a) => a.status === 'a_relire').length;
    const drafts = S.articles.filter((a) => a.status === 'brouillon_wp').length;
    const usedTopics = new Set(S.articles.filter((a) => a.month === monthNow()).map((a) => a.topicId));
    const freeTopics = s.topics.filter((t) => !usedTopics.has(t.id)).length;

    let next;
    if (!s.topics.length) next = ['Commencez par choisir vos sujets', 'Indiquez les thèmes dont vous voulez parler, par exemple « alarme sans abonnement » à Chatou.', 'Ajouter des sujets', () => go('settings')];
    else if (toReview) next = [`${toReview} ${plural(toReview, 'article attend', 'articles attendent')} votre relecture`, 'Lisez le texte, vérifiez les chiffres signalés, puis envoyez-le sur votre site.', 'Relire maintenant', () => go('articles')];
    else if (drafts) next = [`${drafts} ${plural(drafts, 'brouillon est prêt', 'brouillons sont prêts')} sur votre site`, 'Ils ne sont pas visibles du public. Relisez-les, puis publiez-les.', 'Voir les brouillons', () => go('articles')];
    else if (used < s.frequency && freeTopics) next = ['Rédigez les articles du mois', `Il reste ${Math.min(s.frequency - used, freeTopics)} ${plural(Math.min(s.frequency - used, freeTopics), 'article', 'articles')} à préparer ce mois-ci.`, 'Rédiger maintenant', () => { go('articles'); startBatch(); }];
    else if (!latest) next = ['Mesurez la santé de votre site', 'Le score vous dit en 1 minute ce qu\'il faut améliorer sur citylock.fr.', 'Mesurer mon site', () => { go('score'); startAudit(); }];
    else next = ['Tout est à jour', 'Revenez le mois prochain, ou ajoutez de nouveaux sujets quand vous voulez.', 'Voir mes sujets', () => go('settings')];

    const wpPill = S.status.simulate ? el('span', { class: 'pill warn' }, 'Démonstration')
      : S.status.wordpress ? el('span', { class: 'pill ok' }, icon('check'), 'Configuré') : el('span', { class: 'pill ko' }, 'À configurer');

    return [
      head('Bonjour', 'Voici où vous en êtes.'),
      el('div', { class: 'grid3' },
        el('div', { class: 'card stat' }, el('div', { class: 'label' }, icon('file'), 'Articles ce mois-ci'), el('div', { class: 'value' }, used, el('small', {}, ' sur ' + s.frequency)), el('div', { class: 'hint' }, 'Objectif choisi dans les réglages')),
        el('div', { class: 'card stat' }, el('div', { class: 'label' }, icon('gauge'), 'Score du site'),
          el('div', { class: 'value' }, latest ? latest.score : '--', el('small', {}, ' / 100')),
          el('div', { class: 'hint' }, latest ? 'Mesuré le ' + fmtDate(latest.date) : 'Pas encore mesuré')),
        el('div', { class: 'card stat' }, el('div', { class: 'label' }, icon('plug'), 'Liaison avec votre site'), el('div', { class: 'value' }, wpPill), el('div', { class: 'hint' }, 'WordPress (citylock.fr)'))),
      el('div', { class: 'card next' },
        el('div', {}, el('div', { class: 'eyebrow' }, 'Votre prochaine étape'), el('h2', {}, next[0]), el('p', {}, next[1])),
        el('button', { class: 'btn primary big', type: 'button', onclick: safe(next[3]) }, next[2])),
      el('div', { class: 'card' }, el('h2', {}, 'Comment ça marche'), el('p', { class: 'muted' }, 'Trois étapes, et vous gardez toujours la main.'),
        el('div', { class: 'steps' },
          step(1, 'Choisir', 'Vous validez les sujets et le nombre d\'articles par mois.'),
          step(2, 'Relire', 'L\'outil rédige. Vous lisez, vous corrigez les chiffres signalés.'),
          step(3, 'Publier', 'Un clic envoie l\'article sur votre site, d\'abord en brouillon.'))),
    ];
  }
  const step = (n, t, d) => el('div', { class: 'step' }, el('div', { class: 'num' }, n), el('div', {}, el('h3', {}, t), el('p', { class: 'muted small' }, d)));

  // ---------- Articles ----------
  const STATUS = { a_relire: ['À relire', 'warn'], brouillon_wp: ['Brouillon sur le site', 'warn'], publie: ['Publié', 'ok'] };

  function viewArticles() {
    const s = S.settings;
    const used = S.articles.filter((a) => a.month === monthNow()).length;
    const b = S.batch;
    const out = [head('Articles', `Objectif du mois : ${s.frequency} ${plural(s.frequency, 'article', 'articles')}. Déjà préparés : ${used}.`,
      el('button', { class: 'btn primary big', type: 'button', disabled: b.running ? true : false, onclick: safe(startBatch) }, icon('spark'), 'Rédiger les articles du mois'))];

    out.push(el('div', { class: 'alert' + (s.autoDraft ? ' ok' : '') }, s.autoDraft
      ? 'Chaque article rédigé est envoyé automatiquement sur votre site en brouillon. Rien n\'est publié sans votre accord.'
      : 'Les articles restent ici jusqu\'à ce que vous les envoyiez vous-même sur le site.'));

    if (b.running) {
      out.push(el('div', { class: 'card' }, el('h2', {}, 'Rédaction en cours...'),
        el('p', { class: 'muted' }, `${b.done} sur ${b.total} terminés. Cela peut prendre quelques minutes, vous pouvez rester sur cette page.`),
        el('div', { class: 'progress' }, (() => { const i = el('i'); i.style.width = Math.max(6, Math.round((b.done / Math.max(1, b.total)) * 100)) + '%'; return i; })())));
    }
    if (!b.running && b.errors.length) out.push(el('div', { class: 'card' }, el('h2', {}, 'Certains articles n\'ont pas pu être préparés'), el('ul', { class: 'tasks' }, b.errors.map((e) => el('li', {}, e)))));

    const list = el('div', {});
    if (!S.articles.length) {
      list.append(el('div', { class: 'card empty' }, icon('file'), el('h3', {}, 'Aucun article pour l\'instant'),
        el('p', { class: 'muted' }, s.topics.length ? 'Cliquez sur « Rédiger les articles du mois » pour commencer.' : 'Ajoutez d\'abord des sujets dans les réglages.'),
        s.topics.length ? null : el('p', {}, el('button', { class: 'btn primary', type: 'button', onclick: () => go('settings') }, 'Aller aux réglages'))));
    } else {
      S.articles.forEach((a) => {
        const [label, tone] = STATUS[a.status] || [a.status, ''];
        list.append(el('button', { class: 'art-row', type: 'button', onclick: () => go('article', a.id) },
          el('div', { class: 'grow' }, el('div', { class: 't' }, a.title), el('div', { class: 'm' }, a.keyword + (a.city ? ' à ' + a.city : '') + ' · ' + a.wordCount + ' mots · ' + fmtDate(a.createdAt))),
          el('span', { class: 'pill ' + tone }, label)));
      });
    }
    out.push(list);
    return out;
  }

  function highlightMarkers(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    nodes.forEach((n) => {
      if (!n.nodeValue.includes(MARKER)) return;
      const frag = document.createDocumentFragment();
      const parts = n.nodeValue.split(MARKER);
      parts.forEach((p, i) => { frag.append(document.createTextNode(p)); if (i < parts.length - 1) frag.append(el('mark', { class: 'src' }, MARKER)); });
      n.replaceWith(frag);
    });
  }

  function viewArticle() {
    const a = S.articles.find((x) => x.id === S.articleId);
    if (!a) { go('articles'); return []; }
    const markers = (a.htmlContent.match(/\[SOURCE A VERIFIER\]/g) || []).length;
    const stage = { a_relire: 1, brouillon_wp: 2, publie: 3 }[a.status];
    const stepper = el('div', { class: 'stepper' }, ['Rédigé', 'Envoyé sur le site (brouillon)', 'Relu et validé', 'Publié'].map((t, i) => {
      const state = a.status === 'publie' ? 'done' : (i < stage + 0 ? 'done' : i === stage ? 'now' : '');
      return el('div', { class: 's ' + state }, el('span', { class: 'n' }, state === 'done' ? icon('check') : i + 1), t);
    }));

    const preview = el('div', { class: 'preview' });
    preview.innerHTML = a.htmlContent; // HTML assaini côté serveur (balises autorisées uniquement)
    highlightMarkers(preview);

    const wp = safeUrl(a.wpLink);
    const actions = el('div', { class: 'card sticky' });
    const reload = async () => { await refresh(); render(); };
    if (a.status === 'a_relire') {
      add(actions, el('div', { class: 'eyebrow' }, 'Étape suivante'), el('h2', {}, 'Envoyer sur votre site'),
        el('p', { class: 'muted small' }, 'L\'article arrive en brouillon dans WordPress. Il n\'est pas visible du public.'),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary big', type: 'button', onclick: safe(async () => { await api(`/articles/${a.id}/send`, 'POST'); toast('Brouillon créé sur votre site.'); await reload(); }) }, icon('send'), 'Envoyer en brouillon')));
    } else if (a.status === 'brouillon_wp') {
      const chk = el('input', { type: 'checkbox', id: 'validated' });
      const pub = el('button', { class: 'btn primary big', type: 'button', disabled: true, onclick: safe(async () => { await api(`/articles/${a.id}/publish`, 'POST', { validated: true }); toast('Article publié sur votre site.'); await reload(); }) }, icon('check'), 'Publier sur le site');
      chk.addEventListener('change', () => { pub.disabled = !chk.checked; });
      add(actions, el('div', { class: 'eyebrow' }, 'Dernière étape'), el('h2', {}, 'Publier l\'article'),
        el('p', { class: 'muted small' }, 'Le brouillon est sur votre site, pas encore visible. Vous pouvez encore le modifier dans WordPress.'),
        wp && !a.simulated ? el('p', {}, el('a', { class: 'btn', href: wp, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Ouvrir dans WordPress')) : null,
        markers ? el('div', { class: 'alert' }, `${markers} ${plural(markers, 'chiffre doit', 'chiffres doivent')} être sourcé${markers > 1 ? 's' : ''} avant publication (surlignés en jaune).`) : null,
        el('label', { class: 'check', for: 'validated' }, chk, el('span', {}, 'J\'ai relu et validé cet article')),
        el('div', { class: 'actions' }, pub));
    } else {
      add(actions, el('div', { class: 'alert ok' }, 'Cet article est publié sur votre site.'), wp ? el('p', {}, el('a', { class: 'btn', href: wp, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Voir l\'article')) : null);
    }
    if (a.status !== 'publie') {
      add(actions, el('div', { class: 'actions' }, el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => {
        if (!confirm(a.status === 'brouillon_wp' ? 'Supprimer ce brouillon, aussi sur votre site ?' : 'Supprimer cet article ?')) return;
        await api('/articles/' + a.id, 'DELETE'); toast('Article supprimé.'); await refresh(); go('articles');
      }) }, icon('trash'), 'Supprimer ce brouillon')));
    }

    const count = (n, max, what) => el('div', { class: 'count' + (n > max ? ' bad' : ' muted') }, `${n} caractères sur ${max} conseillés${n > max ? ' : trop long, à raccourcir dans votre extension SEO' : ''}`);
    const checks = el('div', { class: 'card' }, el('h2', {}, 'À vérifier avant de publier'));
    add(checks, a.faitsAVerifier.length
      ? el('ul', { class: 'tasks' }, a.faitsAVerifier.map((f) => el('li', {}, f)))
      : el('p', { class: 'muted' }, 'Aucun point signalé. Relisez quand même chaque phrase.'));
    if (a.warnings && a.warnings.length) add(checks, el('h3', {}, 'Remarques automatiques'), el('ul', { class: 'tasks' }, a.warnings.map((w) => el('li', {}, w))));

    const slugUrl = ((S.status.siteUrl || 'https://citylock.fr').replace(/^https?:\/\//, '')) + ' › ' + a.slug;
    const serp = el('div', { class: 'card' }, el('h2', {}, 'Aperçu dans Google'),
      el('p', { class: 'muted small' }, 'À recopier dans l\'extension SEO de WordPress (Yoast ou Rank Math).'),
      el('div', { class: 'serp' }, el('div', { class: 'u' }, slugUrl), el('div', { class: 'tt' }, a.metaTitle), el('div', { class: 'dd' }, a.metaDescription)),
      count(a.metaTitle.length, 60), count(a.metaDescription.length, 155));

    const links = a.internalLinkSuggestions.length ? el('div', { class: 'card' }, el('h2', {}, 'Pages du site à relier'), el('ul', { class: 'tasks' }, a.internalLinkSuggestions.map((l) => el('li', {}, l)))) : null;

    return [
      el('button', { class: 'btn ghost', type: 'button', onclick: () => go('articles') }, icon('back'), 'Retour aux articles'),
      head(a.title, a.keyword + (a.city ? ' à ' + a.city : '') + ' · ' + a.wordCount + ' mots' + (a.simulated ? ' · texte de démonstration' : '')),
      stepper,
      el('div', { class: 'detail' },
        el('div', { class: 'col' }, el('div', { class: 'card post' }, el('h1', { class: 'post-title' }, a.title), preview)),
        el('div', { class: 'col side-col' }, actions, checks, serp, links)),
    ];
  }

  async function startBatch() {
    await api('/articles/batch', 'POST');
    S.batch = { running: true, done: 0, total: 1, errors: [] };
    render();
    pollBatch();
  }
  async function pollBatch() {
    clearTimeout(pollTimer);
    try {
      const b = await api('/articles/batch/status');
      const was = S.batch.running;
      S.batch = b;
      if (b.running) pollTimer = setTimeout(pollBatch, 2500);
      else if (was || b.total) { await refresh(); toast(b.errors.length ? 'Terminé, avec des erreurs.' : 'Vos articles sont prêts à relire.', !!b.errors.length); }
      if (['articles', 'home'].includes(S.view)) render(); else renderNav();
    } catch { /* on réessaiera */ }
  }

  // ---------- Score ----------
  const PLAIN = {
    title: 'Titres des pages', meta: 'Descriptions sous les résultats Google', h1: 'Un titre principal par page', alt: 'Images décrites',
    localbusiness: 'Fiche entreprise lisible par Google', broken: 'Liens qui ne marchent plus', orphans: 'Pages que personne ne relie',
    thin: 'Pages trop courtes', robots: 'Plan du site déclaré aux moteurs', offtopic: 'Pages de test à supprimer', speed: 'Vitesse sur mobile',
  };

  function ring(score) {
    const C = 339.29;
    const tone = score >= 80 ? 'good' : score >= 60 ? 'mid' : 'low';
    const wrap = el('div', { class: 'ring ' + tone });
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    const mk = (cls, dash) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 60); c.setAttribute('cy', 60); c.setAttribute('r', 54); c.setAttribute('class', cls); if (dash) c.setAttribute('stroke-dasharray', dash); svg.append(c); };
    mk('bg'); mk('fg', `${(score / 100) * C} ${C}`);
    wrap.append(svg, el('div', { class: 'num' }, el('div', {}, el('b', {}, score), el('span', {}, ' / 100'))));
    return wrap;
  }

  function viewScore() {
    const d = S.audits;
    const a = d.latest;
    const out = [head('Score du site', 'La santé de citylock.fr, mesurée sur des points précis.'),
      el('div', { class: 'notice' }, 'Score calculé selon les critères ci-dessous, il ne s\'agit pas d\'une note Google.')];

    const label = a ? (a.score >= 80 ? 'Bon état' : a.score >= 60 ? 'Correct, à améliorer' : 'À améliorer en priorité') : '';
    const runBtn = el('button', { class: 'btn primary', type: 'button', disabled: S.auditRunning ? true : false, onclick: safe(startAudit) }, icon('refresh'), S.auditRunning ? 'Mesure en cours...' : a ? 'Relancer la mesure' : 'Mesurer mon site');
    out.push(el('div', { class: 'card score-top' },
      a ? ring(a.score) : el('div', { class: 'empty' }, icon('gauge')),
      el('div', {}, a ? el('h2', {}, label) : el('h2', {}, 'Pas encore de mesure'),
        el('p', { class: 'muted' }, a ? `Mesuré le ${fmtDate(a.date)} sur ${a.pagesCount} pages${a.truncated ? ' (les premières seulement)' : ''}.` : 'Cliquez sur le bouton pour analyser votre site. Cela prend environ une minute.'),
        el('div', { class: 'actions' }, runBtn),
        d.status.lastError && !S.auditRunning ? el('p', { class: 'form-error' }, 'La dernière mesure a échoué : ' + d.status.lastError) : null)));

    if (!a) return out;

    const top = el('div', { class: 'card' }, el('h2', {}, 'À faire en priorité'), el('p', { class: 'muted' }, 'Les 5 actions qui font gagner le plus de points.'));
    if (a.improvements.length) a.improvements.forEach((i) => top.append(el('div', { class: 'todo' }, el('span', { class: 'gain' }, '+' + i.gain + ' pt'), el('div', {}, el('h3', {}, PLAIN[i.id] || i.label), el('p', { class: 'muted small' }, i.explanation)))));
    else top.append(el('p', {}, 'Rien à améliorer sur les points mesurés.'));
    out.push(top);

    out.push(el('div', { class: 'card' }, el('h2', {}, 'Évolution'), el('div', { id: 'chart' }, chart(d.history.slice(-26))),
      el('table', { class: 't' }, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Score'), el('th', {}, 'Lancement')),
        d.history.slice().reverse().slice(0, 10).map((h) => el('tr', {}, el('td', {}, fmtDate(h.date)), el('td', {}, h.score + ' / 100'), el('td', {}, h.trigger))))));

    const crits = el('div', { class: 'card' }, el('h2', {}, 'Détail, point par point'), el('p', { class: 'muted' }, 'Cliquez sur une ligne pour voir pourquoi et quoi faire.'));
    a.criteria.forEach((c) => {
      const nm = c.points == null;
      const tone = nm ? 'nm' : c.points >= c.max ? 'ok' : c.points === 0 ? 'ko' : 'mid';
      crits.append(el('details', { class: 'crit' },
        el('summary', {}, el('span', { class: 'dot-s ' + tone }, icon(tone === 'ok' ? 'check' : tone === 'nm' ? 'alert' : 'x')),
          el('span', { class: 'name' }, PLAIN[c.id] || c.label),
          el('span', { class: 'pill ' + (tone === 'ok' ? 'ok' : tone === 'nm' ? '' : tone === 'ko' ? 'ko' : 'warn') }, nm ? 'Non mesuré' : `${c.points} / ${c.max}`)),
        el('div', { class: 'body' }, el('p', { class: 'muted small' }, c.label), el('p', {}, el('b', {}, 'Constat : '), c.measured), el('p', {}, c.explanation),
          c.details && c.details.length ? el('ul', {}, c.details.map((x) => el('li', {}, x.url + ' : ' + x.why))) : null)));
    });
    out.push(crits);
    return out;
  }

  function chart(points) {
    if (points.length < 2) return el('p', { class: 'muted' }, 'La courbe apparaît à partir de deux mesures.');
    const W = 600, H = 170, P = 30;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Courbe des scores');
    const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; svg.append(n); };
    const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
    const y = (s) => H - P - (s / 100) * (H - 2 * P);
    [0, 50, 100].forEach((g) => { mk('line', { class: 'grid', x1: P, x2: W - P, y1: y(g), y2: y(g) }); mk('text', { x: 0, y: y(g) + 4 }, g); });
    mk('polyline', { class: 'line', points: points.map((p, i) => `${x(i)},${y(p.score)}`).join(' ') });
    points.forEach((p, i) => mk('circle', { class: 'dot', cx: x(i), cy: y(p.score), r: 4 }));
    return svg;
  }

  async function startAudit() {
    await api('/audit/run', 'POST');
    S.auditRunning = true;
    render();
    watchAudit();
  }
  function watchAudit() {
    clearTimeout(pollTimer);
    if (!S.auditRunning) return;
    pollTimer = setTimeout(async () => {
      try {
        S.audits = await api('/audits');
        S.auditRunning = !!S.audits.status.running;
        if (S.view === 'score') render();
        if (S.auditRunning) watchAudit(); else toast(S.audits.status.lastError ? 'La mesure a échoué.' : 'Mesure terminée.', !!S.audits.status.lastError);
      } catch { /* nouvel essai */ watchAudit(); }
    }, 3000);
  }

  // ---------- Réglages ----------
  async function saveSettings(patch, msg) {
    const s = { ...S.settings, ...patch };
    S.settings = await api('/settings', 'PUT', { frequency: Number(s.frequency), brandName: s.brandName, zone: s.zone, autoDraft: s.autoDraft });
    if (msg) toast(msg);
  }

  function viewSettings() {
    const s = S.settings, st = S.status;
    const freq = el('input', { type: 'range', min: 1, max: 8, step: 1, value: s.frequency, 'aria-label': 'Articles par mois' });
    const big = el('div', { class: 'freq-val' }, s.frequency, el('small', {}, plural(s.frequency, 'article par mois', 'articles par mois')));
    const hint = el('p', { class: 'muted small' }, freqHint(s.frequency));
    freq.addEventListener('input', () => { big.replaceChildren(freq.value, el('small', {}, plural(+freq.value, 'article par mois', 'articles par mois'))); hint.textContent = freqHint(+freq.value); });
    freq.addEventListener('change', safe(async () => { await saveSettings({ frequency: Number(freq.value) }, 'Fréquence enregistrée.'); }));

    const kw = el('input', { type: 'text', maxlength: 100, placeholder: 'Sujet, par exemple : alarme sans abonnement', 'aria-label': 'Sujet', required: true });
    const city = el('input', { type: 'text', maxlength: 60, placeholder: 'Ville (facultatif)', 'aria-label': 'Ville' });
    const topics = el('div', { class: 'chips' });
    if (!s.topics.length) topics.append(el('p', { class: 'muted' }, 'Aucun sujet pour l\'instant.'));
    s.topics.forEach((t) => topics.append(el('div', { class: 'chip' }, el('div', { class: 'grow' }, el('b', {}, t.keyword), t.city ? ' à ' + t.city : ''),
      el('button', { type: 'button', 'aria-label': 'Supprimer ce sujet', onclick: safe(async () => { S.settings = await api('/topics/' + t.id, 'DELETE'); render(); }) }, icon('trash')))));

    const brand = el('input', { type: 'text', maxlength: 60, value: s.brandName, id: 'brand' });
    const zone = el('input', { type: 'text', maxlength: 80, value: s.zone, id: 'zone' });

    const auto = el('input', { type: 'checkbox', checked: s.autoDraft ? true : false, id: 'auto', role: 'switch' });
    auto.addEventListener('change', safe(async () => { await saveSettings({ autoDraft: auto.checked }, auto.checked ? 'Envoi automatique activé.' : 'Envoi automatique désactivé.'); }));

    const wpMsg = el('p', { class: 'muted small', id: 'wp-msg' });
    const conn = (name, what, pill, extra) => el('div', { class: 'conn' }, el('div', { class: 'grow' }, el('b', {}, name), el('div', { class: 'muted small' }, what)), pill, extra || null);
    const wpPill = st.simulate ? el('span', { class: 'pill warn' }, 'Démonstration') : st.wordpress ? el('span', { class: 'pill ok' }, 'Identifiants présents') : el('span', { class: 'pill ko' }, 'Non configuré');
    const wpBtns = (st.wordpress || st.simulate) ? el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', onclick: safe(async () => { const r = await api('/wp/test'); wpMsg.textContent = r.simulated ? 'Simulation : aucun test réel.' : `Connecté en tant que ${r.name}. Création de brouillons : ${r.canEdit ? 'oui' : 'non'}. Publication : ${r.canPublish ? 'oui' : 'non'}.`; }) }, 'Tester la connexion'),
      el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api('/category/ensure', 'POST'); toast('Catégorie « Blog » prête sur votre site.'); }) }, 'Préparer la catégorie « Blog »')) : null;

    return [
      head('Réglages', 'Choisissez le rythme, les sujets et la liaison avec votre site.'),
      el('div', { class: 'card' }, el('h2', {}, 'Combien d\'articles par mois ?'), el('p', { class: 'muted' }, 'Déplacez le curseur. L\'outil ne rédigera jamais plus que ce nombre.'), big, freq, el('div', { class: 'scale' }, el('span', {}, '1'), el('span', {}, '8')), hint),
      el('div', { class: 'card' }, el('h2', {}, 'Vos sujets d\'articles'), el('p', { class: 'muted' }, 'Un sujet = un mot-clé que vous voulez travailler, avec une ville si utile.'),
        el('form', { class: 'row', onsubmit: safe(async (e) => { e.preventDefault(); S.settings = await api('/topics', 'POST', { keyword: kw.value, city: city.value }); render(); }) }, kw, city, el('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Ajouter')), topics),
      el('div', { class: 'card' }, el('h2', {}, 'Publication sur le site'),
        el('div', { class: 'switch-row' }, el('div', {}, el('b', {}, 'Envoyer chaque article en brouillon, automatiquement'), el('p', { class: 'muted small' }, 'Le brouillon n\'est pas visible du public. Vous publiez vous-même, après relecture.')),
          el('label', { class: 'switch', for: 'auto', 'aria-label': 'Envoi automatique en brouillon' }, auto, el('span')))),
      el('div', { class: 'card' }, el('h2', {}, 'Votre entreprise'), el('p', { class: 'muted' }, 'Ces informations servent à rédiger les articles.'),
        el('label', { for: 'brand' }, 'Nom commercial'), brand, el('label', { for: 'zone' }, 'Zone desservie'), zone,
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { await saveSettings({ brandName: brand.value, zone: zone.value }, 'Informations enregistrées.'); }) }, 'Enregistrer'))),
      el('div', { class: 'card' }, el('h2', {}, 'Connexions'), el('p', { class: 'muted' }, 'État des services utilisés par l\'outil.'),
        conn('Votre site WordPress', 'Pour créer et publier les articles', wpPill, wpBtns), el('div', {}, wpMsg),
        conn('Rédaction automatique', 'Le service qui écrit les textes', st.simulate ? el('span', { class: 'pill warn' }, 'Démonstration') : st.openrouter ? el('span', { class: 'pill ok' }, 'Prêt') : el('span', { class: 'pill ko' }, 'Non configuré')),
        conn('Vitesse du site (Google)', 'Facultatif : ajoute la vitesse mobile au score', st.pagespeed ? el('span', { class: 'pill ok' }, 'Activée') : el('span', { class: 'pill' }, 'Non activée'))),
    ];
  }
  const freqHint = (n) => `Soit environ un article toutes les ${Math.max(1, Math.round(4.3 / n * 10) / 10).toString().replace('.', ',')} semaines.`;

  // ---------- Aide ----------
  function viewHelp() {
    const faq = (q, ...paras) => el('details', { class: 'faq' }, el('summary', {}, q), el('div', { class: 'a' }, paras.map((p) => el('p', {}, p))));
    return [
      head('Aide', 'Tout ce qu\'il faut savoir, simplement.'),
      faq('À quoi sert cet outil ?', 'Il prépare des articles de blog pour citylock.fr et mesure chaque semaine la santé de votre site pour Google. Rien n\'est publié sans votre accord.'),
      faq('Comment choisir le nombre d\'articles ?', 'Dans « Réglages », déplacez le curseur entre 1 et 8 articles par mois. Ajoutez ensuite vos sujets : un article est préparé par sujet.'),
      faq('Comment relire et publier un article ?', '1. Dans « Articles », cliquez sur « Rédiger les articles du mois ».', '2. Ouvrez un article. Lisez le texte. Les chiffres surlignés en jaune doivent être remplacés par une vraie source, directement dans WordPress.', '3. Quand tout est bon, cochez « J\'ai relu et validé », puis cliquez sur « Publier sur le site ».'),
      faq('Que veut dire « brouillon » ?', 'Un brouillon est un article enregistré sur votre site mais invisible du public. Vous pouvez le modifier tant que vous ne l\'avez pas publié.'),
      faq('Que mesure le score ?', 'Un score sur 100 calculé avec des points précis : titres, descriptions, images décrites, liens cassés, pages trop courtes, plan du site, etc. Il vous dit quoi corriger en priorité.', 'Ce n\'est pas une note Google. Il ne mesure ni votre place dans les résultats, ni le nombre de visiteurs. Un bon score ne garantit aucun classement.'),
      faq('Pourquoi un chiffre est-il signalé « à vérifier » ?', 'L\'outil n\'a pas le droit d\'inventer des chiffres. Quand une statistique serait utile, il laisse un repère [SOURCE A VERIFIER] à remplacer par une source fiable, ou à supprimer.'),
      el('div', { class: 'card' }, el('h2', {}, 'Petit lexique'), el('dl', { class: 'gloss' },
        el('dt', {}, 'SEO'), el('dd', {}, 'Tout ce qui aide votre site à apparaître dans les recherches Google.'),
        el('dt', {}, 'Meta description'), el('dd', {}, 'Le petit texte affiché sous le titre de votre page dans Google.'),
        el('dt', {}, 'Texte alternatif'), el('dd', {}, 'Une courte description d\'une image, lue par Google et par les lecteurs d\'écran.'),
        el('dt', {}, 'Page orpheline'), el('dd', {}, 'Une page que personne ne relie : difficile à trouver pour les visiteurs et pour Google.'))),
      el('div', { class: 'card' }, el('h2', {}, 'Un problème ?'), el('p', {}, S.status.supportContact ? 'Contactez : ' + S.status.supportContact : 'Contactez la personne qui a mis en place cet outil.')),
    ];
  }

  // ---------- Connexion ----------
  function showLogin() {
    clearTimeout(pollTimer);
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }
  async function showApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    await refresh();
    go('home');
    api('/articles/batch/status').then((b) => { if (b.running) { S.batch = b; pollBatch(); } }).catch(() => {});
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.classList.add('hidden');
    try {
      await api('/login', 'POST', { username: $('user').value, password: $('pw').value, remember: $('remember').checked });
      $('pw').value = '';
      await showApp();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  });
  $('logout').addEventListener('click', safe(async () => { await api('/logout', 'POST'); showLogin(); }));

  (async () => {
    try {
      const r = await fetch('/api/session', { credentials: 'same-origin' }).then((x) => x.json());
      if (r.authenticated) await showApp(); else showLogin();
    } catch { showLogin(); }
  })();
})();
