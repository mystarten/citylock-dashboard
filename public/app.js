// Interface du tableau de bord. Aucune clé ici : tout passe par l'API du serveur.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let settings = null;
  let toastTimer = null;
  let polling = null;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* vide */ }
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Session expirée.'); }
    if (!res.ok) throw new Error(data.error || 'Erreur.');
    return data;
  }

  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
  }
  const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // --- Navigation / connexion ---
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'articles') loadArticles();
    if (name === 'score') loadAudit();
  }
  function showLogin() {
    document.querySelectorAll('.tab').forEach((s) => s.classList.add('hidden'));
    $('tabs').classList.add('hidden');
    $('logout').classList.add('hidden');
    $('login').classList.remove('hidden');
  }
  async function showApp() {
    $('login').classList.add('hidden');
    $('tabs').classList.remove('hidden');
    $('logout').classList.remove('hidden');
    const st = await api('/status');
    $('sim').classList.toggle('hidden', !st.simulate);
    if (st.supportContact) $('help-contact').textContent = 'Contactez : ' + st.supportContact;
    settings = await api('/settings');
    renderSettings();
    showTab('settings');
  }

  // --- Réglages ---
  function renderSettings() {
    $('freq').value = settings.frequency;
    $('freq-val').textContent = settings.frequency;
    $('brand').value = settings.brandName;
    $('zone').value = settings.zone;
    const ul = $('topics');
    ul.replaceChildren();
    if (!settings.topics.length) ul.append(el('li', { class: 'muted' }, 'Aucun sujet pour l\'instant.'));
    for (const t of settings.topics) {
      ul.append(el('li', {}, el('span', {}, el('strong', {}, t.keyword), t.city ? ' (' + t.city + ')' : ''),
        el('button', { class: 'btn danger', type: 'button', onclick: run(async () => { settings = await api('/topics/' + t.id, 'DELETE'); renderSettings(); }) }, 'Supprimer')));
    }
  }

  // --- Articles ---
  const STATUS = { a_relire: ['À relire', ''], brouillon_wp: ['Brouillon WordPress', 'draft'], publie: ['Publié', 'pub'] };

  async function loadArticles() {
    const list = await api('/articles');
    settings = await api('/settings');
    const month = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const used = list.filter((a) => a.month === month).length;
    $('batch-info').textContent = `Fréquence réglée : ${settings.frequency} article(s) par mois. Déjà rédigés ce mois-ci : ${used}.`;
    const box = $('articles');
    box.replaceChildren();
    if (!list.length) box.append(el('p', { class: 'muted' }, 'Aucun article pour l\'instant.'));
    for (const a of list) box.append(articleCard(a));
  }

  function articleCard(a) {
    const [label, cls] = STATUS[a.status] || [a.status, ''];
    const body = el('div', { class: 'hidden' });
    const card = el('div', { class: 'card' },
      el('div', { class: 'art' }, el('div', {}, el('strong', {}, a.title), ' ', el('span', { class: 'badge ' + cls }, label), a.simulated ? el('span', { class: 'badge' }, 'simulation') : null),
        el('button', { class: 'btn secondary', type: 'button', onclick: () => body.classList.toggle('hidden') }, 'Relire')),
      body);
    fillReview(body, a);
    return card;
  }

  function fillReview(body, a) {
    body.append(
      el('h3', {}, 'Meta titre (' + a.metaTitle.length + ' caractères)'), el('div', { class: 'meta-box' }, a.metaTitle),
      el('h3', {}, 'Meta description (' + a.metaDescription.length + ' caractères)'), el('div', { class: 'meta-box' }, a.metaDescription),
      el('p', { class: 'muted' }, 'Adresse : /' + a.slug + ' | ' + a.wordCount + ' mots | mot-clé : ' + a.keyword + (a.city ? ' (' + a.city + ')' : '')));
    if (a.warnings && a.warnings.length) body.append(el('h3', { class: 'warn' }, 'Points d\'attention'), el('ul', {}, a.warnings.map((w) => el('li', { class: 'warn' }, w))));
    body.append(el('h3', {}, 'Faits à vérifier'));
    body.append(a.faitsAVerifier.length ? el('ul', {}, a.faitsAVerifier.map((f) => el('li', {}, f))) : el('p', { class: 'muted' }, 'Aucun fait signalé par le modèle. Relisez quand même chaque affirmation.'));
    if (a.internalLinkSuggestions.length) body.append(el('h3', {}, 'Pages du site à lier'), el('ul', {}, a.internalLinkSuggestions.map((l) => el('li', {}, l))));
    body.append(el('h3', {}, 'Aperçu du texte'));
    const prev = el('div', { class: 'preview' });
    prev.innerHTML = a.htmlContent; // HTML assaini côté serveur (balises autorisées uniquement)
    body.append(el('h2', {}, a.title), prev);

    const actions = el('div', { class: 'actions' });
    const reload = () => loadArticles();
    if (a.status === 'a_relire') {
      actions.append(el('button', { class: 'btn', type: 'button', onclick: run(async () => { await api(`/articles/${a.id}/send`, 'POST'); toast('Brouillon créé dans WordPress.'); reload(); }) }, 'Envoyer en brouillon WordPress'));
    }
    if (a.status === 'brouillon_wp') {
      const chk = el('input', { type: 'checkbox', id: 'v-' + a.id });
      const pub = el('button', { class: 'btn', type: 'button', disabled: true, onclick: run(async () => { await api(`/articles/${a.id}/publish`, 'POST', { validated: true }); toast('Article publié.'); reload(); }) }, 'Publier');
      chk.addEventListener('change', () => { pub.disabled = !chk.checked; });
      actions.append(el('label', {}, chk, 'J\'ai relu et validé'), pub);
    }
    if (a.wpLink) actions.append(el('span', { class: 'muted' }, 'Lien WordPress : ' + a.wpLink));
    if (a.status !== 'publie') {
      actions.append(el('button', { class: 'btn danger', type: 'button', onclick: run(async () => {
        if (!confirm(a.status === 'brouillon_wp' ? 'Supprimer ce brouillon, aussi dans WordPress ?' : 'Supprimer cet article ?')) return;
        await api('/articles/' + a.id, 'DELETE'); toast('Supprimé.'); reload();
      }) }, 'Supprimer ce brouillon'));
    }
    body.append(actions);
  }

  async function pollBatch() {
    const s = await api('/articles/batch/status');
    if (s.running) {
      $('batch-status').textContent = `Rédaction en cours : ${s.done} sur ${s.total}. Cela peut prendre quelques minutes.`;
      $('gen-batch').disabled = true;
      polling = setTimeout(run(pollBatch), 3000);
    } else {
      $('gen-batch').disabled = false;
      $('batch-status').textContent = s.errors.length ? 'Erreurs : ' + s.errors.join(' | ') : (s.total ? 'Lot terminé.' : '');
      loadArticles();
    }
  }

  // --- Score SEO ---
  async function loadAudit() {
    const d = await api('/audits');
    renderAudit(d);
    $('run-audit').disabled = d.status.running;
    if (d.status.running) { $('audit-status').textContent = 'Audit en cours, cela peut durer quelques minutes...'; clearTimeout(polling); polling = setTimeout(run(loadAudit), 4000); }
    else $('audit-status').textContent = d.status.lastError ? 'Dernier audit en échec : ' + d.status.lastError : '';
  }

  function renderAudit(d) {
    const a = d.latest;
    $('score-num').textContent = a ? a.score : '--';
    $('score-meta').textContent = a ? `Dernier audit : ${fmtDate(a.date)} (${a.trigger}), ${a.pagesCount} page(s) analysée(s).${a.truncated ? ' Analyse limitée aux premières pages.' : ''}` : 'Aucun audit pour l\'instant.';
    const imp = $('improvements');
    imp.replaceChildren();
    if (a && a.improvements.length) a.improvements.forEach((i) => imp.append(el('li', {}, el('strong', {}, i.label + ' : +' + i.gain + ' pt(s) possibles'), el('br'), i.explanation)));
    else imp.append(el('li', { class: 'muted' }, a ? 'Rien à améliorer sur les critères mesurés.' : 'Lancez un audit.'));

    const hist = $('history');
    hist.replaceChildren(el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Score'), el('th', {}, 'Lancement')));
    d.history.slice().reverse().slice(0, 12).forEach((h) => hist.append(el('tr', {}, el('td', {}, fmtDate(h.date)), el('td', {}, h.score + ' / 100'), el('td', {}, h.trigger))));
    drawChart(d.history.slice(-26));

    const box = $('criteria');
    box.replaceChildren();
    if (!a) return;
    a.criteria.forEach((c) => {
      const nm = c.points == null;
      const cls = nm ? 'nm' : c.points >= c.max ? 'ok' : 'ko';
      box.append(el('div', { class: 'crit' },
        el('div', { class: 'crit-head' }, el('span', {}, c.label), el('span', { class: 'pts ' + cls }, nm ? 'non mesuré' : `${c.points} / ${c.max}`)),
        nm ? null : el('div', { class: 'bar' }, (() => { const i = el('i'); i.style.width = Math.round((c.points / c.max) * 100) + '%'; return i; })()),
        el('div', { class: 'muted' }, 'Mesuré : ' + c.measured),
        el('div', {}, c.explanation),
        c.details && c.details.length ? el('ul', {}, c.details.map((x) => el('li', {}, x.url + ' : ' + x.why))) : null));
    });
  }

  function drawChart(points) {
    const box = $('chart');
    box.replaceChildren();
    if (points.length < 2) { box.append(el('p', { class: 'muted' }, 'La courbe apparaît à partir de deux audits.')); return; }
    const NS = 'http://www.w3.org/2000/svg';
    const W = 600, H = 160, P = 28;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'chart');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Courbe des scores SEO');
    const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text) n.textContent = text; svg.append(n); return n; };
    const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
    const y = (s) => H - P - (s / 100) * (H - 2 * P);
    [0, 50, 100].forEach((g) => { mk('line', { class: 'grid', x1: P, x2: W - P, y1: y(g), y2: y(g) }); mk('text', { x: 2, y: y(g) + 4 }, g); });
    mk('polyline', { class: 'line', points: points.map((p, i) => `${x(i)},${y(p.score)}`).join(' ') });
    points.forEach((p, i) => mk('circle', { class: 'dot', cx: x(i), cy: y(p.score), r: 4 }));
    box.append(svg);
  }

  // --- Evénements ---
  $('login-form').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    await api('/login', 'POST', { username: $('user').value, password: $('pw').value, remember: $('remember').checked });
    $('pw').value = '';
    await showApp();
  }));
  $('logout').addEventListener('click', run(async () => { await api('/logout', 'POST'); showLogin(); }));
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) { clearTimeout(polling); showTab(b.dataset.tab); } });
  $('freq').addEventListener('input', () => { $('freq-val').textContent = $('freq').value; });
  $('freq').addEventListener('change', run(saveSettings));
  $('save-settings').addEventListener('click', run(saveSettings));
  async function saveSettings() {
    settings = await api('/settings', 'PUT', { frequency: Number($('freq').value), brandName: $('brand').value, zone: $('zone').value });
    renderSettings();
    toast('Réglages enregistrés.');
  }
  $('topic-form').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    settings = await api('/topics', 'POST', { keyword: $('t-kw').value, city: $('t-city').value });
    $('t-kw').value = ''; $('t-city').value = '';
    renderSettings();
  }));
  $('ensure-cat').addEventListener('click', run(async () => { const r = await api('/category/ensure', 'POST'); $('cat-result').textContent = ' Catégorie prête (n° ' + r.id + ').'; }));
  $('gen-batch').addEventListener('click', run(async () => {
    await api('/articles/batch', 'POST');
    $('gen-batch').disabled = true;
    await pollBatch();
  }));
  $('run-audit').addEventListener('click', run(async () => { await api('/audit/run', 'POST'); $('run-audit').disabled = true; setTimeout(run(loadAudit), 800); }));

  (async () => {
    try {
      const s = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json());
      if (s.authenticated) await showApp(); else showLogin();
    } catch { showLogin(); }
  })();
})();
