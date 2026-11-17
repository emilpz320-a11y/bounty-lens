import { scanRedFlags, buildPrompt, normaliseBrief, expectedValue, daysLeft, rankPipeline } from './rules.js';
import { state, initFirebase, setMode, triage, onDeviceStatus, loadPipeline, saveBrief, deleteBrief } from './firebase.js';

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const usd = (n) => (n ? `$${Math.round(n).toLocaleString('en-US')}` : '—');
const SOURCE_LABEL = { on_device: 'On-device · private', chrome_prompt_api: 'On-device · private', in_cloud: 'Cloud · Gemini', none: 'Local rules only' };

const SAMPLE = `Global Builders Bounty Week 2026. Build an open-source CLI tool that helps developers.
Prizes: $3,000 total — 1st $1,500, 2nd $1,000, 3rd $500 (3 winners), paid in USDC.
Deadline: December 5, 2026. Online, open worldwide, individuals or teams of up to 4.
Submission: public GitHub repo with README, a demo video under 3 minutes, and a short write-up.
Winners must complete KYC before payout. Participants must be 18+. No entry fee.`;

let pipeline = [];
let current = null;

function setStatus(parts) {
  $('#status').replaceChildren(...parts.map((p) => (typeof p === 'string' ? h('span', {}, p) : p)));
}

function renderFlags(flags) {
  $('#flags').replaceChildren(...flags.map((f) => h('div', { class: `flag ${f.severity}` }, h('b', {}, f.severity === 'block' ? '⛔ ' : '⚠️ ', f.label), h('q', {}, f.evidence))));
}

function renderResult(brief, run) {
  const ev = expectedValue(brief, { winChance: Number($('#chance').value) });
  const dl = daysLeft(brief.deadline);
  const box = $('#result');
  box.hidden = false;
  box.replaceChildren(
    h('div', { class: 'result-head' },
      h('div', {}, h('h2', {}, brief.title), h('p', { class: 'muted small' }, brief.reason)),
      h('div', { class: 'status' },
        h('span', { class: `pill ${brief.verdict}` }, brief.verdict),
        h('span', { class: `pill ${run.source}` }, `${SOURCE_LABEL[run.source] || run.source}${run.ms ? ` · ${(run.ms / 1000).toFixed(1)}s` : ''}`))),
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('b', {}, brief.deadline || '—'), h('span', {}, dl == null ? 'deadline' : dl >= 0 ? `${dl} days left` : 'deadline passed')),
      h('div', { class: 'kpi' }, h('b', {}, usd(brief.prizePoolUsd)), h('span', {}, brief.payPerSubmission ? 'paid per valid submission' : `${brief.winners || '?'} paid winner(s)`)),
      h('div', { class: 'kpi' }, h('b', {}, usd(ev.perWinner)), h('span', {}, 'per winner')),
      h('div', { class: 'kpi' }, h('b', {}, `${brief.effortHours} h`), h('span', {}, 'estimated effort')),
      h('div', { class: 'kpi' }, h('b', {}, ev.perHour ? `$${ev.perHour}/h` : '—'), h('span', {}, `expected, at ${Math.round(Number($('#chance').value) * 100)}% win chance`))),
    h('div', { class: 'cols' },
      h('div', {}, h('h3', { class: 'lbl' }, 'Deliverables'), brief.deliverables.length ? h('ul', {}, brief.deliverables.map((d) => h('li', {}, d))) : h('p', { class: 'muted small' }, 'Not stated.')),
      h('div', {}, h('h3', { class: 'lbl' }, 'Blockers'), brief.blockers.length || brief.localFlags.length
        ? h('ul', {}, brief.blockers.map((b) => h('li', {}, b)), brief.localFlags.map((f) => h('li', {}, `${f.label} (local scan)`)))
        : h('p', { class: 'muted small' }, 'None found.')),
      h('div', {}, h('h3', { class: 'lbl' }, 'Eligibility'), h('p', { class: 'small' }, brief.eligibility || 'Not stated.'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: async (e) => { e.target.disabled = true; const saved = await saveBrief({ ...brief, source: run.source }); pipeline = [saved, ...pipeline]; renderPipeline(); e.target.textContent = 'Saved ✓'; } }, 'Save to pipeline'),
      h('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(checklist(brief)) }, 'Copy checklist')),
  );
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function checklist(b) {
  return [`# ${b.title}`, `Deadline: ${b.deadline || 'unknown'} · Verdict: ${b.verdict}`, '', '## Deliverables', ...b.deliverables.map((d) => `- [ ] ${d}`), '', '## Blockers to clear', ...[...b.blockers, ...b.localFlags.map((f) => f.label)].map((x) => `- [ ] ${x}`)].join('\n');
}

function renderPipeline() {
  const chance = Number($('#chance').value);
  const ranked = rankPipeline(pipeline, { winChance: chance });
  $('#pipeMeta').textContent = `${pipeline.length} saved · ${state.uid ? 'synced to Firestore' : 'stored in this browser'}`;
  if (!ranked.length) {
    $('#pipeline').replaceChildren(h('div', { class: 'empty' }, 'Triage a page and save it to build a ranked pipeline: GO first, then best $/hour.'));
    return;
  }
  $('#pipeline').replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['', 'Opportunity', 'Deadline', 'Per winner', '$/h', 'Ran', ''].map((t, i) => h('th', { class: i >= 3 && i <= 4 ? 'num' : null }, t)))),
    h('tbody', {}, ranked.map((b) => {
      const ev = expectedValue(b, { winChance: chance });
      const dl = daysLeft(b.deadline);
      return h('tr', {},
        h('td', {}, h('span', { class: `pill ${b.verdict}` }, b.verdict)),
        h('td', {}, b.title),
        h('td', {}, b.deadline ? `${b.deadline}${dl != null ? ` (${dl}d)` : ''}` : '—'),
        h('td', { class: 'num' }, usd(ev.perWinner)),
        h('td', { class: 'num' }, ev.perHour ? `$${ev.perHour}` : '—'),
        h('td', {}, h('span', { class: `pill ${b.source || 'none'}` }, b.source === 'in_cloud' ? 'cloud' : b.source === 'none' ? 'rules' : 'device')),
        h('td', {}, h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${b.title}`, onclick: async () => { await deleteBrief(b.id); pipeline = pipeline.filter((x) => x.id !== b.id); renderPipeline(); } }, '✕')));
    })))));
}

async function run() {
  const text = $('#page').value.trim();
  if (text.length < 40) { $('#page').focus(); return; }
  const btn = $('#go');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  const localFlags = scanRedFlags(text, state.remote.redFlags);
  renderFlags(localFlags);
  let runInfo = { source: 'none', ms: 0, text: '{}' };
  try {
    runInfo = await triage(buildPrompt(text));
    await renderStatus();
  } catch (e) {
    console.warn('model call failed', e);
    setStatus([h('span', { class: 'pill none' }, 'Model unavailable'), `Used local rules only (${e.code || e.message}).`]);
  }
  current = normaliseBrief(runInfo.text, { pageText: text, localFlags });
  renderResult(current, runInfo);
  btn.disabled = false;
  btn.textContent = 'Triage';
}

async function renderStatus() {
  const dev = await onDeviceStatus();
  const devPill = h('span', { class: `pill ${dev === 'available' ? 'on_device' : 'neutral'}` }, `Gemini Nano: ${dev}`);
  const parts = [devPill, h('span', { class: `pill ${state.configured ? 'in_cloud' : 'neutral'}` }, state.configured ? 'Firebase AI Logic: ready' : 'Firebase: not configured')];
  if (dev === 'downloadable' || dev === 'downloading') {
    parts.push(h('button', { class: 'btn ghost', type: 'button', id: 'enableNano', onclick: enableNano }, dev === 'downloading' ? 'Downloading Gemini Nano…' : 'Enable on-device model'));
  }
  setStatus(parts);
}

// Chrome needs a user gesture to start the one-time Gemini Nano download.
async function enableNano(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const session = await self.LanguageModel.create({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
      monitor(m) {
        m.addEventListener('downloadprogress', (ev) => { btn.textContent = `Downloading Gemini Nano… ${Math.round(ev.loaded * 100)}%`; });
      },
    });
    session.destroy?.();
  } catch (err) {
    btn.textContent = `On-device model unavailable (${err.name})`;
    return;
  }
  await renderStatus();
}

async function boot() {
  const logs = [];
  await initFirebase((m) => logs.push(m));
  await renderStatus();
  logs.forEach((m) => console.info('[bounty-lens]', m));
  $('#mode').value = state.remote.mode;
  $('#mode').addEventListener('change', (e) => setMode(e.target.value));
  $('#chance').addEventListener('change', () => { renderPipeline(); if (current) renderResult(current, { source: current.source || 'none' }); });
  $('#go').addEventListener('click', run);
  $('#sample').addEventListener('click', () => { $('#page').value = SAMPLE; renderFlags(scanRedFlags(SAMPLE, state.remote.redFlags)); });
  $('#page').addEventListener('input', () => renderFlags(scanRedFlags($('#page').value, state.remote.redFlags)));
  try { pipeline = await loadPipeline(); } catch (e) { console.warn(e); pipeline = []; }
  renderPipeline();
}

boot();
