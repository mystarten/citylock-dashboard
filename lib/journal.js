// Journal des publications et des programmations : date, heure, titre, adresse.
const crypto = require('crypto');
const store = require('./store');
const log = require('./log');

const getLog = () => store.getPublications();

function logEvent(a, kind, extra = {}, now = new Date()) {
  const entry = { id: crypto.randomUUID(), at: now.toISOString(), kind, title: a.title, url: a.wpLink || '', articleId: a.id, ...(a.simulated ? { simulated: true } : {}), ...extra };
  store.savePublications([...getLog(), entry].slice(-500));
  log.info(`${kind === 'programmation' ? 'Programmation' : kind === 'annulation' ? 'Annulation de la programmation' : 'Publication'} : « ${a.title} » ${a.wpLink || ''}`);
  return entry;
}

module.exports = { getLog, logEvent };
