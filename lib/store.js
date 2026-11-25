// Stockage JSON local (pas de base de données). Écriture atomique.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const DEFAULTS = {
  'settings.json': { frequency: 2, zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', topics: [], blogCategoryId: null, autoDraft: true, aiModel: '', aiModelPrevious: '', systemPrompt: '', wpUser: '', secrets: {},
  publishMode: 'brouillon', publishPaused: false, autoPublishDelayDays: 3, autoPublishMaxPerWeek: 2 },
  'audits.json': [],
  'articles.json': [],
  'publications.json': [],
};

function file(name) {
  return path.join(DATA_DIR, name);
}

function read(name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Fichier ${name} illisible : ${e.message}`);
    return JSON.parse(JSON.stringify(DEFAULTS[name]));
  }
}

function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

module.exports = {
  DATA_DIR,
  getSettings: () => ({ ...DEFAULTS['settings.json'], ...read('settings.json') }),
  saveSettings: (v) => write('settings.json', v),
  getAudits: () => read('audits.json'),
  saveAudits: (v) => write('audits.json', v),
  getArticles: () => read('articles.json'),
  saveArticles: (v) => write('articles.json', v),
  getPublications: () => read('publications.json'),
  savePublications: (v) => write('publications.json', v),
};
