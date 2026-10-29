// A signed-in student's progress and the messages to the parents:
// - in a lesson, records each question answered correctly (users/{uid}/progress/quiz)
//   and each lesson finished (users/{uid}/progress/lessons), from the player's events;
// - says how many correct answers are left until the next message to the parents
//   (every `step` answers, set on the admin page: settings/sms; nothing is said
//   while the admin has the messages turned off there);
// - once a message was sent (the server sets users/{uid}.lastSms), tells the student.
import { watchAuthState, getDb, isReady } from "./auth.js";
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot,
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

// "עוד 3 תשובות נכונות ונשלח הודעה להורים", or "" when no message will be sent.
export function remainingText(count, step = STEP, info = INFO) {
  if (!ENABLED || !info || info.notify === false || !(info.fatherPhone || info.motherPhone)) return "";
  const left = step - (count % step);
  return left === 1 ? "עוד תשובה נכונה אחת ונשלח הודעה להורים" : `עוד ${left} תשובות נכונות ונשלח הודעה להורים`;
}

// The current student's details, once loaded: { user, info, step } (user null when signed out).
export function onStudent(cb) {
  ready.push(cb);
  if (SECTIONS) cb({ user: USER, info: INFO, step: STEP });
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
    ready.forEach((cb) => cb({ user: USER, info: INFO, step: STEP }));
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
    if (left && count % STEP === 0) toast(`כל הכבוד! ענית נכון על ${count} שאלות. שולחים הודעה להורים 🎉`, 6000);
    else if (left) toast(`נכון! ${left}`);
  });
  addEventListener("pshita:finished", () => {
    if (!USER) return;
    setDoc(doc(getDb(), "users", USER.uid, "progress", "lessons"),
      { lessons: { [lessonId]: { finishedAt: new Date().toISOString() } } }, { merge: true }).catch(() => {});
  });
}
