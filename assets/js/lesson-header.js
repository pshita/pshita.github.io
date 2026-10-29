// The site's header on a lesson page: the "📖 פשיטא" button with the same menu
// as every other page (lessons by page/amud, the account, and for the admin
// "טקסט" and "ניהול"). Lesson pages are thin shells, so the header is built here
// from lessons.json; it looks the same thanks to site-header.css.
const ARROW = '<svg class="submenu-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const current = document.body.dataset.lesson;

async function build() {
  const site = await fetch("../lessons.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ groups: [] }));
  const groups = site.groups.filter((g) => g.lessons.length).map((g) => `<div class="submenu">
          <button type="button" class="dropdown-item submenu-trigger"><span>${esc(g.title)}</span>${ARROW}</button>
          <div class="dropdown-menu submenu-panel" hidden>
            ${g.lessons.map((l) => `<a class="dropdown-item${l.id === current ? " active" : ""}" href="${esc(l.id)}">${esc(l.title)}</a>`).join("")}
          </div>
        </div>`).join("");
  const header = document.createElement("header");
  header.className = "site-header";
  header.innerHTML = `<div class="sh-wrap">
    <div class="dropdown brand-dropdown">
      <button type="button" class="brand dropdown-trigger"><span class="mark">📖</span><span>פשיטא</span></button>
      <div class="dropdown-menu brand-menu" hidden>
        ${groups}
        <div class="auth-area" id="auth-area-out">
          <a class="auth-link auth-link-primary" href="../login">התחברות</a>
        </div>
        <div class="auth-area" id="auth-area-in" hidden>
          <a class="score-badge" id="score-badge" href="../achievements" hidden></a>
          <div class="auth-hello"><span class="auth-user-name" id="auth-user-name"></span><button type="button" class="auth-logout" id="logout-btn">יציאה</button></div>
        </div>
      </div>
    </div>
  </div>`;
  document.body.prepend(header);

  // open / close, as main.js does on the other pages
  const menu = header.querySelector(".brand-menu");
  header.querySelector(".dropdown-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  header.querySelectorAll(".submenu-trigger").forEach((t) => t.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = t.parentElement.querySelector(".submenu-panel"), open = panel.hidden;
    menu.querySelectorAll(".submenu-panel").forEach((p) => { p.hidden = true; });
    panel.hidden = !open;
  }));
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { menu.hidden = true; });

  // the account part of the menu, the score, and the student's progress (student.js)
  await import("./header-auth.js?v=9");
  await import("./score.js");
}
build();
