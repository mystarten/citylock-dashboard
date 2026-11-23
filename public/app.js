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
  const demoOn = () => !!(S.status && S.status.simulate);
  const mine = () => S.articles.filter((a) => !!a.simulated === demoOn()); // articles du mode en cours
  const pending = () => mine().filter((a) => a.status !== 'publie').length;

  function renderNav() {
    const nav = $('nav');
    nav.replaceChildren(...NAV.map(([id, label, ic]) => {
      const n = id === 'articles' ? pending() : 0;
      return el('button', { type: 'button', class: 'nav-btn' + (S.view === id ? ' active' : ''), 'aria-current': S.view === id ? 'page' : false, onclick: () => go(id) },
        icon(ic), el('span', {}, label), n ? el('span', { class: 'dot' }, n) : null);
    }));
    $('logout').replaceChildren(icon('logout'), el('span', {}, 'Se déconnecter'));
  }

  async function refreshPlan() { S.plan = await api('/articles/plan'); }

  async function refresh() {
    const [settings, status, articles, audits, aiDefaults, plan] = await Promise.all([api('/settings'), api('/status'), api('/articles'), api('/audits'), api('/ai/defaults'), api('/articles/plan')]);
    Object.assign(S, { settings, status, articles, audits, aiDefaults, plan });
    S.auditRunning = !!audits.status.running;
    $('sim').classList.toggle('hidden', !status.simulate);
  }

  function go(view, articleId) {
    S.view = view;
    S.articleId = articleId || null;
    window.scrollTo(0, 0);
    render();
    if (view === 'articles' || view === 'home') refreshPlan().then(() => { if (S.view === view) render(); }).catch(() => {});
    if (view === 'score') watchAudit();
  }

  function render() {
    // Le bandeau suit TOUJOURS le mode en cours (il disparaît dès que le mode démonstration est désactivé).
    $('sim').classList.toggle('hidden', !(S.status && S.status.simulate));
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
    const used = mine().filter((a) => a.month === monthNow()).length;
    const latest = S.audits.latest;
    const toReview = mine().filter((a) => a.status === 'a_relire').length;
    const drafts = mine().filter((a) => a.status === 'brouillon_wp').length;
    const usedTopics = new Set(mine().filter((a) => a.month === monthNow()).map((a) => a.topicId));
    const freeTopics = s.topics.filter((t) => !usedTopics.has(t.id)).length;

    let next;
    if (!s.topics.length) next = ['Commencez par choisir vos sujets', 'Indiquez les thèmes dont vous voulez parler, par exemple « alarme sans abonnement » à Chatou.', 'Ajouter des sujets', () => go('settings')];
    else if (!S.status.simulate && (!S.status.wordpress || !S.status.openrouter)) next = ['Terminez la mise en route', 'Il manque la liaison avec WordPress ou la clé de rédaction pour travailler en mode réel.', 'Ouvrir les connexions', () => { S.settingsTab = 'connexions'; go('settings'); }];
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

  function planCard() {
    const pl = S.plan, s = S.settings;
    const card = el('div', { class: 'card' }, el('h2', {}, 'Ce qui sera rédigé'));
    if (!pl.totalTopics) {
      add(card, el('p', { class: 'muted' }, 'Aucun sujet pour l\'instant. Les sujets sont la base de chaque article : ajoutez les vôtres dans les réglages.'),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: () => { S.settingsTab = 'general'; go('settings'); } }, 'Ajouter des sujets')));
    } else if (pl.remaining <= 0) {
      add(card, el('p', {}, `Le lot du mois est complet : ${pl.already} ${plural(pl.already, 'article rédigé', 'articles rédigés')} sur ${pl.frequency}.`),
        pl.availableTopics ? el('p', { class: 'muted small' }, `${pl.availableTopics} ${plural(pl.availableTopics, 'sujet attend', 'sujets attendent')} le mois prochain.`) : null);
    } else if (!pl.next.length) {
      add(card, el('p', {}, 'Tous vos sujets ont déjà été utilisés ce mois-ci. Ajoutez de nouveaux sujets dans les réglages pour continuer.'),
        el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', onclick: () => { S.settingsTab = 'general'; go('settings'); } }, 'Ajouter des sujets')));
    } else {
      add(card, el('p', { class: 'muted' }, `Ce mois-ci : ${pl.already} sur ${pl.frequency} rédigés. Le prochain lot rédigera ${pl.next.length} ${plural(pl.next.length, 'article', 'articles')}, un par sujet, dans cet ordre :`),
        el('ol', { class: 'tasks' }, pl.next.map((t) => el('li', {}, el('b', {}, t.keyword), t.city ? ' à ' + t.city : ''))),
        pl.availableTopics > pl.next.length ? el('p', { class: 'muted small' }, `${pl.availableTopics - pl.next.length} ${plural(pl.availableTopics - pl.next.length, 'autre sujet attend', 'autres sujets attendent')} le mois prochain.`) : null);
    }
    if (demoOn()) add(card, el('p', { class: 'muted small' }, 'Mode démonstration : les articles seront des textes de test, rien ne part sur votre site.'));
    return card;
  }

  // Essai de rédaction : un article « pour voir », sans envoi sur le site ni usage du quota tant qu'on ne le garde pas.
  function trialCard() {
    const s = S.settings;
    const sel = el('select', { id: 'trial-topic', 'aria-label': 'Sujet de l\'essai' },
      [...s.topics.map((t) => el('option', { value: t.id }, t.keyword + (t.city ? ' à ' + t.city : ''))), el('option', { value: '__free' }, 'Autre sujet (je le tape)')]);
    sel.value = S.trialSel && [...sel.options].some((o) => o.value === S.trialSel) ? S.trialSel : sel.options[0].value;
    const kw = el('input', { type: 'text', id: 'trial-kw', maxlength: 100, placeholder: 'Mot-clé, par exemple : serrure connectée', 'aria-label': 'Mot-clé' });
    const city = el('input', { type: 'text', id: 'trial-city', maxlength: 60, placeholder: 'Ville (facultatif)', 'aria-label': 'Ville' });
    kw.value = S.trialKw || ''; city.value = S.trialCity || '';
    const free = el('div', { class: 'row mt' }, kw, city);
    const sync = () => { S.trialSel = sel.value; S.trialKw = kw.value; S.trialCity = city.value; free.classList.toggle('hidden', sel.value !== '__free'); };
    [sel, kw, city].forEach((n) => n.addEventListener('input', sync)); sel.addEventListener('change', sync); sync();

    const run = el('button', { class: 'btn primary', type: 'button', disabled: S.trialBusy ? true : false, onclick: safe(async () => {
      sync(); S.trialBusy = true; S.trial = null; S.trialErr = ''; render();
      try { S.trial = await api('/articles/test', 'POST', sel.value === '__free' ? { keyword: kw.value, city: city.value } : { topicId: sel.value }); }
      catch (e) { S.trialErr = e.message; }
      S.trialBusy = false; render();
    }) }, icon('spark'), S.trialBusy ? 'Rédaction en cours...' : 'Rédiger un essai');

    const card = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Essayer un article'), el('button', { class: 'btn ghost', type: 'button', onclick: () => { S.trialOpen = false; S.trial = null; render(); } }, 'Fermer')),
      el('p', { class: 'muted' }, 'Rédige un article d\'essai pour juger la qualité, sans rien envoyer sur votre site et sans toucher au lot du mois. Il utilise le modèle et les consignes des réglages.'),
      el('label', { for: 'trial-topic' }, 'Sujet de l\'essai'), sel, free,
      el('div', { class: 'row btn-row' }, run),
      el('p', { class: 'muted small' }, demoOn() ? 'Mode démonstration : texte de test, aucun appel réel.' : 'Un essai coûte un appel à l\'IA (quelques centimes). Limite : 10 essais par jour.'));
    if (S.trialBusy) add(card, el('p', { class: 'muted small' }, 'Cela peut prendre jusqu\'à une minute. Vous pouvez rester sur cette page.'));
    if (S.trialErr) add(card, el('div', { class: 'alert mt' }, S.trialErr));
    if (S.trial) add(card, trialResult(S.trial));
    return card;
  }

  function trialResult(t) {
    const a = t.article;
    const preview = el('div', { class: 'preview' });
    preview.innerHTML = a.htmlContent; // HTML assaini côté serveur
    highlightMarkers(preview);
    const sent = t.sent || {};
    const markers = (a.htmlContent.match(/\[SOURCE A VERIFIER\]/g) || []).length;
    const box = el('div', { class: 'trial' },
      el('div', { class: 'row-between' }, el('h3', {}, 'Résultat de l\'essai'), el('span', { class: 'pill ' + (t.simulated ? 'warn' : 'ok') }, t.simulated ? 'Texte de démonstration' : 'Rédigé par l\'IA')),
      el('p', { class: 'muted small' }, `Sujet : ${t.topic.keyword}${t.topic.city ? ' à ' + t.topic.city : ''} · ${a.wordCount} mots · titre Google (${a.metaTitle.length}/60) · description (${a.metaDescription.length}/155)`),
      el('div', { class: 'card post' }, el('h2', {}, a.title), preview),
      markers ? el('div', { class: 'alert' }, `${markers} ${plural(markers, 'chiffre à sourcer', 'chiffres à sourcer')} (surlignés en jaune) : l'IA n'a pas le droit d'inventer, c'est normal.`) : null,
      a.warnings && a.warnings.length ? el('ul', { class: 'tasks' }, a.warnings.map((w) => el('li', {}, w))) : null,
      el('details', { class: 'faq' }, el('summary', {}, 'Ce qui a été envoyé à l\'IA'), el('div', { class: 'a' },
        el('p', { class: 'muted small' }, (t.simulated ? 'Mode démonstration : voici ce qui serait envoyé, rien n\'est réellement envoyé. ' : '') + 'Modèle : ' + (sent.model || '(aucun choisi)')),
        el('h3', {}, 'Message sur l\'entreprise et le sujet'), el('pre', { class: 'pre' }, sent.user || ''),
        el('h3', {}, 'Consignes de rédaction (modifiables dans Réglages, Rédaction)'), el('pre', { class: 'pre' }, sent.system || ''))),
      el('div', { class: 'row btn-row' },
        el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => {
          const r = await api('/articles/test/keep', 'POST', { trialId: t.trialId });
          S.trial = null; S.trialOpen = false; await refresh();
          toast(r.autoDraftError ? 'Article gardé, mais l\'envoi sur le site a échoué : ' + r.autoDraftError : 'Article gardé dans vos articles.', !!r.autoDraftError);
          go('article', r.article.id);
        }) }, 'Garder dans mes articles'),
        el('button', { class: 'btn', type: 'button', onclick: () => { S.trial = null; render(); } }, 'Ne pas garder')),
      el('p', { class: 'muted small' }, 'Si vous le gardez, il compte dans le lot du mois' + (t.trialsLeft != null && !t.simulated ? ` (il reste ${t.trialsLeft} essais aujourd'hui).` : '.')));
    return box;
  }

  function viewArticles() {
    const s = S.settings, b = S.batch, pl = S.plan;
    const demoCount = S.articles.filter((a) => a.simulated).length;
    const out = [head('Articles', `Objectif du mois : ${s.frequency} ${plural(s.frequency, 'article', 'articles')}. Déjà rédigés : ${pl.already}.`,
      el('div', { class: 'row' },
        el('button', { class: 'btn big', type: 'button', onclick: () => { S.trialOpen = !S.trialOpen; render(); } }, icon('file'), 'Essayer un article'),
        el('button', { class: 'btn primary big', type: 'button', disabled: b.running || pl.remaining <= 0 || !pl.next.length ? true : false, onclick: safe(startBatch) }, icon('spark'), 'Rédiger les articles du mois')))];

    out.push(el('div', { class: 'alert' + (s.autoDraft ? ' ok' : '') }, s.autoDraft
      ? 'Chaque article rédigé est envoyé automatiquement sur votre site en brouillon. Rien n\'est publié sans votre accord.'
      : 'Les articles restent ici jusqu\'à ce que vous les envoyiez vous-même sur le site.'));
    if (S.trialOpen) out.push(trialCard());
    out.push(planCard());

    if (b.running) {
      out.push(el('div', { class: 'card' }, el('h2', {}, 'Rédaction en cours...'),
        el('p', { class: 'muted' }, `${b.done} sur ${b.total} terminés. Cela peut prendre quelques minutes, vous pouvez rester sur cette page.`),
        el('div', { class: 'progress' }, (() => { const i = el('i'); i.style.width = Math.max(6, Math.round((b.done / Math.max(1, b.total)) * 100)) + '%'; return i; })())));
    }
    if (!b.running && b.errors.length) out.push(el('div', { class: 'card' }, el('h2', {}, 'Certains articles n\'ont pas pu être préparés'), el('ul', { class: 'tasks' }, b.errors.map((e) => el('li', {}, e)))));

    if (!demoOn() && demoCount) out.push(el('div', { class: 'alert' }, `${demoCount} ${plural(demoCount, 'article de démonstration reste', 'articles de démonstration restent')} dans la liste (créés avant le passage en mode réel). Ils n'existent pas sur votre site. `,
      el('button', { class: 'btn', type: 'button', onclick: safe(async () => { if (!confirm('Supprimer les articles de démonstration ? Cela ne touche pas à votre site.')) return; const r = await api('/articles/purge-demo', 'POST'); await refresh(); render(); toast(`${r.removed} supprimé${r.removed > 1 ? 's' : ''}.`); }) }, 'Les supprimer')));
    if (demoOn() && S.articles.some((a) => !a.simulated)) out.push(el('div', { class: 'alert' }, 'Vos articles réels sont visibles, mais ne peuvent être ni publiés ni supprimés tant que le mode démonstration est actif.'));

    const list = el('div', {});
    if (!S.articles.length) {
      list.append(el('div', { class: 'card empty' }, icon('file'), el('h3', {}, 'Aucun article pour l\'instant'),
        el('p', { class: 'muted' }, s.topics.length ? 'Cliquez sur « Rédiger les articles du mois », ou sur « Essayer un article » pour juger la qualité d\'abord.' : 'Ajoutez d\'abord des sujets dans les réglages.')));
    } else {
      S.articles.forEach((a) => {
        const [label, tone] = STATUS[a.status] || [a.status, ''];
        list.append(el('button', { class: 'art-row', type: 'button', onclick: () => go('article', a.id) },
          el('div', { class: 'grow' }, el('div', { class: 't' }, a.title), el('div', { class: 'm' }, a.keyword + (a.city ? ' à ' + a.city : '') + ' · ' + a.wordCount + ' mots · ' + fmtDate(a.createdAt))),
          a.simulated ? el('span', { class: 'pill' }, 'Démonstration') : null,
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
    const mismatch = !!a.simulated !== demoOn(); // créé dans l'autre mode (démonstration/réel)
    const actions = el('div', { class: 'card sticky' });
    const reload = async () => { await refresh(); render(); };
    if (mismatch && a.status !== 'publie') {
      add(actions, el('div', { class: 'alert' }, `Cet article a été créé en mode ${a.simulated ? 'démonstration' : 'réel'}. Pour le ${a.status === 'a_relire' ? 'envoyer' : 'publier'}, repassez en mode ${a.simulated ? 'démonstration' : 'réel'} (Réglages, Connexions).`));
    } else if (a.status === 'a_relire') {
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
    if (a.status !== 'publie' && (a.simulated || !mismatch)) {
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
    const s = { ...S.settings, ...patch };
    const payload = { frequency: Number(s.frequency), brandName: s.brandName, zone: s.zone, autoDraft: s.autoDraft };
    for (const k of ['aiModel', 'systemPrompt', 'simulate']) if (k in patch) payload[k] = patch[k];
    S.settings = await api('/settings', 'PUT', payload);
    S.status = await api('/status');
    await refreshPlan();
    if (msg) toast(msg);
  }
  // Clés et identifiants : on peut les remplacer ou les effacer, jamais les relire.
  async function saveSecrets(body, msg) {
    S.settings = await api('/secrets', 'PUT', body);
    S.status = await api('/status');
    if (msg) toast(msg);
  }
  S.settingsTab = 'general';
  S.msgs = {};
  const setMsg = (k, tone, text) => { S.msgs[k] = { tone, text }; };
  const msgBox = (k) => (S.msgs[k] ? el('div', { class: 'alert mt' + (S.msgs[k].tone === 'ok' ? ' ok' : '') }, S.msgs[k].text) : null);

  function secretState(st) {
    if (st.unreadable) return el('span', { class: 'pill ko' }, 'Illisible, à ressaisir');
    if (st.source === 'interface') return el('span', { class: 'pill ok' }, icon('check'), 'Enregistrée');
    if (st.source === 'serveur') return el('span', { class: 'pill ok' }, icon('check'), 'Fournie par le serveur');
    return el('span', { class: 'pill ko' }, 'Non renseignée');
  }
  const secretInput = (id, st, empty) => el('input', { type: 'password', id, autocomplete: 'new-password', spellcheck: 'false', placeholder: st.set ? '•••••••• enregistrée (vide = inchangée)' : empty });

  function tabsBar() {
    const items = [['general', 'Général'], ['connexions', 'Connexions'], ['ia', 'Rédaction']];
    return el('div', { class: 'seg', role: 'tablist' }, items.map(([id, label]) => el('button', { type: 'button', role: 'tab', class: S.settingsTab === id ? 'on' : '', 'aria-selected': S.settingsTab === id ? 'true' : 'false', onclick: () => { S.settingsTab = id; render(); } }, label)));
  }

  function viewSettings() {
    const t = S.settingsTab;
    return [head('Réglages', 'Tout se gère ici : le rythme, les sujets, la liaison avec votre site et la rédaction.'), tabsBar(),
      ...(t === 'connexions' ? settingsConnexions() : t === 'ia' ? settingsIa() : settingsGeneral())];
  }

  // ----- Général : rythme, sujets, publication, entreprise -----
  function settingsGeneral() {
    const s = S.settings;
    const freq = el('input', { type: 'range', min: 1, max: 8, step: 1, value: s.frequency, 'aria-label': 'Articles par mois' });
    const big = el('div', { class: 'freq-val' }, s.frequency, el('small', {}, plural(s.frequency, 'article par mois', 'articles par mois')));
    const hint = el('p', { class: 'muted small' }, freqHint(s.frequency));
    freq.addEventListener('input', () => { big.replaceChildren(freq.value, el('small', {}, plural(+freq.value, 'article par mois', 'articles par mois'))); hint.textContent = freqHint(+freq.value); });
    freq.addEventListener('change', safe(async () => { await saveSettings({ frequency: Number(freq.value) }, 'Fréquence enregistrée.'); }));

    const kw = el('input', { type: 'text', maxlength: 100, placeholder: 'Sujet, par exemple : alarme sans abonnement', 'aria-label': 'Sujet', required: true });
    const city = el('input', { type: 'text', maxlength: 60, placeholder: 'Ville (facultatif)', 'aria-label': 'Ville' });
    const topics = el('div', { class: 'chips' });
    if (!s.topics.length) topics.append(el('p', { class: 'muted' }, 'Aucun sujet pour l\'instant.'));
    s.topics.forEach((tp) => topics.append(el('div', { class: 'chip' }, el('div', { class: 'grow' }, el('b', {}, tp.keyword), tp.city ? ' à ' + tp.city : ''),
      el('button', { type: 'button', 'aria-label': 'Supprimer ce sujet', onclick: safe(async () => { S.settings = await api('/topics/' + tp.id, 'DELETE'); await refreshPlan(); render(); }) }, icon('trash')))));

    const brand = el('input', { type: 'text', maxlength: 60, value: s.brandName, id: 'brand' });
    const zone = el('input', { type: 'text', maxlength: 80, value: s.zone, id: 'zone' });
    const auto = el('input', { type: 'checkbox', checked: s.autoDraft ? true : false, id: 'auto', role: 'switch' });
    auto.addEventListener('change', safe(async () => { await saveSettings({ autoDraft: auto.checked }, auto.checked ? 'Envoi automatique activé.' : 'Envoi automatique désactivé.'); }));

    return [
      el('div', { class: 'card' }, el('h2', {}, 'Combien d\'articles par mois ?'), el('p', { class: 'muted' }, 'Déplacez le curseur. L\'outil ne rédigera jamais plus que ce nombre.'), big, freq, el('div', { class: 'scale' }, el('span', {}, '1'), el('span', {}, '8')), hint),
      el('div', { class: 'card' }, el('h2', {}, 'Vos sujets d\'articles'), el('p', { class: 'muted' }, 'Un sujet = un mot-clé que vous voulez travailler, avec une ville si utile.'),
        el('form', { class: 'row', onsubmit: safe(async (e) => { e.preventDefault(); S.settings = await api('/topics', 'POST', { keyword: kw.value, city: city.value }); await refreshPlan(); render(); }) }, kw, city, el('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Ajouter')), topics),
      el('div', { class: 'card' }, el('h2', {}, 'Publication sur le site'),
        el('div', { class: 'switch-row' }, el('div', {}, el('b', {}, 'Envoyer chaque article en brouillon, automatiquement'), el('p', { class: 'muted small' }, 'Le brouillon n\'est pas visible du public. Vous publiez vous-même, après relecture.')),
          el('label', { class: 'switch', for: 'auto', 'aria-label': 'Envoi automatique en brouillon' }, auto, el('span')))),
      el('div', { class: 'card' }, el('h2', {}, 'Votre entreprise'), el('p', { class: 'muted' }, 'Ces informations servent à rédiger les articles.'),
        el('label', { for: 'brand' }, 'Nom commercial'), brand, el('label', { for: 'zone' }, 'Zone desservie'), zone,
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { await saveSettings({ brandName: brand.value, zone: zone.value }, 'Informations enregistrées.'); }) }, 'Enregistrer'))),
    ];
  }

  // ----- Connexions : mise en route, mode démonstration, WordPress, PageSpeed -----
  function settingsConnexions() {
    const s = S.settings, st = S.status;
    const jump = (tab) => () => { S.settingsTab = tab; render(); };
    const wpOk = st.wordpress, keyOk = s.secrets.openrouterKey.set, modelOk = !!((s.aiModel || '').trim() || S.aiDefaults.envModel);
    const row = (ok, label, hintTxt, btn) => el('div', { class: 'conn' }, el('span', { class: 'dot-s ' + (ok ? 'ok' : 'nm') }, icon(ok ? 'check' : 'alert')),
      el('div', { class: 'grow' }, el('b', {}, label), el('div', { class: 'muted small' }, hintTxt)), btn || null);
    const setup = el('div', { class: 'card' }, el('h2', {}, 'Mise en route'), el('p', { class: 'muted' }, 'Quatre points pour passer du mode démonstration à l\'utilisation réelle.'),
      row(wpOk, 'Liaison avec WordPress', wpOk ? 'Identifiant et mot de passe renseignés.' : 'Identifiant et mot de passe d\'application à saisir plus bas.'),
      row(keyOk, 'Clé de rédaction (OpenRouter)', keyOk ? 'Clé renseignée.' : 'À saisir dans l\'onglet Rédaction.', keyOk ? null : el('button', { class: 'btn', type: 'button', onclick: jump('ia') }, 'Ouvrir Rédaction')),
      row(modelOk, 'Modèle d\'intelligence artificielle', modelOk ? 'Un modèle est choisi.' : 'À choisir dans l\'onglet Rédaction.', modelOk ? null : el('button', { class: 'btn', type: 'button', onclick: jump('ia') }, 'Ouvrir Rédaction')),
      row(!st.simulate, 'Mode réel activé', st.simulate ? 'Le mode démonstration est encore actif : aucun appel réel.' : 'Les vrais services sont utilisés. Rien n\'est publié sans votre validation.'));

    const demo = el('input', { type: 'checkbox', checked: st.simulate ? true : false, id: 'demo', role: 'switch' });
    demo.addEventListener('change', safe(async () => {
      if (!demo.checked && !confirm('Passer en mode réel ? Les articles seront rédigés avec votre clé OpenRouter et envoyés en brouillon sur votre site. Rien n\'est publié sans votre validation.')) { demo.checked = true; return; }
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
      el('p', { class: 'muted' }, 'Permet d\'envoyer les articles en brouillon sur votre site.'),
      el('details', { class: 'faq' }, el('summary', {}, 'Où trouver le mot de passe d\'application ?'), el('div', { class: 'a' },
        el('p', {}, 'À faire une fois, par un administrateur du site :'),
        el('ol', { class: 'tasks' }, [
          'Connectez-vous à WordPress, puis ouvrez Utilisateurs, Profil (idéalement un compte dédié avec le rôle Éditeur).',
          'Descendez jusqu\'à « Mots de passe d\'application », saisissez le nom « Tableau de bord CityLock », puis cliquez sur « Ajouter ».',
          'Copiez le mot de passe affiché (il ne s\'affiche qu\'une fois) et collez-le ci-dessous.'].map((x) => el('li', {}, x))),
        el('p', { class: 'muted small' }, 'Ce n\'est pas le mot de passe de connexion à WordPress. Si la section est absente, le site doit être en HTTPS et une extension de sécurité peut l\'avoir désactivée.'))),
      el('label', { for: 'wp-site' }, 'Adresse du site'), site, el('p', { class: 'muted small' }, 'Fixée sur le serveur, pour protéger vos identifiants.'),
      el('label', { for: 'wp-user' }, 'Identifiant WordPress'), user,
      el('label', { for: 'wp-pass' }, 'Mot de passe d\'application'), pass,
      st.simulate ? el('div', { class: 'alert mt' }, 'Le mode démonstration est actif : le test ne contacte pas votre site.') : null,
      el('div', { class: 'row btn-row' },
        el('button', { class: 'btn primary', type: 'button', onclick: saveTestWp }, 'Enregistrer et tester'),
        el('button', { class: 'btn', type: 'button', onclick: safe(async () => { await api('/category/ensure', 'POST'); toast('Catégorie « Blog » prête sur votre site.'); }) }, 'Préparer la catégorie « Blog »'),
        wpSec.source === 'interface' ? el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => {
          if (!confirm('Effacer le mot de passe enregistré ?')) return;
          await saveSecrets({ wpAppPassword: '' }, 'Mot de passe effacé.'); render();
        }) }, 'Effacer le mot de passe') : null),
      msgBox('wp'));

    // PageSpeed
    const psSec = s.secrets.pagespeedKey;
    const ps = secretInput('ps-key', psSec, 'Collez la clé Google PageSpeed');
    const psCard = el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Vitesse du site (facultatif)'), secretState(psSec)),
      el('p', { class: 'muted' }, 'Avec une clé Google PageSpeed Insights, le score mesure aussi la vitesse sur mobile. Sans clé, ce critère est simplement « non mesuré ».'),
      el('label', { for: 'ps-key' }, 'Clé PageSpeed'), ps,
      el('div', { class: 'row btn-row' },
        el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { if (!ps.value) { toast('Collez d\'abord la clé.', true); return; } await saveSecrets({ pagespeedKey: ps.value }, 'Clé PageSpeed enregistrée.'); render(); }) }, 'Enregistrer'),
        psSec.source === 'interface' ? el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => { await saveSecrets({ pagespeedKey: '' }, 'Clé effacée.'); render(); }) }, 'Effacer la clé') : null));

    return [setup, demoCard, wpCard, psCard,
      el('p', { class: 'muted small' }, 'Les clés saisies ici sont chiffrées sur le serveur et ne s\'affichent plus jamais. Sur l\'hébergement gratuit sans disque, elles sont effacées à un redémarrage : gardez aussi une copie dans les variables de l\'hébergeur.')];
  }

  // ----- Rédaction : clé OpenRouter, modèle, consignes -----
  function settingsIa() {
    const s = S.settings;
    const D = S.aiDefaults;
    const keySec = s.secrets.openrouterKey;
    const key = secretInput('or-key', keySec, 'Collez la clé OpenRouter');
    const rules = el('textarea', { id: 'rules', rows: 16, maxlength: D.maxLength, 'aria-label': 'Consignes de rédaction' });
    rules.value = s.systemPrompt || D.systemPrompt;
    const rulesCount = el('div', { class: 'count muted' });
    const updCount = () => { rulesCount.textContent = `${rules.value.length} caractères sur ${D.maxLength}` + (rules.value.trim() === D.systemPrompt.trim() ? ' · texte d\'origine' : ' · texte personnalisé'); };
    rules.addEventListener('input', updCount); updCount();
    const model = el('input', { type: 'text', id: 'model', maxlength: 99, value: s.aiModel || '', placeholder: D.envModel ? 'Par défaut : ' + D.envModel : 'Exemple : anthropic/claude-haiku-5-5', autocomplete: 'off', spellcheck: 'false' });
    const usedModel = s.aiModel || D.envModel;

    const saveAll = async () => {
      if (key.value) await saveSecrets({ openrouterKey: key.value });
      const text = rules.value.trim() === D.systemPrompt.trim() ? '' : rules.value;
      await saveSettings({ aiModel: model.value, systemPrompt: text });
    };
    return [
      el('div', { class: 'card' }, el('div', { class: 'row-between' }, el('h2', {}, 'Clé OpenRouter'), secretState(keySec)),
        el('p', { class: 'muted' }, 'OpenRouter est le service qui fait écrire les articles par l\'intelligence artificielle. Créez une clé sur openrouter.ai (menu Keys) et collez-la ici.'),
        el('label', { for: 'or-key' }, 'Clé OpenRouter'), key,
        keySec.hint ? el('p', { class: 'muted small' }, `Clé actuelle terminée par « ${keySec.hint} ».`) : null,
        el('p', { class: 'muted small' }, 'La clé est chiffrée sur le serveur et ne s\'affiche plus jamais. Pour en changer, collez la nouvelle.'),
        el('div', { class: 'row btn-row' }, el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { if (!key.value) { toast('Collez d\'abord la clé.', true); return; } await saveSecrets({ openrouterKey: key.value }, 'Clé OpenRouter enregistrée.'); render(); }) }, 'Enregistrer la clé'),
          keySec.source === 'interface' ? el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => { if (!confirm('Effacer la clé enregistrée ?')) return; await saveSecrets({ openrouterKey: '' }, 'Clé effacée.'); render(); }) }, 'Effacer la clé') : null)),
      el('div', { class: 'card' }, el('h2', {}, 'Modèle et consignes'),
        el('p', { class: 'muted' }, 'Choisissez le modèle d\'intelligence artificielle et les consignes qu\'il doit suivre pour écrire vos articles.'),
        el('label', { for: 'model' }, 'Modèle OpenRouter'), model,
        el('p', { class: 'muted small' }, usedModel ? `Modèle utilisé aujourd'hui : ${usedModel}${s.aiModel ? '' : ' (celui du serveur)'}.` : 'Aucun modèle choisi pour l\'instant.'),
        el('p', { class: 'muted small' }, 'Copiez l\'identifiant exact depuis openrouter.ai/models, par exemple anthropic/claude-haiku-5-5. Laissez vide pour utiliser celui du serveur.'),
        el('label', { for: 'rules' }, 'Consignes de rédaction'), rules, rulesCount,
        el('div', { class: 'alert mt' }, 'Gardez les règles 2 et 3 (ne jamais inventer de chiffres, ne jamais promettre un classement) : elles évitent d\'afficher de fausses informations sur votre site. Le format de réponse technique est ajouté automatiquement, ne le décrivez pas ici.'),
        el('div', { class: 'row btn-row' },
          el('button', { class: 'btn primary', type: 'button', onclick: safe(async () => { await saveAll(); setMsg('ia', 'ok', 'Modèle et consignes enregistrés.'); render(); }) }, 'Enregistrer'),
          el('button', { class: 'btn', type: 'button', onclick: safe(async () => {
            await saveAll(); setMsg('ia', 'ko', 'Test en cours...'); render();
            try { const r = await api('/ai/test', 'POST'); setMsg('ia', 'ok', r.simulated ? 'Mode démonstration : aucun test réel. Désactivez-le dans Connexions pour tester le vrai modèle.' : `Le modèle ${r.model} répond correctement.`); } catch (e) { setMsg('ia', 'ko', e.message); }
            render();
          }) }, 'Enregistrer et tester'),
          el('button', { class: 'btn danger', type: 'button', onclick: safe(async () => {
            if (!confirm('Revenir au texte d\'origine des consignes ? Vos modifications seront perdues.')) return;
            await saveSettings({ systemPrompt: '' }); setMsg('ia', 'ok', 'Consignes d\'origine rétablies.'); render();
          }) }, 'Rétablir le texte d\'origine')),
        msgBox('ia'),
        el('p', { class: 'muted small' }, 'Sur l\'hébergement gratuit, ces réglages peuvent être réinitialisés lors d\'un redémarrage du serveur : gardez une copie de vos consignes.')),
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
      faq('Comment relier mon site WordPress ?', 'Dans « Réglages », onglet « Connexions », suivez la carte « Liaison avec WordPress » : un administrateur crée un mot de passe d\'application dans WordPress, puis vous collez l\'identifiant et ce mot de passe, et vous cliquez sur « Enregistrer et tester ». Un message vert confirme que ça marche.', 'La carte « Mise en route » en haut de l\'onglet vous indique ce qu\'il reste à faire.'),
      faq('Comment changer le modèle ou les consignes de rédaction ?', 'Dans « Réglages », onglet « Rédaction » : collez la clé OpenRouter, indiquez l\'identifiant du modèle (à copier depuis openrouter.ai/models) et modifiez les consignes si besoin, puis cliquez sur « Enregistrer et tester ». Le bouton « Rétablir le texte d\'origine » remet les consignes de départ.'),
      faq('À quoi sert « Essayer un article » ?', 'Dans « Articles », ce bouton rédige un article d\'essai pour juger la qualité, sans rien envoyer sur votre site et sans toucher au lot du mois. Vous voyez le texte, les chiffres à vérifier, et exactement ce qui a été envoyé à l\'IA (sujet, ville, consignes). Si le résultat vous plaît, « Garder dans mes articles » le range dans la liste.'),
      faq('Les sujets sont-ils bien pris en compte ?', 'Oui : dans « Articles », la carte « Ce qui sera rédigé » liste les sujets du prochain lot, dans l\'ordre. Chaque article est rédigé pour un sujet (mot-clé et ville). Un sujet déjà utilisé ce mois-ci n\'est pas repris avant le mois suivant.'),
      faq('Pourquoi « entreprise locale » est à 0 alors que ma fiche Google est complète ?', 'Ce sont deux choses différentes. La fiche Google Business Profile (horaires, avis, photos, services) est gérée sur Google. Le score, lui, lit le code de la page d\'accueil de votre site, et cherche une déclaration « entreprise locale » (LocalBusiness). Elle peut manquer même si votre fiche Google est parfaite. Le détail du critère indique les types trouvés sur votre accueil.'),
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
