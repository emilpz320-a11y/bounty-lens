import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanRedFlags, guessFacts, guessDeadline, guessPrize, buildPrompt, normaliseBrief, expectedValue, daysLeft, rankPipeline, BRIEF_SCHEMA,
} from '../docs/rules.js';

const NOW = new Date('2026-11-18T00:00:00Z');

test('red flags: deposit, students-only and KYC are detected with evidence', () => {
  const flags = scanRedFlags('Fund your agent wallet with at least 20 USDC. Students only. Winners complete KYC.');
  const ids = flags.map((f) => f.id);
  assert.deepEqual(ids.sort(), ['deposit', 'kyc', 'students']);
  assert.ok(flags.find((f) => f.id === 'deposit').evidence.includes('fund your agent wallet'));
  assert.equal(flags.find((f) => f.id === 'kyc').severity, 'warn');
});

test('red flags: a clean page has none', () => {
  assert.deepEqual(scanRedFlags('Online hackathon, open worldwide, $5,000 in prizes, submit a repo and video.'), []);
});

test('red flags: negated mentions are ignored', () => {
  assert.deepEqual(scanRedFlags('No entry fee. No deposit required. Not in person.'), []);
});

test('fallback facts: title, winners and deliverables from plain text', () => {
  const f = guessFacts('Global Builders Week. Build a CLI.\nPrizes: $3,000 (3 winners).\nSubmission: public GitHub repo, a demo video and a short write-up.');
  assert.equal(f.title, 'Global Builders Week');
  assert.equal(f.winners, 3);
  assert.deepEqual(f.deliverables, ['public GitHub repo', 'a demo video', 'a short write-up']);
});

test('deadline guess picks the nearest future date in several formats', () => {
  assert.equal(guessDeadline('Opened Nov 1, 2026. Deadline: December 5, 2026. Results 2026-12-20.', NOW), '2026-12-05');
  assert.equal(guessDeadline('Closes 30 Nov 2026', NOW), '2026-11-30');
  assert.equal(guessDeadline('Ended on Oct 3, 2026', NOW), null);
});

test('prize guess takes the largest amount, with k and token suffixes', () => {
  assert.equal(guessPrize('1st $1,500, 2nd $1,000, total $3,000'), 3000);
  assert.equal(guessPrize('$30k grand prize'), 30000);
  assert.equal(guessPrize('10,000 USDC pool'), 10000);
  assert.equal(guessPrize('no money here'), null);
});

test('prompt includes the date and clips long pages', () => {
  const p = buildPrompt('x'.repeat(10000), { maxChars: 100, today: '2026-11-18' });
  assert.match(p, /Today is 2026-11-18/);
  assert.ok(p.length < 1200);
});

test('normalise: parses JSON wrapped in prose and fills gaps from the page', () => {
  const b = normaliseBrief('Sure! {"title":"X","deadline":"","prizePoolUsd":0,"winners":3,"verdict":"GO","reason":"ok"} thanks', {
    pageText: 'Deadline December 5, 2026. Prizes $3,000.', now: NOW,
  });
  assert.equal(b.title, 'X');
  assert.equal(b.deadline, '2026-12-05');
  assert.equal(b.prizePoolUsd, 3000);
  assert.equal(b.verdict, 'GO');
});

test('normalise: local block flags downgrade GO to REVIEW; past deadlines force SKIP', () => {
  const flags = scanRedFlags('Students only');
  const b = normaliseBrief({ title: 'T', verdict: 'GO', deadline: '2026-12-01' }, { localFlags: flags, now: NOW });
  assert.equal(b.verdict, 'REVIEW');
  assert.match(b.reason, /Students only/);
  const past = normaliseBrief({ title: 'T', verdict: 'GO', deadline: '2026-11-01' }, { now: NOW });
  assert.equal(past.verdict, 'SKIP');
});

test('normalise: garbage input gives a safe REVIEW brief', () => {
  const b = normaliseBrief('not json at all', { now: NOW });
  assert.equal(b.verdict, 'REVIEW');
  assert.equal(b.effortHours, 8);
  assert.deepEqual(b.deliverables, []);
});

test('expected value per hour and pay-per-submission', () => {
  const b = { prizePoolUsd: 3000, winners: 3, effortHours: 10, payPerSubmission: false };
  assert.deepEqual(expectedValue(b, { winChance: 0.1 }), { perWinner: 1000, ev: 100, perHour: 10 });
  const pps = expectedValue({ prizePoolUsd: 50, winners: 0, effortHours: 2, payPerSubmission: true });
  assert.equal(pps.ev, 40);
});

test('ranking: GO first, then $/h, then soonest deadline', () => {
  const items = [
    { title: 'skip', verdict: 'SKIP', prizePoolUsd: 1e6, winners: 1, effortHours: 1, deadline: '2026-12-01' },
    { title: 'go-low', verdict: 'GO', prizePoolUsd: 100, winners: 1, effortHours: 10, deadline: '2026-12-01' },
    { title: 'go-high', verdict: 'GO', prizePoolUsd: 10000, winners: 1, effortHours: 10, deadline: '2026-12-10' },
  ];
  assert.deepEqual(rankPipeline(items).map((x) => x.title), ['go-high', 'go-low', 'skip']);
});

test('daysLeft and schema shape', () => {
  assert.equal(daysLeft('2026-11-20', NOW), 3);
  assert.equal(daysLeft('', NOW), null);
  assert.deepEqual(BRIEF_SCHEMA.properties.verdict.enum, ['GO', 'SKIP', 'REVIEW']);
  assert.equal(BRIEF_SCHEMA.required.length, Object.keys(BRIEF_SCHEMA.properties).length);
});
