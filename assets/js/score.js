import { watchAuthState } from "./auth.js";
import { getLessonProgress } from "./progress.js";
import { onStudent, remainingText } from "./student.js";

export const QUIZ_LESSON_ID = "quiz";

let cachedAnswers = {};
let currentUser = null;
const listeners = [];

// every this many correct answers the parents get a message (set on the admin page)
let MILESTONE_STEP = 10;
const MAX_BADGE_DOTS = 6; // most recent achieved milestones shown, plus one "next" dot

function render() {
  const badge = document.getElementById("score-badge");
  if (!badge) return;
  const count = Object.values(cachedAnswers).filter(Boolean).length;
  if (!currentUser || count === 0) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;

  const achieved = Math.floor(count / MILESTONE_STEP);
  const currentBase = achieved * MILESTONE_STEP;
  const progressPct = Math.round(((count - currentBase) / MILESTONE_STEP) * 100);

  const shownAchieved = Math.min(achieved, MAX_BADGE_DOTS);
  let dots = "";
  for (let i = 0; i < shownAchieved; i++) dots += '<span class="score-badge-dot achieved"></span>';
  dots += '<span class="score-badge-dot"></span>'; // next milestone, not yet reached

  badge.title = remainingText(count);
  badge.innerHTML = `
    <span class="score-badge-text">ניקוד: ${count}</span>
    <span class="score-progress-track"><span class="score-progress-fill" style="width:${progressPct}%"></span></span>
    <span class="score-badges">${dots}</span>
  `;
}

export function getCachedAnswers() {
  return cachedAnswers;
}

export function getCurrentQuizUser() {
  return currentUser;
}

export function markQuestionCorrect(questionId) {
  cachedAnswers[questionId] = true;
  render();
}

// Fires once immediately if the answer cache is already loaded, and again
// every time it's (re)loaded after an auth-state change.
export function onAnswersReady(callback) {
  listeners.push(callback);
  callback(cachedAnswers);
}

watchAuthState(async (user) => {
  currentUser = user;
  cachedAnswers = user ? await getLessonProgress(QUIZ_LESSON_ID) : {};
  render();
  listeners.forEach((cb) => cb(cachedAnswers));
});

onStudent(({ step }) => { MILESTONE_STEP = step; render(); });
