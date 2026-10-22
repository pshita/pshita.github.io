import { onAnswersReady, getCurrentQuizUser } from "./score.js";

const MILESTONE_STEP = 10;

const gateEl = document.getElementById("achievements-gate");
const mainEl = document.getElementById("achievements-main");
const totalCountEl = document.getElementById("achv-total-count");
const trackFillEl = document.getElementById("achv-track-fill");
const nextEl = document.getElementById("achv-next");
const milestonesEl = document.getElementById("achv-milestones");

function renderTotals(count) {
  const achieved = Math.floor(count / MILESTONE_STEP);
  const currentBase = achieved * MILESTONE_STEP;
  const pct = Math.round(((count - currentBase) / MILESTONE_STEP) * 100);

  totalCountEl.textContent = count;
  trackFillEl.style.width = pct + "%";
  nextEl.textContent = `עוד ${MILESTONE_STEP - (count - currentBase)} נקודות לאבן הדרך הבאה`;

  milestonesEl.innerHTML = "";
  for (let i = 1; i <= achieved; i++) {
    const dot = document.createElement("span");
    dot.className = "score-badge-dot achieved";
    dot.title = `${i * MILESTONE_STEP} נקודות`;
    milestonesEl.appendChild(dot);
  }
  const next = document.createElement("span");
  next.className = "score-badge-dot";
  next.title = "אבן הדרך הבאה";
  milestonesEl.appendChild(next);
}

onAnswersReady((answers) => {
  const user = getCurrentQuizUser();
  if (!user) {
    gateEl.hidden = false;
    mainEl.hidden = true;
    return;
  }
  gateEl.hidden = true;
  mainEl.hidden = false;
  renderTotals(Object.values(answers).filter(Boolean).length);
});
