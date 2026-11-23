// Mode démonstration : réglage de l'interface s'il existe, sinon variable SIMULATE du serveur.
const store = require('./store');

function isSimulated() {
  const s = store.getSettings();
  if (typeof s.simulate === 'boolean') return s.simulate;
  return process.env.SIMULATE === 'true';
}

module.exports = { isSimulated };
