// Admin page (admin.html), for the site admin only:
// - "תלמידים": every student, the lessons they did, how many questions they got
//   right, their parents' phone numbers (editable) and whether the parents get messages;
// - "הודעה להורים": every how many correct answers a message goes out, and its text
//   (settings/sms, used by notifyParentsOnQuizMilestone in functions/index.js).
import { watchAuthState, getDb, getApp, isReady } from "./auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
// the same defaults as the server (functions/index.js)
const SMS_DEFAULTS = { step: 10, template: "{שם} ענה נכון על {מספר} שאלות בשיעורי הגמרא באתר פשיטא 🎉" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
let STUDENTS = [], LESSONS = [], SMS = { ...SMS_DEFAULTS };

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
    $("adm-gate").textContent = "לא הצלחתי לטעון את הנתונים: " + ((err && (err.code || err.message)) || "שגיאה");
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
  showTab(location.hash === "#sms" ? "sms" : "students");
}

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".adm-tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("tab-students").hidden = name !== "students";
  $("tab-sms").hidden = name !== "sms";
  history.replaceState(null, "", name === "sms" ? "#sms" : location.pathname);
}
document.querySelector(".adm-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) showTab(b.dataset.tab);
});

// ---------- students ----------
const fullName = (s) => `${s.firstName || ""} ${s.lastName || ""}`.trim() || "ללא שם";
const countOf = (s) => Object.values(s.correct).filter(Boolean).length;
const dateOf = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }); };

// What will happen next with this student's parents.
function nextText(s) {
  if (s.notify === false) return "ההודעות להורים כבויות";
  if (!s.fatherPhone && !s.motherPhone) return "אין מספר טלפון של ההורים";
  const left = SMS.step - (countOf(s) % SMS.step);
  return `עוד ${left} ${left === 1 ? "תשובה נכונה" : "תשובות נכונות"} להודעה הבאה`;
}

function studentHtml(s) {
  const count = countOf(s);
  // lessons in site order: correct answers in each, and whether it was finished
  const perLesson = {};
  Object.keys(s.correct).forEach((q) => { if (s.correct[q] && q.includes(":")) { const id = q.split(":")[0]; perLesson[id] = (perLesson[id] || 0) + 1; } });
  const did = LESSONS.filter((l) => perLesson[l.id] || s.finished[l.id]);
  const pills = did.map((l) => `<span class="adm-pill${s.finished[l.id] ? " done" : ""}" title="${s.finished[l.id] ? "סיים את השיעור" : "התחיל את השיעור"}">${s.finished[l.id] ? "✓ " : ""}${esc(l.title)} <i>${perLesson[l.id] || 0}</i></span>`).join("");
  const last = s.lastSms ? ` · הודעה אחרונה: ${dateOf(s.lastSms.at)}, על ${s.lastSms.count} תשובות` : "";
  return `<article class="adm-st" data-id="${esc(s.id)}">
    <div><h3>${esc(fullName(s))}<span class="since">${s.createdAt ? "נרשם " + dateOf(s.createdAt) : ""}</span></h3></div>
    <div class="adm-score"><b>${count}</b><span>תשובות נכונות</span></div>
    <div class="adm-lessons">${pills || '<span class="none">עדיין לא ענה נכון על שאלות בשיעורים.</span>'}</div>
    <div class="adm-contact">
      <label>אבא <input type="tel" data-f="fatherPhone" value="${esc(s.fatherPhone || "")}" placeholder="05XXXXXXXX" inputmode="tel" autocomplete="off"></label>
      <label>אמא <input type="tel" data-f="motherPhone" value="${esc(s.motherPhone || "")}" placeholder="05XXXXXXXX" inputmode="tel" autocomplete="off"></label>
      <label class="notify"><input type="checkbox" data-f="notify"${s.notify === false ? "" : " checked"}> הודעות להורים</label>
      <span class="adm-next">${esc(nextText(s))}${esc(last)}</span>
      <span class="adm-status"></span>
    </div>
  </article>`;
}

function drawStudents() {
  const q = $("adm-search").value.trim();
  const shown = STUDENTS.filter((s) => !q || fullName(s).includes(q));
  $("adm-list").innerHTML = shown.map(studentHtml).join("") || '<p class="adm-note">אין תלמידים להצגה.</p>';
  $("adm-count").textContent = q ? `${shown.length} מתוך ${STUDENTS.length}` : `${STUDENTS.length} תלמידים`;
}
$("adm-search").addEventListener("input", drawStudents);

// Phone numbers and "הודעות להורים" save as soon as they change.
$("adm-list").addEventListener("change", async (e) => {
  const input = e.target.closest("[data-f]");
  if (!input) return;
  const card = input.closest(".adm-st"), s = STUDENTS.find((x) => x.id === card.dataset.id), f = input.dataset.f;
  const status = card.querySelector(".adm-status");
  let value;
  if (f === "notify") value = input.checked;
  else {
    value = input.value.replace(/[^0-9]/g, "");
    if (value && !/^05\d{8}$/.test(value)) {
      input.classList.add("bad");
      status.className = "adm-status err";
      status.textContent = "מספר לא תקין (10 ספרות, מתחיל ב-05)";
      return;
    }
    input.classList.remove("bad");
    input.value = value;
  }
  status.className = "adm-status";
  status.textContent = "שומר…";
  try {
    await updateDoc(doc(getDb(), "users", s.id), { [f]: value });
    s[f] = value;
    card.querySelector(".adm-next").textContent = nextText(s);
    status.textContent = "נשמר ✓";
    setTimeout(() => { if (status.textContent === "נשמר ✓") status.textContent = ""; }, 2000);
  } catch (err) {
    status.className = "adm-status err";
    status.textContent = "השמירה לא הצליחה: " + ((err && (err.code || err.message)) || "שגיאה");
  }
});

// ---------- the message to the parents ----------
const fillTemplate = (t, count) => t.split("{שם מלא}").join("ישראל ישראלי").split("{שם}").join("ישראל").split("{מספר}").join(String(count));
function fillSms() {
  $("sms-step").value = SMS.step;
  $("sms-template").value = SMS.template;
  preview();
}
function preview() {
  const step = +$("sms-step").value || SMS_DEFAULTS.step, text = fillTemplate($("sms-template").value, step);
  $("sms-preview").textContent = text || "—";
  // a message in Hebrew fits 70 characters; a longer one goes in parts of 67
  const n = [...text].length, parts = n <= 70 ? 1 : Math.ceil(n / 67);
  $("sms-length").textContent = `${n} תווים · ${parts === 1 ? "הודעה אחת" : `${parts} הודעות (כל אחת נספרת בחשבון)`}`;
}
$("sms-step").addEventListener("input", preview);
$("sms-template").addEventListener("input", preview);
document.querySelector(".adm-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ins]");
  if (!b) return;
  const t = $("sms-template"), a = t.selectionStart, z = t.selectionEnd;
  t.setRangeText(b.dataset.ins, a, z, "end");
  t.focus();
  preview();
});
$("sms-save").addEventListener("click", async () => {
  const step = Math.round(+$("sms-step").value), template = $("sms-template").value.trim();
  const status = $("sms-status");
  if (!(step >= 1 && step <= 500)) { status.className = "adm-status err"; status.textContent = "מספר התשובות צריך להיות בין 1 ל-500."; return; }
  if (!template) { status.className = "adm-status err"; status.textContent = "נוסח ההודעה ריק."; return; }
  status.className = "adm-status";
  status.textContent = "שומר…";
  try {
    await setDoc(doc(getDb(), "settings", "sms"), { step, template, updatedAt: new Date().toISOString() }, { merge: true });
    SMS = { ...SMS, step, template };
    drawStudents();
    status.textContent = "נשמר ✓";
  } catch (err) {
    status.className = "adm-status err";
    status.textContent = "השמירה לא הצליחה: " + ((err && (err.code || err.message)) || "שגיאה");
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
    status.textContent = "השליחה לא הצליחה: " + ((err && err.message) || "שגיאה");
  } finally {
    btn.disabled = false;
  }
});
