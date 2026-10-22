// Admin editing, loaded on the home page and on every lesson page. It does
// nothing for anyone except the one authorized account.
//
// index.html: lesson cards get hover move/delete controls, and each group
// gets a "+" tile to create a new lesson.
//
// Lesson pages: "✎ עריכה" makes the text on screen editable in place; each
// change is saved into the lesson's data file (see lessons/README.md).

import { watchAuthState, getApp } from "./auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const ALLOWED_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";

let fns = null;
let createLessonFn = null;
let moveLessonFn = null;
let deleteLessonFn = null;
let replaceTextFn = null;

function ensureFns() {
  if (fns) return;
  fns = getFunctions(getApp());
  createLessonFn = httpsCallable(fns, "createLesson");
  moveLessonFn = httpsCallable(fns, "moveLesson");
  deleteLessonFn = httpsCallable(fns, "deleteLesson");
  replaceTextFn = httpsCallable(fns, "replaceLessonText");
}

function preventFocusSteal(e) {
  e.preventDefault();
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


// `buttons` is an array of button configs (see addCtrlButton).
function showToolbarFor(el, buttons) {
  clearTimeout(hideTimer);
  const toolbar = ensureToolbar();
  toolbarOwner = el;
  toolbar.innerHTML = "";
  buttons.forEach((b) => addCtrlButton(toolbar, b));
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
  if (document.querySelector(".group-panel")) {
    initIndexEditor();
  } else if (/\/lessons\/[a-z0-9-]+\.html$/.test(location.pathname)) {
    initGenericEditor();
  }
});
