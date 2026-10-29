// The site's menu: the "📖 פשיטא" button and its dropdown (lessons by page/amud, the
// account, and for the admin "טקסט" and "ניהול"). The site's own pages have it in
// their markup (written by functions/site.js); pages built in the browser (lessons,
// the text page) get the same markup from here, built from lessons.json, and the
// same look from site-header.css.
const ARROW = '<svg class="submenu-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// `up`: the way back to the site's root ("../" from a lesson page); `lessonHref`: a
// lesson's link from this page; `current`: the lesson to mark.
export async function buildMenu({ up = "", lessonHref = (id) => up + "lessons/" + id, current = "" } = {}) {
  const site = await fetch(up + "lessons.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ groups: [] }));
  const groups = site.groups.filter((g) => g.lessons.length).map((g) => `<div class="submenu">
        <button type="button" class="dropdown-item submenu-trigger"><span>${esc(g.title)}</span>${ARROW}</button>
        <div class="dropdown-menu submenu-panel" hidden>
          ${g.lessons.map((l) => `<a class="dropdown-item${l.id === current ? " active" : ""}" href="${esc(lessonHref(l.id))}">${esc(l.title)}</a>`).join("")}
        </div>
      </div>`).join("");
  const box = document.createElement("div");
  box.className = "dropdown brand-dropdown";
  box.innerHTML = `<button type="button" class="brand dropdown-trigger"><span class="mark">📖</span><span>פשיטא</span></button>
    <div class="dropdown-menu brand-menu" hidden>
      ${groups}
      <div class="auth-area" id="auth-area-out">
        <a class="auth-link auth-link-primary" href="${up}login">התחברות</a>
      </div>
      <div class="auth-area" id="auth-area-in" hidden>
        <a class="score-badge" id="score-badge" href="${up}achievements" hidden></a>
        <div class="auth-hello"><span class="auth-user-name" id="auth-user-name"></span><button type="button" class="auth-logout" id="logout-btn">יציאה</button></div>
      </div>
    </div>`;

  // open / close, as main.js does on the other pages
  const menu = box.querySelector(".brand-menu");
  box.querySelector(".dropdown-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    box.dispatchEvent(new CustomEvent("menu-toggle", { bubbles: true }));
  });
  box.querySelectorAll(".submenu-trigger").forEach((t) => t.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = t.parentElement.querySelector(".submenu-panel"), open = panel.hidden;
    menu.querySelectorAll(".submenu-panel").forEach((p) => { p.hidden = true; });
    panel.hidden = !open;
  }));
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { menu.hidden = true; });
  return box;
}

// Once the menu is on the page: the account part, the admin's links, the score,
// the goals and the ✓ marks (header-auth.js, score.js).
export async function activateMenu() {
  await import("./header-auth.js?v=12");
  await import("./score.js");
}
