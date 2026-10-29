// Admin page (admin.html), for the site admin only:
// - "תלמידים": a table of every student: name and parents' phones (editable), the
//   lessons they did, correct answers, and their own message settings (on / off /
//   the default, every how many answers);
// - "הודעות": the default for everyone (on / off, every how many answers), the
//   sender, a copy of every message to the sender and the text (settings/sms, used
//   by functions/index.js), and below, every message sent (smsLog), with its date;
// - "יעדים": the lessons students see in the menu (settings/goals; see header-auth.js).
import { watchAuthState, getDb, getApp, isReady } from "./auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteField,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
// the same defaults as the server (functions/index.js)
const SMS_DEFAULTS = { enabled: false, step: 10, sender: "", template: "{פרטי} ענה נכון על {תשובות} שאלות בשיעורי הגמרא באתר פשיטא 🎉" };
// the older names of the placeholders, shown with the current ones
const newTokens = (t) => t.split("{שם מלא}").join("{פרטי}").split("{שם}").join("{פרטי}").split("{מספר}").join("{תשובות}");

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const errText = (err) => (err && (err.message || err.code)) || "שגיאה";
let STUDENTS = [], LESSONS = [], GROUPS = [], GOALS = [], SMS = { ...SMS_DEFAULTS }, LOG_LOADED = false;

if (!isReady()) $("adm-gate").textContent = "החיבור לנתונים לא מוגדר באתר.";
else watchAuthState((user) => {
  if (!user || user.email !== ADMIN_EMAIL) {
    $("adm-gate").hidden = false;
    $("adm-main").hidden = true;
    $("adm-gate").textContent = "העמוד הזה רק למנהל האתר.";
    return;
  }
  start(user).catch((err) => {
    $("adm-gate").hidden = false;
    $("adm-gate").textContent = "לא הצלחתי לטעון את הנתונים: " + errText(err);
  });
});

async function start(admin) {
  const db = getDb();
  const [site, settings, users, goals] = await Promise.all([
    fetch("lessons.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ groups: [] })),
    getDoc(doc(db, "settings", "sms")),
    getDocs(collection(db, "users")),
    getDoc(doc(db, "settings", "goals")),
  ]);
  GROUPS = site.groups.filter((g) => g.lessons.length);
  LESSONS = GROUPS.flatMap((g) => g.lessons);
  GOALS = (goals.exists() && Array.isArray(goals.data().lessons) && goals.data().lessons) || [];
  if (settings.exists()) SMS = { ...SMS_DEFAULTS, ...settings.data() };
  const list = [];
  users.forEach((u) => { if (u.id !== admin.uid) list.push({ id: u.id, ...u.data() }); });
  await Promise.all(list.map(async (s) => {
    const [quiz, lessons, time] = await Promise.all([
      getDoc(doc(db, "users", s.id, "progress", "quiz")).catch(() => null),
      getDoc(doc(db, "users", s.id, "progress", "lessons")).catch(() => null),
      getDoc(doc(db, "users", s.id, "progress", "time")).catch(() => null),
    ]);
    s.time = (time && time.exists() && time.data()) || {};
    s.correct = (quiz && quiz.exists() && quiz.data().sections) || {};
    s.finished = (lessons && lessons.exists() && lessons.data().lessons) || {};
  }));
  STUDENTS = list.sort((a, b) => fullName(a).localeCompare(fullName(b), "he"));
  $("adm-gate").hidden = true;
  $("adm-main").hidden = false;
  drawStudents();
  fillSms();
  drawGoals();
  showTab({ "#sms": "sms", "#log": "sms", "#goals": "goals" }[location.hash] || "students");
}

// Fields are as wide as their text (CSS field-sizing); where the browser doesn't
// do that yet, here.
const FIT = !(window.CSS && CSS.supports("field-sizing", "content"));
function fit(el) {
  if (!FIT) return;
  const len = [...(el.value || el.placeholder || "")].length;
  if (el.tagName === "TEXTAREA") { el.style.width = "100%"; el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
  else if (el.type === "number") el.style.width = `${Math.max(2, len) + 1}ch`;
  else el.size = Math.max(2, len + 1);
}
const fitAll = (root) => root.querySelectorAll("input[type=text], input[type=tel], input[type=number], textarea").forEach(fit);
document.addEventListener("input", (e) => { if (e.target.matches && e.target.matches("input, textarea")) fit(e.target); });

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".adm-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["students", "sms", "goals"].forEach((t) => { $("tab-" + t).hidden = t !== name; });
  fitAll($("tab-" + name));
  history.replaceState(null, "", name === "students" ? location.pathname : "#" + name);
  if (name === "sms" && !LOG_LOADED) loadLog();
}
document.querySelector(".adm-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) showTab(b.dataset.tab);
});

// ---------- students ----------
const fullName = (s) => `${s.firstName || ""} ${s.lastName || ""}`.trim() || "ללא שם";
const countOf = (s) => Object.values(s.correct).filter(Boolean).length;
const dateOf = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }); };
const timeOf = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("he-IL", { day: "numeric", month: "numeric", year: "2-digit", hour: "2-digit", minute: "2-digit" }); };

// This student's messages, the same rule as studentPlan in functions/index.js.
const modeOf = (s) => (s.smsMode === "on" || s.smsMode === "off" ? s.smsMode : s.notify === false ? "off" : "default");
function planOf(s) {
  const mode = modeOf(s);
  return { on: mode === "on" || (mode === "default" && SMS.enabled), step: Number.isInteger(s.smsStep) && s.smsStep > 0 ? s.smsStep : SMS.step };
}
// Time spent learning (see student.js): the total, and opened, each day newest first.
const hm = (secs) => { const m = Math.round((secs || 0) / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
function timeHtml(t) {
  const days = Object.entries(t.days || {}).filter(([, v]) => v > 0).sort((a, b) => b[0].localeCompare(a[0]));
  if (!days.length) return '<span class="adm-dim">—</span>';
  const day = (k) => { const [y, m, d] = k.split("-"); return `${+d}.${+m}.${y.slice(2)}`; };
  return `<details><summary class="num">${hm(t.total)}</summary><div class="adm-pills">${days.map(([k, v]) => `<span>${day(k)} <i>${hm(v)}</i></span>`).join("")}</div></details>`;
}

function rowHtml(s) {
  // lessons in site order: correct answers in each, and how many times it was finished
  const times = (id) => (s.finished[id] && s.finished[id].times) || 0;
  const perLesson = {};
  Object.keys(s.correct).forEach((q) => { if (s.correct[q] && q.includes(":")) { const id = q.split(":")[0]; perLesson[id] = (perLesson[id] || 0) + 1; } });
  const did = LESSONS.filter((l) => perLesson[l.id] || times(l.id));
  const done = did.filter((l) => times(l.id)).length;
  const pills = did.map((l) => `<span class="adm-pill${times(l.id) ? " done" : ""}">${"✓".repeat(Math.min(times(l.id), 10))}${times(l.id) ? " " : ""}${esc(l.title)} <i>${perLesson[l.id] || 0}</i></span>`).join("");
  const lessons = did.length ? `<details><summary>${did.length}${done ? ` (סיים ${done})` : ""}</summary><div class="adm-pills">${pills}</div></details>` : '<span class="adm-dim">—</span>';
  const mode = modeOf(s);
  return `<tr data-id="${esc(s.id)}">
    <td><input type="text" class="name" data-f="firstName" value="${esc(s.firstName || "")}" autocomplete="off"></td>
    <td><input type="text" class="name" data-f="lastName" value="${esc(s.lastName || "")}" autocomplete="off"></td>
    <td><input type="tel" data-f="fatherPhone" value="${esc(s.fatherPhone || "")}" placeholder="05XXXXXXXX" inputmode="tel" autocomplete="off"></td>
    <td><input type="tel" data-f="motherPhone" value="${esc(s.motherPhone || "")}" placeholder="05XXXXXXXX" inputmode="tel" autocomplete="off"></td>
    <td>${lessons}</td>
    <td class="num">${countOf(s)}</td>
    <td>${timeHtml(s.time)}</td>
    <td><select data-f="smsMode">
      <option value="default"${mode === "default" ? " selected" : ""}>ברירת מחדל</option>
      <option value="on"${mode === "on" ? " selected" : ""}>פתוחה</option>
      <option value="off"${mode === "off" ? " selected" : ""}>סגורה</option>
    </select></td>
    <td><input type="number" class="step" data-f="smsStep" min="1" max="500" inputmode="numeric" value="${Number.isInteger(s.smsStep) ? s.smsStep : ""}" placeholder="${SMS.step}"><span class="adm-status"></span></td>
  </tr>`;
}

function drawStudents() {
  $("adm-list").innerHTML = STUDENTS.map(rowHtml).join("");
  fitAll($("adm-list"));
}

function rowStatus(row, text, bad = false) {
  const st = row.querySelector(".adm-status");
  st.className = "adm-status" + (bad ? " err" : "");
  st.textContent = text;
  if (text === "נשמר ✓") setTimeout(() => { if (st.textContent === "נשמר ✓") st.textContent = ""; }, 2000);
}

// Every change in the table saves right away.
$("adm-list").addEventListener("change", async (e) => {
  const input = e.target.closest("[data-f]");
  if (!input) return;
  const row = input.closest("tr"), s = STUDENTS.find((x) => x.id === row.dataset.id), f = input.dataset.f;
  input.classList.remove("bad");
  const bad = (text) => { input.classList.add("bad"); rowStatus(row, text, true); };
  rowStatus(row, "שומר…");
  try {
    if (f === "firstName" || f === "lastName") {
      // the name is also the account's name (login list, "שלום ..."): changed on the server
      const first = row.querySelector('[data-f="firstName"]').value.trim(), last = row.querySelector('[data-f="lastName"]').value.trim();
      if (!first || !last) return bad("צריך שם פרטי ושם משפחה");
      const fns = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js");
      await fns.httpsCallable(fns.getFunctions(getApp()), "renameStudent")({ uid: s.id, firstName: first, lastName: last });
      s.firstName = first; s.lastName = last;
    } else if (f === "smsMode") {
      const v = input.value;
      // "default" removes the student's own setting (and the older on/off field)
      await updateDoc(doc(getDb(), "users", s.id), v === "default" ? { smsMode: deleteField(), notify: deleteField() } : { smsMode: v, notify: deleteField() });
      if (v === "default") delete s.smsMode; else s.smsMode = v;
      delete s.notify;
    } else if (f === "smsStep") {
      const raw = input.value.trim(), v = Math.round(+raw);
      if (raw && !(v >= 1 && v <= 500)) return bad("בין 1 ל-500");
      await updateDoc(doc(getDb(), "users", s.id), { smsStep: raw ? v : deleteField() });
      if (raw) { s.smsStep = v; input.value = v; } else delete s.smsStep;
    } else {
      const v = input.value.replace(/[^0-9]/g, "");
      if (v && !/^05\d{8}$/.test(v)) return bad("10 ספרות, מתחיל ב-05");
      input.value = v;
      await updateDoc(doc(getDb(), "users", s.id), { [f]: v });
      s[f] = v;
    }
    rowStatus(row, "נשמר ✓");
  } catch (err) {
    rowStatus(row, "לא נשמר: " + errText(err), true);
  }
});

// ---------- the message to the parents ----------
const fillTemplate = (t, count) => newTokens(t).split("{פרטי}").join("ישראל").split("{תשובות}").join(String(count));
function fillSms() {
  $("sms-enabled").checked = SMS.enabled === true;
  $("sms-step").value = SMS.step;
  $("sms-sender").value = SMS.sender || "";
  $("sms-copy").checked = SMS.copyToMe === true;
  $("sms-template").value = newTokens(SMS.template);
  countChars();
  fitAll($("tab-sms"));
}
// Length of the message as sent (with an example name).
function countChars() {
  const text = fillTemplate($("sms-template").value, +$("sms-step").value || SMS_DEFAULTS.step);
  const n = [...text].length;
  $("sms-length").textContent = `(${n} תווים)`;
}
$("sms-step").addEventListener("input", countChars);
$("sms-template").addEventListener("input", countChars);
document.querySelector(".adm-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ins]");
  if (!b) return;
  const t = $("sms-template");
  t.setRangeText(b.dataset.ins, t.selectionStart, t.selectionEnd, "end");
  t.focus();
  countChars();
});
// Saved automatically: a moment after typing in the text, right away for the rest.
let SAVE_T;
async function saveSms() {
  clearTimeout(SAVE_T);
  const step = Math.round(+$("sms-step").value), template = $("sms-template").value.trim();
  const sender = $("sms-sender").value.trim().replace(/[\s-]/g, ""), status = $("sms-status");
  const fail = (t) => { status.className = "adm-status err"; status.textContent = t; };
  if (!(step >= 1 && step <= 500)) return fail("מספר התשובות צריך להיות בין 1 ל-500.");
  if (!template) return fail("נוסח ההודעה ריק.");
  if (sender && !/^0\d{8,9}$/.test(sender) && !/^[A-Za-z][A-Za-z0-9]{1,10}$/.test(sender)) return fail("מספר השולח לא תקין.");
  status.textContent = "";
  try {
    const enabled = $("sms-enabled").checked, copyToMe = $("sms-copy").checked;
    await setDoc(doc(getDb(), "settings", "sms"), { enabled, step, template, sender, copyToMe, updatedAt: new Date().toISOString() }, { merge: true });
    SMS = { ...SMS, enabled, step, template, sender, copyToMe };
    $("sms-sender").value = sender;
    drawStudents();
  } catch (err) {
    fail("השמירה לא הצליחה: " + errText(err));
  }
}
["sms-enabled", "sms-step", "sms-sender", "sms-copy"].forEach((id) => $(id).addEventListener("change", saveSms));
$("sms-template").addEventListener("input", () => { clearTimeout(SAVE_T); SAVE_T = setTimeout(saveSms, 800); });
$("sms-template").addEventListener("change", saveSms);
document.querySelector(".adm-chips").addEventListener("click", (e) => { if (e.target.closest("[data-ins]")) saveSms(); });

// ---------- archive: every message sent, newest first ----------
async function loadLog() {
  LOG_LOADED = true;
  $("log-note").textContent = "טוען…";
  try {
    const snap = await getDocs(collection(getDb(), "smsLog"));
    const rows = [];
    snap.forEach((d) => rows.push(d.data()));
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    $("log-list").innerHTML = rows.map((r) => `<tr class="${r.ok ? "" : "failed"}">
      <td class="when">${esc(timeOf(r.at))}</td>
      <td>${esc(r.name || "")}${r.kind === "test" ? ' <span class="adm-tag">בדיקה</span>' : ""}</td>
      <td class="phones">${(r.to || []).map(esc).join("<br>")}</td>
      <td class="msg">${esc(r.msg || "")}</td>
      <td>${r.ok ? "נשלחה" : `<span class="adm-err">לא נשלחה</span><div class="adm-dim">${esc(r.error || "")}</div>`}</td>
    </tr>`).join("");
    $("log-note").textContent = rows.length ? `${rows.length} הודעות` : "עדיין לא נשלחו הודעות.";
  } catch (err) {
    LOG_LOADED = false;
    $("log-note").textContent = "הארכיון לא נטען: " + errText(err);
  }
}

// ---------- goals: the lessons students see in the menu ----------
function drawGoals() {
  $("goals-list").innerHTML = GROUPS.map((g) => `<div class="adm-goals">
    <p class="adm-label">${esc(g.title)}</p>
    ${g.lessons.map((l) => `<label class="adm-switch"><input type="checkbox" data-goal="${esc(l.id)}"${GOALS.includes(l.id) ? " checked" : ""}> ${esc(l.title)}</label>`).join("")}
  </div>`).join("");
}
$("goals-list").addEventListener("change", async () => {
  const status = $("goals-status");
  const lessons = [...$("goals-list").querySelectorAll("[data-goal]:checked")].map((x) => x.dataset.goal);
  status.className = "adm-status";
  status.textContent = "";
  try {
    await setDoc(doc(getDb(), "settings", "goals"), { lessons, updatedAt: new Date().toISOString() });
    GOALS = lessons;
  } catch (err) {
    status.className = "adm-status err";
    status.textContent = "השמירה לא הצליחה: " + errText(err);
  }
});
