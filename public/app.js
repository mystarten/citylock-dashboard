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
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch (netErr) {
      throw new Error('Connexion au tableau de bord perdue. Vérifiez votre réseau, puis réessayez. Si l\'action concernait une rédaction, rien n\'a été perdu : relancez-la.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* corps vide */ }
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Votre session a expiré. Reconnectez-vous.'); }
    if (!res.ok) { const err = new Error(data.error || 'Une erreur est survenue.'); if (data.code) err.code = data.code; throw err; }
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
  const S = { settings: null, status: null, articles: [], audits: null, view: 'home', articleId: null, writeMode: 'one', plan: null, batch: { running: false, done: 0, total: 0, errors: [], notes: [] }, auditRunning: false, settingsTab: 'redaction', msgs: {} };
  let pollTimer = null;

  const NAV = [
    ['home', 'Accueil', 'home'],
    ['write', 'Rédiger', 'spark'],
    ['articles', 'Articles', 'file'],
    ['score', 'Score du site', 'gauge'],
    ['settings', 'Réglages', 'sliders'],
    ['help', 'Aide', 'help'],
  ];
  const demoOn = () => !!(S.status && S.status.simulate);
  const mine = () => S.articles.filter((a) => !!a.simulated === demoOn()); // articles du mode en cours
  const pending = () => mine().filter((a) => a.status === 'a_relire').length;
  const limits = () => ({ min: (S.settings && S.settings.minWords) || 600, max: (S.settings && S.settings.maxWords) || 900 });
  const navActive = (id) => S.view === id || (id === 'articles' && (S.view === 'article' || S.view === 'edit'));
  const fmtDateTime = (iso) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  // Premier jour proposé : aujourd'hui, sauf s'il est trop tard pour une publication à 10 h (alors demain).
  const defaultStart = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const min = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
    const day = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(now);
    return min < 9 * 60 + 50 ? day : plusDays(day, 1);
  };
  const todayParis = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  const plusDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const modelTag = (m) => el('span', { class: 'model-tag' }, 'Rédigé avec : ', el('b', {}, m === 'démonstration' ? 'texte de démonstration (aucune IA)' : (m || 'modèle non enregistré')));

  function renderNav() {
    const nav = $('nav');
    nav.replaceChildren(...NAV.map(([id, label, ic]) => {
      const n = id === 'articles' ? pending() : 0;
      return el('button', { type: 'button', class: 'nav-btn' + (navActive(id) ? ' active' : ''), 'aria-current': navActive(id) ? 'page' : false, onclick: () => go(id) },
        icon(ic), el('span', {}, label), n ? el('span', { class: 'dot' }, n) : null);
    }));
    $('logout').replaceChildren(icon('logout'), el('span', {}, 'Se déconnecter'));
  }

  async function refresh() {
    const [settings, status, articles, audits, aiDefaults, publications] = await Promise.all([api('/settings'), api('/status'), api('/articles'), api('/audits'), api('/ai/defaults'), api('/publications')]);
    Object.assign(S, { settings, status, articles, audits, aiDefaults, publications });
    S.auditRunning = !!audits.status.running;
    $('sim').classList.toggle('hidden', !status.simulate);
  }

  function go(view, articleId) {
    S.view = view;
    S.articleId = articleId || null;
    if (view !== 'edit') S.edit = null;
    window.scrollTo(0, 0);
    render();
    if (view === 'score') watchAudit();
    if (view === 'articles' || view === 'home') refresh().then(() => { if (S.view === view) render(); }).catch(() => {}); // met aussi à jour les articles publiés par WordPress
  }

  function render() {
    $('sim').classList.toggle('hidden', !(S.status && S.status.simulate));
    renderNav();
    const main = $('main');
    main.replaceChildren();
    const views = { home: viewHome, write: viewWrite, articles: viewArticles, article: viewArticle, edit: viewEdit, score: viewScore, settings: viewSettings, help: viewHelp };
    main.append(...[].concat(views[S.view]()).filter(Boolean));
  }
  const head = (title, sub, right) => el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, title), sub ? el('p', { class: 'muted' }, sub) : null), right || null);

  // Les liens du texte sont écrits « /page/ » : dans l'aperçu ils doivent ouvrir VOTRE site (pas ce tableau de bord).
  const siteBase = () => ((S.status && S.status.siteUrl) || '').replace(/\/+$/, '');
  function fixLinks(root) {
    const base = siteBase();
    root.querySelectorAll('a').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (h.startsWith('/')) { if (base) a.setAttribute('href', base + h); else a.removeAttribute('href'); }
      if (a.getAttribute('href')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); a.setAttribute('title', a.getAttribute('href')); }
    });
  }
  function linksOf(html) {
    const box = el('div', {}); box.innerHTML = html; fixLinks(box); // assaini côté serveur
    return [...box.querySelectorAll('a')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })).filter((l) => l.href);
  }
  function previewOf(html) {
    const p = el('div', { class: 'preview' });
    p.innerHTML = html; // HTML assaini côté serveur (balises autorisées uniquement)
    highlightMarkers(p); fixLinks(p);
    return p;
  }

  // Appelle une route avec les confirmations demandées par le serveur (hors plage, points à vérifier, texte modifié sur le site).
  async function confirmed(path, body) {
    let extra = {};
    for (let i = 0; i < 4; i++) {
      try { return await api(path, 'POST', { ...body, ...extra }); } catch (e) {
        if (e.code === 'out_of_range') { if (!confirm(e.message)) return null; extra = { ...extra, confirmOutOfRange: true }; }
        else if (e.code === 'issues') { if (!confirm(e.message)) return null; extra = { ...extra, confirmIssues: true }; }
        else if (e.code === 'wp_changed') { if (!confirm(e.message)) return null; extra = { ...extra, force: true }; }
        else throw e;
      }
    }
    return null;
  }

  // ---------- Accueil ----------
  function viewHome() {
    const s = S.settings, m = mine();
    const toReview = m.filter((a) => a.status === 'a_relire').length;
    const drafts = m.filter((a) => a.status === 'brouillon_wp').length;
    const sched = m.filter((a) => a.status === 'programme').sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt));
    const published = m.filter((a) => a.status === 'publie').length;
    const latest = S.audits.latest;
    const jump = (tab) => () => { S.settingsTab = tab; go('settings'); };

    let next;
    if (!S.status.simulate && (!S.status.wordpress || !S.status.openrouter)) next = ['Terminez la mise en route', 'Il manque la liaison avec WordPress ou la clé de rédaction pour travailler en mode réel.', 'Ouvrir les connexions', jump('connexions')];
    else if (!m.length) next = ['Rédigez votre premier article', 'Choisissez un sujet : l\'article apparaît en quelques instants, prêt à être relu.', 'Rédiger un article', () => go('write')];
    else if (toReview) next = [`${toReview} ${plural(toReview, 'article attend', 'articles attendent')} votre relecture`, 'Lisez, corrigez à la main si besoin, puis envoyez-le sur le site ou programmez-le.', 'Relire maintenant', () => go('articles')];
    else if (m.some((a) => a.plannedDate && ['a_relire', 'brouillon_wp'].includes(a.status))) next = ['Des articles ont une date prévue', 'Programmez-les d\'un clic : WordPress les publiera tout seul à la date choisie.', 'Voir les articles', () => go('articles')];
    else if (!latest) next = ['Mesurez la santé de votre site', 'Le score vous dit en 1 minute ce qu\'il faut améliorer sur citylock.fr.', 'Mesurer mon site', () => { go('score'); startAudit(); }];
    else next = ['Tout est à jour', 'Rédigez un nouvel article ou planifiez les prochains mois.', 'Rédiger', () => go('write')];

    const wpPill = S.status.simulate ? el('span', { class: 'pill warn' }, 'Démonstration')
      : S.status.wordpress ? el('span', { class: 'pill ok' }, icon('check'), 'Configuré') : el('span', { class: 'pill ko' }, 'À configurer');
    return [
      head('Bonjour', 'Voici où vous en êtes.'),
      el('div', { class: 'grid3' },
        el('div', { class: 'card stat' }, el('div', { class: 'label' }, icon('file'), 'Articles'), el('div', { class: 'value' }, m.length),
          el('div', { class: 'hint' }, `${toReview + drafts} à relire ou en brouillon · ${sched.length} programmé${sched.length > 1 ? 's' : ''} · ${published} publié${published > 1 ? 's' : ''}`)),
        el('div', { class: 'card stat' }, el('div', { class: 'label' }, icon('gauge'), 'Score du site'), el('div', { class: 'value' }, latest ? latest.score : '--', el('small', {}, ' / 100')),
          el('div', { class: 'hint' }, latest ? 'Mesuré le ' + fmtDate(latest.date) : 'Pas encore mesuré')),
        el('div', { class: 'card stat' }, el('div', { class: 'label' }, icon('plug'), 'Liaison avec votre site'), el('div', { class: 'value' }, wpPill), el('div', { class: 'hint' }, 'WordPress (citylock.fr)'))),
      el('div', { class: 'card next' }, el('div', {}, el('div', { class: 'eyebrow' }, 'Votre prochaine étape'), el('h2', {}, next[0]), el('p', {}, next[1])),
        el('button', { class: 'btn primary big', type: 'button', onclick: safe(next[3]) }, next[2])),
      sched.length ? el('div', { class: 'card' }, el('h2', {}, 'Prochaines publications'), el('ul', { class: 'versions' }, sched.slice(0, 5).map((a) => el('li', {}, el('div', { class: 'grow' }, el('b', {}, a.title), el('div', { class: 'muted small' }, fmtDateTime(a.scheduledAt))), el('button', { class: 'btn', type: 'button', onclick: () => go('article', a.id) }, 'Ouvrir'))))) : null,
      el('div', { class: 'card' }, el('h2', {}, 'Comment ça marche'), el('p', { class: 'muted' }, 'Deux façons de travailler, et vous gardez toujours la main.'),
        el('div', { class: 'steps' },
          step(1, 'Rédiger', 'Un seul article, ou plusieurs mois d\'un coup avec une date par article.'),
          step(2, 'Relire et corriger', 'Vous lisez, vous modifiez à la main si besoin. Rien n\'est publié sans vous.'),
          step(3, 'Programmer ou publier', 'WordPress publie tout seul à la date choisie, ou vous publiez tout de suite.'))),
    ];
  }
  const step = (n, t, d) => el('div', { class: 'step' }, el('div', { class: 'num' }, n), el('div', {}, el('h3', {}, t), el('p', { class: 'muted small' }, d)));

  // ---------- Rédiger : deux modes ----------
  const topicLabel = (t) => t.keyword + (t.city ? ' à ' + t.city : '');

  function viewWrite() {
    const s = S.settings;
    const seg = el('div', { class: 'seg', role: 'tablist' }, [['one', 'Un seul article'], ['many', 'Plusieurs articles (planning)']].map(([id, label]) =>
      el('button', { type: 'button', role: 'tab', class: S.writeMode === id ? 'on' : '', 'aria-selected': S.writeMode === id ? 'true' : 'false', onclick: () => { S.writeMode = id; render(); } }, label)));
    const out = [head('Rédiger', 'Choisissez comment travailler.'), seg];
    if (S.settings.promptProblems && S.settings.promptProblems.length) out.push(el('div', { class: 'alert' }, 'Votre prompt a un souci : ' + S.settings.promptProblems.join(' '), ' ', el('button', { class: 'btn', type: 'button', onclick: () => { S.settingsTab = 'redaction'; go('settings'); } }, 'Ouvrir le prompt')));
    out.push(...(S.writeMode === 'one' ? writeOne() : writeMany()));
    return out;
  }

  function writeOne() {
    const s = S.settings;
    const W = S.one || (S.one = { sel: '', kw: '', city: '', busy: false, err: '', sent: null });
    const sel = el('select', { id: 'one-topic', 'aria-label': 'Sujet' }, [...s.topics.map((t) => el('option', { value: t.id }, topicLabel(t))), el('option', { value: '__free' }, 'Un autre sujet (je le tape)')]);
    sel.value = [...sel.options].some((o) => o.value === W.sel) ? W.sel : (s.topics.length ? sel.options[0].value : '__free');
    const kw = el('input', { type: 'text', id: 'one-kw', maxlength: 100, placeholder: 'Mot-clé, par exemple : serrure connectée', 'aria-label': 'Mot-clé' });
    const city = el('input', { type: 'text', id: 'one-city', maxlength: 60, placeholder: 'Ville (facultatif)', 'aria-label': 'Ville' });
    kw.value = W.kw; city.value = W.city;
    const free = el('div', { class: 'row mt' }, kw, city);
    const sync = () => { W.sel = sel.value; W.kw = kw.value; W.city = city.value; free.classList.toggle('hidden', sel.value !== '__free'); };
    [sel, kw, city].forEach((n) => n.addEventListener('input', sync)); sel.addEventListener('change', sync); sync();
    const body = () => (sel.value === '__free' ? { keyword: kw.value, city: city.value } : { topicId: sel.value });

    const run = el('button', { class: 'btn primary big', type: 'button', disabled: W.busy ? true : false, onclick: safe(async () => {
      sync(); W.busy = true; W.err = ''; render();
      try {
        const r = await api('/write/one', 'POST', body());
        W.busy = false; await refresh(); toast('Article rédigé. Relisez-le, modifiez-le si besoin, puis envoyez-le ou programmez-le.');
        go('article', r.article.id); return;
      } catch (e) { W.err = e.message; }
      W.busy = false; render();
    }) }, icon('spark'), W.busy ? 'Rédaction en cours...' : 'Rédiger l\'article');

    const seeBtn = el('button', { class: 'btn', type: 'button', onclick: safe(async () => { sync(); W.sent = await api('/write/preview', 'POST', body()); render(); }) }, 'Voir ce qui sera envoyé à l\'IA');
    const card = el('div', { class: 'card' }, el('h2', {}, 'Un seul article'),
      el('p', { class: 'muted' }, 'Il apparaît dans « Articles », en attente : vous pouvez le relire, le modifier à la main, l\'envoyer en brouillon sur le site ou le programmer à la date de votre choix.'),
      el('label', { for: 'one-topic' }, 'Sujet'), sel, free,
      el('div', { class: 'row btn-row' }, run, seeBtn),
      el('p', { class: 'muted small' }, demoOn() ? 'Mode démonstration : texte de test, aucun appel réel.' : 'Un article coûte un appel à l\'IA (quelques centimes). Cela peut prendre jusqu\'à une minute.'));
    if (!s.topics.length) add(card, el('p', { class: 'muted small' }, 'Astuce : enregistrez vos sujets dans Réglages, Rédaction pour les retrouver ici.'));
    if (W.err) add(card, el('div', { class: 'alert mt' }, W.err));
    if (W.sent) add(card, el('details', { class: 'faq', open: 'open' }, el('summary', {}, 'Ce qui sera envoyé à l\'IA'), el('div', { class: 'a' },
      el('p', { class: 'muted small' }, 'Modèle : ' + (W.sent.sent.model || '(aucun choisi)')),
      el('h3', {}, 'Message sur l\'entreprise et le sujet'), el('pre', { class: 'pre' }, W.sent.sent.user),
      el('h3', {}, 'Votre prompt (Réglages, Rédaction)'), el('pre', { class: 'pre' }, W.sent.sent.system || '(vide)'))));
    return [card];
  }

  function writeMany() {
    const s = S.settings, b = S.batch;
    const P = S.many || (S.many = { count: 4, spacing: 7, startDate: defaultStart(), items: null, err: '' });
    const out = [];
    if (b.running) {
      out.push(el('div', { class: 'card' }, el('h2', {}, 'Rédaction en cours...'),
        el('p', { class: 'muted' }, `${b.done} sur ${b.total} terminés. Cela peut prendre quelques minutes : vous pouvez rester sur cette page ou aller ailleurs.`),
        el('div', { class: 'progress' }, (() => { const i = el('i'); i.style.width = Math.max(6, Math.round((b.done / Math.max(1, b.total)) * 100)) + '%'; return i; })())));
      return out;
    }
    if (b.total && !b.running && !P.items) out.push(el('div', { class: 'card' }, el('h2', {}, `Terminé : ${b.total - b.errors.length} sur ${b.total} rédigés`),
      b.errors.length ? el('ul', { class: 'tasks' }, b.errors.map((e) => el('li', { class: 'warn' }, e))) : null,
      b.notes && b.notes.length ? el('ul', { class: 'tasks' }, b.notes.map((e) => el('li', {}, e))) : null,
      el('p', { class: 'muted' }, 'Les articles sont des brouillons ici, avec leur date prévue. Rien n\'est encore sur le site.'),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: () => go('articles') }, 'Relire et programmer'))));

    const count = el('input', { type: 'number', id: 'm-count', min: 1, max: 20, step: 1 });
    const gap = el('select', { id: 'm-gap', 'aria-label': 'Écart entre deux articles' }, [[0, 'le même jour'], [1, 'tous les jours'], [3, 'tous les 3 jours'], [7, 'toutes les semaines'], [14, 'tous les 15 jours'], [30, 'tous les mois']].map(([v, l]) => el('option', { value: v }, l)));
    const start = el('input', { type: 'date', id: 'm-start', min: todayParis() });
    count.value = P.count; gap.value = P.spacing; start.value = P.startDate;
    const sync = () => { P.count = Number(count.value); P.spacing = Number(gap.value); P.startDate = start.value; };
    [count, gap, start].forEach((n) => n.addEventListener('change', sync));
    const prepare = el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => {
      sync(); P.err = '';
      try { const r = await api('/write/plan', 'POST', { count: P.count, spacingDays: P.spacing, startDate: P.startDate }); P.items = r.items; P.missing = r.missing; } catch (e) { P.err = e.message; P.items = null; }
      render();
    }) }, 'Préparer la liste');
    out.push(el('div', { class: 'card' }, el('h2', {}, 'Plusieurs articles d\'un coup'),
      el('p', { class: 'muted' }, 'Choisissez combien d\'articles vous voulez (de 1 à 20). Vous indiquez ensuite le mot-clé de chacun, puis une date proposée que vous pourrez changer. Les articles sont rédigés, rangés dans « Articles », et vous les programmez à 10 h le jour choisi.'),
      el('div', { class: 'row' }, el('div', { class: 'grow-field' }, el('label', { for: 'm-count' }, 'Nombre d\'articles'), count), el('div', { class: 'grow-field' }, el('label', { for: 'm-start' }, 'Premier article le'), start), el('div', { class: 'grow-field' }, el('label', { for: 'm-gap' }, 'Ensuite'), gap)),
      el('div', { class: 'row btn-row' }, prepare),
      P.err ? el('div', { class: 'alert mt' }, P.err) : null));

    if (P.items) {
      const rows = P.items.map((it, i) => {
        const date = el('input', { type: 'date', value: it.plannedDate, min: todayParis(), 'aria-label': `Date de l'article ${i + 1}` });
        const kw = el('input', { type: 'text', value: it.keyword, maxlength: 100, placeholder: 'Mot-clé à saisir', 'aria-label': `Mot-clé de l'article ${i + 1}` });
        const city = el('input', { type: 'text', value: it.city || '', maxlength: 60, placeholder: 'Ville', 'aria-label': `Ville de l'article ${i + 1}` });
        date.addEventListener('input', () => { it.plannedDate = date.value; }); kw.addEventListener('input', () => { it.keyword = kw.value; it.topicId = null; }); city.addEventListener('input', () => { it.city = city.value; });
        return el('div', { class: 'plan-row' }, el('span', { class: 'plan-n' }, i + 1), date, kw, city);
      });
      out.push(el('div', { class: 'card' }, el('h2', {}, `Vos ${P.items.length} ${plural(P.items.length, 'article', 'articles')}`),
        P.missing ? el('div', { class: 'alert' }, `Écrivez le mot-clé de chaque ligne vide (${P.missing} ${plural(P.missing, 'ligne', 'lignes')}). Les mots-clés de votre liste de sujets sont déjà remplis. Deux articles sur le même mot-clé se font concurrence sur Google : variez-les.`) : null,
        el('p', { class: 'muted small' }, 'Date de publication prévue, mot-clé, ville. Une fois programmés, les articles sont publiés à 10 h (heure de Paris) le jour choisi.'),
        el('div', { class: 'plan' }, rows),
        el('div', { class: 'row btn-row' },
          el('button', { class: 'btn primary big', type: 'button', onclick: safe(async () => {
            const missing = P.items.filter((it) => !it.keyword.trim()).length;
            if (missing) { toast(`Complétez le mot-clé des ${missing} ligne${missing > 1 ? 's' : ''} vide${missing > 1 ? 's' : ''}.`, true); return; }
            if (!demoOn() && !confirm(`Rédiger ${P.items.length} articles ? Cela fait ${P.items.length} appels payants à l'IA (quelques centimes chacun). Rien n'est envoyé sur le site.`)) return;
            await api('/write/batch', 'POST', { items: P.items.map((it) => ({ topicId: it.topicId || undefined, keyword: it.keyword, city: it.city, plannedDate: it.plannedDate })) });
            S.batch = { running: true, done: 0, total: P.items.length, errors: [], notes: [] }; P.items = null; render(); pollBatch();
          }) }, icon('spark'), `Rédiger ces ${P.items.length} articles`),
          el('button', { class: 'btn', type: 'button', onclick: () => { P.items = null; render(); } }, 'Annuler')),
        el('p', { class: 'muted small' }, demoOn() ? 'Mode démonstration : textes de test, aucun appel réel.' : 'Chaque article est rédigé l\'un après l\'autre (environ une minute chacun). Ils arrivent dans « Articles », à relire.')));
    }
    return out;
  }

  async function pollBatch() {
    clearTimeout(pollTimer);
    try {
      const b = await api('/write/status');
      const was = S.batch.running;
      S.batch = b;
      if (b.running) pollTimer = setTimeout(pollBatch, 2500);
      else if (was || b.total) { await refresh(); toast(b.errors.length ? 'Terminé, avec des erreurs.' : 'Vos articles sont rédigés : relisez-les puis programmez-les.', !!b.errors.length); }
      if (['write', 'home'].includes(S.view)) render(); else renderNav();
    } catch { /* on réessaiera */ }
  }

  // ---------- Articles ----------
  function articleRow(a) {
    const when = a.status === 'programme' ? 'Publication : ' + fmtDateTime(a.scheduledAt) : a.plannedDate && a.status !== 'publie' ? 'Date prévue : ' + fmtDay(a.plannedDate) : '';
    return el('button', { class: 'art-row', type: 'button', onclick: () => go('article', a.id) },
      el('div', { class: 'grow' }, el('div', { class: 't' }, a.title), el('div', { class: 'm' }, a.keyword + (a.city ? ' à ' + a.city : '') + ' · ' + a.check.words + ' mots' + (when ? ' · ' + when : ''))),
      a.simulated ? el('span', { class: 'pill' }, 'Démonstration') : null,
      el('span', { class: 'pill ' + a.state.tone }, a.state.label));
  }

  function viewArticles() {
    const demoCount = S.articles.filter((a) => a.simulated).length;
    const m = mine();
    const out = [head('Articles', 'Tout ce qui est rédigé : à relire, programmé ou publié.', el('button', { class: 'btn primary big', type: 'button', onclick: () => go('write') }, icon('spark'), 'Rédiger'))];

    const waiting = m.filter((a) => ['a_relire', 'brouillon_wp'].includes(a.status));
    if (waiting.length) {
      const rows = [...waiting].sort((x, y) => (x.plannedDate || '9999').localeCompare(y.plannedDate || '9999')).map((a) => {
        const d = el('input', { type: 'date', min: todayParis(), 'aria-label': 'Date de publication de ' + a.title });
        d.value = a.plannedDate || '';
        d.addEventListener('change', safe(async () => { await api(`/articles/${a.id}/planned`, 'PUT', { plannedDate: d.value }); await refresh(); render(); }));
        return el('div', { class: 'cal-row' },
          el('button', { class: 'linkish', type: 'button', onclick: () => go('article', a.id) }, el('b', {}, a.title), el('span', { class: 'muted small' }, ` ${a.keyword} · ${a.check.words} mots`)),
          d,
          el('button', { class: 'btn', type: 'button', disabled: !a.plannedDate, onclick: safe(async () => {
            const r = await confirmed(`/articles/${a.id}/schedule`, { date: d.value });
            if (r) { toast('Programmé : ' + fmtDateTime(r.scheduledAt) + '.'); await refresh(); render(); }
          }) }, 'Programmer à 10 h'));
      });
      const ready = waiting.filter((a) => a.plannedDate).length;
      out.push(el('div', { class: 'card' }, el('h2', {}, 'Calendrier de publication'),
        el('p', { class: 'muted' }, 'Choisissez la date de chaque article (cliquez sur le champ pour ouvrir le calendrier). À 10 h le jour choisi, WordPress le publie tout seul. Vous pouvez programmer un par un, ou tous ceux qui ont une date.'),
        el('div', { class: 'cal' }, rows),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary big', type: 'button', disabled: !ready, onclick: safe(scheduleAll) }, icon('send'), `Programmer les ${ready} articles datés`)),
        el('p', { class: 'muted small' }, 'Un article avec un problème de longueur, un mot interdit ou une source à compléter est laissé de côté, avec la raison.')));
    }
    if (S.scheduleReport) {
      const r = S.scheduleReport;
      out.push(el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Résultat de la programmation'), el('button', { class: 'btn ghost', type: 'button', onclick: () => { S.scheduleReport = null; render(); } }, 'Fermer')),
        r.scheduled.length ? el('p', { class: 'ok-text' }, `${r.scheduled.length} ${plural(r.scheduled.length, 'article programmé', 'articles programmés')}.`) : null,
        r.skipped.length ? [el('p', {}, `${r.skipped.length} ${plural(r.skipped.length, 'article laissé de côté', 'articles laissés de côté')} :`), el('ul', { class: 'tasks' }, r.skipped.map((x) => el('li', { class: 'warn' }, el('b', {}, x.title), ' : ', x.reasons.join(' '), ' ', el('button', { class: 'btn', type: 'button', onclick: () => go('article', x.id) }, 'Ouvrir'))))] : null));
    }

    if (!demoOn() && demoCount) out.push(el('div', { class: 'alert' }, `${demoCount} ${plural(demoCount, 'article de démonstration reste', 'articles de démonstration restent')} dans la liste (créés avant le passage en mode réel). Ils n'existent pas sur votre site. `,
      el('button', { class: 'btn', type: 'button', onclick: safe(async () => { if (!confirm('Supprimer les articles de démonstration ? Cela ne touche pas à votre site.')) return; const r = await api('/articles/purge-demo', 'POST'); await refresh(); render(); toast(`${r.removed} supprimé${r.removed > 1 ? 's' : ''}.`); }) }, 'Les supprimer')));
    if (demoOn() && S.articles.some((a) => !a.simulated)) out.push(el('div', { class: 'alert' }, 'Vos articles réels sont visibles, mais ne peuvent être ni publiés, ni programmés, ni supprimés tant que le mode démonstration est actif.'));

    const list = el('div', {});
    if (!S.articles.length) {
      list.append(el('div', { class: 'card empty' }, icon('file'), el('h3', {}, 'Aucun article pour l\'instant'), el('p', { class: 'muted' }, 'Cliquez sur « Rédiger » pour écrire un article, ou plusieurs d\'un coup.')));
    } else {
      const order = { programme: 0, a_relire: 1, brouillon_wp: 1, publie: 2 };
      [...S.articles].sort((x, y) => (order[x.status] - order[y.status]) || ((x.scheduledAt || x.plannedDate || x.createdAt).localeCompare(y.scheduledAt || y.plannedDate || y.createdAt))).forEach((a) => list.append(articleRow(a)));
    }
    out.push(list);

    const pubs = S.publications || [];
    out.push(el('details', { class: 'faq' }, el('summary', {}, `Historique des publications (${pubs.length})`), el('div', { class: 'a' },
      pubs.length ? el('div', { class: 'tablewrap' }, el('table', { class: 't' }, el('tr', {}, ['Date', 'Action', 'Titre', 'Adresse'].map((h) => el('th', {}, h))),
        pubs.map((p) => el('tr', {}, el('td', {}, fmtDateTime(p.at)), el('td', {}, { publication: p.by === 'programmation' ? 'Publié par programmation' : 'Publié', programmation: 'Programmé', annulation: 'Programmation annulée' }[p.kind] || p.kind), el('td', {}, p.title), el('td', {}, p.url && !p.simulated ? el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.url) : (p.simulated ? 'démonstration' : '')))))) : el('p', { class: 'muted small' }, 'Rien pour l\'instant.'),
      el('p', { class: 'muted small' }, 'Sur l\'hébergement gratuit sans disque, ce journal est effacé à un redémarrage du serveur.'))));
    return out;
  }

  async function scheduleAll() {
    const facts = mine().filter((a) => a.plannedDate && ['a_relire', 'brouillon_wp'].includes(a.status) && a.faitsAVerifier.length).length;
    if (!confirm('Programmer tous les articles datés à 10 h le jour choisi ?')) return;
    let acceptFacts = false;
    if (facts) acceptFacts = confirm(`${facts} ${plural(facts, 'article a', 'articles ont')} encore des « faits à vérifier » dans leur liste.\n\nOK : les programmer quand même (vous aurez vérifié les chiffres).\nAnnuler : les laisser de côté pour les relire d'abord.`);
    S.scheduleReport = await api('/articles/schedule-all', 'POST', { acceptFacts });
    await refresh(); render();
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


  const lengthMsg = (c) => `Cet article compte ${c.words} mots : il en faut entre ${c.limits.min} et ${c.limits.max}. Il n'est ni envoyé ni programmé sans votre confirmation.`;

  async function regenerate(a) {
    if (!confirm('Régénérer cet article ? Un nouveau texte est rédigé pour le même sujet. L\'ancien reste dans l\'historique (écran « Modifier »).')) return;
    S.regen = a.id; render();
    try {
      let r;
      try { r = await api(`/articles/${a.id}/regenerate`, 'POST', {}); } catch (e) {
        if (e.code !== 'wp_changed' || !confirm(e.message)) throw e;
        r = await api(`/articles/${a.id}/regenerate`, 'POST', { force: true });
      }
      toast(r.syncError ? 'Régénéré ici, mais le site n\'a pas pu être mis à jour : ' + r.syncError : 'Nouvel article rédigé. L\'ancien texte est gardé dans l\'historique.', !!r.syncError);
    } finally { S.regen = null; await refresh(); render(); }
  }

  function viewArticle() {
    const a = S.articles.find((x) => x.id === S.articleId);
    if (!a) { go('articles'); return []; }
    const c = a.check;
    const stage = { a_relire: 1, brouillon_wp: 2, programme: 3, publie: 4 }[a.status];
    const stepper = el('div', { class: 'stepper' }, ['Rédigé', 'Brouillon sur le site', 'Programmé', 'Publié'].map((t, i) => {
      const state = i < stage ? 'done' : i === stage ? 'now' : '';
      return el('div', { class: 's ' + state }, el('span', { class: 'n' }, state === 'done' ? icon('check') : i + 1), t);
    }));

    const preview = previewOf(a.htmlContent);
    const wpUrl = safeUrl(a.wpLink);
    const mismatch = !!a.simulated !== demoOn(); // créé dans l'autre mode (démonstration/réel)
    const reload = async () => { S.seo = {}; await refresh(); render(); };
    const busy = S.regen === a.id;
    const regenBtn = () => el('button', { class: 'btn' + (!c.inRange ? ' primary' : ''), type: 'button', disabled: busy ? true : false, onclick: safe(() => regenerate(a)) }, icon('refresh'), busy ? 'Rédaction en cours...' : 'Régénérer');
    const editBtn = el('button', { class: 'btn', type: 'button', onclick: () => go('edit', a.id) }, icon('file'), 'Modifier');

    // Programmer : une date, une heure (10 h par défaut), un bouton.
    const scheduleBlock = (label) => {
      const d = el('input', { type: 'date', id: 'sc-date', min: plusDays(todayParis(), 0), 'aria-label': 'Date de publication' });
      const t = el('input', { type: 'time', id: 'sc-time', value: '10:00', 'aria-label': 'Heure de publication (heure de Paris)' });
      d.value = a.status === 'programme' && a.scheduledAt ? new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(a.scheduledAt)) : (a.plannedDate && a.plannedDate > todayParis() ? a.plannedDate : plusDays(todayParis(), 1));
      return el('div', { class: 'sched' }, el('h3', {}, label),
        el('div', { class: 'row' }, d, t),
        el('p', { class: 'muted small' }, 'Heure de Paris. WordPress publie l\'article tout seul à ce moment : l\'outil n\'a pas besoin d\'être ouvert.'),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary big', type: 'button', onclick: safe(async () => {
          if (!d.value) { toast('Choisissez une date.', true); return; }
          const r = await confirmed(`/articles/${a.id}/schedule`, { date: d.value, time: t.value });
          if (r) { toast('Article programmé : ' + fmtDateTime(r.scheduledAt) + '.'); await reload(); }
        }) }, icon('send'), a.status === 'programme' ? 'Changer la date' : 'Programmer')));
    };
    const publishNow = () => {
      const chk = el('input', { type: 'checkbox', id: 'validated' });
      const pub = el('button', { class: 'btn', type: 'button', disabled: true, onclick: safe(async () => { const r = await confirmed(`/articles/${a.id}/publish`, { validated: true }); if (r) { toast('Article publié sur votre site.'); await reload(); } }) }, icon('check'), 'Publier maintenant');
      chk.addEventListener('change', () => { pub.disabled = !chk.checked; });
      return el('div', { class: 'sched' }, el('h3', {}, a.status === 'a_relire' ? 'Ou publier directement' : 'Ou publier tout de suite'), el('label', { class: 'check', for: 'validated' }, chk, el('span', {}, 'J\'ai relu et validé cet article')), el('div', { class: 'actions' }, pub));
    };

    const actions = el('div', { class: 'card sticky' });
    if (mismatch && a.status !== 'publie') {
      add(actions, el('div', { class: 'alert' }, `Cet article a été créé en mode ${a.simulated ? 'démonstration' : 'réel'}. Pour le modifier sur le site, repassez en mode ${a.simulated ? 'démonstration' : 'réel'} (Réglages, Connexions).`));
    } else if (a.status === 'a_relire') {
      add(actions, el('div', { class: 'eyebrow' }, 'Étape suivante'), el('h2', {}, 'Cet article est en attente'),
        el('p', { class: 'muted small' }, 'Il n\'est pas encore sur votre site. Relisez-le, puis choisissez : brouillon (invisible du public), programmation, ou publication directe.'),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { const r = await confirmed(`/articles/${a.id}/send`, {}); if (r) { toast('Brouillon créé sur votre site (invisible du public).'); await reload(); } }) }, icon('send'), 'Envoyer en brouillon sur le site')),
        scheduleBlock('Ou programmer la publication (10 h par défaut)'), publishNow());
    } else if (a.status === 'brouillon_wp') {
      add(actions, el('div', { class: 'eyebrow' }, 'Dernière étape'), el('h2', {}, 'Brouillon sur votre site'),
        el('p', { class: 'muted small' }, 'Il est sur votre site mais invisible du public. Vous pouvez encore le modifier ici ou dans WordPress.'),
        a.siteDirty ? el('div', { class: 'alert' }, 'Vos dernières modifications ne sont pas encore envoyées sur le site. Ouvrez « Modifier » et enregistrez à nouveau.') : null,
        wpUrl && !a.simulated ? el('p', {}, el('a', { class: 'btn', href: wpUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Ouvrir dans WordPress')) : null,
        scheduleBlock('Programmer la publication'), publishNow());
    } else if (a.status === 'programme') {
      add(actions, el('div', { class: 'eyebrow' }, 'Programmé'), el('h2', {}, a.state.label),
        a.state.code === 'programme_retard' ? el('div', { class: 'alert' }, 'La date est passée mais WordPress ne l\'a pas encore publié. Vérifiez dans WordPress que la planification fonctionne (elle se déclenche quand quelqu\'un visite le site).') : el('p', { class: 'muted small' }, 'WordPress le publiera tout seul. Vous pouvez encore le modifier ici.'),
        wpUrl && !a.simulated ? el('p', {}, el('a', { class: 'btn', href: wpUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Ouvrir dans WordPress')) : null,
        scheduleBlock('Changer la date'),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api(`/articles/${a.id}/unschedule`, 'POST'); toast('Programmation annulée : l\'article redevient un brouillon.'); await reload(); }) }, 'Annuler la programmation')),
        publishNow());
    } else {
      add(actions, el('div', { class: 'alert ok' }, 'Cet article est publié sur votre site' + (a.publishedBy === 'programmation' ? ' (publié à la date programmée).' : '.')), wpUrl ? el('p', {}, el('a', { class: 'btn', href: wpUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), 'Voir l\'article')) : null);
    }
    if (a.status !== 'publie') {
      add(actions, el('div', { class: 'actions' }, editBtn, regenBtn()));
      if (a.simulated || !mismatch) add(actions, el('div', { class: 'actions' }, el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => {
        if (!confirm(a.status === 'a_relire' ? 'Supprimer cet article ?' : 'Supprimer cet article, aussi sur votre site ?')) return;
        await api('/articles/' + a.id, 'DELETE'); toast('Article supprimé.'); await refresh(); go('articles');
      }) }, icon('trash'), 'Supprimer')));
    }

    // Date prévue (planning)
    let planned = null;
    if (a.status !== 'publie') {
      const pd = el('input', { type: 'date', id: 'pl-date', min: todayParis(), 'aria-label': 'Date prévue' });
      pd.value = a.plannedDate || '';
      planned = el('div', { class: 'card' }, el('h2', {}, 'Date prévue'), el('p', { class: 'muted small' }, 'Un simple pense-bête : elle sert à « Programmer tous les articles prêts ». Elle ne programme rien toute seule.'),
        el('div', { class: 'row' }, pd, el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api(`/articles/${a.id}/planned`, 'PUT', { plannedDate: pd.value }); toast(pd.value ? 'Date prévue enregistrée.' : 'Date prévue retirée.'); await reload(); }) }, 'Enregistrer')));
    }

    // Contrôles : longueur, mots interdits, sources, faits à vérifier...
    const checks = el('div', { class: 'card' }, el('h2', {}, 'À vérifier avant de publier'));
    if (!c.inRange) add(checks, el('div', { class: 'alert' }, lengthMsg(c), a.status !== 'publie' ? el('div', { class: 'actions' }, regenBtn()) : null));
    const others = c.issues.filter((i) => i.code !== 'length');
    if (others.length) add(checks, el('ul', { class: 'tasks' }, others.map((i) => el('li', { class: i.blocking ? 'warn' : 'muted' }, i.message))));
    else if (c.inRange) add(checks, el('p', { class: 'muted' }, 'Rien à signaler. Relisez quand même chaque phrase.'));
    if (a.faitsAVerifier.length) add(checks, el('h3', {}, 'Faits à vérifier'), el('ul', { class: 'tasks' }, a.faitsAVerifier.map((f) => el('li', {}, f))));

    // Correction par l'IA : on dit quoi changer, l'IA s'en charge, l'ancien texte reste dans l'historique
    let aiCard = null;
    if (a.status !== 'publie' && !mismatch) {
      S.aiRes = S.aiRes || {};
      const instr = el('textarea', { id: 'ai-instr', rows: 4, maxlength: 2000, placeholder: 'Exemples : « Raccourcis l\'introduction. » · « Dans la section sur les capteurs, explique la différence entre un détecteur d\'ouverture et un détecteur de mouvement. » · « Remplace la dernière phrase par une invitation à appeler. »', 'aria-label': 'Ce qu\'il faut changer' });
      instr.value = (S.aiDraft && S.aiDraft[a.id]) || '';
      instr.addEventListener('input', () => { S.aiDraft = S.aiDraft || {}; S.aiDraft[a.id] = instr.value; });
      const busyAi = S.aiBusy === a.id;
      const run = el('button', { class: 'btn primary', type: 'button', disabled: busyAi ? true : false, onclick: safe(async () => {
        if (instr.value.trim().length < 5) { toast('Expliquez d\'abord ce qu\'il faut changer.', true); return; }
        S.aiBusy = a.id; render();
        try {
          let r;
          try { r = await api(`/articles/${a.id}/ai-edit`, 'POST', { instruction: instr.value }); } catch (e) {
            if (e.code !== 'wp_changed' || !confirm(e.message)) throw e;
            r = await api(`/articles/${a.id}/ai-edit`, 'POST', { instruction: instr.value, force: true });
          }
          S.aiRes[a.id] = r; S.aiDraft[a.id] = '';
          toast(r.syncError ? 'Corrigé ici, mais le site n\'a pas pu être mis à jour : ' + r.syncError : 'Article corrigé. L\'ancien texte est gardé dans l\'historique.', !!r.syncError);
        } finally { S.aiBusy = null; await reload(); }
      }) }, icon('spark'), busyAi ? 'Correction en cours...' : 'Corriger avec l\'IA');
      const R = S.aiRes[a.id];
      aiCard = el('div', { class: 'card' }, el('h2', {}, 'Corriger avec l\'IA'),
        el('p', { class: 'muted small' }, 'Dites à l\'IA quoi changer et où : elle réécrit l\'article en gardant le SEO (mot-clé, liens, longueur). Votre texte d\'avant est conservé : vous pouvez l\'annuler d\'un clic.'),
        instr, el('div', { class: 'actions' }, run),
        busyAi ? el('p', { class: 'muted small' }, 'Cela peut prendre une minute. Ne quittez pas la page.') : null,
        R ? el('div', { class: 'mt' },
          el('div', { class: 'alert' + (R.seo.worse.length ? '' : ' ok') },
            el('b', {}, `Corrigé par ${R.model}. `), `Points SEO hors critères : ${R.seo.before.missing} avant, ${R.seo.after.missing} après.`,
            R.seo.worse.length ? el('div', {}, 'Attention, la correction a dégradé : ', el('b', {}, R.seo.worse.join(', ')), '. Annulez-la ou corrigez à nouveau.') : null),
          el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api(`/articles/${a.id}/revert`, 'POST', {}); S.aiRes[a.id] = null; toast('Correction annulée : version d\'avant restaurée.'); await reload(); }) }, 'Annuler cette correction'))) : null);
    }

    // Contrôle SEO : ce que contient réellement le site (relu après chaque envoi), en rouge ce qui manque
    S.seo = S.seo || {};
    const seoBox = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Contrôle SEO'),
      el('button', { class: 'btn', type: 'button', onclick: safe(async () => { delete S.seo[a.id]; render(); }) }, icon('refresh'), 'Relire')));
    const R = S.seo[a.id];
    if (!R) {
      add(seoBox, el('p', { class: 'muted small' }, 'Lecture en cours...'));
      api(`/articles/${a.id}/seo`).then((r) => { S.seo[a.id] = r; if (S.view === 'article' && S.articleId === a.id) render(); }).catch((e) => { S.seo[a.id] = { error: e.message }; if (S.view === 'article' && S.articleId === a.id) render(); });
    } else if (R.error) add(seoBox, el('div', { class: 'alert' }, R.error));
    else {
      add(seoBox, el('p', { class: 'muted small' }, R.source === 'site' ? 'Relu sur votre site à l\'instant.' : 'Contrôle du texte ici (pas encore sur le site : les champs Yoast sont vérifiés après l\'envoi).'),
        R.ok ? el('p', { class: 'ok-text' }, 'Tout est en règle.') : el('p', { class: 'seo-miss' }, `${R.missing} ${plural(R.missing, 'point manque', 'points manquent')} ou ${plural(R.missing, 'est', 'sont')} hors des critères.`),
        el('ul', { class: 'seo-list' }, R.items.map((i) => el('li', { class: i.ok ? 'ok' : 'ko' },
          el('span', { class: 'seo-dot' }, icon(i.ok ? 'check' : 'x')), el('div', { class: 'grow' }, el('b', {}, i.label), ' : ', el('span', { class: 'seo-val' }, i.value), i.detail ? el('div', { class: 'muted small' }, i.detail) : null)))));
    }

    // Yoast : ce qui est réellement parti sur le site
    let yoast = null;
    if (a.wpId && !a.simulated) {
      yoast = el('div', { class: 'card' }, el('h2', {}, 'Yoast SEO'),
        a.yoast ? el('p', { class: 'ok-text' }, 'Mot-clé principal, titre SEO et description ont été envoyés à Yoast.')
          : el('div', { class: 'alert' }, 'Le mot-clé principal, le titre SEO et la description n\'ont PAS été transmis à Yoast : le site ne les accepte pas encore. Installez le petit extrait de code (Réglages, Connexions, « Yoast SEO »), puis enregistrez à nouveau l\'article (« Modifier », « Enregistrer »).'));
    }

    const count = (n, max) => el('div', { class: 'count' + (n > max ? ' bad' : ' muted'), }, `${n} caractères sur ${max} conseillés${n > max ? ' : trop long, à raccourcir' : ''}`);
    const slugUrl = ((S.status.siteUrl || 'https://citylock.fr').replace(/^https?:\/\//, '')) + ' › ' + a.slug;
    const serp = el('div', { class: 'card' }, el('h2', {}, 'Aperçu dans Google'),
      el('p', { class: 'muted small' }, 'Titre et description affichés dans les résultats' + (a.yoast ? ' (déjà dans Yoast).' : '.')),
      el('div', { class: 'serp' }, el('div', { class: 'u' }, slugUrl), el('div', { class: 'tt' }, a.metaTitle), el('div', { class: 'dd' }, a.metaDescription)),
      count(a.metaTitle.length, 60), count(a.metaDescription.length, 155),
      el('p', { class: 'muted small' }, 'Mot-clé principal : ', el('b', {}, a.keyword)));

    // Liens du texte : on montre où ils mènent vraiment.
    const ls = linksOf(a.htmlContent);
    const linksCard = el('div', { class: 'card' }, el('h2', {}, 'Liens dans le texte'),
      ls.length ? [el('p', { class: 'muted small' }, 'Cliquez pour vérifier : chaque lien s\'ouvre sur votre site, dans un nouvel onglet.'), el('ul', { class: 'tasks' }, ls.map((l) => el('li', {}, el('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.text || l.href), el('div', { class: 'muted small' }, l.href))))]
        : el('p', { class: 'muted small' }, 'Aucun lien dans le texte. Vous pouvez en ajouter dans « Modifier ».'));

    return [
      el('button', { class: 'btn ghost', type: 'button', onclick: () => go('articles') }, icon('back'), 'Retour aux articles'),
      head(a.title, a.keyword + (a.city ? ' à ' + a.city : '') + ' · ' + c.words + ' mots'),
      el('div', { class: 'state-line' }, el('span', { class: 'pill big ' + a.state.tone }, a.state.label), a.simulated ? el('span', { class: 'pill' }, 'Démonstration') : null, modelTag(a.modelUsed),
        a.versionsCount ? el('span', { class: 'muted small' }, `${a.versionsCount} ${plural(a.versionsCount, 'version précédente', 'versions précédentes')}`) : null),
      stepper,
      el('div', { class: 'detail' },
        el('div', { class: 'col' }, el('div', { class: 'card post' }, el('h1', { class: 'post-title' }, a.title), preview)),
        el('div', { class: 'col side-col' }, actions, aiCard, seoBox, planned, checks, yoast, serp, linksCard)),
    ];
  }

  // ---------- Modifier un article ----------
  const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function viewEdit() {
    const a = S.articles.find((x) => x.id === S.articleId);
    if (!a) { go('articles'); return []; }
    const E = (S.edit && S.edit.id === a.id) ? S.edit : (S.edit = { id: a.id, versions: [], link: { url: '', text: '' } });
    if (!E.f) E.f = { title: a.title, metaTitle: a.metaTitle, metaDescription: a.metaDescription, slug: a.slug, keyword: a.keyword, htmlContent: a.htmlContent, faits: a.faitsAVerifier.join('\n') };
    const f = E.f;
    const input = (id, key, label, hintTxt, max) => [el('label', { for: id }, label), (() => { const n = el('input', { type: 'text', id, maxlength: max || 300 }); n.value = f[key]; n.addEventListener('input', () => { f[key] = n.value; schedulePreview(); }); return n; })(), hintTxt ? el('p', { class: 'muted small hint' }, hintTxt) : null];
    const area = (id, key, label, hintTxt, rows, cls) => [el('label', { for: id }, label), (() => { const n = el('textarea', { id, rows, class: cls || '' }); n.value = f[key]; n.addEventListener('input', () => { f[key] = n.value; schedulePreview(); }); return n; })(), hintTxt ? el('p', { class: 'muted small hint' }, hintTxt) : null];

    const prevBox = el('div', { class: 'preview' });
    const prevInfo = el('div', {});
    const setPreview = (p) => {
      prevBox.innerHTML = p.html; // assaini par le serveur
      highlightMarkers(prevBox); fixLinks(prevBox);
      prevInfo.replaceChildren(
        el('p', { class: 'muted small' }, `${p.check.words} ${plural(p.check.words, 'mot', 'mots')} (visé : ${p.check.limits.min} à ${p.check.limits.max}).`),
        p.check.issues.length ? el('ul', { class: 'tasks' }, p.check.issues.map((i) => el('li', { class: i.blocking ? 'warn' : 'muted' }, i.message))) : el('p', { class: 'ok-text' }, 'Aucun problème détecté.'));
    };
    let timer = null;
    const runPreview = async () => { try { setPreview(await api('/preview', 'POST', { title: f.title, metaTitle: f.metaTitle, metaDescription: f.metaDescription, htmlContent: f.htmlContent, faitsAVerifier: f.faits })); } catch { /* l'aperçu est facultatif */ } };
    function schedulePreview() { clearTimeout(timer); timer = setTimeout(runPreview, 450); }
    runPreview();
    if (!E.versionsLoaded) { E.versionsLoaded = true; api(`/articles/${a.id}/versions`).then((v) => { E.versions = v.versions; if (S.view === 'edit' && S.articleId === a.id) renderVersions(); }).catch(() => {}); }

    // zone de texte du contenu (référence conservée pour insérer un lien à l'endroit du curseur)
    const textArea = area('ed-text', 'htmlContent', 'Texte de l\'article', 'Le texte est écrit en HTML simple : gardez les balises (<h2>, <p>, <ul>...). L\'aperçu à droite montre le résultat.', 22, 'big mono');
    const ta = textArea[1];
    const urlIn = el('input', { type: 'text', id: 'lk-url', placeholder: 'https://... ou /page-du-site/', autocomplete: 'off', 'aria-label': 'Adresse du lien' });
    const txtIn = el('input', { type: 'text', id: 'lk-text', placeholder: 'Texte du lien (ou sélectionnez des mots dans le texte)', autocomplete: 'off', 'aria-label': 'Texte du lien' });
    urlIn.value = E.link.url; txtIn.value = E.link.text;
    urlIn.addEventListener('input', () => { E.link.url = urlIn.value; }); txtIn.addEventListener('input', () => { E.link.text = txtIn.value; });
    const insertLink = () => {
      const url = urlIn.value.trim();
      if (!/^(https?:\/\/|\/)\S*$/i.test(url)) { toast('L\'adresse du lien doit commencer par https:// ou par / (page de votre site).', true); return; }
      const start = ta.selectionStart, end = ta.selectionEnd;
      const text = (txtIn.value.trim() || ta.value.slice(start, end)).trim();
      if (!text) { toast('Indiquez le texte du lien, ou sélectionnez des mots dans le texte.', true); return; }
      ta.setRangeText(`<a href="${url.replace(/"/g, '%22')}">${escapeHtml(text)}</a>`, start, end, 'end');
      f.htmlContent = ta.value; schedulePreview(); ta.focus();
      urlIn.value = ''; txtIn.value = ''; E.link = { url: '', text: '' };
      toast('Lien inséré dans le texte.');
    };

    const versionsBox = el('div', {});
    function renderVersions() {
      versionsBox.replaceChildren(E.versions.length
        ? el('ul', { class: 'versions' }, E.versions.slice().reverse().map((v) => el('li', {}, el('div', { class: 'grow' }, el('b', {}, v.label), el('div', { class: 'muted small' }, `${fmtDateTime(v.at)} · ${v.wordCount} mots · « ${v.title} »`)),
          el('button', { class: 'btn', type: 'button', onclick: safe(() => revert(v.index)) }, 'Restaurer'))))
        : el('p', { class: 'muted small' }, 'Aucune version précédente pour l\'instant : elles sont gardées à chaque enregistrement.'));
    }
    renderVersions();

    const finish = async (r, doneMsg) => {
      await refresh();
      S.edit = null; // on repart des valeurs enregistrées
      S.articleId = a.id; S.view = 'edit'; render();
      const cur = S.articles.find((x) => x.id === a.id);
      if (r.syncError) toast('Enregistré ici, mais le site n\'a pas pu être mis à jour : ' + r.syncError + ' Cliquez à nouveau sur « Enregistrer » pour réessayer.', true);
      else toast(r.siteUpdated ? doneMsg + ' Le brouillon sur le site est à jour.' : doneMsg);
      return cur;
    };
    async function call(method, path, body) {
      try { return await api(path, method, body); } catch (e) {
        if (e.code !== 'wp_changed' || !confirm(e.message)) throw e;
        return api(path, method, { ...body, force: true });
      }
    }
    async function revert(index) { await finish(await call('POST', `/articles/${a.id}/revert`, index === undefined ? {} : { index }), 'Version restaurée.'); }
    const save = safe(async () => {
      const r = await call('PUT', `/articles/${a.id}`, { title: f.title, metaTitle: f.metaTitle, metaDescription: f.metaDescription, slug: f.slug, keyword: f.keyword, htmlContent: f.htmlContent, faitsAVerifier: f.faits });
      await finish(r, r.unchanged ? 'Aucune modification à enregistrer.' : 'Modifications enregistrées.');
    });

    const onSite = ['brouillon_wp', 'programme'].includes(a.status) && !a.simulated;
    return [
      el('button', { class: 'btn ghost', type: 'button', onclick: () => { S.edit = null; go('article', a.id); } }, icon('back'), 'Retour à l\'article sans enregistrer'),
      head('Modifier l\'article', 'Corrigez le texte à la main. Rien n\'est publié : seul le brouillon est mis à jour.'),
      el('div', { class: 'state-line' }, el('span', { class: 'pill big ' + a.state.tone }, a.state.label), modelTag(a.modelUsed)),
      onSite ? el('div', { class: 'alert' }, 'Cet article est déjà sur votre site : en enregistrant, la version du site (brouillon ou article programmé) est mise à jour. Si le texte a été modifié directement dans WordPress, on vous demandera confirmation avant de l\'écraser.') : null,
      el('div', { class: 'detail editor' },
        el('div', { class: 'col' },
          el('div', { class: 'card' }, el('h2', {}, 'Titre et mot-clé'),
            ...input('ed-title', 'title', 'Titre de l\'article', 'Le titre affiché en haut de la page.', 200),
            ...input('ed-kw', 'keyword', 'Mot-clé principal', 'Le mot-clé que l\'article doit travailler : il est transmis à Yoast comme « mot-clé principal ».', 100)),
          el('div', { class: 'card' }, el('h2', {}, 'Ce qui s\'affiche dans Google (et dans Yoast)'),
            ...input('ed-mt', 'metaTitle', 'Titre pour Google', '60 caractères au maximum.', 300),
            ...area('ed-md', 'metaDescription', 'Description pour Google', '155 caractères au maximum.', 3),
            ...input('ed-slug', 'slug', 'Adresse de la page', 'La fin de l\'adresse, en minuscules et avec des tirets (exemple : alarme-sans-fil).', 80)),
          el('div', { class: 'card' }, el('h2', {}, 'Texte'),
            ...textArea,
            el('div', { class: 'linkbox' }, el('h3', {}, 'Insérer un lien'),
              el('p', { class: 'muted small' }, 'Placez le curseur dans le texte (ou sélectionnez les mots du lien), collez l\'adresse, puis cliquez sur « Insérer ».'),
              el('div', { class: 'row' }, urlIn, txtIn, el('button', { class: 'btn', type: 'button', onclick: insertLink }, icon('plus'), 'Insérer')))),
          el('div', { class: 'card' }, el('h2', {}, 'Faits à vérifier'),
            ...area('ed-facts', 'faits', 'Un fait par ligne', 'Chaque chiffre ou affirmation qu\'un humain doit contrôler. Videz la liste quand tout est vérifié.', 5))),
        el('div', { class: 'col side-col' },
          el('div', { class: 'card sticky' }, el('h2', {}, 'Aperçu et contrôles'),
            el('div', { class: 'actions row-actions' }, el('button', { class: 'btn primary big', type: 'button', onclick: save }, 'Enregistrer'),
              a.versionsCount ? el('button', { class: 'btn', type: 'button', onclick: safe(() => revert()) }, 'Revenir à la version précédente') : null),
            prevInfo, prevBox),
          el('div', { class: 'card' }, el('h2', {}, 'Historique des versions'), el('p', { class: 'muted small' }, 'Chaque enregistrement garde la version d\'avant. Restaurer une version garde aussi l\'état actuel.'), versionsBox))),
    ];
  }

  // ---------- Score ----------
  const PLAIN = {
    title: 'Titres des pages', meta: 'Descriptions sous les résultats Google', h1: 'Un titre principal par page', alt: 'Images décrites',
    localbusiness: 'Entreprise locale déclarée sur l\'accueil (pas la fiche Google)', broken: 'Liens qui ne marchent plus', orphans: 'Pages que personne ne relie',
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

  const METHOD = [['title', 10], ['meta', 10], ['h1', 10], ['alt', 10], ['localbusiness', 10], ['broken', 10], ['orphans', 10], ['thin', 10], ['robots', 5], ['offtopic', 5], ['speed', 10]];
  function methodCard() {
    return el('div', { class: 'card' }, el('h2', {}, 'Sur quoi repose ce score ?'),
      el('p', {}, 'Le robot de l\'outil lit les vraies pages publiques de votre site (celles du plan du site, 150 au maximum), comme le ferait un moteur de recherche. Il applique ensuite 11 vérifications précises, chacune avec ses points. Le score est le total obtenu divisé par le total possible, sur 100.'),
      el('table', { class: 't' }, el('tr', {}, el('th', {}, 'Vérification'), el('th', {}, 'Points')), METHOD.map(([id, pts]) => el('tr', {}, el('td', {}, PLAIN[id]), el('td', {}, pts + (id === 'speed' ? ' (si clé PageSpeed)' : ''))))),
      el('h3', { class: 'mt' }, 'Ce que le score mesure'),
      el('p', { class: 'muted' }, 'L\'hygiène technique de votre site : des faits vérifiables page par page (un titre, une description, un titre principal, des images décrites, des liens qui marchent…). C\'est réel et reproductible : deux mesures d\'un site inchangé donnent le même résultat.'),
      el('h3', {}, 'Ce qu\'il ne mesure pas'),
      el('p', { class: 'muted' }, 'Votre position dans Google, votre nombre de visiteurs, la qualité de vos textes, vos liens depuis d\'autres sites, ni votre fiche Google Business Profile. Un bon score ne garantit aucun classement : il enlève des obstacles techniques.'),
      el('h3', {}, 'Suivre la progression'),
      el('p', { class: 'muted' }, 'Comparez des mesures faites dans les mêmes conditions. Ajouter ou supprimer des pages, ou ajouter la clé PageSpeed, change le total possible et peut faire bouger le score sans vraie amélioration. L\'écran signale ce cas. Sur l\'hébergement gratuit, l\'historique est effacé à chaque redémarrage : téléchargez-le régulièrement (CSV).'));
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
        a ? progressLine(d) : null,
        el('div', { class: 'actions' }, runBtn),
        d.status.lastError && !S.auditRunning ? el('p', { class: 'form-error' }, 'La dernière mesure a échoué : ' + d.status.lastError) : null)));

    if (!a) { out.push(methodCard()); return out; }

    const top = el('div', { class: 'card' }, el('h2', {}, 'À faire en priorité'), el('p', { class: 'muted' }, 'Les 5 actions qui font gagner le plus de points.'));
    if (a.improvements.length) a.improvements.forEach((i) => top.append(el('div', { class: 'todo' }, el('span', { class: 'gain' }, '+' + i.gain + ' pt'), el('div', {}, el('h3', {}, PLAIN[i.id] || i.label), el('p', { class: 'muted small' }, i.explanation)))));
    else top.append(el('p', {}, 'Rien à améliorer sur les points mesurés.'));
    out.push(top);

    out.push(el('div', { class: 'card' }, el('h2', {}, 'Évolution'), el('p', { class: 'muted' }, d.history.length > 1 ? `${d.history.length} mesures conservées.` : 'Une seule mesure pour l\'instant : la courbe apparaît à partir de deux mesures.'), el('div', { id: 'chart' }, chart(d.history.slice(-26))),
      el('table', { class: 't' }, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Score'), el('th', {}, 'Lancement')),
        d.history.slice().reverse().slice(0, 10).map((h) => el('tr', {}, el('td', {}, fmtDate(h.date)), el('td', {}, h.score + ' / 100'), el('td', {}, h.trigger)))),
      el('div', { class: 'actions' }, el('a', { class: 'btn', href: '/api/audits/export.csv', download: 'historique-score-seo.csv' }, 'Télécharger l\'historique (CSV)')),
      el('p', { class: 'muted small' }, 'Sur l\'hébergement gratuit sans disque, l\'historique est effacé à chaque redémarrage du serveur. Le fichier CSV vous permet d\'en garder une trace durable.')));

    const crits = el('div', { class: 'card' }, el('h2', {}, 'Détail, point par point'), el('p', { class: 'muted' }, 'Cliquez sur une ligne pour voir pourquoi et quoi faire.'));
    const prevMap = new Map((d.previous ? d.previous.criteria : []).map((x) => [x.id, x]));
    a.criteria.forEach((c) => {
      const nm = c.points == null;
      const pc = prevMap.get(c.id);
      const dv = pc && pc.points != null && c.points != null ? Math.round((c.points - pc.points) * 10) / 10 : 0;
      const tone = nm ? 'nm' : c.points >= c.max ? 'ok' : c.points === 0 ? 'ko' : 'mid';
      crits.append(el('details', { class: 'crit' },
        el('summary', {}, el('span', { class: 'dot-s ' + tone }, icon(tone === 'ok' ? 'check' : tone === 'nm' ? 'alert' : 'x')),
          el('span', { class: 'name' }, PLAIN[c.id] || c.label),
          dv ? el('span', { class: 'delta ' + (dv > 0 ? 'up' : 'down') }, (dv > 0 ? '+' : '') + String(dv).replace('.', ',')) : null,
          el('span', { class: 'pill ' + (tone === 'ok' ? 'ok' : tone === 'nm' ? '' : tone === 'ko' ? 'ko' : 'warn') }, nm ? 'Non mesuré' : `${c.points} / ${c.max}`)),
        el('div', { class: 'body' }, el('p', { class: 'muted small' }, c.label), el('p', {}, el('b', {}, 'Constat : '), c.measured), el('p', {}, c.explanation),
          c.details && c.details.length ? el('ul', {}, c.details.map((x) => el('li', {}, x.url + ' : ' + x.why))) : null)));
    });
    out.push(crits);
    out.push(methodCard());
    return out;
  }

  // Variation depuis la mesure précédente, avec avertissement si les critères mesurés ont changé.
  function progressLine(d) {
    const a = d.latest, prev = d.previous;
    if (!prev) return el('p', { class: 'muted small' }, 'La progression s\'affichera dès la prochaine mesure.');
    const diff = a.score - prev.score;
    const ids = (list) => list.filter((c) => c.points != null).map((c) => c.id).sort().join(',');
    const same = ids(a.criteria) === ids(prev.criteria);
    return el('div', {}, el('p', { class: 'delta big ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '') }, diff === 0 ? 'Stable depuis le ' + fmtDate(prev.date) : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} ${Math.abs(diff) > 1 ? 'points' : 'point'} depuis le ${fmtDate(prev.date)} (${prev.score} → ${a.score})`.replace(' → ', ' vers ')),
      same ? null : el('p', { class: 'muted small' }, 'Attention : les critères mesurés ne sont pas les mêmes que la fois précédente (par exemple la vitesse). La comparaison est moins fiable.'));
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
    S.settings = await api('/settings', 'PUT', patch);
    S.status = await api('/status');
    if (msg) toast(msg);
  }
  // Clés et identifiants : on peut les remplacer ou les effacer, jamais les relire.
  async function saveSecrets(body, msg) {
    S.settings = await api('/secrets', 'PUT', body);
    S.status = await api('/status');
    if (msg) toast(msg);
  }
  const setMsg = (k, tone, text) => { S.msgs[k] = { tone, text }; };
  const msgBox = (k) => (S.msgs[k] ? el('div', { class: 'alert mt' + (S.msgs[k].tone === 'ok' ? ' ok' : '') }, S.msgs[k].text) : null);
  const hint = (t) => el('p', { class: 'muted small hint' }, t); // explication de deux lignes maximum sous chaque réglage

  function secretState(st) {
    if (st.unreadable) return el('span', { class: 'pill ko' }, 'Illisible, à ressaisir');
    if (st.source === 'interface') return el('span', { class: 'pill ok' }, icon('check'), 'Enregistrée');
    if (st.source === 'serveur') return el('span', { class: 'pill ok' }, icon('check'), 'Fournie par le serveur');
    return el('span', { class: 'pill ko' }, 'Non renseignée');
  }
  const secretInput = (id, st, empty) => el('input', { type: 'password', id, autocomplete: 'new-password', spellcheck: 'false', placeholder: st.set ? '•••••••• enregistrée (vide = inchangée)' : empty });

  function viewSettings() {
    const items = [['redaction', 'Rédaction'], ['connexions', 'Connexions']];
    const bar = el('div', { class: 'seg', role: 'tablist' }, items.map(([id, label]) => el('button', { type: 'button', role: 'tab', class: S.settingsTab === id ? 'on' : '', 'aria-selected': S.settingsTab === id ? 'true' : 'false', onclick: () => { S.settingsTab = id; render(); } }, label)));
    return [head('Réglages', 'Rédaction : le prompt, le modèle, les sujets. Connexions : WordPress, clé OpenRouter, Yoast.'), bar, ...(S.settingsTab === 'connexions' ? settingsConnexions() : settingsRedaction())];
  }

  // ----- Rédaction : le prompt (unique), le modèle, la longueur, les sujets, l'entreprise -----
  function settingsRedaction() {
    const s = S.settings, D = S.aiDefaults;

    // Le prompt : la seule consigne envoyée à l'IA. Aucun texte caché dans le code.
    const prompt = el('textarea', { id: 'prompt', rows: 22, maxlength: D.maxLength, class: 'mono', 'aria-label': 'Prompt de rédaction', spellcheck: 'false' });
    prompt.value = s.systemPrompt;
    const count = el('div', { class: 'count muted' });
    const warn = el('div', {});
    const upd = () => {
      const v = prompt.value;
      count.textContent = `${v.length} caractères sur ${D.maxLength}` + (v.trim() === D.systemPrompt.trim() ? ' · texte d\'origine' : v.trim() === s.systemPrompt.trim() ? ' · enregistré' : ' · modifié, pas encore enregistré');
      const probs = [];
      if (!/json/i.test(v)) probs.push('Le mot « JSON » n\'apparaît pas : l\'IA ne saura pas répondre dans le bon format.');
      for (const k of ['title', 'htmlContent']) if (!v.includes(k)) probs.push(`La clé « ${k} » n'apparaît pas dans le format de réponse.`);
      if (!/\d+\s*(à|et|-)\s*\d+\s*mots/i.test(v)) probs.push('Aucune longueur n\'est demandée (par exemple « entre 600 et 900 mots ») : les articles risquent d\'être trop courts.');
      warn.replaceChildren(...(probs.length ? [el('div', { class: 'alert mt' }, el('b', {}, 'À corriger : '), el('ul', { class: 'tasks' }, probs.map((p) => el('li', {}, p))))] : []));
    };
    prompt.addEventListener('input', upd); upd();
    const wmin = el('input', { type: 'number', id: 'wmin', min: 50, max: 3000, step: 10, value: s.minWords });
    const wmax = el('input', { type: 'number', id: 'wmax', min: 50, max: 3000, step: 10, value: s.maxWords });
    const promptCard = el('div', { class: 'card' }, el('h2', {}, 'Prompt de rédaction'),
      el('p', { class: 'muted' }, 'C\'est LE texte envoyé à l\'IA pour chaque article : ton, faits autorisés, mots interdits, structure, longueur, liens, et format de réponse (JSON). Rien d\'autre n\'est ajouté par l\'outil, sauf le sujet et la ville.'),
      el('label', { for: 'prompt' }, 'Votre prompt'), prompt, count, warn,
      hint('Le format JSON (title, metaTitle, metaDescription, slug, htmlContent, internalLinkSuggestions, faitsAVerifier) doit rester dans le prompt, sinon l\'outil ne peut pas lire la réponse. Un changement s\'applique aux prochains articles.'),
      el('div', { class: 'row btn-row' },
        el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { await saveSettings({ systemPrompt: prompt.value }); setMsg('prompt', 'ok', 'Prompt enregistré. Il sera utilisé pour les prochains articles.'); render(); }) }, 'Enregistrer le prompt'),
        el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => {
          if (!confirm('Remplacer votre prompt par le texte d\'origine ? Vos modifications seront perdues.')) return;
          await saveSettings({ systemPrompt: D.systemPrompt }); setMsg('prompt', 'ok', 'Texte d\'origine rétabli.'); render();
        }) }, 'Rétablir le texte d\'origine')),
      msgBox('prompt'),
      el('h3', { class: 'mt' }, 'Contrôle de la longueur'),
      el('p', { class: 'muted small' }, 'Le prompt demande la longueur à l\'IA ; ces deux nombres servent à CONTRÔLER le résultat : hors de la plage, l\'article est signalé et ne part pas sans votre confirmation. Il n\'y a pas de nouvel essai automatique : si l\'IA écrit trop court, régénérez l\'article ou changez de modèle.'),
      el('div', { class: 'row' }, el('div', { class: 'grow-field' }, el('label', { for: 'wmin' }, 'Minimum (mots)'), wmin), el('div', { class: 'grow-field' }, el('label', { for: 'wmax' }, 'Maximum (mots)'), wmax)),
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await saveSettings({ minWords: Number(wmin.value), maxWords: Number(wmax.value) }, 'Longueur enregistrée.'); render(); }) }, 'Enregistrer la longueur')),
      el('p', { class: 'muted small' }, 'Sur l\'hébergement gratuit, les réglages peuvent être réinitialisés lors d\'un redémarrage du serveur : gardez une copie de votre prompt.'));

    // Correction par l'IA : modèle (Haiku par défaut) + prompt
    const eprompt = el('textarea', { id: 'eprompt', rows: 14, maxlength: D.maxLength, class: 'mono', 'aria-label': 'Prompt de correction', spellcheck: 'false' });
    eprompt.value = s.editPrompt;
    const ewarn = el('div', {});
    const eupd = () => { const v = eprompt.value; const pr = []; if (!/json/i.test(v)) pr.push('Le mot « JSON » n\'apparaît pas.'); for (const k of ['title', 'htmlContent']) if (!v.includes(k)) pr.push(`La clé « ${k} » n'apparaît pas dans le format de réponse.`); ewarn.replaceChildren(...(pr.length ? [el('div', { class: 'alert mt' }, el('b', {}, 'À corriger : '), pr.join(' '))] : [])); };
    eprompt.addEventListener('input', eupd); eupd();
    const emodel = el('input', { type: 'text', id: 'emodel', maxlength: 99, value: s.editModel || '', placeholder: 'Par défaut : ' + D.activeEditModel, autocomplete: 'off', spellcheck: 'false' });
    const editCard = el('div', { class: 'card' }, el('h2', {}, 'Correction par l\'IA'),
      el('p', { class: 'muted' }, 'Sur chaque article, vous pouvez dire à l\'IA quoi changer. Elle utilise son propre modèle (Haiku par défaut, plus rapide et moins cher) et son propre prompt, qui lui demande de garder le SEO.'),
      el('div', { class: 'model-now' }, 'Correction faite avec : ', el('b', {}, D.activeEditModel)),
      el('label', { for: 'emodel' }, 'Modèle de correction'), emodel,
      hint('Vide = Haiku. Le modèle est testé avant d\'être activé.'),
      el('div', { class: 'row btn-row' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => {
        setMsg('emodel', 'ko', 'Test en cours (quelques secondes)...'); render();
        try { const r = await api('/ai/model', 'POST', { model: emodel.value, target: 'edit' }); setMsg('emodel', r.ok ? 'ok' : 'ko', r.message); } catch (e) { setMsg('emodel', 'ko', e.message); }
        S.settings = await api('/settings'); S.aiDefaults = await api('/ai/defaults'); render();
      }) }, 'Tester et activer le modèle')), msgBox('emodel'),
      el('label', { for: 'eprompt' }, 'Prompt de correction'), eprompt, ewarn,
      el('div', { class: 'row btn-row' },
        el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { await saveSettings({ editPrompt: eprompt.value }); setMsg('eprompt', 'ok', 'Prompt de correction enregistré.'); render(); }) }, 'Enregistrer le prompt'),
        el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => { if (!confirm('Remplacer le prompt de correction par le texte d\'origine ?')) return; await saveSettings({ editPrompt: D.editPrompt }); setMsg('eprompt', 'ok', 'Texte d\'origine rétabli.'); render(); }) }, 'Rétablir le texte d\'origine')),
      msgBox('eprompt'));

    // Modèle
    const model = el('input', { type: 'text', id: 'model', maxlength: 99, value: s.aiModel || '', placeholder: D.envModel ? 'Par défaut : ' + D.envModel : 'Exemple : anthropic/claude-haiku-5-5', autocomplete: 'off', spellcheck: 'false' });
    const activate = async (value) => {
      setMsg('model', 'ko', 'Test en cours (quelques secondes)...'); render();
      try { const r = await api('/ai/model', 'POST', { model: value }); setMsg('model', r.ok ? 'ok' : 'ko', r.message); } catch (e) { setMsg('model', 'ko', e.message); }
      S.settings = await api('/settings'); S.aiDefaults = await api('/ai/defaults'); S.status = await api('/status'); render();
    };
    const modelCard = el('div', { class: 'card' }, el('h2', {}, 'Modèle d\'intelligence artificielle'),
      el('p', { class: 'muted' }, 'C\'est ce modèle qui rédige vos articles. Un nouveau modèle est testé avant d\'être utilisé : s\'il ne répond pas, l\'actuel est conservé.'),
      el('div', { class: 'model-now' }, 'Rédigé avec : ', el('b', {}, D.activeModel || 'aucun modèle choisi'), D.activeModel && !s.aiModel ? el('span', { class: 'muted small' }, ' (modèle du serveur)') : null),
      el('label', { for: 'model' }, 'Identifiant du modèle'), model,
      hint('Copiez l\'identifiant exact depuis openrouter.ai/models. Vide = modèle du serveur.'),
      el('div', { class: 'row btn-row' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(() => activate(model.value)) }, 'Tester et activer le modèle'),
        D.previousModel ? el('button', { class: 'btn', type: 'button', onclick: safe(() => activate(D.previousModel)) }, `Revenir au modèle précédent (${D.previousModel})`) : null),
      msgBox('model'));

    // Sujets
    const kw = el('input', { type: 'text', maxlength: 100, placeholder: 'Sujet, par exemple : alarme sans fil pour appartement', 'aria-label': 'Sujet', required: true });
    const city = el('input', { type: 'text', maxlength: 60, placeholder: 'Ville (facultatif)', 'aria-label': 'Ville' });
    const topics = el('div', { class: 'chips' });
    if (!s.topics.length) topics.append(el('p', { class: 'muted' }, 'Aucun sujet pour l\'instant.'));
    s.topics.forEach((tp) => topics.append(el('div', { class: 'chip' }, el('div', { class: 'grow' }, el('b', {}, tp.keyword), tp.city ? ' à ' + tp.city : ''),
      el('button', { type: 'button', 'aria-label': 'Supprimer ce sujet', onclick: safe(async () => { S.settings = await api('/topics/' + tp.id, 'DELETE'); render(); }) }, icon('trash')))));
    const topicsCard = el('div', { class: 'card' }, el('h2', {}, 'Sujets d\'articles'), el('p', { class: 'muted' }, 'Une liste de mots-clés (avec une ville si utile). Le mode « Plusieurs articles » les prend dans l\'ordre. Vous pouvez aussi taper un sujet à la volée dans « Rédiger ».'),
      el('form', { class: 'row', onsubmit: safe(async (e) => { e.preventDefault(); S.settings = await api('/topics', 'POST', { keyword: kw.value, city: city.value }); render(); }) }, kw, city, el('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Ajouter')),
      hint('Pour un planning de 6 mois à 3 articles par mois, il faut 18 sujets différents. Évitez deux articles sur le même mot-clé.'), topics);

    // Entreprise
    const brand = el('input', { type: 'text', maxlength: 60, value: s.brandName, id: 'brand' });
    const zone = el('input', { type: 'text', maxlength: 80, value: s.zone, id: 'zone' });
    const companyCard = el('div', { class: 'card' }, el('h2', {}, 'Votre entreprise'), el('p', { class: 'muted' }, 'Le nom et la zone sont transmis à l\'IA avec chaque sujet (en plus du prompt).'),
      el('label', { for: 'brand' }, 'Nom commercial'), brand, el('label', { for: 'zone' }, 'Zone desservie'), zone,
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { await saveSettings({ brandName: brand.value, zone: zone.value }, 'Informations enregistrées.'); }) }, 'Enregistrer')));

    return [promptCard, modelCard, editCard, topicsCard, companyCard];
  }

  // Extrait de code à installer une fois dans WordPress pour que Yoast reçoive mot-clé, titre SEO et description.
  const YOAST_SNIPPET = `add_action('init', function () {
    foreach (['_yoast_wpseo_focuskw', '_yoast_wpseo_title', '_yoast_wpseo_metadesc'] as $key) {
        register_post_meta('post', $key, [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function () { return current_user_can('edit_posts'); },
        ]);
    }
});`;

  // ----- Connexions : mise en route, WordPress, Yoast, clé de rédaction, PageSpeed -----
  function settingsConnexions() {
    const s = S.settings, st = S.status;
    const jump = (tab) => () => { S.settingsTab = tab; render(); };
    const wpOk = st.wordpress, keyOk = s.secrets.openrouterKey.set, modelOk = !!S.aiDefaults.activeModel;
    const row = (ok, label, hintTxt, btn) => el('div', { class: 'conn' }, el('span', { class: 'dot-s ' + (ok ? 'ok' : 'nm') }, icon(ok ? 'check' : 'alert')),
      el('div', { class: 'grow' }, el('b', {}, label), el('div', { class: 'muted small' }, hintTxt)), btn || null);
    const fragile = ['wpAppPassword', 'openrouterKey'].filter((k) => s.secrets[k].source === 'interface').length || (s.wpUser && !st.wpUserFromServer);
    const keepCard = fragile ? el('div', { class: 'alert' }, el('b', {}, 'Pour ne jamais les ressaisir : '), 'vos identifiants sont enregistrés ici, et l\'hébergement gratuit de Render les efface à chaque redémarrage. Copiez-les une fois dans Render (onglet Environment) : ', el('code', {}, 'WP_USER'), ', ', el('code', {}, 'WP_APP_PASSWORD'), ' et ', el('code', {}, 'OPENROUTER_API_KEY'), '. Le tableau de bord les relit tout seul à chaque démarrage.') : el('div', { class: 'alert ok' }, 'Vos identifiants sont fournis par le serveur (Render) : ils survivent aux redémarrages.');
    const setup = el('div', { class: 'card' }, el('h2', {}, 'Mise en route'), el('p', { class: 'muted' }, 'Quatre points pour passer du mode démonstration à l\'utilisation réelle.'),
      row(wpOk, 'Liaison avec WordPress', wpOk ? 'Identifiant et mot de passe renseignés.' : 'Identifiant et mot de passe d\'application à saisir plus bas.'),
      row(keyOk, 'Clé de rédaction (OpenRouter)', keyOk ? 'Clé renseignée.' : 'À saisir plus bas, dans « Clé de rédaction ».'),
      row(modelOk, 'Modèle d\'intelligence artificielle', modelOk ? 'Un modèle est choisi.' : 'À choisir et tester dans l\'onglet Rédaction.', modelOk ? null : el('button', { class: 'btn', type: 'button', onclick: jump('redaction') }, 'Ouvrir Rédaction')),
      row(!st.simulate, 'Mode réel activé', st.simulate ? 'Le mode démonstration est encore actif : aucun appel réel.' : 'Les vrais services sont utilisés. Rien n\'est publié sans votre validation.'));

    const demo = el('input', { type: 'checkbox', checked: st.simulate ? true : false, id: 'demo', role: 'switch' });
    demo.addEventListener('change', safe(async () => {
      if (!demo.checked && !confirm('Passer en mode réel ? Les articles seront rédigés avec votre clé OpenRouter et envoyés sur votre site à votre demande. Rien n\'est publié sans votre validation.')) { demo.checked = true; return; }
      await saveSettings({ simulate: demo.checked }, demo.checked ? 'Mode démonstration activé.' : 'Mode réel activé.'); render();
    }));
    const demoCard = el('div', { class: 'card' }, el('h2', {}, 'Mode démonstration'),
      el('div', { class: 'switch-row' }, el('div', {}, el('b', {}, 'Faire semblant, sans rien envoyer'), el('p', { class: 'muted small' }, 'Les articles sont des textes de test et aucun appel n\'est fait à OpenRouter ni à WordPress. ' + (st.simulateFromSettings ? '' : 'Valeur actuelle fournie par le serveur.'))),
        el('label', { class: 'switch', for: 'demo', 'aria-label': 'Mode démonstration' }, demo, el('span'))));

    // WordPress
    const wpSec = s.secrets.wpAppPassword;
    const user = el('input', { type: 'text', id: 'wp-user', value: s.wpUser || '', placeholder: 'Identifiant WordPress', autocomplete: 'off', spellcheck: 'false' });
    const pass = secretInput('wp-pass', wpSec, 'xxxx xxxx xxxx xxxx xxxx xxxx');
    const site = el('input', { type: 'text', id: 'wp-site', value: st.siteUrl || '', readonly: 'readonly' });
    const saveTestWp = safe(async () => {
      const body = {};
      if (user.value.trim() !== (s.wpUser || '')) body.wpUser = user.value;
      if (pass.value) body.wpAppPassword = pass.value;
      if (Object.keys(body).length) await saveSecrets(body);
      setMsg('wp', 'ko', 'Test en cours...'); render();
      try {
        const r = await api('/wp/test');
        setMsg('wp', r.canEdit ? 'ok' : 'ko', r.simulated ? 'Mode démonstration : aucun test réel. Désactivez-le ci-dessus pour tester la vraie connexion.'
          : `Connexion réussie à « ${r.site || 'votre site'} », en tant que ${r.name}. Créer des brouillons : ${r.canEdit ? 'oui' : 'non'}. Publier : ${r.canPublish ? 'oui' : 'non'}.${r.canEdit ? '' : ' Ce compte ne peut pas créer d\'articles : utilisez un compte Auteur ou Éditeur.'}`);
      } catch (e) { setMsg('wp', 'ko', e.message); }
      render();
    });
    const wpCard = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Liaison avec WordPress'), secretState(wpSec)),
      el('p', { class: 'muted' }, 'Permet d\'envoyer, programmer et publier les articles sur votre site.'),
      el('details', { class: 'faq' }, el('summary', {}, 'Où trouver le mot de passe d\'application ?'), el('div', { class: 'a' },
        el('ol', { class: 'tasks' }, [
          'Connectez-vous à WordPress, puis ouvrez Utilisateurs, Profil (idéalement un compte dédié avec le rôle Éditeur).',
          'Descendez jusqu\'à « Mots de passe d\'application », saisissez le nom « Tableau de bord CityLock », puis cliquez sur « Ajouter ».',
          'Copiez le mot de passe affiché (il ne s\'affiche qu\'une fois) et collez-le ci-dessous.'].map((x) => el('li', {}, x))),
        el('p', { class: 'muted small' }, 'Ce n\'est pas le mot de passe de connexion à WordPress.'))),
      el('label', { for: 'wp-site' }, 'Adresse du site'), site, hint('Fixée sur le serveur pour protéger vos identifiants. Elle ne se change pas ici.'),
      el('label', { for: 'wp-user' }, 'Identifiant WordPress'), user,
      el('label', { for: 'wp-pass' }, 'Mot de passe d\'application'), pass, hint('Un mot de passe créé exprès pour cet outil. Il n\'est jamais réaffiché une fois enregistré.'),
      el('div', { class: 'row btn-row' },
        el('button', { class: 'btn primary', type: 'button', onclick: saveTestWp }, 'Enregistrer et tester'),
        el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api('/category/ensure', 'POST'); toast('Catégorie « Blog » prête sur votre site.'); }) }, 'Préparer la catégorie « Blog »'),
        wpSec.source === 'interface' ? el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => { if (!confirm('Effacer le mot de passe enregistré ?')) return; await saveSecrets({ wpAppPassword: '' }, 'Mot de passe effacé.'); render(); }) }, 'Effacer le mot de passe') : null),
      msgBox('wp'));

    // Yoast
    const Y = S.yoast;
    const yTone = !Y ? '' : Y.simulated ? 'warn' : Y.ok ? 'ok' : 'ko';
    const yText = !Y ? 'Pas encore vérifié.' : Y.simulated ? 'Mode démonstration : non vérifiable.' : Y.ok ? 'Le site accepte le mot-clé principal, le titre SEO et la description : ils sont envoyés avec chaque article.' : Y.known ? 'Le site n\'accepte pas encore ces champs : les articles partent sans mot-clé principal ni description Yoast (Yoast affiche alors des voyants rouges).' : 'Impossible de lire l\'état du site.';
    const yoastCard = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Yoast SEO'), Y ? el('span', { class: 'pill ' + yTone }, Y.simulated ? 'Démonstration' : Y.ok ? 'Actif' : 'À installer') : null),
      el('p', { class: 'muted' }, 'Pour que Yoast reçoive le mot-clé principal, le titre SEO et la description de chaque article, WordPress doit autoriser ces trois champs. C\'est un petit extrait de code, à installer une seule fois.'),
      el('p', { class: yTone === 'ok' ? 'ok-text' : '' }, yText),
      el('details', { class: 'faq' }, el('summary', {}, 'Installer l\'extrait de code (une fois)'), el('div', { class: 'a' },
        el('ol', { class: 'tasks' }, [
          'Dans WordPress, installez l\'extension gratuite « WPCode » (ou « Code Snippets »).',
          'Créez un nouvel extrait de type PHP, collez le code ci-dessous, activez-le et enregistrez.',
          'Revenez ici et cliquez sur « Vérifier ». Puis, pour un article déjà envoyé, ouvrez « Modifier » et enregistrez à nouveau.'].map((x) => el('li', {}, x))),
        el('pre', { class: 'pre' }, YOAST_SNIPPET),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await navigator.clipboard.writeText(YOAST_SNIPPET); toast('Code copié.'); }) }, 'Copier le code')),
        el('p', { class: 'muted small' }, 'Il ne modifie aucun contenu : il autorise seulement l\'outil à écrire ces trois champs Yoast. Il faut un compte capable de modifier des articles.'))),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { S.yoast = await api('/wp/yoast'); render(); }) }, 'Vérifier')),
      el('p', { class: 'muted small' }, 'Honnêtement : cela corrige les voyants « pas de mot-clé » et « pas de méta description ». Les autres voyants de Yoast (longueur, mot-clé dans l\'introduction, liens sortants, etc.) dépendent du texte lui-même.'));
    if (!S.yoastLoaded) { S.yoastLoaded = true; api('/wp/yoast').then((y) => { S.yoast = y; if (S.view === 'settings' && S.settingsTab === 'connexions') render(); }).catch(() => {}); }

    // Clé OpenRouter
    const keySec = s.secrets.openrouterKey;
    const key = secretInput('or-key', keySec, 'Collez la clé OpenRouter');
    const keyCard = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Clé de rédaction (OpenRouter)'), secretState(keySec)),
      el('p', { class: 'muted' }, 'OpenRouter est le service qui fait écrire les articles par l\'intelligence artificielle.'),
      el('label', { for: 'or-key' }, 'Clé OpenRouter'), key, hint('Créez-la sur openrouter.ai (menu Keys). Elle est chiffrée et ne s\'affiche plus jamais.'),
      keySec.hint ? el('p', { class: 'muted small' }, `Clé actuelle terminée par « ${keySec.hint} ».`) : null,
      el('div', { class: 'row btn-row' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { if (!key.value) { toast('Collez d\'abord la clé.', true); return; } await saveSecrets({ openrouterKey: key.value }, 'Clé OpenRouter enregistrée.'); render(); }) }, 'Enregistrer la clé'),
        keySec.source === 'interface' ? el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => { if (!confirm('Effacer la clé enregistrée ?')) return; await saveSecrets({ openrouterKey: '' }, 'Clé effacée.'); render(); }) }, 'Effacer la clé') : null));

    // PageSpeed
    const psSec = s.secrets.pagespeedKey;
    const ps = secretInput('ps-key', psSec, 'Collez la clé Google PageSpeed');
    const psCard = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Vitesse du site (facultatif)'), secretState(psSec)),
      el('p', { class: 'muted' }, 'Avec une clé Google PageSpeed Insights, le score mesure aussi la vitesse sur mobile. Sans clé, ce critère est simplement « non mesuré ».'),
      el('label', { for: 'ps-key' }, 'Clé PageSpeed'), ps,
      el('div', { class: 'row btn-row' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { if (!ps.value) { toast('Collez d\'abord la clé.', true); return; } await saveSecrets({ pagespeedKey: ps.value }, 'Clé PageSpeed enregistrée.'); render(); }) }, 'Enregistrer'),
        psSec.source === 'interface' ? el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => { await saveSecrets({ pagespeedKey: '' }, 'Clé effacée.'); render(); }) }, 'Effacer la clé') : null));

    return [keepCard, setup, demoCard, wpCard, yoastCard, keyCard, psCard,
      el('p', { class: 'muted small' }, 'Les clés saisies ici sont chiffrées sur le serveur et ne s\'affichent plus jamais. Sur l\'hébergement gratuit sans disque, elles sont effacées à un redémarrage : gardez aussi une copie dans les variables de l\'hébergeur.')];
  }

  // ---------- Aide ----------
  function viewHelp() {
    const faq = (q, ...paras) => el('details', { class: 'faq' }, el('summary', {}, q), el('div', { class: 'a' }, paras.map((p) => el('p', {}, p))));
    return [
      head('Aide', 'Tout ce qu\'il faut savoir, simplement.'),
      faq('À quoi sert cet outil ?', 'Il rédige des articles de blog pour citylock.fr, vous les laissez relire et corriger, puis WordPress les publie à la date que vous choisissez. Il mesure aussi la santé de votre site pour Google. Rien n\'est publié sans votre accord.'),
      faq('Les deux façons de rédiger', 'Dans « Rédiger » :', '« Un seul article » : vous choisissez un sujet, l\'article arrive dans « Articles », vous faites ce que vous voulez (le modifier, l\'envoyer en brouillon, le programmer, le supprimer).', '« Plusieurs articles » : vous choisissez combien d\'articles (de 1 à 20), vous écrivez le mot-clé de chacun, l\'outil propose une date que vous pouvez changer, puis il rédige tout. Tous les articles arrivent dans « Articles ». Là, un calendrier vous laisse choisir la date de chacun : à 10 h ce jour-là, WordPress le publie tout seul.'),
      faq('Où est le prompt de rédaction ?', 'Dans « Réglages », onglet « Rédaction ». C\'est le seul texte envoyé à l\'IA (avec le sujet et la ville) : vous pouvez tout y changer, y compris la longueur demandée et le format de réponse. L\'outil n\'ajoute rien en cachette. Si vous supprimez la partie « format de réponse (JSON) », un avertissement apparaît, car l\'outil ne pourrait plus lire l\'article.'),
      faq('Que veut dire « programmer » ?', 'Vous choisissez une date et une heure : WordPress publie alors l\'article tout seul à ce moment (heure de Paris), même si cet outil est fermé. Vous pouvez annuler la programmation, changer la date, ou publier tout de suite.', 'Pour que WordPress publie à l\'heure exacte, il faut que le site soit visité ou qu\'une tâche planifiée tourne (c\'est le cas de presque tous les sites). Si un article reste « programmé » après sa date, regardez dans WordPress.'),
      faq('Que veut dire « brouillon » ?', 'Un brouillon est un article enregistré sur votre site mais invisible du public. Vous pouvez le modifier tant que vous ne l\'avez pas publié.'),
      faq('Pourquoi un article est-il « laissé de côté » ?', 'Parce qu\'il a un problème qui demande votre œil : longueur hors de la plage, mot interdit, marqueur [SOURCE A VERIFIER] à remplacer, ou faits à vérifier. Ouvrez-le, corrigez-le avec « Modifier », puis programmez-le.'),
      faq('Un article est trop court. Que faire ?', 'Le prompt demande 600 à 900 mots, mais certains modèles écrivent plus court. L\'outil ne réessaie pas tout seul : l\'article est signalé, et il ne part pas sans votre confirmation. Cliquez sur « Régénérer », ou changez de modèle (Réglages, Rédaction).'),
      faq('Comment faire corriger un article par l\'IA ?', 'Ouvrez l\'article, carte « Corriger avec l\'IA » : écrivez ce qu\'il faut changer et où, puis cliquez sur « Corriger avec l\'IA ». Elle réécrit l\'article en gardant le SEO. Le résultat indique les points SEO hors critères avant et après : si quelque chose s\'est dégradé, c\'est signalé et « Annuler cette correction » remet la version d\'avant. Le modèle (Haiku par défaut) et le prompt de correction se règlent dans Réglages, Rédaction.'),
      faq('Comment modifier un article à la main ?', 'Ouvrez l\'article, puis « Modifier » : titre, texte, description Google, mot-clé principal, faits à vérifier. Le bouton « Insérer un lien » ajoute un lien à l\'endroit du curseur. Chaque enregistrement garde la version d\'avant. Si l\'article est déjà sur le site, il est mis à jour en même temps.'),
      faq('Les liens « alarme avec / sans abonnement » ne s\'ouvraient pas', 'Les liens du texte sont des adresses de votre site (par exemple /choisir-alarme-sans-abonnement/…). Dans l\'aperçu, ils s\'ouvraient par erreur sur ce tableau de bord : c\'est corrigé, ils s\'ouvrent maintenant sur citylock.fr dans un nouvel onglet. La carte « Liens dans le texte » de chaque article les liste pour les tester.'),
      faq('Pourquoi Yoast est-il rouge ?', 'Avant, l\'outil n\'envoyait ni le mot-clé principal, ni le titre SEO, ni la description à Yoast. Désormais il le fait, à condition d\'installer une fois un petit extrait de code dans WordPress (Réglages, Connexions, carte « Yoast SEO »). Les autres voyants (longueur du texte, mot-clé dans l\'introduction, liens…) dépendent du contenu.'),
      faq('Comment relier mon site WordPress ?', 'Dans « Réglages », onglet « Connexions » : un administrateur crée un mot de passe d\'application dans WordPress, vous collez l\'identifiant et ce mot de passe, puis « Enregistrer et tester ».'),
      faq('Comment changer le modèle d\'IA ?', 'Dans « Réglages », onglet « Rédaction » : collez l\'identifiant du modèle (openrouter.ai/models) puis « Tester et activer le modèle ». Le modèle n\'est utilisé que si le test réussit. Chaque article indique le modèle qui l\'a rédigé.'),
      faq('Pourquoi « entreprise locale » est à 0 alors que ma fiche Google est complète ?', 'Ce sont deux choses différentes. La fiche Google Business Profile se gère sur Google. Le score lit le code de la page d\'accueil et cherche une déclaration « entreprise locale » (LocalBusiness), qui peut manquer même si votre fiche est parfaite.'),
      faq('Que mesure le score ?', 'Un score sur 100 calculé avec des points précis : titres, descriptions, images décrites, liens cassés, pages trop courtes, plan du site, etc. Ce n\'est pas une note Google et il ne garantit aucun classement.'),
      faq('Pourquoi un chiffre est-il signalé « à vérifier » ?', 'L\'outil n\'a pas le droit d\'inventer des chiffres. Quand une statistique serait utile, il laisse un repère [SOURCE A VERIFIER] à remplacer par une source fiable, ou à supprimer.'),
      el('div', { class: 'card' }, el('h2', {}, 'Petit lexique'), el('dl', { class: 'gloss' },
        el('dt', {}, 'SEO'), el('dd', {}, 'Tout ce qui aide votre site à apparaître dans les recherches Google.'),
        el('dt', {}, 'Meta description'), el('dd', {}, 'Le petit texte affiché sous le titre de votre page dans Google.'),
        el('dt', {}, 'Mot-clé principal'), el('dd', {}, 'L\'expression que l\'article veut faire trouver (« mot-clé principal » dans Yoast).'),
        el('dt', {}, 'Texte alternatif'), el('dd', {}, 'Une courte description d\'une image, lue par Google et par les lecteurs d\'écran.'))),
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
    api('/write/status').then((b) => { if (b.running) { S.batch = b; pollBatch(); } }).catch(() => {});
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
