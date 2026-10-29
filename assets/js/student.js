// A signed-in student's progress and the messages to the parents:
// - in a lesson, records each question answered correctly (users/{uid}/progress/quiz)
//   and each time a lesson is finished with all its questions (users/{uid}/progress/lessons:
//   times), from the player's events;
// - says how many correct answers are left until the next message to the parents
//   (every `step` answers: the default in settings/sms, or the student's own,
//   both set on the admin page; nothing is said while messages are off for them);
// - once a message was sent (the server sets users/{uid}.lastSms), tells the student.
import { watchAuthState, getDb, isReady } from "./auth.js";
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, increment,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const STEP_DEFAULT = 10;
let USER = null, INFO = null, SECTIONS = null, STEP = STEP_DEFAULT, ENABLED = false;
let unwatch = null;
const ready = [];

async function smsSettings() {
  try {
    const snap = await getDoc(doc(getDb(), "settings", "sms"));
    const v = snap.exists() ? snap.data() : {};
    return { step: Number.isInteger(v.step) && v.step > 0 ? v.step : STEP_DEFAULT, enabled: v.enabled === true };
  } catch (e) {
    return { step: STEP_DEFAULT, enabled: false };
  }
}

// Messages for this student: on or off, and every how many answers (the same rule
// as studentPlan in functions/index.js).
function plan(info = INFO) {
  const v = info || {};
  const mode = v.smsMode === "on" || v.smsMode === "off" ? v.smsMode : v.notify === false ? "off" : "default";
  const on = (mode === "on" || (mode === "default" && ENABLED)) && Boolean(v.fatherPhone || v.motherPhone);
  const step = Number.isInteger(v.smsStep) && v.smsStep > 0 ? v.smsStep : STEP;
  return { on, step };
}

// "עוד 3 תשובות נכונות ונשלח הודעה להורים", or "" when no message will be sent.
export function remainingText(count) {
  const { on, step } = plan();
  if (!on) return "";
  const left = step - (count % step);
  return left === 1 ? "עוד תשובה נכונה אחת ונשלח הודעה להורים" : `עוד ${left} תשובות נכונות ונשלח הודעה להורים`;
}

// The current student's details, once loaded: { user, info, step } (user null when signed out).
export function onStudent(cb) {
  ready.push(cb);
  if (SECTIONS) cb({ user: USER, info: INFO, step: plan().step });
}

// ---------- a small message at the bottom of the screen ----------
let toastEl = null, toastT;
export function toast(text, ms = 3500) {
  if (!toastEl) {
    const css = document.createElement("style");
    css.textContent = `.pshita-toast{position:fixed;bottom:18px;left:50%;transform:translate(-50%,20px);opacity:0;z-index:50;max-width:calc(100vw - 32px);background:#2b241b;color:#fff;font:600 15px/1.5 "Rubik","Heebo",Arial,sans-serif;padding:10px 18px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.25);text-align:center;transition:opacity .25s,transform .25s;pointer-events:none}
.pshita-toast.show{opacity:1;transform:translate(-50%,0)}
.pshita-toast.big{background:#1f6f4a;font-size:16px;padding:14px 20px}`;
    document.head.appendChild(css);
    toastEl = document.createElement("div");
    toastEl.className = "pshita-toast";
    toastEl.setAttribute("role", "status");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.toggle("big", ms > 5000);
  toastEl.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove("show"), ms);
}

// ---------- the signed-in student ----------
if (isReady()) {
  watchAuthState(async (user) => {
    if (unwatch) { unwatch(); unwatch = null; }
    USER = user; INFO = null; SECTIONS = null;
    if (user) {
      const db = getDb();
      const [quiz, sms] = await Promise.all([
        getDoc(doc(db, "users", user.uid, "progress", "quiz")).catch(() => null),
        smsSettings(),
      ]);
      SECTIONS = (quiz && quiz.exists() && quiz.data().sections) || {};
      STEP = sms.step;
      ENABLED = sms.enabled;
      await new Promise((resolve) => {
        unwatch = onSnapshot(doc(db, "users", user.uid), (snap) => {
          INFO = snap.exists() ? snap.data() : {};
          resolve();
          const sms = INFO.lastSms;
          if (sms && sms.seen === false) {
            toast(`נשלחה הודעה להורים שלך: ענית נכון על ${sms.count} שאלות! כל הכבוד 🎉`, 8000);
            updateDoc(snap.ref, { "lastSms.seen": true }).catch(() => {});
          }
        }, () => resolve());
      });
    } else SECTIONS = {};
    ready.forEach((cb) => cb({ user: USER, info: INFO, step: plan().step }));
  });
}

// ---------- in a lesson: the player reports answers and the end of the lesson ----------
const lessonId = document.body.dataset.lesson;
let toldToLogin = false;
if (lessonId) {
  addEventListener("pshita:correct", (e) => {
    if (!USER) {
      if (isReady() && !toldToLogin) { toldToLogin = true; toast("כדי שהתשובות הנכונות שלך יישמרו, צריך להתחבר לחשבון"); }
      return;
    }
    if (!SECTIONS) return;
    const q = `${lessonId}:${e.detail.q}`;
    if (SECTIONS[q]) return;  // answered correctly before: counted once
    SECTIONS[q] = true;
    setDoc(doc(getDb(), "users", USER.uid, "progress", "quiz"),
      { sections: { [q]: true }, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
    const count = Object.values(SECTIONS).filter(Boolean).length;
    const left = remainingText(count);
    if (left && count % plan().step === 0) toast(`כל הכבוד! ענית נכון על ${count} שאלות. שולחים הודעה להורים 🎉`, 6000);
    else if (left) toast(`נכון! ${left}`);
  });
  addEventListener("pshita:finished", () => {
    if (!USER) return;
    setDoc(doc(getDb(), "users", USER.uid, "progress", "lessons"),
      { lessons: { [lessonId]: { finishedAt: new Date().toISOString(), times: increment(1) } } }, { merge: true }).catch(() => {});
  });
}

// ---------- in a lesson: time spent learning ----------
// Counted while a lesson page is open and in view, and only up to 5 minutes after the
// last move to another screen of the lesson (or opening it, or coming back to the tab).
// Kept per day and in total: users/{uid}/progress/time = { days: { "2026-10-29": seconds }, total }.
const IDLE_MS = 5 * 60 * 1000;
if (lessonId) {
  let lastMove = Date.now(), countedTo = Date.now(), pending = 0, visible = !document.hidden;
  const dayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  // add the time since the last count, up to 5 minutes after the last move
  const count = () => {
    const now = Date.now(), until = Math.min(now, lastMove + IDLE_MS);
    if (visible && until > countedTo) pending += until - countedTo;
    countedTo = now;
  };
  const flush = () => {
    count();
    const secs = Math.round(pending / 1000);
    if (!USER || secs < 1) return;
    pending -= secs * 1000;
    setDoc(doc(getDb(), "users", USER.uid, "progress", "time"),
      { days: { [dayKey()]: increment(secs) }, total: increment(secs) }, { merge: true }).catch(() => {});
  };
  addEventListener("pshita:screen", () => { count(); lastMove = Date.now(); });
  document.addEventListener("visibilitychange", () => {
    count();
    visible = !document.hidden;
    if (visible) lastMove = Date.now(); else flush();
  });
  addEventListener("pagehide", flush);
  setInterval(flush, 60 * 1000);
}
