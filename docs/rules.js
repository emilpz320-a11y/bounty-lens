// Pure, dependency-free logic shared by the app and the tests.
// Everything here runs locally: red-flag scanning, the JSON schema the model must follow,
// the prompt, response normalisation and expected-value ranking.

export const DEFAULT_RED_FLAGS = [
  { id: 'deposit', label: 'Requires a deposit or your own funds', severity: 'block', patterns: ['deposit', 'fund your (?:agent |own )?wallet', 'minimum (?:balance|deposit)', 'stake (?:at least|\\d)', 'pay (?:an? )?(?:entry|registration) fee', 'entry fee'] },
  { id: 'trading', label: 'Requires trading, buying tokens or volume', severity: 'block', patterns: ['trading volume', 'buy (?:the )?tokens?', '\\$?\\d[\\d,]*k? (?:in )?volume', 'swap at least', 'provide liquidity'] },
  { id: 'kyc', label: 'Identity verification (KYC) before payout', severity: 'warn', patterns: ['\\bkyc\\b', 'identity verification', 'sumsub', 'government[- ]issued id', 'passport'] },
  { id: 'students', label: 'Students only', severity: 'block', patterns: ['students? only', 'only (?:open to )?students', 'must be (?:a |an )?(?:enrolled |current )?student', 'university students'] },
  { id: 'inperson', label: 'In-person attendance', severity: 'block', patterns: ['in[- ]person', 'on[- ]site', 'onsite', 'must attend', 'venue'] },
  { id: 'country', label: 'Country or residency restriction', severity: 'warn', patterns: ['residents? of', 'only (?:open )?(?:to|for) (?:participants|residents|citizens) (?:in|of|from)', 'excluded countries', 'not available in'] },
  { id: 'noai', label: 'AI-generated content not allowed', severity: 'block', patterns: ['no ai[- ]generated', 'ai[- ]generated (?:content|submissions) (?:is|are|will be) (?:not|disqualified)', 'must not use (?:ai|chatgpt|llms?)'] },
  { id: 'engagement', label: 'Judged on followers or engagement', severity: 'warn', patterns: ['(?:most|highest) (?:likes|views|engagement)', 'follower count', 'impressions'] },
];

/** Scan raw page text with regex rules. Runs before (and without) any model. */
export function scanRedFlags(text, rules = DEFAULT_RED_FLAGS) {
  const hay = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const hits = [];
  for (const r of rules) {
    let found = null;
    for (const p of r.patterns) {
      const re = new RegExp(p, 'gi');
      let m;
      while ((m = re.exec(hay))) {
        // Skip negated mentions such as "no entry fee", "not required", "without a deposit".
        const before = hay.slice(Math.max(0, m.index - 16), m.index);
        if (/\b(no|not|without|zero|never)\b[^.;]*$/.test(before)) continue;
        found = m;
        break;
      }
      if (found) break;
    }
    if (found) {
      const start = Math.max(0, found.index - 50);
      hits.push({ id: r.id, label: r.label, severity: r.severity, evidence: hay.slice(start, found.index + found[0].length + 50).trim() });
    }
  }
  return hits;
}

/** Fallback facts when no model ran: title, winners and deliverables from plain sentences. */
export function guessFacts(text) {
  const clean = String(text || '').replace(/\r/g, '');
  const firstLine = clean.split('\n').map((s) => s.trim()).find(Boolean) || '';
  const title = firstLine.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '').slice(0, 120);
  const w = /\((\d{1,4})\s+winners?\)|(\d{1,4})\s+(?:paid\s+)?winners?\b|top\s+(\d{1,3})\b/i.exec(clean);
  const winners = w ? Number(w[1] || w[2] || w[3]) : 0;
  const sub = /(?:submission|submit|deliverables?)[^:]*:\s*([^\n]+)/i.exec(clean);
  const deliverables = sub ? sub[1].split(/,\s*(?:and\s+)?|\s+and\s+/).map((s) => s.replace(/\.$/, '').trim()).filter((s) => s.length > 2).slice(0, 8) : [];
  return { title, winners, deliverables };
}

/** Find the closest future date mentioned in the text, as a fallback deadline. */
export function guessDeadline(text, now = new Date()) {
  const months = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const re = new RegExp(`\\b(\\d{1,2})\\s+(${months})[a-z]*\\.?,?\\s+(20\\d{2})\\b|\\b(${months})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`, 'gi');
  let best = null;
  for (const m of String(text || '').matchAll(re)) {
    let d;
    if (m[1]) d = new Date(`${m[2]} ${m[1]} ${m[3]} UTC`);
    else if (m[4]) d = new Date(`${m[4]} ${m[5]} ${m[6]} UTC`);
    else d = new Date(`${m[7]}-${m[8]}-${m[9]}T00:00:00Z`);
    if (Number.isNaN(+d) || d < now) continue;
    if (!best || d < best) best = d;
  }
  return best ? best.toISOString().slice(0, 10) : null;
}

/** Largest money amount in the text (USD-ish), as a fallback prize. */
export function guessPrize(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b|(\d[\d,]*)\s*(usdc|usdt|usd)\b/gi)) {
    let v = parseFloat((m[1] || m[3]).replace(/,/g, ''));
    if (m[2]?.toLowerCase() === 'k') v *= 1e3;
    if (m[2]?.toLowerCase() === 'm') v *= 1e6;
    if (v > max) max = v;
  }
  return max || null;
}

// JSON Schema used for BOTH on-device (Prompt API responseConstraint) and cloud (responseJsonSchema).
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    deadline: { type: 'string', description: 'YYYY-MM-DD or empty if unknown' },
    prizePoolUsd: { type: 'number', description: 'Total cash prize pool in USD, 0 if unknown' },
    winners: { type: 'integer', description: 'Number of paid winners, 0 if unknown' },
    payPerSubmission: { type: 'boolean' },
    eligibility: { type: 'string' },
    deliverables: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    effortHours: { type: 'number' },
    verdict: { type: 'string', enum: ['GO', 'SKIP', 'REVIEW'] },
    reason: { type: 'string' },
  },
  required: ['title', 'deadline', 'prizePoolUsd', 'winners', 'payPerSubmission', 'eligibility', 'deliverables', 'blockers', 'effortHours', 'verdict', 'reason'],
};

export const PROMPT_VERSION = 'v3';

export function buildPrompt(pageText, { maxChars = 6000, today = new Date().toISOString().slice(0, 10) } = {}) {
  const clipped = String(pageText || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return [
    'You triage hackathons, bounties and grants for a solo builder. Read the page below and fill the JSON schema.',
    `Today is ${today}. Use only facts stated on the page; use "" or 0 when a fact is missing.`,
    'Blockers are anything that needs the builder\'s own money, trading, KYC before payout, being a student, attending in person, or a country they may not be in.',
    'Verdict: GO if a solo builder can realistically submit before the deadline with no blocker; SKIP if a blocker applies or the deadline has passed; REVIEW if key facts are missing.',
    'Keep "reason" to one sentence.',
    '--- PAGE ---',
    clipped,
  ].join('\n');
}

const clampNum = (v, lo, hi, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** Parse model output defensively and merge it with the local scan. */
export function normaliseBrief(raw, { pageText = '', localFlags = [], now = new Date() } = {}) {
  let obj = raw;
  if (typeof raw === 'string') {
    const s = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    try {
      obj = JSON.parse(s);
    } catch {
      obj = {};
    }
  }
  obj = obj && typeof obj === 'object' ? obj : {};
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(obj.deadline || '') ? obj.deadline : guessDeadline(pageText, now) || '';
  const prize = clampNum(obj.prizePoolUsd, 0, 1e8) || guessPrize(pageText) || 0;
  const blockers = [...new Set([...(Array.isArray(obj.blockers) ? obj.blockers : []).map(String).filter(Boolean)])].slice(0, 8);
  const facts = guessFacts(pageText);
  const modelDeliverables = (Array.isArray(obj.deliverables) ? obj.deliverables : []).map(String).filter(Boolean);
  const brief = {
    title: String(obj.title || facts.title || 'Untitled opportunity').slice(0, 140),
    deadline,
    prizePoolUsd: prize,
    winners: Math.round(clampNum(obj.winners, 0, 10000)) || facts.winners,
    payPerSubmission: Boolean(obj.payPerSubmission),
    eligibility: String(obj.eligibility || '').slice(0, 300),
    deliverables: (modelDeliverables.length ? modelDeliverables : facts.deliverables).slice(0, 10),
    blockers,
    effortHours: clampNum(obj.effortHours, 0, 500, 8),
    verdict: ['GO', 'SKIP', 'REVIEW'].includes(obj.verdict) ? obj.verdict : 'REVIEW',
    reason: String(obj.reason || '').slice(0, 300),
    localFlags,
  };
  // Local rules can only make the verdict stricter, never looser.
  const hardStop = localFlags.find((f) => f.severity === 'block');
  if (hardStop && brief.verdict === 'GO') {
    brief.verdict = 'REVIEW';
    brief.reason = `Local scan found "${hardStop.label}". ${brief.reason}`.trim();
  }
  if (deadline && new Date(`${deadline}T23:59:59Z`) < now) {
    brief.verdict = 'SKIP';
    brief.reason = `Deadline ${deadline} has passed. ${brief.reason}`.trim();
  }
  return brief;
}

/** Expected value per hour: prize per winner × win chance / effort. Chance is a user estimate. */
export function expectedValue(brief, { winChance = 0.05 } = {}) {
  const perWinner = brief.winners > 0 ? brief.prizePoolUsd / brief.winners : brief.prizePoolUsd;
  const chance = brief.payPerSubmission ? 0.8 : winChance;
  const ev = perWinner * chance;
  const perHour = brief.effortHours > 0 ? ev / brief.effortHours : ev;
  return { perWinner: Math.round(perWinner), ev: Math.round(ev), perHour: Math.round(perHour * 10) / 10 };
}

export function daysLeft(deadline, now = new Date()) {
  if (!deadline) return null;
  return Math.ceil((new Date(`${deadline}T23:59:59Z`) - now) / 864e5);
}

/** Rank a pipeline: GO first, then highest $/hour, then soonest deadline. */
export function rankPipeline(items, opts) {
  const order = { GO: 0, REVIEW: 1, SKIP: 2 };
  return [...items].sort((a, b) => {
    const v = order[a.verdict] - order[b.verdict];
    if (v) return v;
    const e = expectedValue(b, opts).perHour - expectedValue(a, opts).perHour;
    if (e) return e;
    return (daysLeft(a.deadline) ?? 999) - (daysLeft(b.deadline) ?? 999);
  });
}
