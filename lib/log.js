// Journalisation avec masquage des secrets.
const SECRET_VARS = ['OPENROUTER_API_KEY', 'WP_APP_PASSWORD', 'PAGESPEED_API_KEY', 'DASHBOARD_PASSWORD', 'SESSION_SECRET'];

let extraSecrets = () => [];
const setSecretsProvider = (fn) => { extraSecrets = fn; };

function redact(input) {
  let s = String(input);
  try { for (const v of extraSecrets()) if (v && v.length >= 4) s = s.split(v).join('[masqué]'); } catch { /* ne jamais casser un journal */ }
  for (const k of SECRET_VARS) {
    const v = process.env[k];
    if (v && v.length >= 4) s = s.split(v).join('[masqué]');
  }
  const u = process.env.WP_USER;
  const p = process.env.WP_APP_PASSWORD;
  if (u && p) s = s.split(Buffer.from(`${u}:${p}`).toString('base64')).join('[masqué]');
  return s.replace(/([?&]key=)[^&\s"']+/g, '$1[masqué]').replace(/Bearer\s+\S+/g, 'Bearer [masqué]');
}

function log(level, message, err) {
  const parts = [new Date().toISOString(), level.toUpperCase(), message];
  if (err) parts.push(err && err.message ? err.message : String(err));
  const line = redact(parts.join(' '));
  (level === 'error' ? console.error : console.log)(line);
}

module.exports = {
  redact,
  setSecretsProvider,
  info: (m) => log('info', m),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
};
