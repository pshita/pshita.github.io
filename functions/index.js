const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const logger = require("firebase-functions/logger");
const {
  MENU_PAGES, formatLessonJson, formatSiteJson, lessonShellHtml, newLessonData, setIndexPanels, setMenu,
} = require("./site");

initializeApp();
const db = getFirestore();

// Set these once via: firebase functions:secrets:set SMS4FREE_KEY (etc.)
// Never put real values in this file or in git.
const SMS4FREE_KEY = defineSecret("SMS4FREE_KEY");
const SMS4FREE_USER = defineSecret("SMS4FREE_USER");
const SMS4FREE_PASS = defineSecret("SMS4FREE_PASS");

// Set once via: firebase functions:secrets:set GITHUB_TOKEN
// A GitHub fine-grained personal access token scoped to this repo only,
// with Contents: Read and write permission.
const GITHUB_TOKEN = defineSecret("GITHUB_TOKEN");

// Parent SMS settings, edited on the admin page (admin.html) and stored in
// settings/sms - the default for every student:
//   enabled  - whether messages go out (off until the admin turns it on)
//   step     - every how many correct answers
//   template - the text; {שם} is the student's first name, {שם מלא} the full
//              name and {מספר} the number of correct answers
//   sender   - the number (or name) the message comes from, sent with each message
// A student may have their own: users/{uid}.smsMode ("on" / "off"; none = the
// default; the older notify === false also means off) and users/{uid}.smsStep.
const SMS_DEFAULTS = {
  step: 10,
  template: "{שם} ענה נכון על {מספר} שאלות בשיעורי הגמרא באתר פשיטא 🎉",
};

async function smsSettings() {
  const snap = await db.collection("settings").doc("sms").get();
  const v = snap.exists ? snap.data() : {};
  const step = Number.isInteger(v.step) && v.step > 0 ? v.step : SMS_DEFAULTS.step;
  const template = typeof v.template === "string" && v.template.trim() ? v.template : SMS_DEFAULTS.template;
  const sender = typeof v.sender === "string" ? v.sender.trim() : "";
  return { step, template, enabled: v.enabled === true, sender };
}

// This student's messages: on or off, and every how many answers.
function studentPlan(settings, userData) {
  const mode = userData.smsMode === "on" || userData.smsMode === "off" ? userData.smsMode
    : userData.notify === false ? "off" : "default";
  const on = mode === "on" || (mode === "default" && settings.enabled);
  const step = Number.isInteger(userData.smsStep) && userData.smsStep > 0 ? userData.smsStep : settings.step;
  return { on, step };
}

function smsText(template, userData, count) {
  const first = (userData.firstName || "").trim();
  const full = `${first} ${(userData.lastName || "").trim()}`.trim();
  return template.split("{שם מלא}").join(full).split("{שם}").join(first).split("{מספר}").join(String(count));
}

function countCorrect(sections) {
  if (!sections) return 0;
  return Object.values(sections).filter(Boolean).length;
}

function smsSecrets(sender) {
  return {
    key: SMS4FREE_KEY.value(),
    user: SMS4FREE_USER.value(),
    pass: SMS4FREE_PASS.value(),
    sender,
  };
}

async function sendSms({ key, user, pass, sender, recipient, msg }) {
  const res = await fetch("https://api.sms4free.co.il/ApiSMS/v2/SendSMS", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, user, pass, sender, recipient, msg }),
  });
  const data = await res.json();
  if (!(data.status > 0)) {
    throw new Error(`SMS4Free error ${data.status}: ${data.message}`);
  }
  return data;
}

// Every message sent (or tried) is kept in smsLog, shown on the admin page ("ארכיון").
async function sendAndLog({ kind, uid = null, name = "", to, msg, count = null, sender }) {
  const entry = { at: new Date().toISOString(), kind, uid, name, to, msg, count, sender: sender || "", ok: true };
  try {
    await sendSms({ ...smsSecrets(sender), recipient: to.join(";"), msg });
  } catch (err) {
    entry.ok = false;
    entry.error = err.message;
  }
  await db.collection("smsLog").add(entry).catch((e) => logger.error("smsLog write failed", e));
  if (!entry.ok) throw new Error(entry.error);
}

// Fires on every write to a user's quiz-progress doc (users/{uid}/progress/quiz),
// which holds one entry per question answered correctly (see student.js). If the
// score just crossed another multiple of this student's step and messages are on
// for them, texts the parents. The student is told on the site: users/{uid}.lastSms.
exports.notifyParentsOnQuizMilestone = onDocumentWritten(
  {
    document: "users/{uid}/progress/quiz",
    secrets: [SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS],
  },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;

    const prevScore = countCorrect(before?.sections);
    const newScore = countCorrect(after.sections);
    if (newScore <= prevScore) return;

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return;
    const userData = userSnap.data();
    const settings = await smsSettings();
    const { on, step } = studentPlan(settings, userData);
    if (!on) return;
    const prevMilestone = Math.floor(prevScore / step) * step;
    const newMilestone = Math.floor(newScore / step) * step;
    if (newMilestone <= prevMilestone || newMilestone === 0) return;

    const recipients = [userData.fatherPhone, userData.motherPhone].filter(Boolean);
    if (recipients.length === 0) return;

    const name = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
    try {
      await sendAndLog({ kind: "milestone", uid, name, to: recipients, msg: smsText(settings.template, userData, newMilestone), count: newMilestone, sender: settings.sender });
      await userRef.update({ lastSms: { at: new Date().toISOString(), count: newMilestone, seen: false } });
      logger.info(`Notified parents of ${uid} at ${newMilestone} points`);
    } catch (err) {
      logger.error(`Failed to notify parents of ${uid} at ${newMilestone} points`, err);
    }
  }
);

// Admin page: send the message (as it will look) to one phone number, to check
// that the SMS4Free account details work.
exports.sendTestSms = onCall(
  { secrets: [SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS] },
  async (request) => {
    try {
      return await testSms(request);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      // anything unexpected: show what it was on the admin page, not just "internal"
      logger.error("sendTestSms failed", err);
      throw new HttpsError("internal", `תקלה בשרת: ${(err && err.message) || err}`);
    }
  }
);

// The test message itself (see sendTestSms).
async function testSms(request) {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה.");
  }
  const phone = String((request.data && request.data.phone) || "").replace(/[^0-9]/g, "");
  if (!/^05\d{8}$/.test(phone)) throw new HttpsError("invalid-argument", "מספר טלפון לא תקין.");
  const settings = await smsSettings();
  const missing = Object.entries(smsSecrets(settings.sender)).filter(([, v]) => !String(v || "").trim()).map(([k]) => k);
  if (missing.length) throw new HttpsError("failed-precondition", `חסרים פרטי SMS4Free: ${missing.join(", ")}`);
  const msg = smsText(settings.template, { firstName: "ישראל", lastName: "ישראלי" }, settings.step);
  try {
    await sendAndLog({ kind: "test", name: "הודעת בדיקה", to: [phone], msg, count: settings.step, sender: settings.sender });
  } catch (err) {
    throw new HttpsError("failed-precondition", err.message);
  }
  return { msg };
}

// Admin page: a student's first and last name. Changes the profile and the
// account's display name (shown in the login list and in "שלום ..."); the
// student keeps signing in the same way (from the list, with the password).
exports.renameStudent = onCall(async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה.");
  }
  const { uid } = request.data || {};
  const firstName = String((request.data && request.data.firstName) || "").trim().replace(/\s+/g, " ");
  const lastName = String((request.data && request.data.lastName) || "").trim().replace(/\s+/g, " ");
  if (typeof uid !== "string" || !uid) throw new HttpsError("invalid-argument", "תלמיד לא מוכר.");
  if (!firstName || !lastName || firstName.length > 40 || lastName.length > 40) {
    throw new HttpsError("invalid-argument", "צריך שם פרטי ושם משפחה.");
  }
  const ref = db.collection("users").doc(uid);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "התלמיד לא נמצא.");
  await getAuth().updateUser(uid, { displayName: `${firstName} ${lastName}` });
  await ref.update({ firstName, lastName });
  return { firstName, lastName };
});

// Login page: the list of everyone registered, so a student picks their name and
// types only the password. Returns each account's name (the admin's as "ניהול") and
// its sign-in email, which is a hash of the name and reveals nothing else.
exports.listUsers = onCall(async () => {
  const people = [];
  let page;
  do {
    page = await getAuth().listUsers(1000, page && page.pageToken);
    page.users.forEach((u) => { if (u.email && !u.disabled) people.push({ uid: u.uid, email: u.email, name: (u.displayName || "").trim() }); });
  } while (page.pageToken);
  // a name missing from the account: take it from the profile
  const missing = people.filter((p) => !p.name);
  if (missing.length) {
    const docs = await db.getAll(...missing.map((p) => db.collection("users").doc(p.uid)));
    docs.forEach((d, i) => {
      const v = d.exists ? d.data() : {};
      missing[i].name = `${v.firstName || ""} ${v.lastName || ""}`.trim();
    });
  }
  const list = people
    .map((p) => ({ name: p.email === ALLOWED_EMAIL ? "ניהול" : p.name, email: p.email }))
    .filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name, "he"));
  return { users: list };
});

// ---------------------------------------------------------------------
// Admin content editing: every change is committed straight to the
// GitHub repo that serves the site.
// ---------------------------------------------------------------------

const REPO_OWNER = "pshita";
const REPO_NAME = "pshita.github.io";
const REPO_BRANCH = "main";

// Lesson ids are validated by shape (matches every id already in use, e.g.
// "avot-vetoldot") rather than a fixed list, so a newly created lesson can
// be edited right away with no code change or redeploy.
const LESSON_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function isValidLessonId(id) {
  return typeof id === "string" && id.length >= 2 && id.length <= 60 && LESSON_ID_RE.test(id);
}

// Only this account may write to the site's content. Computed the same way
// auth.js turns a name into a pseudo-email: sha256("<first>|<last>", both
// normalized), first 32 hex chars, prefixed "u", @arba-avot-users.local.
const ALLOWED_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";

async function githubRequest(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "avot-admin-panel",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Lesson pages a text edit may come from.
const EDITABLE_PATH_RE = /^lessons\/[a-z0-9]+(-[a-z0-9]+)*\.html$/;

// ---------------------------------------------------------------------
// Site data (see site.js for the layout):
//   lessons.json            - lesson list and order
//   lessons/data/<id>.json  - one lesson's content
//   lessons/<id>.html       - thin page loading the shared player
// ---------------------------------------------------------------------

const SITE_JSON = "lessons.json";
const dataPath = (id) => `lessons/data/${id}.json`;
const idFromPagePath = (path) => (path.match(/^lessons\/([a-z0-9]+(?:-[a-z0-9]+)*)\.html$/) || [])[1];

async function readRepoFile(path, token) {
  const current = await githubRequest(`contents/${path}?ref=${REPO_BRANCH}`, { token });
  return { sha: current.sha, text: Buffer.from(current.content, "base64").toString("utf8") };
}

async function writeRepoFile(path, text, { sha, message, token }) {
  await githubRequest(`contents/${path}`, {
    method: "PUT",
    token,
    body: { message, content: Buffer.from(text, "utf8").toString("base64"), ...(sha ? { sha } : {}), branch: REPO_BRANCH },
  });
}

async function deleteRepoFile(path, { message, token }) {
  const current = await githubRequest(`contents/${path}?ref=${REPO_BRANCH}`, { token });
  await githubRequest(`contents/${path}`, { method: "DELETE", token, body: { message, sha: current.sha, branch: REPO_BRANCH } });
}

// Replaces every string in `value` that equals one of the forms of `oldText`
// (first form that matches anything wins).
function replaceInJson(value, pairs) {
  for (const [oldText, newText] of pairs) {
    let count = 0;
    const walk = (v) => {
      if (typeof v === "string") { if (v === oldText) { count++; return newText; } return v; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    const out = walk(value);
    if (count) return { out, count };
  }
  return null;
}

// Text edited in place on a lesson page: the page path comes in
// (lessons/<id>.html); the text lives in that lesson's data file.
exports.replaceLessonText = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }
  const { path, pairs, all } = request.data || {};
  if (typeof path !== "string" || !EDITABLE_PATH_RE.test(path)) {
    throw new HttpsError("invalid-argument", "עמוד לא מוכר.");
  }
  // pairs: [[old, new], ...] - the same edit in several forms (raw HTML,
  // without highlight wrappers, plain text...).
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 6 ||
      !pairs.every((p) => Array.isArray(p) && p.length === 2 &&
        typeof p[0] === "string" && typeof p[1] === "string" &&
        p[0].trim() && p[0].length <= 20000 && p[1].length <= 20000)) {
    throw new HttpsError("invalid-argument", "שינוי לא תקין.");
  }

  const token = GITHUB_TOKEN.value();
  const id = idFromPagePath(path);
  const filePath = dataPath(id);
  let file;
  try {
    file = await readRepoFile(filePath, token);
  } catch (err) {
    throw new HttpsError("not-found", "העמוד לא נמצא.");
  }
  const r = replaceInJson(JSON.parse(file.text), pairs);
  const result = r && { out: formatLessonJson(r.out), count: r.count };
  if (!result) {
    throw new HttpsError("not-found", "את הטקסט הזה אי אפשר לערוך מכאן (הוא לא נמצא בקובץ כמו שהוא).");
  }
  // The same exact text in several places (a short term reused in cards,
  // answers...) - don't change them all unless the admin confirmed it.
  if (result.count > 1 && all !== true) {
    return { ok: false, needConfirm: true, count: result.count };
  }
  try {
    await writeRepoFile(filePath, result.out, { sha: file.sha, message: `עדכון טקסט: ${id} (עריכה באתר)`, token });
  } catch (err) {
    logger.error(`replaceLessonText failed for ${path}`, err);
    throw new HttpsError("internal", "השמירה נכשלה. נסו שוב.");
  }
  return { ok: true, count: result.count };
});

// ---------------------------------------------------------------------
// text.html edits a whole lesson as data (headings, paragraphs, new
// sections) and saves it back. `src` is the data file's exact text, used
// to refuse overwriting a version changed elsewhere in the meantime.

const JS_KEY_RE = /^[A-Za-z_$][\w$]*$/;
function validLessonData(v, depth = 0) {
  if (depth > 10) return false;
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return typeof v !== "number" || Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => validLessonData(x, depth + 1));
  if (typeof v === "object") return Object.entries(v).every(([k, x]) => JS_KEY_RE.test(k) && validLessonData(x, depth + 1));
  return false;
}

async function readLessonData(path, token) {
  const id = typeof path === "string" && EDITABLE_PATH_RE.test(path) ? idFromPagePath(path) : null;
  if (!id) throw new HttpsError("invalid-argument", "עמוד לא מוכר.");
  try {
    return { id, ...(await readRepoFile(dataPath(id), token)) };
  } catch (err) {
    throw new HttpsError("not-found", "לשיעור הזה אין קובץ תוכן שאפשר לערוך מכאן.");
  }
}

exports.getLessonData = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }
  const { text } = await readLessonData((request.data || {}).path, GITHUB_TOKEN.value());
  return { src: text };
});

exports.saveLessonData = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }
  const { path, lesson, base } = request.data || {};
  if (!lesson || typeof lesson !== "object" || Array.isArray(lesson) || !validLessonData(lesson) ||
      typeof lesson.title !== "string" || !Array.isArray(lesson.stations) ||
      !lesson.stations.every((s) => typeof s === "string") || !Array.isArray(lesson.screens) ||
      !lesson.screens.length || !lesson.screens.every((s) => s && typeof s === "object" && typeof s.type === "string") ||
      JSON.stringify(lesson).length > 500000 || typeof base !== "string") {
    throw new HttpsError("invalid-argument", "תוכן השיעור לא תקין.");
  }
  const token = GITHUB_TOKEN.value();
  const { id, sha, text } = await readLessonData(path, token);
  if (text !== base) {
    throw new HttpsError("aborted", "השיעור השתנה מאז שנטען. טענו את העמוד מחדש ונסו שוב.");
  }
  const out = formatLessonJson(lesson);
  try {
    await writeRepoFile(dataPath(id), out, { sha, message: `עדכון שיעור: ${id} (עריכה מעמוד הטקסט)`, token });
  } catch (err) {
    logger.error(`saveLessonData failed for ${path}`, err);
    throw new HttpsError("internal", "השמירה נכשלה. נסו שוב.");
  }
  // A renamed lesson: its name also shows in the lesson list (home page, menus) and the page's tab.
  try {
    await syncLessonTitle(id, lesson.title, token);
  } catch (err) {
    logger.error(`saveLessonData: title sync failed for ${id}`, err);
    throw new HttpsError("internal", "התוכן נשמר, אבל השם החדש לא עודכן ברשימת השיעורים. נסו לשנות אותו שוב.");
  }
  return { ok: true, src: out };
});

async function syncLessonTitle(id, title, token) {
  const { site, sha } = await readSite(token);
  const entry = [].concat(...site.groups.map((g) => g.lessons)).find((l) => l.id === id);
  if (!entry || entry.title === title) return;
  entry.title = title;
  const message = `שינוי שם שיעור: ${id} (עריכה מעמוד הטקסט)`;
  await publishSite({ site, sha, token, message });
  const shell = await readRepoFile(`lessons/${id}.html`, token);
  const html = lessonShellHtml({ id, title });
  if (html !== shell.text) await writeRepoFile(`lessons/${id}.html`, html, { sha: shell.sha, message, token });
}

// ---------------------------------------------------------------------
// Adding, moving and removing lessons: lessons.json is the one list; the
// home page panels and every header menu are regenerated from it. Lesson
// pages need no change - the player reads previous/next from lessons.json.

async function fileExists(path, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/${path}?ref=${REPO_BRANCH}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "avot-admin-panel" },
  });
  return res.status === 200;
}

// A lesson's displayed title always carries the Hebrew corner quotes
// (the "דיבור המתחיל" convention) - add them if the admin didn't type them.
function quoteTitle(titleText) {
  const t = titleText.trim();
  return /^״.*״$/.test(t) ? t : `״${t}״`;
}

async function readSite(token) {
  const file = await readRepoFile(SITE_JSON, token);
  return { sha: file.sha, site: JSON.parse(file.text) };
}

// Writes lessons.json, then the pages whose markup lists the lessons.
async function publishSite({ site, sha, token, message }) {
  const groups = site.groups.filter((g) => g.lessons.length);
  const clean = { groups };
  await writeRepoFile(SITE_JSON, formatSiteJson(clean), { sha, message, token });
  for (const page of MENU_PAGES) {
    let file;
    try {
      file = await readRepoFile(page, token);
    } catch (err) {
      continue;
    }
    let html = setMenu(file.text, groups, "lessons/");
    if (page === "index.html") html = setIndexPanels(html, groups);
    if (html !== file.text) await writeRepoFile(page, html, { sha: file.sha, message, token });
  }
}

async function createLessonFiles({ lessonId, titleText, sourceText, afterLessonId, token }) {
  const title = quoteTitle(titleText);
  const ref = sourceText.trim();
  const { site, sha } = await readSite(token);

  let group = site.groups.find((g) => g.title === ref);
  if (!group) {
    group = { title: ref, lessons: [] };
    site.groups.push(group);
  }
  if (afterLessonId && !group.lessons.some((l) => l.id === afterLessonId)) {
    throw new Error("מיקום ההוספה לא נמצא באותו דף ועמוד.");
  }
  const at = afterLessonId ? group.lessons.findIndex((l) => l.id === afterLessonId) + 1 : group.lessons.length;
  group.lessons.splice(at, 0, { id: lessonId, title });

  // Series and masechet come from the lesson before it.
  const all = [].concat(...site.groups.map((g) => g.lessons));
  const prev = all[all.findIndex((l) => l.id === lessonId) - 1];
  let like = null;
  if (prev) {
    try { like = JSON.parse((await readRepoFile(dataPath(prev.id), token)).text); } catch (err) { like = null; }
  }

  const message = `הוספת שיעור חדש: ${lessonId} (דרך פאנל הניהול)`;
  // Files first: if a later step fails the site has an unlinked lesson, never a link to a missing one.
  await writeRepoFile(dataPath(lessonId), formatLessonJson(newLessonData({ title, ref, like })), { message, token });
  await writeRepoFile(`lessons/${lessonId}.html`, lessonShellHtml({ id: lessonId, title }), { message, token });
  await publishSite({ site, sha, token, message });
}

exports.createLesson = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }

  const { lessonId, titleText, sourceText, afterLessonId } = request.data || {};
  if (!isValidLessonId(lessonId)) {
    throw new HttpsError("invalid-argument", "מזהה שיעור לא תקין (אותיות אנגליות קטנות, ספרות ומקפים בלבד).");
  }
  if (typeof titleText !== "string" || !titleText.trim()) {
    throw new HttpsError("invalid-argument", "צריך כותרת (דיבור המתחיל) לשיעור.");
  }
  if (typeof sourceText !== "string" || !sourceText.trim()) {
    throw new HttpsError("invalid-argument", "צריך לציין על איזה דף ועמוד השיעור.");
  }
  if (afterLessonId !== undefined && afterLessonId !== null && !isValidLessonId(afterLessonId)) {
    throw new HttpsError("invalid-argument", "מיקום הוספה לא תקין.");
  }

  const token = GITHUB_TOKEN.value();
  if (await fileExists(`contents/lessons/${lessonId}.html`, token) || await fileExists(`contents/${dataPath(lessonId)}`, token)) {
    throw new HttpsError("already-exists", "כבר קיים שיעור עם המזהה הזה.");
  }

  try {
    await createLessonFiles({ lessonId, titleText: titleText.trim(), sourceText: sourceText.trim(), afterLessonId: afterLessonId || null, token });
    return { ok: true, lessonId };
  } catch (err) {
    logger.error(`createLesson failed for ${lessonId}`, err);
    throw new HttpsError("internal", err.message || "יצירת השיעור נכשלה. נסו שוב.");
  }
});

// Swaps a lesson with its neighbor within its own page/amud group.
async function moveLessonFiles({ lessonId, direction, token }) {
  const { site, sha } = await readSite(token);
  const group = site.groups.find((g) => g.lessons.some((l) => l.id === lessonId));
  if (!group) throw new Error("השיעור לא נמצא.");
  const L = group.lessons, i = L.findIndex((l) => l.id === lessonId);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0) throw new Error("השיעור כבר ראשון ברשימה.");
  if (j >= L.length) throw new Error("השיעור כבר אחרון ברשימה.");
  [L[i], L[j]] = [L[j], L[i]];
  await publishSite({ site, sha, token, message: `שינוי סדר שיעורים: ${lessonId} (דרך פאנל הניהול)` });
}

exports.moveLesson = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }
  const { lessonId, direction } = request.data || {};
  if (!isValidLessonId(lessonId)) {
    throw new HttpsError("invalid-argument", "שיעור לא מוכר.");
  }
  if (direction !== "up" && direction !== "down") {
    throw new HttpsError("invalid-argument", "כיוון לא תקין.");
  }
  try {
    await moveLessonFiles({ lessonId, direction, token: GITHUB_TOKEN.value() });
    return { ok: true };
  } catch (err) {
    logger.error(`moveLesson failed for ${lessonId}`, err);
    throw new HttpsError("internal", err.message || "שינוי הסדר נכשל. נסו שוב.");
  }
});

// Removes a lesson: first from the list and every page (so no link points
// at it), then its files.
async function deleteLessonFiles({ lessonId, token }) {
  const { site, sha } = await readSite(token);
  const group = site.groups.find((g) => g.lessons.some((l) => l.id === lessonId));
  if (!group) throw new Error("השיעור לא נמצא.");
  group.lessons = group.lessons.filter((l) => l.id !== lessonId);
  if (!site.groups.some((g) => g.lessons.length)) throw new Error("אי אפשר למחוק את השיעור האחרון באתר.");

  const message = `מחיקת שיעור: ${lessonId} (דרך פאנל הניהול)`;
  await publishSite({ site, sha, token, message });
  for (const path of [`lessons/${lessonId}.html`, dataPath(lessonId)]) {
    try {
      await deleteRepoFile(path, { message, token });
    } catch (err) {
      logger.warn(`deleteLesson: ${path} not removed`, err);
    }
  }
}

exports.deleteLesson = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }
  const { lessonId } = request.data || {};
  if (!isValidLessonId(lessonId)) {
    throw new HttpsError("invalid-argument", "שיעור לא מוכר.");
  }
  try {
    await deleteLessonFiles({ lessonId, token: GITHUB_TOKEN.value() });
    return { ok: true };
  } catch (err) {
    logger.error(`deleteLesson failed for ${lessonId}`, err);
    throw new HttpsError("internal", err.message || "המחיקה נכשלה. נסו שוב.");
  }
});
