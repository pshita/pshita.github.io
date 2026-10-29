// Admin page (admin.html), for the site admin only:
// - "תלמידים": a table of every student: name (editable), correct answers, the
//   lessons they did, parents' phones, and their own message settings (on / off /
//   the default, every how many answers);
// - "הודעה להורים": the default for everyone (on / off, every how many answers),
//   the sender and the text (settings/sms, used by notifyParentsOnQuizMilestone
//   in functions/index.js);
// - "ארכיון הודעות": every message sent (smsLog), with its date.
import { watchAuthState, getDb, getApp, isReady } from "./auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteField,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
// the same defaults as the server (functions/index.js)
const SMS_DEFAULTS = { enabled: false, step: 10, sender: "", template: "{שם} ענה נכון על {מספר} שאלות בשיעורי הגמרא באתר פשיטא 🎉" };
// every message is counted by this many characters (spaces included)
const SMS_CHARS = 134;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const errText = (err) => (err && (err.message || err.code)) || "שגיאה";
let STUDENTS = [], LESSONS = [], SMS = { ...SMS_DEFAULTS }, LOG_LOADED = false;

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
  const [site, settings, users] = await Promise.all([
    fetch("lessons.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ groups: [] })),
    getDoc(doc(db, "settings", "sms")),
    getDocs(collection(db, "users")),
  ]);
  LESSONS = site.groups.flatMap((g) => g.lessons);
  if (settings.exists()) SMS = { ...SMS_DEFAULTS, ...settings.data() };
  const list = [];
  users.forEach((u) => { if (u.id !== admin.uid) list.push({ id: u.id, ...u.data() }); });
  await Promise.all(list.map(async (s) => {
    const [quiz, lessons] = await Promise.all([
      getDoc(doc(db, "users", s.id, "progress", "quiz")).catch(() => null),
      getDoc(doc(db, "users", s.id, "progress", "lessons")).catch(() => null),
    ]);
    s.correct = (quiz && quiz.exists() && quiz.data().sections) || {};
    s.finished = (lessons && lessons.exists() && lessons.data().lessons) || {};
  }));
  STUDENTS = list.sort((a, b) => fullName(a).localeCompare(fullName(b), "he"));
  $("adm-gate").hidden = true;
  $("adm-main").hidden = false;
  drawStudents();
  fillSms();
  showTab({ "#sms": "sms", "#log": "log" }[location.hash] || "students");
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".adm-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["students", "sms", "log"].forEach((t) => { $("tab-" + t).hidden = t !== name; });
  history.replaceState(null, "", name === "students" ? location.pathname : "#" + name);
  if (name === "log" && !LOG_LOADED) loadLog();
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
// What will happen next with this student's parents.
function nextText(s) {
  const { on, step } = planOf(s);
  let t;
  if (!on) t = "כבויות";
  else if (!s.fatherPhone && !s.motherPhone) t = "אין טלפון";
  else { const left = step - (countOf(s) % step); t = `עוד ${left} ${left === 1 ? "תשובה" : "תשובות"}`; }
  return t + (s.lastSms ? ` · אחרונה: ${dateOf(s.lastSms.at)}` : "");
}

function rowHtml(s) {
  // lessons in site order: correct answers in each, and whether it was finished
  const perLesson = {};
  Object.keys(s.correct).forEach((q) => { if (s.correct[q] && q.includes(":")) { const id = q.split(":")[0]; perLesson[id] = (perLesson[id] || 0) + 1; } });
  const did = LESSONS.filter((l) => perLesson[l.id] || s.finished[l.id]);
  const done = did.filter((l) => s.finished[l.id]).length;
  const pills = did.map((l) => `<span class="adm-pill${s.finished[l.id] ? " done" : ""}" title="${s.finished[l.id] ? "סיים את השיעור" : "התחיל את השיעור"}">${s.finished[l.id] ? "✓ " : ""}${esc(l.title)} <i>${perLesson[l.id] || 0}</i></span>`).join("");
  const lessons = did.length ? `<details><summary>${did.length}${done ? ` (סיים ${done})` : ""}</summary><div class="adm-pills">${pills}</div></details>` : '<span class="adm-dim">—</span>';
  const mode = modeOf(s), def = SMS.enabled ? "פתוחה" : "סגורה";
  return `<tr data-id="${esc(s.id)}">
    <td><input type="text" class="name" data-f="firstName" value="${esc(s.firstName || "")}" autocomplete="off"></td>
    <td><input type="text" class="name" data-f="lastName" value="${esc(s.lastName || "")}" autocomplete="off"></td>
    <td class="num">${countOf(s)}</td>
    <td>${lessons}</td>
    <td><input type="tel" data-f="fatherPhone" value="${esc(s.fatherPhone || "")}" placeholder="05XXXXXXXX" inputmode="tel" autocomplete="off"></td>
    <td><input type="tel" data-f="motherPhone" value="${esc(s.motherPhone || "")}" placeholder="05XXXXXXXX" inputmode="tel" autocomplete="off"></td>
    <td><select data-f="smsMode">
      <option value="default"${mode === "default" ? " selected" : ""}>ברירת מחדל (${def})</option>
      <option value="on"${mode === "on" ? " selected" : ""}>פתוחה</option>
      <option value="off"${mode === "off" ? " selected" : ""}>סגורה</option>
    </select></td>
    <td><input type="number" class="step" data-f="smsStep" min="1" max="500" inputmode="numeric" value="${Number.isInteger(s.smsStep) ? s.smsStep : ""}" placeholder="${SMS.step}"></td>
    <td><span class="adm-next">${esc(nextText(s))}</span><span class="adm-status"></span></td>
  </tr>`;
}

function drawStudents() {
  const q = $("adm-search").value.trim();
  const shown = STUDENTS.filter((s) => !q || fullName(s).includes(q));
  $("adm-list").innerHTML = shown.map(rowHtml).join("") || '<tr><td colspan="9" class="adm-dim">אין תלמידים להצגה.</td></tr>';
  $("adm-count").textContent = q ? `${shown.length} מתוך ${STUDENTS.length}` : `${STUDENTS.length} תלמידים`;
}
$("adm-search").addEventListener("input", drawStudents);

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
    row.querySelector(".adm-next").textContent = nextText(s);
    rowStatus(row, "נשמר ✓");
  } catch (err) {
    rowStatus(row, "לא נשמר: " + errText(err), true);
  }
});

// ---------- the message to the parents ----------
const fillTemplate = (t, count) => t.split("{שם מלא}").join("ישראל ישראלי").split("{שם}").join("ישראל").split("{מספר}").join(String(count));
function fillSms() {
  $("sms-enabled").checked = SMS.enabled === true;
  $("sms-step").value = SMS.step;
  $("sms-sender").value = SMS.sender || "";
  $("sms-template").value = SMS.template;
  countChars();
}
// Length of the message as sent (with an example name), and how many messages it counts as.
function countChars() {
  const text = fillTemplate($("sms-template").value, +$("sms-step").value || SMS_DEFAULTS.step);
  const n = [...text].length, parts = Math.max(1, Math.ceil(n / SMS_CHARS));
  $("sms-length").textContent = `${n} תווים (עם שם לדוגמה) · ${parts === 1 ? "הודעה אחת" : `${parts} הודעות`} · כל הודעה עד ${SMS_CHARS} תווים כולל רווחים`;
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
$("sms-save").addEventListener("click", async () => {
  const step = Math.round(+$("sms-step").value), template = $("sms-template").value.trim();
  const sender = $("sms-sender").value.trim().replace(/[\s-]/g, ""), status = $("sms-status");
  const fail = (t) => { status.className = "adm-status err"; status.textContent = t; };
  if (!(step >= 1 && step <= 500)) return fail("מספר התשובות צריך להיות בין 1 ל-500.");
  if (!template) return fail("נוסח ההודעה ריק.");
  if (sender && !/^0\d{8,9}$/.test(sender) && !/^[A-Za-z][A-Za-z0-9]{1,10}$/.test(sender)) return fail("מספר השולח: מספר טלפון, או שם באנגלית עד 11 תווים.");
  status.className = "adm-status";
  status.textContent = "שומר…";
  try {
    const enabled = $("sms-enabled").checked;
    await setDoc(doc(getDb(), "settings", "sms"), { enabled, step, template, sender, updatedAt: new Date().toISOString() }, { merge: true });
    SMS = { ...SMS, enabled, step, template, sender };
    $("sms-sender").value = sender;
    drawStudents();
    status.textContent = "נשמר ✓";
  } catch (err) {
    fail("השמירה לא הצליחה: " + errText(err));
  }
});

// A test message, to check the SMS4Free account details.
$("test-send").addEventListener("click", async () => {
  const phone = $("test-phone").value.replace(/[^0-9]/g, ""), status = $("test-status"), btn = $("test-send");
  if (!/^05\d{8}$/.test(phone)) { status.className = "adm-status err"; status.textContent = "מספר לא תקין (10 ספרות, מתחיל ב-05)"; return; }
  status.className = "adm-status";
  status.textContent = "שולח… (נשלח הנוסח השמור)";
  btn.disabled = true;
  try {
    const f = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js");
    await f.httpsCallable(f.getFunctions(getApp()), "sendTestSms")({ phone });
    status.textContent = "ההודעה נשלחה ✓ החיבור ל-SMS4Free עובד.";
  } catch (err) {
    status.className = "adm-status err";
    status.textContent = "השליחה לא הצליחה: " + errText(err);
  } finally {
    btn.disabled = false;
    LOG_LOADED = false;
  }
});

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
