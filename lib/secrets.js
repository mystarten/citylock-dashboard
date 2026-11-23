// Clés saisies dans l'interface : chiffrées (AES-256-GCM) avec une clé dérivée de SESSION_SECRET,
// jamais renvoyées au navigateur. Une valeur de l'interface prend le pas sur la variable d'environnement.
const crypto = require('crypto');
const store = require('./store');
const log = require('./log');

const ENV_NAMES = { openrouterKey: 'OPENROUTER_API_KEY', wpAppPassword: 'WP_APP_PASSWORD', pagespeedKey: 'PAGESPEED_API_KEY' };
let keyCache = null;

function key() {
  if (!keyCache) keyCache = crypto.scryptSync(process.env.SESSION_SECRET, 'citylock-secrets-v1', 32);
  return keyCache;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['enc1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(blob) {
  try {
    const [v, iv, tag, data] = String(blob).split(':');
    if (v !== 'enc1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

const stored = (name) => { const b = (store.getSettings().secrets || {})[name]; return b ? decrypt(b) : null; };

function get(name) {
  return stored(name) || process.env[ENV_NAMES[name]] || '';
}

function set(name, value) {
  if (!ENV_NAMES[name]) throw new Error('Clé inconnue.');
  const s = store.getSettings();
  s.secrets = s.secrets || {};
  if (value) s.secrets[name] = encrypt(value); else delete s.secrets[name];
  store.saveSettings(s);
}

// État affiché dans l'interface : jamais la valeur elle-même.
function status() {
  const raw = store.getSettings().secrets || {};
  const out = {};
  for (const name of Object.keys(ENV_NAMES)) {
    const own = stored(name);
    const env = process.env[ENV_NAMES[name]] || '';
    out[name] = {
      set: !!(own || env),
      source: own ? 'interface' : env ? 'serveur' : null,
      unreadable: !!raw[name] && !own, // enregistrée mais illisible (SESSION_SECRET changé)
      hint: name === 'openrouterKey' && (own || env).length >= 16 ? (own || env).slice(-4) : '',
    };
  }
  return out;
}

// Les journaux masquent aussi les clés de l'interface.
log.setSecretsProvider(() => {
  const vals = Object.keys(ENV_NAMES).map(get).filter(Boolean);
  const user = (store.getSettings().wpUser || '').trim() || process.env.WP_USER || '';
  const pass = get('wpAppPassword');
  if (user && pass) vals.push(Buffer.from(`${user}:${pass}`).toString('base64'));
  return vals;
});

module.exports = { get, set, status, encrypt, decrypt };
