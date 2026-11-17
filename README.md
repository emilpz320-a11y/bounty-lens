# Bounty Lens: private triage for hackathons and bounties

**Live app:** https://emilpz320-a11y.github.io/bounty-lens/

Solo builders scan dozens of hackathon, bounty and grant pages a week. Most of the time goes into
the fine print: is it students only? In person? Does it want a deposit, trading volume or KYC?
How many winners, and is it worth the hours? Bounty Lens answers those questions in seconds
**on your own device**. You paste the page; Gemini Nano runs locally through Chrome's built-in
Prompt API; the page never leaves your computer. When the device can't run the model, the same
request goes to Gemini in the cloud through **Firebase AI Logic hybrid inference**.

> Built for #BuildHybridAI 2026 (Web / Chrome track).

## What you get

| | |
|---|---|
| **Typed brief** | title, deadline, prize pool, number of paid winners, pay-per-submission, eligibility, deliverables, blockers, effort and a **GO / SKIP / REVIEW** verdict |
| **Red-flag scan** | deposits, trading, KYC, students-only, in-person, country limits, "no AI content", engagement-judged. These are regex rules served from **Remote Config** that run before any model, with negation handling ("no entry fee" is not a flag) |
| **Where it ran** | every result says *On-device · private* or *Cloud · Gemini*, plus latency |
| **$/hour** | prize per winner × your win chance ÷ effort, so you can compare a $500 bounty with 5 winners against a $30k hackathon with 3,000 entrants |
| **Pipeline** | saved briefs ranked GO-first, then by $/hour, then by deadline. Stored in **Firestore** under an anonymous **Firebase Auth** user |

## How hybrid inference is used

```js
const model = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,           // Gemini Nano first, cloud only as fallback
  onDeviceParams: { promptOptions: { responseConstraint: BRIEF_SCHEMA } },   // JSON schema on device
  inCloudParams: { model: 'gemini-3.5-flash-lite',
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: BRIEF_SCHEMA } },
});
const res = await model.generateContent(prompt);
res.response.inferenceSource;                     // 'on_device' | 'in_cloud', shown in the UI
```

The same JSON schema constrains both paths, so the UI never has to care where the answer came from.
The mode switch (prefer device, only device, prefer cloud, only cloud) is in the UI, and its default comes from Remote Config.

**Safety net:** the model's verdict is merged with the local scan, and local rules can only make it
*stricter*: a "students only" hit downgrades GO to REVIEW, and a past deadline is always SKIP. If no
model is available at all, the app still produces a brief from deterministic rules (title,
deadline, prize, winners and deliverables heuristics).

## Firebase products

| Product | Use |
|---|---|
| **Firebase AI Logic** | hybrid inference (`PREFER_ON_DEVICE`), Gemini Developer API backend |
| **App Check** | reCAPTCHA v3 in production, debug token on localhost or with `?appcheck-debug` |
| **Authentication** | anonymous sign-in, so each visitor has a private pipeline |
| **Firestore** | `users/{uid}/briefs`, with field-whitelisted security rules in [`firestore.rules`](firestore.rules) |
| **Remote Config** | `inference_mode`, `cloud_model`, `red_flags` ([template](remoteconfig.template.json)) |

## Run it

```bash
npm test                          # 13 unit tests for the pure logic (no network)
python -m http.server -d docs     # open http://localhost:8000
```

To connect your own Firebase project, fill `docs/firebase-config.js` with the web app config. Then enable
AI Logic (Gemini Developer API), App Check, Anonymous Auth and Firestore, and deploy `firestore.rules`.
For on-device inference, use desktop Chrome with the built-in Prompt API (Gemini Nano) available.

## Layout

```
docs/index.html        UI
docs/app.js            rendering and flow
docs/firebase.js       Firebase AI Logic, App Check, Auth, Firestore, Remote Config
docs/rules.js          pure logic: red flags, schema, prompt, normalisation, $/hour, ranking
test/rules.test.mjs    node:test suite
firestore.rules        security rules
```

Apache-2.0 licensed.
