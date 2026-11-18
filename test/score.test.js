const test = require('node:test');
const assert = require('node:assert');
const { computeScore, isOffTopic } = require('../lib/scoring');

const t = (n, c = 'a') => c.repeat(n);
const dataset = (extra = {}) => ({
  pages: [
    { url: 'https://x.test/', isHome: true, title: t(40, 'a'), metaDescription: t(130), h1Count: 1, images: { total: 2, withAlt: 2 }, jsonLdTypes: ['LocalBusiness'], words: 500 },
    { url: 'https://x.test/p2/', title: '', metaDescription: t(100), h1Count: 2, images: { total: 2, withAlt: 1 }, jsonLdTypes: [], words: 400 },
    { url: 'https://x.test/p3/', title: t(20, 'b'), metaDescription: t(140), h1Count: 1, images: { total: 0, withAlt: 0 }, jsonLdTypes: [], words: 200 },
    { url: 'https://x.test/p4/', title: t(40, 'c'), metaDescription: t(150), h1Count: 1, images: { total: 1, withAlt: 1 }, jsonLdTypes: [], words: 350 },
  ],
  sitemapUrls: ['https://x.test/', 'https://x.test/p2/', 'https://x.test/p3/', 'https://x.test/p4/'],
  sitemapCount: 3,
  orphans: ['https://x.test/p3/'],
  links: { checked: 20, broken: [{ url: 'https://x.test/a', status: 404 }, { url: 'https://x.test/b', status: 500 }] },
  robotsHasSitemap: true,
  speed: null,
  ...extra,
});
const pts = (r, id) => r.criteria.find((c) => c.id === id).points;

test('points par critère sur le jeu de test (calculés à la main)', () => {
  const r = computeScore(dataset());
  assert.strictEqual(pts(r, 'title'), 5);
  assert.strictEqual(pts(r, 'meta'), 7.5);
  assert.strictEqual(pts(r, 'h1'), 7.5);
  assert.strictEqual(pts(r, 'alt'), 8);
  assert.strictEqual(pts(r, 'localbusiness'), 10);
  assert.strictEqual(pts(r, 'broken'), 9);
  assert.strictEqual(pts(r, 'orphans'), 6.7);
  assert.strictEqual(pts(r, 'thin'), 7.5);
  assert.strictEqual(pts(r, 'robots'), 5);
  assert.strictEqual(pts(r, 'offtopic'), 5);
});

test('vitesse non mesurée : non comptée, score ramené sur 90', () => {
  const r = computeScore(dataset());
  assert.strictEqual(r.maxCounted, 90);
  assert.strictEqual(r.criteria.find((c) => c.id === 'speed').notMeasured, true);
  assert.strictEqual(r.score, 79); // 71,2 / 90
});

test('vitesse : 95 donne 10 pts, 60 donne 5 pts, 30 donne 0', () => {
  assert.strictEqual(computeScore(dataset({ speed: { score: 95 } })).score, 81);
  assert.strictEqual(computeScore(dataset({ speed: { score: 60 } })).score, 76);
  assert.strictEqual(computeScore(dataset({ speed: { score: 30 } })).score, 71);
});

test('titres en double pénalisés', () => {
  const d = dataset();
  d.pages[3].title = d.pages[0].title;
  assert.strictEqual(pts(computeScore(d), 'title'), 0); // accueil et p4 en double + p2 et p3 non conformes
});

test('les 5 améliorations sont triées par gain décroissant', () => {
  const r = computeScore(dataset());
  assert.deepStrictEqual(r.improvements.map((i) => i.id), ['title', 'orphans', 'meta', 'h1', 'thin']);
});

test('site parfait = 100', () => {
  const d = dataset({ orphans: [], links: { checked: 5, broken: [] } });
  d.pages.forEach((p, i) => Object.assign(p, { title: t(40, 'abcd'[i]), metaDescription: t(140), h1Count: 1, images: { total: 1, withAlt: 1 }, words: 600 }));
  d.pages[0].jsonLdTypes = ['LocalBusiness'];
  assert.strictEqual(computeScore({ ...d, speed: { score: 99 } }).score, 100);
});

test('détection de pages de démonstration', () => {
  assert.ok(isOffTopic('https://x.test/hello-world/', ''));
  assert.ok(isOffTopic('https://x.test/page-d-exemple/', ''));
  assert.ok(isOffTopic('https://x.test/ok/', 'Hello world'));
  assert.strictEqual(isOffTopic('https://x.test/alarme-ajax-chatou/', 'Alarme Ajax à Chatou'), null);
});
