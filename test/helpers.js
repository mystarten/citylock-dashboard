// Outils partagés par les tests d'API : serveur sur un port libre, client avec connexion, texte de n mots.
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

// Client HTTP déjà connecté (cookie conservé). Retourne { status, json }.
async function client(server, { user = 'laurent-test', password = 'mdp-de-test-123' } = {}) {
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, extraHeaders = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'citylock', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* pas de corps */ }
    return { status: res.status, json };
  };
  await call('POST', '/api/login', { username: user, password });
  return call;
}

// Texte de n mots en paragraphes de 40 mots (aucun mot interdit).
const bodyWords = (n) => Array.from({ length: Math.ceil(n / 40) }, (_, i) => `<p>${Array.from({ length: Math.min(40, n - i * 40) }, (__, j) => `mot${i * 40 + j}`).join(' ')}</p>`).join('');

module.exports = { listen, client, bodyWords };
