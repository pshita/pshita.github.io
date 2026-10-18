const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const cheerio = require("cheerio");

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

function submenuLinksHtml(entries, hrefPrefix) {
  return entries
    .map((e) => `            <a class="dropdown-item" href="${hrefPrefix}${e.id}.html">${escapeHtml(e.title)}</a>`)
    .join("\n");
}

// Renders a lesson's prev/next nav div for a given position in the full
// site-wide lesson order. Matches the three shapes already in use: "single"
// with only a next button (first lesson ever), "single" with only a prev
// button (last lesson ever), or both buttons (everyone else).
function renderLessonNavHtml(prevId, nextId) {
  const single = !prevId || !nextId;
  const prevBtn = prevId ? `<a class="lesson-nav-btn lesson-nav-btn--secondary" href="${prevId}.html">לשיעור הקודם</a>\n      ` : "";
  const nextBtn = nextId ? `<a class="lesson-nav-btn" href="${nextId}.html">לשיעור הבא</a>\n    ` : "";
  return `<div class="lesson-nav${single ? " single" : ""}">\n      ${prevBtn}${nextBtn}</div>`;
}

function renderNewLessonHtml({ lessonId, titleText, sourceText, prevId, allEntries }) {
  const title = escapeHtml(titleText);
  const source = escapeHtml(sourceText);
  return `<!DOCTYPE html><html lang="he" dir="rtl"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | ארבעה אבות</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
  <link href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@500;700&amp;family=Heebo:wght@300;400;600&amp;family=Rubik:wght@400;600;700&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../assets/css/style.css?v=45">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <div class="dropdown brand-dropdown">
        <button type="button" class="brand dropdown-trigger">
          <span class="mark">📖</span>
          <span>פשיטא</span>
        </button>
        <div class="dropdown-menu brand-menu" hidden="">
          <div class="submenu">
            <button type="button" class="dropdown-item submenu-trigger">
              <span>ארבעה אבות</span>
              <svg class="submenu-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div class="dropdown-menu submenu-panel" hidden="">
${submenuLinksHtml(allEntries, "")}
            </div>
          </div>
          <div class="auth-area" id="auth-area-out">
            <a class="auth-link auth-link-primary" href="../login.html">התחברות</a>
          </div>
          <div class="auth-area" id="auth-area-in" hidden="">
            <a class="score-badge" id="score-badge" href="../achievements.html" hidden=""></a>
            <span class="auth-user-name" id="auth-user-name"></span>
            <button type="button" class="auth-link auth-link-primary" id="logout-btn">התנתקות</button>
          </div>
        </div>
      </div>
    </div>
    <div class="reading-progress" id="reading-progress"><span class="reading-progress-fill" id="reading-progress-fill"></span></div>
  </header>

  <main class="wrap" style="padding-top: 34px;">
    <div class="lesson-title-row">
      <h1 class="lesson-title">${title}</h1>
      <span class="lesson-source">${source}</span>
    </div>

    <div class="intro-box"><p class="p-light">כאן יופיע תוכן השיעור.</p></div>

    ${renderLessonNavHtml(prevId, null)}
  </main>

  <footer class="site-footer"></footer>

  <script src="../assets/js/main.js?v=2"></script>
  <script src="../assets/js/reading-progress.js"></script>
  <script type="module" src="../assets/js/header-auth.js?v=1"></script>
  <script type="module" src="../assets/js/score.js"></script>
  <script type="module" src="../assets/js/quiz.js?v=12"></script>
  <script type="module" src="../assets/js/content-editor.js"></script>


</body></html>`;
}

function renderNewGroupPanelHtml(sourceText, lessonId, titleText) {
  const source = escapeHtml(sourceText);
  return `<div class="dropdown group-title-dropdown">
      <div class="group-panel">
        <button type="button" class="group-title dropdown-trigger">
          <span>${source}</span>
          <span class="group-progress" hidden></span>
          <svg class="group-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="dropdown-menu lessons-menu">
        <div class="lesson-grid">
          <a class="lesson-card" href="lessons/${lessonId}.html">
            <h3>${escapeHtml(titleText)}</h3>
          </a>
        </div>
        </div>
      </div>
    </div>`;
}

// Reads index.html's lesson grid(s) - the source of truth for every existing
// lesson's id, title, order and which page-group (e.g. "דף ב, עמוד א") it
// belongs to - so none of this needs to live in this file's own code.
// `panelEl` is the live cheerio node for that group's .group-panel (present
// only for groups that already exist in $index; a newly-created group is
// pushed onto the array without one, and gets it filled in once its panel
// markup is inserted).
function readLessonGroups($index) {
  const groups = [];
  $index(".group-panel").each((i, panel) => {
    const $panel = $index(panel);
    const title = $panel.find(".group-title span").first().text().trim();
    const entries = [];
    $panel.find(".lesson-card").each((j, card) => {
      const $card = $index(card);
      const href = $card.attr("href") || "";
      const m = href.match(/^lessons\/([a-z0-9-]+)\.html$/);
      if (m) entries.push({ id: m[1], title: $card.find("h3").text().trim() });
    });
    groups.push({ title, entries, panelEl: $panel });
  });
  return groups;
}

function flattenGroups(groups) {
  const out = [];
  groups.forEach((g) => g.entries.forEach((e) => out.push(e)));
  return out;
}

// Rewrites every page so its lesson cards, submenu and (for lesson pages)
// prev/next nav all match `groups`' order. Used both for inserting a lesson
// at an arbitrary position and for reordering existing ones - either way,
// the full site-wide order can change, so every page needs a fresh pass
// rather than a patch targeted at just the two lessons that moved.
async function rebuildAllPagesForOrder({ $index, indexCurrent, groups, token, commitMessage }) {
  groups.forEach((g) => {
    const cardsHtml = g.entries
      .map((e) => `<a class="lesson-card" href="lessons/${e.id}.html">\n            <h3>${escapeHtml(e.title)}</h3>\n          </a>`)
      .join("\n          ");
    g.panelEl.find(".lesson-grid").html(`\n          ${cardsHtml}\n        `);
  });

  const fullOrder = flattenGroups(groups);

  $index(".submenu-panel").html(`\n${submenuLinksHtml(fullOrder, "lessons/")}\n            `);
  await githubRequest("contents/index.html", {
    method: "PUT",
    token,
    body: {
      message: commitMessage,
      content: Buffer.from($index.html(), "utf8").toString("base64"),
      sha: indexCurrent.sha,
      branch: REPO_BRANCH,
    },
  });

  for (const page of ["login.html", "register.html", "achievements.html"]) {
    const path = `contents/${page}`;
    const current = await githubRequest(`${path}?ref=${REPO_BRANCH}`, { token });
    const html = Buffer.from(current.content, "base64").toString("utf8");
    const $ = cheerio.load(html);
    $(".submenu-panel").html(`\n${submenuLinksHtml(fullOrder, "lessons/")}\n            `);
    await githubRequest(path, {
      method: "PUT",
      token,
      body: {
        message: commitMessage,
        content: Buffer.from($.html(), "utf8").toString("base64"),
        sha: current.sha,
        branch: REPO_BRANCH,
      },
    });
  }

  for (let i = 0; i < fullOrder.length; i++) {
    const entry = fullOrder[i];
    const prevEntry = i > 0 ? fullOrder[i - 1] : null;
    const nextEntry = i < fullOrder.length - 1 ? fullOrder[i + 1] : null;
    const path = `contents/lessons/${entry.id}.html`;
    const current = await githubRequest(`${path}?ref=${REPO_BRANCH}`, { token });
    const html = Buffer.from(current.content, "base64").toString("utf8");
    const $ = cheerio.load(html);
    $(".submenu-panel").html(`\n${submenuLinksHtml(fullOrder, "")}\n            `);
    $(".lesson-nav").replaceWith(renderLessonNavHtml(prevEntry ? prevEntry.id : null, nextEntry ? nextEntry.id : null));
    await githubRequest(path, {
      method: "PUT",
      token,
      body: {
        message: commitMessage,
        content: Buffer.from($.html(), "utf8").toString("base64"),
        sha: current.sha,
        branch: REPO_BRANCH,
      },
    });
  }
}

async function createLessonFiles({ lessonId, titleText, sourceText, afterLessonId, token }) {
  const quotedTitle = quoteTitle(titleText);
  const trimmedSource = sourceText.trim();

  const indexPath = "contents/index.html";
  const indexCurrent = await githubRequest(`${indexPath}?ref=${REPO_BRANCH}`, { token });
  const indexHtml = Buffer.from(indexCurrent.content, "base64").toString("utf8");
  const $index = cheerio.load(indexHtml);

  const groups = readLessonGroups($index);
  if (!groups.length) throw new Error("No existing lessons found in index.html");
  const flatBefore = flattenGroups(groups);
  const prevId = flatBefore[flatBefore.length - 1].id;

  let targetGroup = groups.find((g) => g.title === trimmedSource);
  const isNewGroup = !targetGroup;
  if (isNewGroup) {
    targetGroup = { title: trimmedSource, entries: [], panelEl: null };
    groups.push(targetGroup);
  }

  if (afterLessonId && !targetGroup.entries.some((e) => e.id === afterLessonId)) {
    throw new Error("מיקום ההוספה לא נמצא באותו דף ועמוד.");
  }

  const newEntry = { id: lessonId, title: quotedTitle };
  if (afterLessonId) {
    const idx = targetGroup.entries.findIndex((e) => e.id === afterLessonId);
    targetGroup.entries.splice(idx + 1, 0, newEntry);
  } else {
    targetGroup.entries.push(newEntry);
  }

  // 1) Create the new lesson file first (placeholder prev/submenu - the
  // rebuild pass below fixes it to its real, possibly non-last, position).
  // If a later step fails, the site ends up with an unlinked page rather
  // than a link to a missing one.
  const allEntries = flattenGroups(groups);
  const newHtml = renderNewLessonHtml({ lessonId, titleText: quotedTitle, sourceText: trimmedSource, prevId, allEntries });
  await githubRequest(`contents/lessons/${lessonId}.html`, {
    method: "PUT",
    token,
    body: {
      message: `הוספת שיעור חדש: ${lessonId} (דרך פאנל הניהול)`,
      content: Buffer.from(newHtml, "utf8").toString("base64"),
      branch: REPO_BRANCH,
    },
  });

  // 2) A brand new page-group needs its panel markup inserted into
  // index.html before the rebuild pass can fill its lesson-grid.
  if (isNewGroup) {
    $index("main.wrap").append(renderNewGroupPanelHtml(trimmedSource, lessonId, quotedTitle));
    targetGroup.panelEl = $index(".group-panel").filter(
      (i, panel) => $index(panel).find(".group-title span").first().text().trim() === trimmedSource
    ).first();
  }

  // 3) Rewrite every page (cards, submenus, nav) to match the final order.
  await rebuildAllPagesForOrder({
    $index,
    indexCurrent,
    groups,
    token,
    commitMessage: `הוספת שיעור חדש: ${lessonId} (דרך פאנל הניהול)`,
  });
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
  if (await fileExists(`contents/lessons/${lessonId}.html`, token)) {
    throw new HttpsError("already-exists", "כבר קיים שיעור עם המזהה הזה.");
  }

  try {
    await createLessonFiles({
      lessonId,
      titleText: titleText.trim(),
      sourceText: sourceText.trim(),
      afterLessonId: afterLessonId || null,
      token,
    });
    return { ok: true, lessonId };
  } catch (err) {
    logger.error(`createLesson failed for ${lessonId}`, err);
    throw new HttpsError("internal", err.message || "יצירת השיעור נכשלה. נסו שוב.");
  }
});

// Swaps a lesson with its neighbor within its own page-group (the same
// "דף ועמוד" it's already listed under) - moving it across groups isn't
// supported, since that would mean re-deciding which group it belongs to.
async function moveLessonFiles({ lessonId, direction, token }) {
  const indexPath = "contents/index.html";
  const indexCurrent = await githubRequest(`${indexPath}?ref=${REPO_BRANCH}`, { token });
  const indexHtml = Buffer.from(indexCurrent.content, "base64").toString("utf8");
  const $index = cheerio.load(indexHtml);

  const groups = readLessonGroups($index);
  const group = groups.find((g) => g.entries.some((e) => e.id === lessonId));
  if (!group) throw new Error("השיעור לא נמצא.");

  const idx = group.entries.findIndex((e) => e.id === lessonId);
  if (direction === "up") {
    if (idx <= 0) throw new Error("השיעור כבר ראשון ברשימה.");
    [group.entries[idx - 1], group.entries[idx]] = [group.entries[idx], group.entries[idx - 1]];
  } else {
    if (idx >= group.entries.length - 1) throw new Error("השיעור כבר אחרון ברשימה.");
    [group.entries[idx + 1], group.entries[idx]] = [group.entries[idx], group.entries[idx + 1]];
  }

  await rebuildAllPagesForOrder({
    $index,
    indexCurrent,
    groups,
    token,
    commitMessage: `שינוי סדר שיעורים: ${lessonId} (דרך פאנל הניהול)`,
  });
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

// Removes a lesson entirely: drops it from its page/amud group (and that
// whole group's panel, if it was the last lesson in it), rewrites every
// page to match, and only then deletes the lesson's own file - the
// rebuild runs first so a failure partway through leaves an orphaned but
// still-existing file rather than a dangling link to a 404.
async function deleteLessonFiles({ lessonId, token }) {
  const indexPath = "contents/index.html";
  const indexCurrent = await githubRequest(`${indexPath}?ref=${REPO_BRANCH}`, { token });
  const indexHtml = Buffer.from(indexCurrent.content, "base64").toString("utf8");
  const $index = cheerio.load(indexHtml);

  const groups = readLessonGroups($index);
  const group = groups.find((g) => g.entries.some((e) => e.id === lessonId));
  if (!group) throw new Error("השיעור לא נמצא.");

  group.entries = group.entries.filter((e) => e.id !== lessonId);

  let remainingGroups = groups;
  if (group.entries.length === 0) {
    group.panelEl.closest(".group-title-dropdown").remove();
    remainingGroups = groups.filter((g) => g !== group);
  }
  if (flattenGroups(remainingGroups).length === 0) {
    throw new Error("אי אפשר למחוק את השיעור האחרון באתר.");
  }

  await rebuildAllPagesForOrder({
    $index,
    indexCurrent,
    groups: remainingGroups,
    token,
    commitMessage: `מחיקת שיעור: ${lessonId} (דרך פאנל הניהול)`,
  });

  const lessonPath = `contents/lessons/${lessonId}.html`;
  const lessonCurrent = await githubRequest(`${lessonPath}?ref=${REPO_BRANCH}`, { token });
  await githubRequest(lessonPath, {
    method: "DELETE",
    token,
    body: {
      message: `מחיקת שיעור: ${lessonId} (דרך פאנל הניהול)`,
      sha: lessonCurrent.sha,
      branch: REPO_BRANCH,
    },
  });
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
