const test = require('node:test');
const assert = require('node:assert');
const d = require('../lib/dates');

test('dates : 9 h à Paris = 8 h UTC en hiver et 7 h UTC en été (changements d\'heure gérés)', () => {
  assert.strictEqual(d.parisToUtc('2027-01-15', 9, 0).toISOString(), '2027-01-15T08:00:00.000Z'); // hiver : UTC+1
  assert.strictEqual(d.parisToUtc('2027-07-15', 9, 0).toISOString(), '2027-07-15T07:00:00.000Z'); // été : UTC+2
  assert.strictEqual(d.parisToUtc('2027-03-28', 9, 0).toISOString(), '2027-03-28T07:00:00.000Z'); // jour du changement d'heure
  assert.strictEqual(d.parisToUtc('2027-10-31', 9, 0).toISOString(), '2027-10-31T08:00:00.000Z');
});

test('dates : validation, ajout de jours et de mois (fin de mois)', () => {
  assert.ok(d.isDate('2027-02-28') && !d.isDate('2027-02-30') && !d.isDate('27-02-28') && !d.isDate(null));
  assert.strictEqual(d.addDays('2027-02-27', 3), '2027-03-02');
  assert.strictEqual(d.addMonths('2027-01-31', 1), '2027-02-28');
  assert.strictEqual(d.addMonths('2027-11-15', 3), '2028-02-15');
});

test('planning : mois x articles par mois, répartis dans le mois, sujets dans l\'ordre, lignes vides si sujets manquants', () => {
  const topics = Array.from({ length: 5 }, (_, i) => ({ id: 't' + i, keyword: 'kw' + i, city: i ? 'Chatou' : '' }));
  const p2 = d.buildPlan({ months: 2, perMonth: 2, startDate: '2027-01-05', topics });
  assert.deepStrictEqual(p2.map((x) => x.plannedDate), ['2027-01-05', '2027-01-20', '2027-02-05', '2027-02-20']);
  assert.deepStrictEqual(p2.map((x) => x.keyword), ['kw0', 'kw1', 'kw2', 'kw3']);
  const p3 = d.buildPlan({ months: 1, perMonth: 3, startDate: '2027-01-05', topics });
  assert.deepStrictEqual(p3.map((x) => x.plannedDate), ['2027-01-05', '2027-01-15', '2027-01-25']);
  const long = d.buildPlan({ months: 6, perMonth: 3, startDate: '2027-01-31', topics });
  assert.strictEqual(long.length, 18);
  assert.strictEqual(long.filter((x) => !x.topicId).length, 13);
  assert.ok(long.every((x) => d.isDate(x.plannedDate)));
});
