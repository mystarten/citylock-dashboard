// Authentification par mot de passe unique, cookie signé (HMAC), sans dépendance.
const crypto = require('crypto');

const COOKIE = 'cl_session';
const SESSION_MS = 12 * 3600 * 1000;      // sans « se souvenir de moi »
const REMEMBER_MS = 30 * 24 * 3600 * 1000; // avec « se souvenir de moi » : 30 jours
const attempts = new Map(); // ip -> {count, first}

function sign(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return a.count >= 5;
}

function login(req, res, username, password, remember) {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return { ok: false, status: 429, error: 'Trop de tentatives. Réessayez dans 15 minutes.' };
  const userOk = typeof username === 'string' && safeEqual(username.trim(), process.env.DASHBOARD_USER || '');
  const passOk = typeof password === 'string' && safeEqual(password, process.env.DASHBOARD_PASSWORD || '');
  if (!userOk || !passOk) {
    const a = attempts.get(ip) || { count: 0, first: Date.now() };
    a.count += 1;
    attempts.set(ip, a);
    return { ok: false, status: 401, error: 'Identifiant ou mot de passe incorrect.' };
  }
  attempts.delete(ip);
  const maxAge = remember ? REMEMBER_MS : SESSION_MS;
  const exp = String(Date.now() + maxAge);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge, path: '/',
  });
  return { ok: true };
}

function logout(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Connexion requise.' });
}

module.exports = { isAuthenticated, login, logout, requireAuth };
