// Stockage JSON local (pas de base de données). Écriture atomique.
const fs = require('fs');
const path = require('path');
const DEFAULT_PROMPT = require('./defaultRules');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const DEFAULTS = {
  'settings.json': { zone: 'Chatou, Yvelines', brandName: 'CITYLOCK', topics: [], blogCategoryId: null, aiModel: '', aiModelPrevious: '', systemPrompt: '', minWords: 600, maxWords: 900, wpUser: '', secrets: {}, },
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
  // Le prompt est enregistré DANS les réglages dès la première lecture : c'est lui, et lui seul, qui est utilisé.
  getSettings: () => {
    const s = { ...DEFAULTS['settings.json'], ...read('settings.json') };
    if (typeof s.systemPrompt !== 'string' || !s.systemPrompt.trim()) {
      s.systemPrompt = DEFAULT_PROMPT;
      try { write('settings.json', s); } catch { /* disque en lecture seule : le texte d'origine sert quand même */ }
    }
    return s;
  },
  saveSettings: (v) => write('settings.json', v),
  getAudits: () => read('audits.json'),
  saveAudits: (v) => write('audits.json', v),
  getArticles: () => read('articles.json'),
  saveArticles: (v) => write('articles.json', v),
  // Remplace UN article dans la liste la plus récente (jamais d'écrasement d'un article ajouté entre-temps).
  saveArticle: (a) => { const l = read('articles.json'); const i = l.findIndex((x) => x.id === a.id); if (i >= 0) { l[i] = a; write('articles.json', l); } },
  getPublications: () => read('publications.json'),
  savePublications: (v) => write('publications.json', v),
};
