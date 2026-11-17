// Firebase wiring: AI Logic (hybrid on-device / cloud), App Check, anonymous Auth,
// Firestore pipeline and Remote Config. Loaded from the official gstatic ESM build, no bundler.
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { BRIEF_SCHEMA, DEFAULT_RED_FLAGS, PROMPT_VERSION } from './rules.js';

const V = '13.4.0';
const cdn = (m) => `https://www.gstatic.com/firebasejs/${V}/${m}.js`;

export const state = {
  configured: Boolean(firebaseConfig && firebaseConfig.apiKey),
  uid: null,
  db: null,
  model: null,
  modeLabel: 'prefer_on_device',
  remote: { redFlags: DEFAULT_RED_FLAGS, cloudModel: 'gemini-3.5-flash-lite', mode: 'prefer_on_device', promptVersion: PROMPT_VERSION },
  fs: null,
};

export async function initFirebase(log = () => {}) {
  if (!state.configured) {
    log('Firebase not configured: running local-only mode (red-flag scan + on-device Prompt API if Chrome exposes it).');
    return state;
  }
  const [{ initializeApp }, ai, appCheck, auth, fs, rc] = await Promise.all([
    import(cdn('firebase-app')),
    import(cdn('firebase-ai')),
    import(cdn('firebase-app-check')),
    import(cdn('firebase-auth')),
    import(cdn('firebase-firestore')),
    import(cdn('firebase-remote-config')),
  ]);
  const app = initializeApp(firebaseConfig);

  // App Check (reCAPTCHA Enterprise) is enforced on Firebase AI Logic. For local judging with a
  // registered debug token, open the app with ?appcheck-debug.
  if (new URLSearchParams(location.search).has('appcheck-debug')) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  if (appCheckSiteKey) {
    appCheck.initializeAppCheck(app, { provider: new appCheck.ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  }

  // Remote Config: red-flag rules, cloud model and default mode can change without a redeploy.
  try {
    const remote = rc.getRemoteConfig(app);
    remote.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
    remote.defaultConfig = {
      red_flags: JSON.stringify(DEFAULT_RED_FLAGS),
      cloud_model: state.remote.cloudModel,
      inference_mode: state.remote.mode,
    };
    await rc.fetchAndActivate(remote);
    const flags = JSON.parse(rc.getValue(remote, 'red_flags').asString() || '[]');
    if (Array.isArray(flags) && flags.length) state.remote.redFlags = flags;
    state.remote.cloudModel = rc.getValue(remote, 'cloud_model').asString() || state.remote.cloudModel;
    state.remote.mode = rc.getValue(remote, 'inference_mode').asString() || state.remote.mode;
    log(`Remote Config: ${state.remote.redFlags.length} red-flag rules, cloud model ${state.remote.cloudModel}.`);
  } catch (e) {
    log(`Remote Config unavailable, using defaults (${e.code || e.message}).`);
  }

  // Anonymous Auth scopes each visitor's saved pipeline to their own uid.
  try {
    const a = auth.getAuth(app);
    const cred = await auth.signInAnonymously(a);
    state.uid = cred.user.uid;
    state.db = fs.getFirestore(app);
    state.fs = fs;
    log('Signed in anonymously; pipeline syncs to Firestore.');
  } catch (e) {
    log(`Auth/Firestore unavailable (${e.code || e.message}); pipeline stays in this browser.`);
  }

  state.ai = ai;
  state.aiInstance = ai.getAI(app, { backend: new ai.GoogleAIBackend() });
  setMode(state.remote.mode);
  return state;
}

export function setMode(mode) {
  state.modeLabel = mode;
  if (!state.aiInstance) return;
  const { InferenceMode, getGenerativeModel } = state.ai;
  const map = {
    prefer_on_device: InferenceMode.PREFER_ON_DEVICE,
    only_on_device: InferenceMode.ONLY_ON_DEVICE,
    only_in_cloud: InferenceMode.ONLY_IN_CLOUD,
    prefer_in_cloud: InferenceMode.PREFER_IN_CLOUD,
  };
  state.model = getGenerativeModel(state.aiInstance, {
    mode: map[mode] ?? InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] },
      promptOptions: { responseConstraint: BRIEF_SCHEMA },
    },
    inCloudParams: {
      model: state.remote.cloudModel,
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: BRIEF_SCHEMA, temperature: 0.2 },
    },
  });
}

/** Run one triage. Returns { text, source: 'on_device' | 'in_cloud' | 'chrome_prompt_api' | 'none', ms }. */
export async function triage(prompt) {
  const t0 = performance.now();
  if (state.model) {
    const res = await state.model.generateContent(prompt);
    return { text: res.response.text(), source: res.response.inferenceSource || 'in_cloud', ms: Math.round(performance.now() - t0) };
  }
  // Local-only mode: call Chrome's built-in Prompt API directly if present.
  if (typeof self.LanguageModel !== 'undefined') {
    const avail = await self.LanguageModel.availability();
    if (avail === 'available') {
      const session = await self.LanguageModel.create();
      const text = await session.prompt(prompt, { responseConstraint: BRIEF_SCHEMA });
      session.destroy?.();
      return { text, source: 'chrome_prompt_api', ms: Math.round(performance.now() - t0) };
    }
  }
  return { text: '{}', source: 'none', ms: 0 };
}

export async function onDeviceStatus() {
  if (typeof self.LanguageModel === 'undefined') return 'unsupported';
  try {
    return await self.LanguageModel.availability();
  } catch {
    return 'unsupported';
  }
}

// --- Pipeline persistence (Firestore when signed in, localStorage otherwise) ---------------

const LS = 'bountylens.pipeline.v1';
const readLocal = () => {
  try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; }
};
const writeLocal = (items) => {
  try { localStorage.setItem(LS, JSON.stringify(items)); } catch { /* private mode */ }
};

export async function loadPipeline() {
  if (state.db && state.uid) {
    const { collection, getDocs, query, orderBy, limit } = state.fs;
    const snap = await getDocs(query(collection(state.db, 'users', state.uid, 'briefs'), orderBy('savedAt', 'desc'), limit(50)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return readLocal();
}

export async function saveBrief(brief) {
  const item = { ...brief, savedAt: new Date().toISOString() };
  if (state.db && state.uid) {
    const { collection, addDoc } = state.fs;
    const ref = await addDoc(collection(state.db, 'users', state.uid, 'briefs'), item);
    return { id: ref.id, ...item };
  }
  const items = readLocal();
  const withId = { id: `local-${Date.now()}`, ...item };
  writeLocal([withId, ...items].slice(0, 50));
  return withId;
}

export async function deleteBrief(id) {
  if (state.db && state.uid && !String(id).startsWith('local-')) {
    const { doc, deleteDoc } = state.fs;
    await deleteDoc(doc(state.db, 'users', state.uid, 'briefs', id));
    return;
  }
  writeLocal(readLocal().filter((x) => x.id !== id));
}
