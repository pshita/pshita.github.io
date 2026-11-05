const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const logger = require("firebase-functions/logger");
const {
  MENU_PAGES, formatLessonJson, formatSiteJson, lessonShellHtml, newLessonData, setIndexPanels, setMenu, nextLessonId,
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
//   template - the text; {כינוי} is the student's nickname (kept as firstName),
//              {היום} the correct answers since the last message, {סהכ} (or {תשובות})
//              all of them (the older {פרטי}, {שם}, {שם מלא}, {מספר} still work)
//   sender   - the number (or name) the message comes from, sent with each message
//   copyToMe - every message to parents also goes to the sender number
// A student may have their own: users/{uid}.smsMode ("on" / "off"; none = the
// default; the older notify === false also means off).
const SMS_DEFAULTS = {
  // the first message, once, to a student who registered from WELCOME_FROM on: what these messages are
  welcome: "שלום, {כינוי} נרשם לאתר ארבעה אבות ללימוד גמרא. מעכשיו תקבלו בכל ערב הודעה קצרה: על כמה שאלות ענה נכון באותו יום, ובסך הכול.",
  template: "{כינוי} ענה היום נכון על {היום} שאלות בשיעורי הגמרא באתר ארבעה אבות, ובסך הכול על {סהכ} 🎉",
};

async function smsSettings() {
  const snap = await db.collection("settings").doc("sms").get();
  const v = snap.exists ? snap.data() : {};
  const template = typeof v.template === "string" && v.template.trim() ? v.template : SMS_DEFAULTS.template;
  const sender = typeof v.sender === "string" ? v.sender.trim() : "";
  const welcome = typeof v.welcome === "string" && v.welcome.trim() ? v.welcome : SMS_DEFAULTS.welcome;
  return { template, welcome, enabled: v.enabled === true, sender, copyToMe: v.copyToMe === true };
}

// Whether this student's parents get messages.
function studentPlan(settings, userData) {
  const mode = userData.smsMode === "on" || userData.smsMode === "off" ? userData.smsMode
    : userData.notify === false ? "off" : "default";
  return { on: mode === "on" || (mode === "default" && settings.enabled) };
}

function smsText(template, userData, today, total) {
  const first = (userData.firstName || "").trim();
  const full = `${first} ${(userData.lastName || "").trim()}`.trim();
  return template.split("{שם מלא}").join(full).split("{שם}").join(first).split("{פרטי}").join(first).split("{כינוי}").join(first)
    .split("{היום}").join(String(today)).split("{סהכ}").join(String(total))
    .split("{מספר}").join(String(total)).split("{תשובות}").join(String(total));
}

function countCorrect(sections) {
  if (!sections) return 0;
  return Object.values(sections).reduce((n, v) => n + (v === true ? 1 : Number.isFinite(v) && v > 0 ? Math.min(v, MAX_PER_QUESTION) : 0), 0);
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
// true: no message actually goes out (everything else goes on as usual: the students see
// what their parents will get, the day's count starts over as if it was sent, so there's no
// flood of old counts afterwards). Nothing is written to the archive for a message not sent.
const SMS_PAUSED = false;

async function sendAndLog({ kind, uid = null, name = "", to, msg, count = null, sender }) {
  if (SMS_PAUSED) { logger.info(`SMS paused: not sent to ${to.join(";")}`); return; }
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

// Students registered before this get no first message (they knew already).
const WELCOME_FROM = "2026-11-04T16:50:00Z";
const needsWelcome = (userData) => userData.smsWelcomed !== true && typeof userData.createdAt === "string" && userData.createdAt >= WELCOME_FROM;

// Once a day the parents get a message: how many questions their child answered correctly
// since the last message ("today"; answers after the hour wait for the next one) and in all.
// users/{uid}.smsBase is the total at the last message (set when the student first answers,
// below). No message when nothing was answered, or when messages are off for the student.
async function sendDaily() {
  const settings = await smsSettings();
  const users = await db.collection("users").get();
  for (const u of users.docs) {
    try {
      const userData = u.data();
      const quiz = await u.ref.collection("progress").doc("quiz").get();
      const total = countCorrect(quiz.exists ? quiz.data().sections : null);
      const base = Number.isInteger(userData.smsBase) ? userData.smsBase : total;
      const today = total - base;
      if (!Number.isInteger(userData.smsBase)) await u.ref.update({ smsBase: total });
      if ((!Number.isInteger(userData.smsBase) || today <= 0) && !needsWelcome(userData)) continue;
      // the parents, and the student's own phone if given
      const recipients = [userData.fatherPhone, userData.motherPhone, userData.childPhone].filter(Boolean);
      if (!studentPlan(settings, userData).on || !recipients.length) { await u.ref.update({ smsBase: total }); continue; }
      const to = [...recipients];
      if (settings.copyToMe && /^0\d{8,9}$/.test(settings.sender) && !to.includes(settings.sender)) to.push(settings.sender);
      const name = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
      // a new student: the first message explains what these are; today's answers go in the next one
      if (needsWelcome(userData)) {
        await sendAndLog({ kind: "welcome", uid: u.id, name, to, msg: smsText(settings.welcome, userData, today, total), count: total, sender: settings.sender });
        if (!SMS_PAUSED) await u.ref.update({ smsWelcomed: true });  // while paused it waits to really go out
        continue;
      }
      if (!Number.isInteger(userData.smsBase) || today <= 0) continue;
      await sendAndLog({ kind: "daily", uid: u.id, name, to, msg: smsText(settings.template, userData, today, total), count: total, sender: settings.sender });
      await u.ref.update({ smsBase: total, lastSms: { at: new Date().toISOString(), count: total, today, seen: false } });
    } catch (err) {
      logger.error(`daily message for ${u.id} failed`, err);
    }
  }
}

const SMS_SECRETS = [SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS];
const DAILY = { timeZone: "Asia/Jerusalem", secrets: SMS_SECRETS, timeoutSeconds: 540 };
// Sunday to Thursday at 18:00, Friday at 13:00, Saturday night at 19:30
exports.parentsDailyWeekdays = onSchedule({ ...DAILY, schedule: "0 18 * * 0-4" }, sendDaily);
exports.parentsDailyFriday = onSchedule({ ...DAILY, schedule: "0 13 * * 5" }, sendDaily);
exports.parentsDailySaturday = onSchedule({ ...DAILY, schedule: "30 19 * * 6" }, sendDaily);

// The first correct answer since this began: the count before it is where "today" starts.
exports.parentsDailyStart = onDocumentWritten("users/{uid}/progress/quiz", async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const userRef = db.collection("users").doc(event.params.uid);
  const user = await userRef.get();
  if (!user.exists || Number.isInteger(user.get("smsBase"))) return;
  await userRef.update({ smsBase: countCorrect(before && before.sections) });
});

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

// Admin page: a student is deleted - the account, the profile and all their progress.
exports.deleteStudent = onCall(async (request) => {
  requireAdmin(request);
  const { uid } = request.data || {};
  if (typeof uid !== "string" || !uid) throw new HttpsError("invalid-argument", "תלמיד לא מוכר.");
  const user = await getAuth().getUser(uid).catch(() => null);
  if (user && user.email === ALLOWED_EMAIL) throw new HttpsError("failed-precondition", "אי אפשר למחוק את המנהל.");
  await db.recursiveDelete(db.collection("users").doc(uid));
  if (user) await getAuth().deleteUser(uid);
  return { ok: true };
});

// A new student registered: the admin gets a message (to the sender number on the admin
// page) with what the student filled in. Kept in the archive like the other messages.
exports.notifyAdminOnNewStudent = onDocumentCreated({ document: "users/{uid}", secrets: [SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS] }, async (event) => {
  const v = event.data ? event.data.data() : null;
  if (!v) return;
  const settings = await smsSettings();
  if (!/^0\d{8,9}$/.test(settings.sender)) return;
  const name = `${v.firstName || ""} ${v.lastName || ""}`.trim();
  const msg = [`נרשם תלמיד חדש: ${name}`, v.fatherPhone && `אבא: ${v.fatherPhone}`, v.motherPhone && `אמא: ${v.motherPhone}`, v.childPhone && `ילד: ${v.childPhone}`].filter(Boolean).join("\n");
  await sendAndLog({ kind: "newStudent", uid: event.params.uid, name, to: [settings.sender], msg, sender: settings.sender })
    .catch((err) => logger.error("new student message failed", err));
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
  // the admin isn't in the list: the admin signs in on the text page or the admin page
  const list = people
    .filter((p) => p.email !== ALLOWED_EMAIL)
    .map((p) => ({ name: p.name, email: p.email }))
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

// A lesson's content as sent from the text page: the expected shape, and not too big.
function validLesson(lesson) {
  return Boolean(lesson) && typeof lesson === "object" && !Array.isArray(lesson) && validLessonData(lesson) &&
    typeof lesson.title === "string" && Array.isArray(lesson.stations) &&
    lesson.stations.every((s) => typeof s === "string") && Array.isArray(lesson.screens) &&
    lesson.screens.length > 0 && lesson.screens.every((s) => s && typeof s === "object" && typeof s.type === "string") &&
    JSON.stringify(lesson).length <= 500000;
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
  if (!validLesson(lesson) || typeof base !== "string") {
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
  // The content is saved either way: a failure here is reported along with the new
  // source (so the next save isn't refused), and the next save of this lesson tries again.
  try {
    await withRetry((again) => syncLessonTitle(id, lesson.title, token, again));
  } catch (err) {
    logger.error(`saveLessonData: title sync failed for ${id}`, err);
    return { ok: true, src: out, titleError: true };
  }
  return { ok: true, src: out };
});

// Several lessons saved at once (a search and replace over all of them) change the
// same files (lessons.json, the pages with menus): a write that lost the race is
// refused by GitHub (409) and is done again from a fresh read.
async function withRetry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn(i > 0);
    } catch (err) {
      if (i >= tries - 1 || !/failed: (409|422)\b/.test(String(err && err.message))) throw err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1) + Math.random() * 700));
    }
  }
}

// A lesson's name in the lesson list, the menus and its page's tab. `again`: a retry
// after a refused write, when the list may already have the name but not every page.
async function syncLessonTitle(id, title, token, again = false) {
  const { site, sha } = await readSite(token);
  const entry = [].concat(...site.groups.map((g) => g.lessons)).find((l) => l.id === id);
  if (!entry || (entry.title === title && !again)) return;
  const message = `שינוי שם שיעור: ${id} (עריכה מעמוד הטקסט)`;
  if (entry.title !== title) {
    entry.title = title;
    await publishSite({ site, sha, token, message });
  } else {
    await publishSite({ site, sha: null, token, message, pagesOnly: true });
  }
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
async function publishSite({ site, sha, token, message, pagesOnly = false }) {
  const groups = site.groups.filter((g) => g.lessons.length);
  const clean = { groups };
  if (!pagesOnly) await writeRepoFile(SITE_JSON, formatSiteJson(clean), { sha, message, token });
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

  let { lessonId, titleText, sourceText, afterLessonId } = request.data || {};
  const token = GITHUB_TOKEN.value();
  // no id given: the next number in that daf and amud
  if (!lessonId && typeof sourceText === "string") lessonId = nextLessonId((await readSite(token)).site, sourceText);
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
// ---------------------------------------------------------------------
// Drafts: lessons being written on the text page ("עריכה"). Kept just like the
// lessons (lessons/data/<id>.json, and a page lessons/<id>.html to preview the
// lesson as students will see it), but not in lessons.json, so they appear in no
// list on the site; drafts.json lists them. Only the admin works with them.
// ---------------------------------------------------------------------
const DRAFTS_JSON = "drafts.json";

function requireAdmin(request) {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }
}

async function readDrafts(token) {
  let file;
  try {
    file = await readRepoFile(DRAFTS_JSON, token);
  } catch (err) {
    if (/failed: 404\b/.test(String(err && err.message))) return { sha: null, list: [] };
    throw err;
  }
  return { sha: file.sha, list: JSON.parse(file.text).drafts || [] };
}
const formatDrafts = (list) => `{\n  "drafts": [\n${list.map((d) => "    " + JSON.stringify(d)).join(",\n")}\n  ]\n}\n`;

// Change the list of drafts (read fresh each time, again if another save got there first).
function updateDrafts(token, message, change) {
  return withRetry(async () => {
    const { sha, list } = await readDrafts(token);
    const next = change(list.map((d) => ({ ...d })));
    if (JSON.stringify(next) !== JSON.stringify(list)) await writeRepoFile(DRAFTS_JSON, formatDrafts(next), { sha, message, token });
  });
}

const isSiteLesson = async (id, token) => (await readSite(token)).site.groups.some((g) => g.lessons.some((l) => l.id === id));

exports.listDrafts = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  requireAdmin(request);
  const token = GITHUB_TOKEN.value();
  const { list } = await readDrafts(token);
  const drafts = await Promise.all(list.map(async (d) => {
    try {
      return { ...d, src: (await readRepoFile(dataPath(d.id), token)).text };
    } catch (err) {
      return null;
    }
  }));
  return { drafts: drafts.filter(Boolean) };
});

// Save a draft (a new one gets its page and its place in drafts.json).
exports.saveDraft = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  requireAdmin(request);
  const { id, lesson, createdAt } = request.data || {};
  if (!isValidLessonId(id) || !validLesson(lesson)) throw new HttpsError("invalid-argument", "תוכן הטיוטה לא תקין.");
  const token = GITHUB_TOKEN.value(), message = `טיוטה: ${id} (עמוד הטקסט)`;
  let sha = null;
  try { sha = (await readRepoFile(dataPath(id), token)).sha; } catch (err) { sha = null; }
  if (!sha && await isSiteLesson(id, token)) throw new HttpsError("already-exists", "כבר יש שיעור עם המזהה הזה.");
  await writeRepoFile(dataPath(id), formatLessonJson(lesson), { sha, message, token });
  // a draft has no page of its own (no link): it's seen only on the text page ("מעוצב")
  await updateDrafts(token, message, (list) => {
    const title = lesson.title || "";
    const d = list.find((x) => x.id === id);
    if (d) d.title = title; else list.push({ id, title, createdAt: Number(createdAt) || Date.now() });
    return list;
  });
  return { ok: true };
});

exports.deleteDraft = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  requireAdmin(request);
  const { id } = request.data || {};
  if (!isValidLessonId(id)) throw new HttpsError("invalid-argument", "טיוטה לא מוכרת.");
  const token = GITHUB_TOKEN.value(), message = `מחיקת טיוטה: ${id} (עמוד הטקסט)`;
  if (await isSiteLesson(id, token)) throw new HttpsError("failed-precondition", "זה שיעור באתר, לא טיוטה.");
  await updateDrafts(token, message, (list) => list.filter((d) => d.id !== id));
  for (const path of [`lessons/${id}.html`, dataPath(id)]) {
    await deleteRepoFile(path, { message, token }).catch(() => {});
  }
  return { ok: true };
});

// A draft goes up to the site: under the given id, at the end of the given page/amud.
exports.publishDraft = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  requireAdmin(request);
  const { id, group } = request.data || {};
  let { lessonId } = request.data || {};
  const token = GITHUB_TOKEN.value();
  // no id given: the next number in that daf and amud
  if (!lessonId && typeof group === "string") lessonId = nextLessonId((await readSite(token)).site, group);
  if (!isValidLessonId(id) || !isValidLessonId(lessonId)) {
    throw new HttpsError("invalid-argument", "מזהה לא תקין (אותיות אנגליות קטנות, ספרות ומקפים בלבד).");
  }
  if (typeof group !== "string" || !group.trim()) throw new HttpsError("invalid-argument", "צריך לבחור דף ועמוד.");
  const message = `העלאת טיוטה לאתר: ${lessonId} (עמוד הטקסט)`;
  const { list } = await readDrafts(token);
  if (!list.some((d) => d.id === id)) throw new HttpsError("not-found", "הטיוטה לא נמצאה.");
  if (await isSiteLesson(lessonId, token)) throw new HttpsError("already-exists", "כבר יש שיעור עם המזהה הזה.");
  const data = await readRepoFile(dataPath(id), token);
  const lesson = JSON.parse(data.text);
  const title = String(lesson.title || "").trim() || lessonId;
  if (lessonId !== id) {
    if (await fileExists(`contents/${dataPath(lessonId)}`, token)) throw new HttpsError("already-exists", "כבר יש קובץ עם המזהה הזה.");
    await writeRepoFile(dataPath(lessonId), data.text, { message, token });
  }
  const shell = await readRepoFile(`lessons/${lessonId}.html`, token).catch(() => null);
  const html = lessonShellHtml({ id: lessonId, title });
  if (!shell || shell.text !== html) await writeRepoFile(`lessons/${lessonId}.html`, html, { sha: shell && shell.sha, message, token });
  await withRetry(async () => {
    const { site, sha } = await readSite(token);
    let g = site.groups.find((x) => x.title === group.trim());
    if (!g) { g = { title: group.trim(), lessons: [] }; site.groups.push(g); }
    if (!g.lessons.some((l) => l.id === lessonId)) g.lessons.push({ id: lessonId, title });
    await publishSite({ site, sha, token, message });
  });
  await updateDrafts(token, message, (l) => l.filter((d) => d.id !== id));
  if (lessonId !== id) {
    for (const path of [`lessons/${id}.html`, dataPath(id)]) await deleteRepoFile(path, { message, token }).catch(() => {});
  }
  const src = (await readRepoFile(dataPath(lessonId), token)).text;
  return { ok: true, src, title, lessonId };
});

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

// ---------- one time: lessons renamed from English names to numbers ----------
// The students' records (correct answers, lessons finished) and the goals list keep the
// lesson id, so they move to the new ids too. Safe to run again: done once, then a flag.
const RENAMED_LESSONS = {
  "avot-vetoldot": "211", "shor-umave": "212", "lo-hari-hashor": "213", "gabei-shabbat-tanan": "214",
  "umai-ika": "215", "gabei-tumaot-tanan": "216",
  "shlosha-avot-beshor": "221", "keren-manlan": "222", "toldah-dekeren": "223", "mai-shena-negicha": "224",
  "mai-shena-gabei-adam": "225", "muad-livhema": "226",
};
// for a short while they were "2-1-1" and so on
for (const id of Object.values(RENAMED_LESSONS)) RENAMED_LESSONS[id.split("").join("-")] = id;
const renamedId = (id) => RENAMED_LESSONS[id] || id;
// "avot-vetoldot:7" -> "2-1-1:7"
const renamedKey = (k) => { const i = k.lastIndexOf(":"); return i > 0 ? renamedId(k.slice(0, i)) + k.slice(i) : renamedId(k); };
function renameKeys(obj, rename, merge) {
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const nk = rename(k);
    if (nk !== k) changed = true;
    out[nk] = nk in out ? merge(out[nk], v) : v;
  }
  return { out, changed };
}
const asCount = (v) => (v === true ? 1 : Number.isFinite(v) ? v : 0);

exports.renameLessonIds = onCall(async (request) => {
  requireAdmin(request);
  const flag = db.doc("settings/migrations");
  if ((await flag.get()).get("lessonIds2")) return { ok: true, already: true };
  const users = await db.collection("users").get();
  let moved = 0;
  for (const u of users.docs) {
    const quizRef = u.ref.collection("progress").doc("quiz"), lessonsRef = u.ref.collection("progress").doc("lessons");
    const [quiz, lessons] = await Promise.all([quizRef.get(), lessonsRef.get()]);
    if (quiz.exists) {
      const { out, changed } = renameKeys(quiz.get("sections"), renamedKey, (a, b) => Math.max(asCount(a), asCount(b)));
      if (changed) { await quizRef.update({ sections: out }); moved++; }
    }
    if (lessons.exists) {
      const { out, changed } = renameKeys(lessons.get("lessons"), renamedId, (a, b) => ({ ...a, ...b, times: (a.times || 0) + (b.times || 0) }));
      if (changed) { await lessonsRef.update({ lessons: out }); moved++; }
    }
  }
  const goals = await db.doc("settings/goals").get();
  if (goals.exists && Array.isArray(goals.get("lessons"))) {
    await goals.ref.update({ lessons: [...new Set(goals.get("lessons").map(renamedId))] });
  }
  await flag.set({ lessonIds2: new Date().toISOString() }, { merge: true });
  return { ok: true, moved };
});
