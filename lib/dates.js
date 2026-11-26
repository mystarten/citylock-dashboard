// Dates du planning : tout est calculé à l'heure de Paris. Fonctions pures, testées sans réseau.

const pad = (n) => String(n).padStart(2, '0');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const todayParis = (now = new Date()) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(now);

// Instant UTC correspondant à « jour (heure de Paris) à hh:mm » : gère l'heure d'été et d'hiver.
function parisToUtc(dateStr, hh = 9, mm = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
    const g = (k) => Number(parts.find((p) => p.type === k).value);
    t += target - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  }
  return new Date(t);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate(); // dernier jour du mois (le 31 devient le 30, le 28...)
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

// Planning : `months` mois, `perMonth` articles par mois, à partir de `startDate`. Les articles d'un même mois sont
// répartis dans le mois (2 par mois : le jour J puis J+15 ; 3 par mois : J, J+10, J+20).
// Les sujets de la liste sont pris dans l'ordre ; s'il en manque, la ligne reste vide (mot-clé à saisir à la main).
function buildPlan({ months, perMonth, startDate, topics }) {
  const items = [];
  for (let i = 0; i < months * perMonth; i++) {
    const m = Math.floor(i / perMonth), j = i % perMonth;
    const t = topics[i];
    items.push({ topicId: t ? t.id : null, keyword: t ? t.keyword : '', city: t ? t.city || '' : '', plannedDate: addDays(addMonths(startDate, m), Math.round((j * 30) / perMonth)) });
  }
  return items;
}

// Planning par nombre d'articles : `count` articles, un tous les `spacingDays` jours à partir de `startDate`.
function buildPlanCount({ count, spacingDays, startDate, topics }) {
  return Array.from({ length: count }, (_, i) => {
    const t = topics[i];
    return { topicId: t ? t.id : null, keyword: t ? t.keyword : '', city: t ? t.city || '' : '', plannedDate: addDays(startDate, i * spacingDays) };
  });
}

module.exports = { buildPlanCount, isDate, todayParis, parisToUtc, addDays, addMonths, buildPlan };
