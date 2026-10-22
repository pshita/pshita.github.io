// Inline WYSIWYG admin editor. Loaded on every page that has editable
// content (index.html + every lessons/*.html); no-ops immediately for
// everyone except the one authorized account, so readers never download
// functionality they can't use and never see any editor chrome.
//
// Lesson pages: the real .intro-box content (headings, paragraphs, quiz
// blocks) becomes directly editable in place - no separate panel, no
// generic form controls. Saves go through the same saveLessonContent
// Cloud Function admin.html used to call, with `sections` now serialized
// straight from the live, edited DOM instead of a parsed fetch.
//
// index.html: lesson cards get hover move/delete controls, and each group
// gets a "+" tile to create a new lesson (which redirects to the new
// lesson's own page to build it out with the same block-template menu
// used everywhere else).
//
// Every move/delete/add/style control lives in ONE floating toolbar
// (document.body, positioned via getBoundingClientRect) instead of being
// appended as a child of the content element itself. That's deliberate,
// not just cosmetic: a control button appended inside a contenteditable
// <p>/<h2>/<h3> would be swept into its text by serializeInline() below
// and corrupt the saved content, and any extra element spliced in as a
// *sibling* inside .intro-box (between a heading and its paragraph, say)
// would break this site's existing adjacency CSS (the heading/paragraph
// band-merge rules key off direct `+` sibling selectors). The floating
// toolbar touches neither.

import { watchAuthState, getApp } from "./auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const ALLOWED_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";

let fns = null;
let saveFn = null;
let createLessonFn = null;
let moveLessonFn = null;
let deleteLessonFn = null;
let replaceTextFn = null;

function ensureFns() {
  if (fns) return;
  fns = getFunctions(getApp());
  saveFn = httpsCallable(fns, "saveLessonContent");
  createLessonFn = httpsCallable(fns, "createLesson");
  moveLessonFn = httpsCallable(fns, "moveLesson");
  deleteLessonFn = httpsCallable(fns, "deleteLesson");
  replaceTextFn = httpsCallable(fns, "replaceLessonText");
}

function preventFocusSteal(e) {
  e.preventDefault();
}

// ---------------------------------------------------------------------
// Save-status pill, fixed to the corner so it never shifts page layout.
// ---------------------------------------------------------------------

let statusEl = null;
function ensureStatusEl() {
  if (statusEl) return statusEl;
  statusEl = document.createElement("div");
  statusEl.className = "ed-status";
  document.body.appendChild(statusEl);
  return statusEl;
}
function setStatus(state, label) {
  const el = ensureStatusEl();
  el.className = "ed-status" + (state ? " ed-status-" + state : "");
  el.textContent = label || "";
  el.hidden = !label;
}

// ---------------------------------------------------------------------
// DOM <-> sections. Mirrors functions/index.js's renderBoxes/markdownLiteToHtml
// (the inverse direction) so what gets saved is exactly what's on screen.
// ---------------------------------------------------------------------

function serializeInline(el) {
  let out = "";
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const inner = serializeInline(node);
      if (tag === "strong" || tag === "b") out += "**" + inner + "**";
      else if (tag === "em" || tag === "i") out += "_" + inner + "_";
      else if (tag === "br") out += "\n";
      else out += node.textContent;
    }
  });
  return out;
}

function domToSections(root) {
  const boxes = root.querySelectorAll(":scope > .intro-box");
  const sections = [];
  boxes.forEach((box) => {
    sections.push({ type: "box" });
    Array.from(box.children).forEach((child) => {
      const tag = child.tagName.toLowerCase();
      if (tag === "h1" || tag === "h2" || tag === "h3") {
        sections.push({ type: "heading", tag, cls: "", text: serializeInline(child).trim() });
      } else if (tag === "p") {
        const cls = child.classList.contains("p-strong") ? "p-strong" : child.classList.contains("p-light") ? "p-light" : "";
        sections.push({ type: "paragraphs", items: [{ text: serializeInline(child).trim(), cls }] });
      } else if (tag === "div" && child.classList.contains("quiz")) {
        sections.push(quizElToBlock(child));
      } else if (tag === "div" && child.classList.contains("quiz-group")) {
        // quiz.js wraps every run of adjacent .quiz elements into this
        // accordion for every visitor (admin included) as soon as it loads
        // - it's never part of the saved document, so it's unwrapped back
        // into its individual quiz blocks rather than saved as "raw" HTML.
        child.querySelectorAll(".quiz").forEach((q) => sections.push(quizElToBlock(q)));
      } else {
        sections.push({ type: "raw", html: child.outerHTML.trim() });
      }
    });
  });
  // Merge adjacent {type:"paragraphs", items:[1]} blocks so the saved
  // shape matches what the Cloud Function/site expect (one block can carry
  // several paragraph items) - not required for correctness (renderBoxes
  // just appends each item's <p> either way) but keeps the saved document
  // tidy and consistent with lessons never touched by this editor.
  const merged = [];
  sections.forEach((b) => {
    const prev = merged[merged.length - 1];
    if (b.type === "paragraphs" && prev && prev.type === "paragraphs") {
      prev.items.push(b.items[0]);
    } else {
      merged.push(b);
    }
  });
  return merged;
}

function choiceText(btn) {
  const textSpan = btn.querySelector(".ed-quiz-text");
  return (textSpan ? textSpan.textContent : btn.textContent).trim();
}

function quizElToBlock(div) {
  const qid = div.getAttribute("data-question-id") || "";
  const questionEl = div.querySelector(".quiz-question");
  const question = questionEl ? questionEl.textContent.trim() : "";
  const choices = Array.from(div.querySelectorAll(".quiz-choice")).map((btn) => ({
    text: choiceText(btn),
    correct: btn.getAttribute("data-correct") === "true",
  }));
  const block = { type: "quiz", qid, question, choices };
  const marksSection = div.getAttribute("data-marks-section");
  if (marksSection) block.marksSection = marksSection;
  return block;
}

// ---------------------------------------------------------------------
// Save scheduling - one lesson per page now, so a single debounce timer.
// ---------------------------------------------------------------------

let saveTimer = null;
let lessonId = null;

function scheduleSave() {
  setStatus(null, "");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 700);
}

function flushPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    doSave();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushPendingSave();
});
window.addEventListener("pagehide", flushPendingSave);

function doSave() {
  ensureFns();
  setStatus("saving", "שומר…");
  const main = document.querySelector("main");
  const titleEl = document.querySelector(".lesson-title-row h1");
  const titleText = titleEl ? titleEl.textContent.trim() : "";
  const sections = domToSections(main);
  saveFn({ lessonId, titleText, sections })
    .then(() => setStatus("saved", "נשמר באתר ✓"))
    .catch((err) => setStatus("error", (err && err.message) || "שגיאה בשמירה"));
}

// ---------------------------------------------------------------------
// Floating toolbar: one shared element, repositioned and rebuilt for
// whichever block is currently hovered or focused.
// ---------------------------------------------------------------------

let toolbarEl = null;
let toolbarOwner = null;
let toolbarHoverLocked = false;
let hideTimer = null;

function ensureToolbar() {
  if (toolbarEl) return toolbarEl;
  toolbarEl = document.createElement("div");
  toolbarEl.className = "ed-toolbar";
  toolbarEl.hidden = true;
  toolbarEl.addEventListener("mouseenter", () => { toolbarHoverLocked = true; clearTimeout(hideTimer); });
  toolbarEl.addEventListener("mouseleave", () => { toolbarHoverLocked = false; scheduleHideToolbar(); });
  document.body.appendChild(toolbarEl);
  return toolbarEl;
}

function scheduleHideToolbar() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (toolbarHoverLocked) return;
    if (toolbarOwner && document.activeElement === toolbarOwner) return;
    toolbarEl.hidden = true;
    toolbarOwner = null;
  }, 250);
}

function addCtrlButton(container, { label, title, cls, active, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ed-ctrl-btn" + (cls ? " " + cls : "") + (active ? " ed-ctrl-active" : "");
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener("mousedown", preventFocusSteal);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  container.appendChild(btn);
  return btn;
}

function buildAddControl(ref) {
  const wrap = document.createElement("span");
  wrap.className = "ed-add-wrap";
  const flyout = document.createElement("div");
  flyout.className = "ed-add-flyout";
  flyout.hidden = true;
  [["heading", "כותרת קטע"], ["section", "כותרת משנה + טקסט"], ["quiz", "שאלת תרגול"]].forEach(([type, label]) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "ed-add-option";
    opt.textContent = label;
    opt.addEventListener("mousedown", preventFocusSteal);
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      flyout.hidden = true;
      insertAfter(ref, type);
    });
    flyout.appendChild(opt);
  });
  addCtrlButton(wrap, {
    label: "+",
    title: "הוספת קטע אחרי זה",
    cls: "ed-ctrl-add",
    onClick: () => { flyout.hidden = !flyout.hidden; },
  });
  wrap.appendChild(flyout);
  return wrap;
}

// `buttons` is an array of button configs (see addCtrlButton), with an
// optional {addAfter: el} entry that renders the "+" insert control.
function showToolbarFor(el, buttons) {
  clearTimeout(hideTimer);
  const toolbar = ensureToolbar();
  toolbarOwner = el;
  toolbar.innerHTML = "";
  buttons.forEach((b) => {
    if (b.addAfter) {
      toolbar.appendChild(buildAddControl(b.addAfter));
    } else {
      addCtrlButton(toolbar, b);
    }
  });
  const rect = el.getBoundingClientRect();
  toolbar.style.top = window.scrollY + rect.top - 38 + "px";
  toolbar.style.left = window.scrollX + rect.left + "px";
  toolbar.hidden = false;
}

function wireHoverTarget(el, buildButtons) {
  const show = () => showToolbarFor(el, buildButtons());
  el.addEventListener("mouseenter", show);
  el.addEventListener("focusin", show);
  el.addEventListener("mouseleave", scheduleHideToolbar);
  el.addEventListener("focusout", scheduleHideToolbar);
}

// ---------------------------------------------------------------------
// Small floating bold/italic bubble shown on text selection inside any
// editable element - toggles real <b>/<i> via execCommand, so what's
// typed is exactly what readers will see (no markdown markers on screen).
// ---------------------------------------------------------------------

let bubbleEl = null;
function ensureBubble() {
  if (bubbleEl) return bubbleEl;
  bubbleEl = document.createElement("div");
  bubbleEl.className = "ed-bubble";
  bubbleEl.hidden = true;
  const boldBtn = document.createElement("button");
  boldBtn.type = "button";
  boldBtn.className = "ed-bubble-btn ed-bubble-bold";
  boldBtn.textContent = "הדגשה";
  const italicBtn = document.createElement("button");
  italicBtn.type = "button";
  italicBtn.className = "ed-bubble-btn ed-bubble-italic";
  italicBtn.textContent = "נטוי";
  [boldBtn, italicBtn].forEach((btn) => {
    btn.addEventListener("mousedown", preventFocusSteal);
    btn.addEventListener("pointerdown", preventFocusSteal);
  });
  boldBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.execCommand("bold");
    scheduleSave();
  });
  italicBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.execCommand("italic");
    scheduleSave();
  });
  bubbleEl.appendChild(boldBtn);
  bubbleEl.appendChild(italicBtn);
  document.body.appendChild(bubbleEl);
  return bubbleEl;
}

function wireSelectionBubble() {
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (bubbleEl) bubbleEl.hidden = true;
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const editable = el && el.closest && el.closest("[contenteditable='true']");
    if (!editable) {
      if (bubbleEl) bubbleEl.hidden = true;
      return;
    }
    const bubble = ensureBubble();
    const rect = range.getBoundingClientRect();
    bubble.style.top = window.scrollY + rect.top - 42 + "px";
    bubble.style.left = window.scrollX + rect.left + rect.width / 2 + "px";
    bubble.hidden = false;
  });
}

// ---------------------------------------------------------------------
// Making real elements editable in place, with their hover toolbar.
// ---------------------------------------------------------------------

function cycleParagraphClass(el) {
  if (el.classList.contains("p-strong")) {
    el.classList.remove("p-strong");
    el.classList.add("p-light");
  } else if (el.classList.contains("p-light")) {
    el.classList.remove("p-light");
  } else {
    el.classList.add("p-strong");
  }
}

function paragraphStyleLabel(el) {
  if (el.classList.contains("p-strong")) return "תוכן";
  if (el.classList.contains("p-light")) return "קל";
  return "רגיל";
}

function deleteContentEl(el) {
  if (!window.confirm("למחוק את הקטע הזה?")) return;
  const box = el.closest(".intro-box");
  const group = el.closest(".quiz-group");
  el.remove();
  // A quiz that was the last one left in its accordion leaves an empty,
  // now-useless "תרגול מכפיל" shell behind - drop the whole wrapper too,
  // same as quiz.js would produce if it ran fresh with one fewer quiz.
  if (group && group.querySelectorAll(".quiz").length === 0) group.remove();
  scheduleSave();
  if (box && box.children.length === 0) {
    box.remove();
    scheduleSave();
  }
  toolbarEl.hidden = true;
}

function moveContentEl(el, dir) {
  const sib = dir === "up" ? el.previousElementSibling : el.nextElementSibling;
  if (!sib) return;
  if (dir === "up") el.parentElement.insertBefore(el, sib);
  else el.parentElement.insertBefore(sib, el);
  scheduleSave();
  showToolbarFor(el, buildButtonsFor(el));
}

// Builds the toolbar button list for a given live content element -
// shared by the initial wiring and by re-showing the toolbar after a move.
function buildButtonsFor(el) {
  const tag = el.tagName.toLowerCase();
  const buttons = [];
  if (tag === "p") {
    buttons.push({
      label: paragraphStyleLabel(el),
      title: "סגנון פסקה",
      cls: "ed-ctrl-style",
      onClick: () => { cycleParagraphClass(el); showToolbarFor(el, buildButtonsFor(el)); scheduleSave(); },
    });
  }
  if (tag === "div" && el.classList.contains("quiz")) {
    buttons.push({
      label: "✎",
      title: "עריכת השאלה",
      cls: "ed-ctrl-edit",
      active: el.classList.contains("ed-quiz-editing"),
      onClick: () => { toggleQuizEditMode(el); showToolbarFor(el, buildButtonsFor(el)); },
    });
  }
  buttons.push({ label: "↑", title: "הזזה למעלה", onClick: () => moveContentEl(el, "up") });
  buttons.push({ label: "↓", title: "הזזה למטה", onClick: () => moveContentEl(el, "down") });
  buttons.push({ label: "✕", title: "מחיקה", cls: "ed-ctrl-del", onClick: () => deleteContentEl(el) });
  buttons.push({ addAfter: el });
  return buttons;
}

function makeHeadingEditable(el) {
  el.contentEditable = "true";
  el.classList.add("ed-editable", "ed-editable-heading");
  el.addEventListener("input", scheduleSave);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.blur();
    }
  });
  wireHoverTarget(el, () => buildButtonsFor(el));
}

function makeParagraphEditable(el) {
  el.contentEditable = "true";
  el.classList.add("ed-editable", "ed-editable-p");
  el.addEventListener("input", scheduleSave);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const next = document.createElement("p");
      if (el.className) next.className = el.className;
      next.textContent = "";
      el.after(next);
      makeParagraphEditable(next);
      next.focus();
      scheduleSave();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
    }
  });
  wireHoverTarget(el, () => buildButtonsFor(el));
}

// A "raw" block (list/table/example markup from the original content) -
// not editable here, same as the old admin panel, but still movable and
// deletable.
function wireRawBlock(el) {
  wireHoverTarget(el, () => [
    { label: "↑", title: "הזזה למעלה", onClick: () => moveContentEl(el, "up") },
    { label: "↓", title: "הזזה למטה", onClick: () => moveContentEl(el, "down") },
    { label: "✕", title: "מחיקה", cls: "ed-ctrl-del", onClick: () => deleteContentEl(el) },
    { addAfter: el },
  ]);
}

// ---------------------------------------------------------------------
// Inserting new blocks (heading / subheading+text / quiz / new card),
// matching the old admin's template choices.
// ---------------------------------------------------------------------

function newBid() {
  return "c" + Date.now() + Math.random().toString(36).slice(2, 7);
}

function buildQuizDom(qid) {
  const div = document.createElement("div");
  div.className = "quiz";
  div.setAttribute("data-question-id", qid);
  const q = document.createElement("p");
  q.className = "quiz-question";
  q.textContent = "שאלה חדשה";
  const choicesWrap = document.createElement("div");
  choicesWrap.className = "quiz-choices";
  [["תשובה נכונה", true], ["תשובה שגויה", false], ["תשובה שגויה", false]].forEach(([text, correct]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quiz-choice";
    btn.setAttribute("data-correct", correct ? "true" : "false");
    btn.textContent = text;
    choicesWrap.appendChild(btn);
  });
  const feedback = document.createElement("p");
  feedback.className = "quiz-feedback";
  feedback.hidden = true;
  div.appendChild(q);
  div.appendChild(choicesWrap);
  div.appendChild(feedback);
  return div;
}

function insertAfter(ref, type) {
  let created;
  if (type === "heading") {
    created = document.createElement("h3");
    created.textContent = "כותרת חדשה";
    ref.after(created);
    makeHeadingEditable(created);
  } else if (type === "section") {
    const h = document.createElement("h3");
    h.textContent = "כותרת משנה חדשה";
    const p = document.createElement("p");
    p.className = "p-strong";
    p.textContent = "טקסט חדש";
    ref.after(h);
    h.after(p);
    makeHeadingEditable(h);
    makeParagraphEditable(p);
    created = h;
  } else if (type === "quiz") {
    created = buildQuizDom("custom-" + newBid());
    ref.after(created);
    wireQuizBlock(created);
  } else if (type === "box") {
    const box = document.createElement("div");
    box.className = "intro-box";
    const p = document.createElement("p");
    p.className = "p-light";
    p.textContent = "תוכן הקלף החדש";
    box.appendChild(p);
    ref.closest(".intro-box").after(box);
    makeParagraphEditable(p);
    wireNewBoxControl(box);
    created = box;
  }
  scheduleSave();
  return created;
}

// A small "+ קלף חדש" button that floats just after each .intro-box - a
// real DOM sibling at the <main> level (never between a box's own
// children), so it can't interfere with any CSS that only targets
// elements inside .intro-box.
function wireNewBoxControl(box) {
  const row = document.createElement("div");
  row.className = "ed-new-box-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ed-add-toggle";
  btn.textContent = "+ קלף חדש";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    insertAfter(box.lastElementChild, "box");
  });
  row.appendChild(btn);
  box.after(row);
}

// ---------------------------------------------------------------------
// Quiz block edit-mode: the toolbar's pencil button disables the real
// click-to-answer buttons (via interception, see below) and turns the
// question + each choice's text editable in place, with a small dot per
// choice to mark which one is correct.
// ---------------------------------------------------------------------

function wireQuizBlock(div) {
  // quiz.js attaches its own click-to-answer listener directly on each
  // .quiz-choice button. A capture-phase listener up here runs before that
  // (capture fires top-down, ahead of the target's own bubble-phase
  // listener), so while in edit mode it can stop the event before quiz.js
  // ever sees it - except on the correct-answer dot, which needs its own
  // click to go through untouched. The native `disabled` attribute isn't
  // used for this: a disabled button also blocks interaction with its own
  // descendants, which would make the contenteditable text span inside it
  // unusable too.
  div.addEventListener("click", (e) => {
    if (!div.classList.contains("ed-quiz-editing")) return;
    if (e.target.closest(".ed-quiz-dot")) return;
    if (e.target.closest(".quiz-choice")) e.stopPropagation();
  }, true);
  wireHoverTarget(div, () => buildButtonsFor(div));
}

function toggleQuizEditMode(div) {
  const entering = !div.classList.contains("ed-quiz-editing");
  div.classList.toggle("ed-quiz-editing", entering);
  const question = div.querySelector(".quiz-question");
  const choices = Array.from(div.querySelectorAll(".quiz-choice"));
  if (entering) {
    question.contentEditable = "true";
    question.addEventListener("input", scheduleSave);
    choices.forEach((btn) => {
      const text = btn.textContent.trim();
      btn.textContent = "";
      const dot = document.createElement("span");
      dot.className = "ed-quiz-dot" + (btn.getAttribute("data-correct") === "true" ? " ed-quiz-dot-correct" : "");
      dot.title = "סמנו כתשובה הנכונה";
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        choices.forEach((c) => c.setAttribute("data-correct", "false"));
        btn.setAttribute("data-correct", "true");
        div.querySelectorAll(".ed-quiz-dot").forEach((d) => d.classList.remove("ed-quiz-dot-correct"));
        dot.classList.add("ed-quiz-dot-correct");
        scheduleSave();
      });
      const textSpan = document.createElement("span");
      textSpan.className = "ed-quiz-text";
      textSpan.contentEditable = "true";
      textSpan.textContent = text;
      textSpan.addEventListener("input", scheduleSave);
      btn.appendChild(dot);
      btn.appendChild(textSpan);
    });
  } else {
    question.contentEditable = "false";
    choices.forEach((btn) => {
      const textSpan = btn.querySelector(".ed-quiz-text");
      const finalText = textSpan ? textSpan.textContent : btn.textContent;
      const dot = btn.querySelector(".ed-quiz-dot");
      if (dot) dot.remove();
      if (textSpan) textSpan.remove();
      btn.textContent = finalText;
    });
  }
}

// ---------------------------------------------------------------------
// Lesson-page bootstrap.
// ---------------------------------------------------------------------

function initLessonEditor() {
  const m = location.pathname.match(/\/lessons\/([a-z0-9-]+)\.html$/);
  if (!m) return;
  lessonId = m[1];

  const titleEl = document.querySelector(".lesson-title-row h1");
  if (titleEl) {
    titleEl.contentEditable = "true";
    titleEl.classList.add("ed-editable", "ed-editable-title");
    titleEl.addEventListener("input", scheduleSave);
    titleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
    });
  }

  document.querySelectorAll(".intro-box").forEach((box) => {
    Array.from(box.children).forEach((child) => {
      const tag = child.tagName.toLowerCase();
      if (tag === "h1" || tag === "h2" || tag === "h3") {
        makeHeadingEditable(child);
      } else if (tag === "p") {
        makeParagraphEditable(child);
      } else if (tag === "div" && child.classList.contains("quiz")) {
        wireQuizBlock(child);
      } else if (tag === "div" && child.classList.contains("quiz-group")) {
        // See domToSections: quiz.js already unpacked this run of adjacent
        // .quiz elements into its own accordion by the time this runs, for
        // every visitor - wire each real quiz inside it individually
        // rather than treating the accordion shell as one opaque block.
        child.querySelectorAll(".quiz").forEach(wireQuizBlock);
      } else {
        wireRawBlock(child);
      }
    });
    wireNewBoxControl(box);
  });

  wireSelectionBubble();
  document.body.classList.add("admin-edit-mode");
}

// ---------------------------------------------------------------------
// index.html bootstrap: per-card move/delete, "+ new lesson" per group.
// ---------------------------------------------------------------------

function cardLessonId(card) {
  const href = card.getAttribute("href") || "";
  const m = href.match(/^lessons\/([a-z0-9-]+)\.html$/);
  return m ? m[1] : null;
}

function wireLessonCard(card) {
  wireHoverTarget(card, () => [
    { label: "↑", title: "הזזה למעלה", onClick: () => runLessonMove(cardLessonId(card), "up", card) },
    { label: "↓", title: "הזזה למטה", onClick: () => runLessonMove(cardLessonId(card), "down", card) },
    { label: "✕", title: "מחיקה", cls: "ed-ctrl-del", onClick: () => runLessonDelete(cardLessonId(card), card) },
  ]);
}

function runLessonMove(id, direction, card) {
  if (!id) return;
  ensureFns();
  card.classList.add("ed-busy");
  moveLessonFn({ lessonId: id, direction })
    .then(() => window.location.reload())
    .catch((err) => {
      card.classList.remove("ed-busy");
      window.alert((err && err.message) || "שינוי הסדר נכשל.");
    });
}

function runLessonDelete(id, card) {
  if (!id) return;
  const h3 = card.querySelector("h3");
  if (!window.confirm('למחוק את השיעור "' + (h3 ? h3.textContent : id) + '"? הפעולה לא הפיכה.')) return;
  ensureFns();
  card.classList.add("ed-busy");
  deleteLessonFn({ lessonId: id })
    .then(() => window.location.reload())
    .catch((err) => {
      card.classList.remove("ed-busy");
      window.alert((err && err.message) || "המחיקה נכשלה.");
    });
}

function buildNewLessonTile(groupTitle, grid) {
  const tile = document.createElement("div");
  tile.className = "ed-new-lesson-tile";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ed-add-toggle";
  btn.textContent = "+ שיעור חדש";

  const form = document.createElement("div");
  form.className = "ed-new-lesson-form";
  form.hidden = true;
  form.innerHTML = `
    <label>מזהה (אנגלית, מקפים) <input type="text" class="ed-field-id" dir="ltr"></label>
    <label>כותרת (דיבור המתחיל) <input type="text" class="ed-field-title"></label>
    <div class="ed-new-lesson-actions">
      <button type="button" class="ed-add-toggle ed-field-create">יצירה</button>
      <button type="button" class="ed-add-toggle ed-field-cancel">ביטול</button>
    </div>
    <p class="ed-field-status"></p>
  `;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    form.hidden = !form.hidden;
  });
  form.querySelector(".ed-field-cancel").addEventListener("click", (e) => {
    e.stopPropagation();
    form.hidden = true;
  });
  form.querySelector(".ed-field-create").addEventListener("click", (e) => {
    e.stopPropagation();
    const idInput = form.querySelector(".ed-field-id");
    const titleInput = form.querySelector(".ed-field-title");
    const statusEl2 = form.querySelector(".ed-field-status");
    const id = idInput.value.trim();
    const title = titleInput.value.trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
      statusEl2.textContent = "מזהה לא תקין (אותיות אנגליות קטנות, ספרות ומקפים בלבד).";
      return;
    }
    if (!title) {
      statusEl2.textContent = "צריך כותרת.";
      return;
    }
    const lastCard = grid.querySelector(".lesson-card:last-of-type");
    const afterLessonId = lastCard ? cardLessonId(lastCard) : null;
    statusEl2.textContent = "יוצר…";
    ensureFns();
    createLessonFn({ lessonId: id, titleText: title, sourceText: groupTitle, afterLessonId })
      .then(() => { window.location.href = "lessons/" + id + ".html"; })
      .catch((err) => { statusEl2.textContent = (err && err.message) || "יצירת השיעור נכשלה."; });
  });

  tile.appendChild(btn);
  tile.appendChild(form);
  return tile;
}

function initIndexEditor() {
  document.querySelectorAll(".group-panel").forEach((panel) => {
    const titleEl = panel.querySelector(".group-title span");
    const groupTitle = titleEl ? titleEl.textContent.trim() : "";
    const grid = panel.querySelector(".lesson-grid");
    if (!grid) return;
    grid.querySelectorAll(".lesson-card").forEach(wireLessonCard);
    grid.after(buildNewLessonTile(groupTitle, grid));
  });

  document.body.classList.add("admin-edit-mode");
}

// ---------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// General text mode, for lesson pages in any other structure (e.g. the
// question-player lessons, which draw their screens from a JS data list).
// It doesn't need to know the structure: with "עריכה" switched on, any
// text on screen becomes editable in place, and on leaving it the edit is
// sent as old-text -> new-text to replaceLessonText, which finds that exact
// text in the page's source file and replaces it there.
// ---------------------------------------------------------------------

const GEN_CSS = `
.ed-gen-bar{position:fixed;bottom:14px;left:14px;z-index:900;display:flex;flex-direction:column;gap:6px;align-items:flex-start;font-family:Rubik,Heebo,Arial,sans-serif;direction:rtl}
.ed-gen-toggle{border:0;border-radius:999px;padding:10px 16px;font:700 14px Rubik,Heebo,Arial,sans-serif;background:#14213D;color:#FFF8EC;box-shadow:0 3px 10px rgba(0,0,0,.25);cursor:pointer}
.ed-gen-toggle.on{background:#F2B33D;color:#14213D}
.ed-gen-status{font:600 13px Rubik,Heebo,Arial,sans-serif;background:#fff;border:1px solid #E8DCC4;border-radius:999px;padding:7px 12px;color:#5A6680;box-shadow:0 3px 10px rgba(0,0,0,.12)}
.ed-gen-status.ok{color:#1A7D72}.ed-gen-status.err{color:#B5432A}
.ed-gen-on .ed-gen-t{outline:1px dashed rgba(242,179,61,.9);outline-offset:2px;cursor:text}
.ed-gen-on .ed-gen-t:focus{outline:2px solid #F2B33D;background:rgba(252,235,196,.35)}
.ed-gen-ov{position:fixed;z-index:2147483646;box-sizing:border-box;background:#fff;border:2px solid #F2B33D;border-radius:10px;padding:8px 10px;font:inherit;color:#14213D;outline:none;box-shadow:0 6px 20px rgba(20,33,61,.25);direction:rtl;text-align:right}
`;

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "svg", "TEXTAREA", "INPUT", "SELECT", "OPTION", "TITLE", "HEAD"]);
let genOn = false;
let genBar = null, genStatus = null;
const genOriginal = new WeakMap();

function genSetStatus(text, kind) {
  genStatus.textContent = text || "";
  genStatus.className = "ed-gen-status" + (kind ? " " + kind : "");
  genStatus.hidden = !text;
}

function hasOwnText(el) {
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) return true;
  }
  return false;
}

function isGenCandidate(el) {
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (el.closest(".ed-gen-bar, .ed-gen-ov, .site-header, header, svg")) return false;
  return hasOwnText(el);
}

// Marks the outermost element of each piece of text as editable; its own
// inner markup (bold, highlights) stays inside the one editable block.
function genScan(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el = walker.currentNode.nodeType === Node.ELEMENT_NODE ? walker.currentNode : walker.nextNode();
  while (el) {
    if (el.closest && el.closest(".ed-gen-bar")) { el = walker.nextSibling() || nextOutside(walker); continue; }
    if (isGenCandidate(el) && !(el.parentElement && el.parentElement.closest(".ed-gen-t"))) {
      if (!el.classList.contains("ed-gen-t")) el.classList.add("ed-gen-t");
      el.contentEditable = genOn && el.tagName !== "BUTTON" ? "true" : "false";
      el = walker.nextSibling() || nextOutside(walker);
      continue;
    }
    el = walker.nextNode();
  }
}
function nextOutside(walker) {
  while (walker.parentNode()) {
    const sib = walker.nextSibling();
    if (sib) return sib;
  }
  return null;
}

// The same text in a few forms, most specific first: the server uses the
// first one it finds in the file. Highlight wrappers a page adds while
// drawing (<mark>, <span>) are dropped; "own text" skips child elements,
// e.g. the letter badge inside an answer button.
function genForms(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  const raw = clone.innerHTML;
  clone.querySelectorAll("mark, span").forEach((n) => n.replaceWith(...n.childNodes));
  const unwrapped = clone.innerHTML;
  const plain = el.textContent;
  let own = "";
  el.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) own += n.textContent; });
  const norm = (t) => t.replace(/ |&nbsp;/g, " ").trim();
  return [raw, unwrapped, plain, own].map(norm);
}

function genSave(el, before, after, all) {
  const pairs = [];
  const seen = new Set();
  before.forEach((b, i) => {
    if (!b || b === after[i] || seen.has(b)) return;
    seen.add(b);
    pairs.push([b, after[i]]);
  });
  if (!pairs.length) return;
  ensureFns();
  genSetStatus("שומר…");
  const path = location.pathname.replace(/^.*?\/(lessons\/[^/]+\.html)$/, "$1");
  replaceTextFn({ path, pairs, all: !!all })
    .then((res) => {
      const d = res.data || {};
      if (d.needConfirm) {
        if (window.confirm("הטקסט הזה מופיע " + d.count + " פעמים בעמוד. לשנות את כולם?")) {
          genSave(el, before, after, true);
        } else {
          el.innerHTML = genOriginal.get(el).html;
          genSetStatus("השינוי בוטל", "err");
        }
        return;
      }
      genOriginal.set(el, { html: el.innerHTML, forms: genForms(el) });
      genSetStatus("נשמר באתר ✓" + (d.count > 1 ? " (" + d.count + " מקומות)" : ""), "ok");
    })
    .catch((err) => {
      el.innerHTML = genOriginal.get(el).html;
      genSetStatus((err && err.message) || "שגיאה בשמירה", "err");
    });
}

// Browsers don't let you type inside a <button> (answer options, cards),
// so its text is edited in a small box laid over it.
function editButtonText(btn) {
  const own = [...btn.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  if (!own.length) return;
  const r = btn.getBoundingClientRect();
  const ov = document.createElement("div");
  ov.className = "ed-gen-ov";
  ov.contentEditable = "true";
  ov.textContent = own.map((n) => n.textContent).join("").trim();
  Object.assign(ov.style, { top: r.top + "px", left: r.left + "px", width: r.width + "px", minHeight: r.height + "px", fontSize: getComputedStyle(btn).fontSize });
  document.body.appendChild(ov);
  ov.focus();
  const sel = getSelection(), range = document.createRange();
  range.selectNodeContents(ov); range.collapse(false); sel.removeAllRanges(); sel.addRange(range);
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const text = ov.textContent.replace(/\s+/g, " ").trim();
    ov.remove();
    if (!keep || !text || text === own.map((n) => n.textContent).join("").trim()) return;
    const html = btn.innerHTML, before = genForms(btn);
    own[0].textContent = text;
    own.slice(1).forEach((n) => n.remove());
    genOriginal.set(btn, { html, forms: before });
    genSave(btn, before, genForms(btn), false);
  };
  ov.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  ov.addEventListener("blur", () => finish(true));
  ov.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " "));
  });
}

function setGenOn(on) {
  genOn = on;
  document.body.classList.toggle("ed-gen-on", on);
  const t = genBar.querySelector(".ed-gen-toggle");
  t.classList.toggle("on", on);
  t.textContent = on ? "✓ סיום עריכה" : "✎ עריכה";
  if (on) genScan(document.body);
  document.querySelectorAll(".ed-gen-t").forEach((el) => { el.contentEditable = on && el.tagName !== "BUTTON" ? "true" : "false"; });
  if (!on) genSetStatus("");
}

function initGenericEditor() {
  const style = document.createElement("style");
  style.textContent = GEN_CSS;
  document.head.appendChild(style);

  genBar = document.createElement("div");
  genBar.className = "ed-gen-bar";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ed-gen-toggle";
  toggle.textContent = "✎ עריכה";
  toggle.addEventListener("click", (e) => { e.stopPropagation(); setGenOn(!genOn); });
  genStatus = document.createElement("span");
  genStatus.hidden = true;
  // Status above the button, so a message appearing mid-click (when leaving
  // a text saves it) never shifts the button out from under the pointer.
  genBar.appendChild(genStatus);
  genBar.appendChild(toggle);
  document.body.appendChild(genBar);
  genSetStatus("");

  // While editing, a click on text only places the cursor - it must not
  // also answer a question, flip a card or follow a link underneath.
  document.addEventListener("click", (e) => {
    const el = genOn && e.target.closest && e.target.closest(".ed-gen-t");
    if (el) {
      e.stopPropagation();
      e.preventDefault();
      if (el.tagName === "BUTTON") editButtonText(el);
    }
  }, true);

  document.addEventListener("focusin", (e) => {
    const el = e.target.closest && e.target.closest(".ed-gen-t");
    if (genOn && el) genOriginal.set(el, { html: el.innerHTML, forms: genForms(el) });
  });
  document.addEventListener("focusout", (e) => {
    const el = e.target.closest && e.target.closest(".ed-gen-t");
    if (!genOn || !el || !genOriginal.has(el)) return;
    const before = genOriginal.get(el).forms;
    const after = genForms(el);
    if (before.every((b, i) => b === after[i])) return;
    genSave(el, before, after, false);
  });
  document.addEventListener("keydown", (e) => {
    const el = e.target.closest && e.target.closest(".ed-gen-t");
    if (!genOn || !el) return;
    // Space/Enter on a button would "press" it; Enter also ends the edit.
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    else if (e.key === " " && el.tagName === "BUTTON") {
      e.preventDefault();
      document.execCommand("insertText", false, " ");
    }
  }, true);

  // Pages that draw new screens (next question, next station) get their
  // new text picked up as it appears.
  new MutationObserver((muts) => {
    if (!genOn) return;
    muts.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType === Node.ELEMENT_NODE && !n.closest(".ed-gen-bar, .ed-gen-ov")) genScan(n);
    }));
  }).observe(document.body, { childList: true, subtree: true });
}

watchAuthState((user) => {
  if (!user || user.email !== ALLOWED_EMAIL) return;
  if (document.querySelector(".intro-box")) {
    initLessonEditor();
  } else if (document.querySelector(".group-panel")) {
    initIndexEditor();
  } else if (/\/lessons\/[a-z0-9-]+\.html$/.test(location.pathname)) {
    initGenericEditor();
  }
});
