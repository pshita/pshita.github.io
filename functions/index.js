const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const cheerio = require("cheerio");
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
const SMS4FREE_SENDER = defineSecret("SMS4FREE_SENDER");

// Set once via: firebase functions:secrets:set GITHUB_TOKEN
// A GitHub fine-grained personal access token scoped to this repo only,
// with Contents: Read and write permission.
const GITHUB_TOKEN = defineSecret("GITHUB_TOKEN");

// Send a parent SMS every time a student's quiz score crosses another
// multiple of this number (10, 20, 30, ...).
const MILESTONE_STEP = 10;

function countCorrect(sections) {
  if (!sections) return 0;
  return Object.values(sections).filter(Boolean).length;
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

// Fires on every write to a user's quiz-progress doc (users/{uid}/progress/quiz),
// which quiz.js updates each time a question is answered correctly for the
// first time. Compares the score before/after the write; if it just crossed
// a new MILESTONE_STEP multiple, texts the parents.
exports.notifyParentsOnQuizMilestone = onDocumentWritten(
  {
    document: "users/{uid}/progress/quiz",
    secrets: [SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS, SMS4FREE_SENDER],
  },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;

    const prevScore = countCorrect(before?.sections);
    const newScore = countCorrect(after.sections);
    if (newScore <= prevScore) return;

    const prevMilestone = Math.floor(prevScore / MILESTONE_STEP) * MILESTONE_STEP;
    const newMilestone = Math.floor(newScore / MILESTONE_STEP) * MILESTONE_STEP;
    if (newMilestone <= prevMilestone || newMilestone === 0) return;

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) return;
    const userData = userSnap.data();
    const recipients = [userData.fatherPhone, userData.motherPhone].filter(Boolean);
    if (recipients.length === 0) return;

    const fullName = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
    const msg = `${fullName}: ${newMilestone} נקודות בשיעורי "ארבעה אבות" 🎉`;

    try {
      await sendSms({
        key: SMS4FREE_KEY.value(),
        user: SMS4FREE_USER.value(),
        pass: SMS4FREE_PASS.value(),
        sender: SMS4FREE_SENDER.value(),
        recipient: recipients.join(";"),
        msg,
      });
      logger.info(`Notified parents of ${uid} at ${newMilestone} points`);
    } catch (err) {
      logger.error(`Failed to notify parents of ${uid} at ${newMilestone} points`, err);
    }
  }
);

// ---------------------------------------------------------------------
// Admin content panel: commits lesson edits straight to the GitHub repo
// so the change is baked into the static HTML (no runtime DB lookup).
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

// Paragraph text may carry lightweight inline markup: **bold** and
// _italic_, matching what admin.html's textarea buttons insert. Escape
// everything else first so the markers are the only way to produce tags.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownLiteToHtml(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/_(.+?)_/g, "<em>$1</em>");
  return out;
}

function renderQuizBlock($, block) {
  const $div = $("<div></div>").addClass("quiz");
  $div.attr("data-question-id", block.qid || "");
  if (block.marksSection) $div.attr("data-marks-section", block.marksSection);

  const $q = $("<p></p>").addClass("quiz-question").text(block.question || "");
  const $choicesWrap = $("<div></div>").addClass("quiz-choices");
  (block.choices || []).forEach((c) => {
    const $btn = $("<button></button>").attr("type", "button").addClass("quiz-choice").text(c.text || "");
    $btn.attr("data-correct", c.correct ? "true" : "false");
    $choicesWrap.append($btn);
  });
  const $feedback = $("<p></p>").addClass("quiz-feedback").attr("hidden", "");

  $div.append($q).append($choicesWrap).append($feedback);
  return $div;
}

// Builds one cheerio element per "box" block (a fresh <div class="intro-box">),
// appending every block that follows it until the next box marker.
function renderBoxes($, sections) {
  const boxes = [];
  let $current = null;
  (sections || []).forEach((block) => {
    if (block.type === "box") {
      $current = $("<div></div>").addClass("intro-box");
      boxes.push($current);
      return;
    }
    if (!$current) return;
    if (block.type === "heading") {
      const tag = ["h1", "h2", "h3"].includes(block.tag) ? block.tag : "h3";
      const $el = $(`<${tag}></${tag}>`).text(block.text || "");
      if (block.cls) $el.addClass(block.cls);
      $current.append($el);
    } else if (block.type === "paragraphs") {
      (block.items || []).forEach((it) => {
        const $p = $("<p></p>").html(markdownLiteToHtml(it.text || ""));
        if (it.cls) $p.addClass(it.cls);
        $current.append($p);
      });
    } else if (block.type === "quiz") {
      $current.append(renderQuizBlock($, block));
    } else if (block.type === "raw" && block.html) {
      $current.append($(block.html));
    }
  });
  return boxes;
}

function validateSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return false;
  if (sections[0].type !== "box") return false;
  return sections.every((b) => ["box", "heading", "paragraphs", "quiz", "raw"].includes(b.type));
}

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

async function updateLessonFile({ lessonId, titleText, sections, token }) {
  const path = `contents/lessons/${lessonId}.html`;
  const current = await githubRequest(`${path}?ref=${REPO_BRANCH}`, { token });
  const currentHtml = Buffer.from(current.content, "base64").toString("utf8");

  const $ = cheerio.load(currentHtml);

  if (typeof titleText === "string" && titleText.trim()) {
    $(".lesson-title-row h1").text(titleText);
  }

  const existingBoxes = $(".intro-box");
  if (existingBoxes.length === 0) throw new Error("No .intro-box found in lesson file");
  const $anchor = existingBoxes.first();
  existingBoxes.slice(1).remove();

  const newBoxes = renderBoxes($, sections);
  newBoxes.forEach(($box) => $anchor.before($box));
  $anchor.remove();

  const newHtml = $.html();

  await githubRequest(path, {
    method: "PUT",
    token,
    body: {
      message: `עדכון תוכן: ${lessonId} (דרך פאנל הניהול)`,
      content: Buffer.from(newHtml, "utf8").toString("base64"),
      sha: current.sha,
      branch: REPO_BRANCH,
    },
  });
}

exports.saveLessonContent = onCall({ secrets: [GITHUB_TOKEN] }, async (request) => {
  if (!request.auth || request.auth.token.email !== ALLOWED_EMAIL) {
    throw new HttpsError("permission-denied", "אין הרשאה לערוך תוכן באתר.");
  }

  const { lessonId, titleText, sections } = request.data || {};
  if (!isValidLessonId(lessonId)) {
    throw new HttpsError("invalid-argument", "שיעור לא מוכר.");
  }
  if (!validateSections(sections)) {
    throw new HttpsError("invalid-argument", "מבנה התוכן שגוי.");
  }

  try {
    await updateLessonFile({ lessonId, titleText, sections, token: GITHUB_TOKEN.value() });
    return { ok: true };
  } catch (err) {
    logger.error(`saveLessonContent failed for ${lessonId}`, err);
    throw new HttpsError("internal", "השמירה נכשלה. נסו שוב.");
  }
});

// ---------------------------------------------------------------------
// Structure-agnostic text editing: the admin edits a piece of text where it
// shows on the page, and this replaces that exact text inside the page's
// source file - whether it sits in the HTML itself (between > and <) or in
// a JS string the page renders from (like the question-player lessons'
// LESSON data). Only whole values are replaced (the full text between its
// delimiters), never a fragment inside a longer string.
// ---------------------------------------------------------------------

const EDITABLE_PATH_RE = /^lessons\/[a-z0-9]+(-[a-z0-9]+)*\.html$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsQuote(s, q) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(q, "g"), "\\" + q)
    .replace(/\r?\n/g, "\\n")
    .replace(/<\//g, "<\\/");
}

function replaceWholeValue(src, oldText, newText) {
  let count = 0;
  let out = src;
  // Inside a JS string literal: '...', "..." or `...`.
  for (const q of ["'", '"', "`"]) {
    const re = new RegExp(escapeRegExp(q + jsQuote(oldText, q) + q), "g");
    out = out.replace(re, () => { count++; return q + jsQuote(newText, q) + q; });
  }
  // As an HTML text value: >old<
  const reHtml = new RegExp(">(\\s*)" + escapeRegExp(oldText) + "(\\s*)<", "g");
  out = out.replace(reHtml, (m, a, b) => { count++; return ">" + a + newText + b + "<"; });
  return { out, count };
}


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
// (lessons/<id>.html); the text lives in that lesson's data file. Pages
// that still carry their own content (older formats) are edited in the
// page file itself.
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
  let file, filePath, result;
  try {
    filePath = dataPath(id);
    file = await readRepoFile(filePath, token);
    const r = replaceInJson(JSON.parse(file.text), pairs);
    result = r && { out: formatLessonJson(r.out), count: r.count };
  } catch (err) {
    filePath = path;
    try {
      file = await readRepoFile(filePath, token);
    } catch (e) {
      throw new HttpsError("not-found", "העמוד לא נמצא.");
    }
    result = null;
    for (const [oldText, newText] of pairs) {
      const r = replaceWholeValue(file.text, oldText, newText);
      if (r.count) { result = r; break; }
    }
  }
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
  return { ok: true, src: out };
});

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
