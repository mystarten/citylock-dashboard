// Faux site WordPress local pour les tests : pages, sitemap, robots.txt et API REST minimale.
const express = require('express');

function page({ title, meta, h1 = 1, imgs = [], ld = null, words = 350, links = [] }) {
  const body = Array.from({ length: words }, (_, i) => `mot${i}`).join(' ');
  return `<!doctype html><html><head>${title != null ? `<title>${title}</title>` : ''}${meta ? `<meta name="description" content="${meta}">` : ''}` +
    `${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}</head><body><nav>${links.map((l) => `<a href="${l}">lien</a>`).join('')}</nav>` +
    `<main>${'<h1>Titre</h1>'.repeat(h1)}<p>${body}</p>${imgs.map((a) => `<img src="/i.png" alt="${a}">`).join('')}</main></body></html>`;
}

function create({ robots = true } = {}) {
  const app = express();
  const wpPosts = new Map();
  const wpCats = [];
  let nextId = 100;

  app.get('/sitemap_index.xml', (req, res) => res.type('xml').send('<sitemapindex><sitemap><loc>http://HOST/sub.xml</loc></sitemap></sitemapindex>'.replace(/HOST/g, req.headers.host)));
  app.get('/sub.xml', (req, res) => res.type('xml').send(`<urlset>${['/', '/services/', '/orphan/', '/hello-world/', '/gone/'].map((p) => `<url><loc>http://${req.headers.host}${p}</loc></url>`).join('')}</urlset>`));
  app.get('/robots.txt', (req, res) => res.type('text').send(robots ? `User-agent: *\nSitemap: http://${req.headers.host}/sitemap_index.xml\n` : 'User-agent: *\n'));

  const T40 = 'Alarme Ajax sans abonnement a Chatou 78';
  app.get('/', (req, res) => res.send(page({ title: T40, meta: 'm'.repeat(130), imgs: ['logo', ''], ld: { '@graph': [{ '@type': 'LocalBusiness' }] }, links: ['/services/', '/hello-world/', '/lien-mort/', 'https://autre-site.test/x', 'mailto:a@b.fr'] })));
  app.get('/services/', (req, res) => res.send(page({ title: 'Services', meta: 'court', h1: 2, words: 120 })));
  app.get('/orphan/', (req, res) => res.send(page({ title: T40, meta: 'm'.repeat(140) })));
  app.get('/hello-world/', (req, res) => res.send(page({ title: 'Hello world', meta: 'm'.repeat(140), imgs: ['x'] })));
  // /gone/ et /lien-mort/ : 404 par défaut

  // API REST WordPress minimale (authentification Basic obligatoire)
  const needAuth = (req, res, next) => {
    const exp = 'Basic ' + Buffer.from('laurent:abcd efgh').toString('base64');
    if (req.headers.authorization !== exp) return res.status(401).json({ code: 'rest_forbidden' });
    next();
  };
  app.use('/wp-json/wp/v2', express.json(), needAuth);
  app.get('/wp-json/wp/v2/users/me', (req, res) => res.json({ name: 'Laurent', capabilities: { edit_posts: true, publish_posts: true } }));
  app.get('/wp-json/wp/v2/categories', (req, res) => res.json(wpCats));
  app.post('/wp-json/wp/v2/categories', (req, res) => { const c = { id: 7, ...req.body }; wpCats.push(c); res.status(201).json(c); });
  app.post('/wp-json/wp/v2/posts', (req, res) => { const p = { id: ++nextId, link: `http://x/?p=${nextId}`, ...req.body }; wpPosts.set(p.id, p); res.status(201).json(p); });
  app.get('/wp-json/wp/v2/posts/:id', (req, res) => (wpPosts.has(+req.params.id) ? res.json({ ...wpPosts.get(+req.params.id), content: { raw: wpPosts.get(+req.params.id).content } }) : res.status(404).json({ code: 'rest_post_invalid_id' })));
  app.post('/wp-json/wp/v2/posts/:id', (req, res) => { const p = wpPosts.get(+req.params.id); Object.assign(p, req.body); res.json(p); });
  app.delete('/wp-json/wp/v2/posts/:id', (req, res) => { wpPosts.delete(+req.params.id); res.json({ deleted: true }); });

  return { app, wpPosts, wpCats };
}

module.exports = { create };
