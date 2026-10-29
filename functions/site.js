// Pure helpers that turn the site's data files into page markup.
// Shared by the Cloud Functions (index.js) and by local maintenance
// scripts, so both always produce identical output.
//
// Data layout:
//   lessons.json               - the lesson list: groups (page/amud) -> lessons (id, title), in order
//   lessons/data/<id>.json     - one lesson's content (title, ref, stations, screens)
//   lessons/<id>.html          - a thin page that loads the shared player with that lesson
//   assets/js/lesson-player.js - the one shared lesson engine
//   assets/css/lesson-player.css

const PLAYER_VERSION = 4;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const escapeText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// One screen per line, so a diff of a lesson edit shows exactly what changed.
function formatLessonJson(lesson) {
  const { screens = [], ...rest } = lesson;
  const head = Object.entries(rest).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  head.push(`  "screens": [\n${screens.map((s) => "    " + JSON.stringify(s)).join(",\n")}\n  ]`);
  return `{\n${head.join(",\n")}\n}\n`;
}

function formatSiteJson(site) {
  const groups = site.groups.map((g) =>
    `    {"title": ${JSON.stringify(g.title)}, "lessons": [\n${g.lessons.map((l) => "      " + JSON.stringify({ id: l.id, title: l.title })).join(",\n")}\n    ]}`);
  return `{\n  "groups": [\n${groups.join(",\n")}\n  ]\n}\n`;
}

function lessonShellHtml({ id, title }) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(String(title).replace(/[״"]/g, ""))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700;800&family=Frank+Ruhl+Libre:wght@700;900&display=swap">
<link rel="stylesheet" href="../assets/css/lesson-player.css?v=${PLAYER_VERSION}">
<link rel="icon" type="image/png" sizes="32x32" href="../assets/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="64x64" href="../assets/icons/favicon-64.png">
<link rel="apple-touch-icon" href="../assets/icons/apple-touch-icon.png">
<link rel="manifest" href="../manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="פשיטא">
<meta name="theme-color" content="#ffffff">
</head>
<body data-lesson="${escapeHtml(id)}">
<div class="wrap">
  <div id="view"></div>
</div>
<script src="../assets/js/lesson-player.js?v=${PLAYER_VERSION}"></script>
<script type="module" src="../assets/js/student.js?v=${PLAYER_VERSION}"></script>
<script type="module" src="../assets/js/content-editor.js"></script>
</body>
</html>
`;
}

// Starting content for a lesson created from the home page; series and
// masechet are taken from the lesson it follows.
function newLessonData({ title, ref, like }) {
  const intro = like && like.screens && like.screens.find((s) => s.type === "intro");
  const masechet = intro && intro.daf ? intro.daf.split(" · ")[0] : "בבא קמא";
  return {
    title,
    ref,
    stations: ["פתיחה"],
    screens: [
      { type: "intro", daf: `${masechet} · ${ref}`, series: (intro && intro.series) || "", question: "", cards: [] },
      { type: "read", st: 0, text: ["כאן יופיע תוכן השיעור."] },
      { type: "summary" },
    ],
  };
}

const ARROW = (cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Home page: one collapsible panel per page/amud group.
function groupPanelsHtml(groups) {
  return groups.filter((g) => g.lessons.length).map((g) => `    <div class="dropdown group-title-dropdown">
      <div class="group-panel">
        <button type="button" class="group-title dropdown-trigger">
          <span>${escapeText(g.title)}</span>
          ${ARROW("group-arrow")}
        </button>
        <div class="dropdown-menu lessons-menu">
        <div class="lesson-grid">
${g.lessons.map((l) => `          <a class="lesson-card" href="lessons/${l.id}">
            <h3>${escapeText(l.title)}</h3>
          </a>`).join("\n")}
        </div>
        </div>
      </div>
    </div>`).join("\n");
}

// Header menu: one dropdown per group, listing its lessons.
function groupSubmenusHtml(groups, hrefPrefix) {
  return groups.filter((g) => g.lessons.length).map((g) => `<div class="submenu">
            <button type="button" class="dropdown-item submenu-trigger">
              <span>${escapeText(g.title)}</span>
              ${ARROW("submenu-arrow")}
            </button>
            <div class="dropdown-menu submenu-panel" hidden>
${g.lessons.map((l) => `            <a class="dropdown-item" href="${hrefPrefix}${l.id}">${escapeText(l.title)}</a>`).join("\n")}
            </div>
          </div>`).join("\n          ");
}

function setIndexPanels(html, groups) {
  const re = /(<main class="wrap">)[\s\S]*?(\n\s*<\/main>)/;
  if (!re.test(html)) throw new Error("index.html: <main class=\"wrap\"> not found");
  return html.replace(re, (m, a, b) => `${a}\n${groupPanelsHtml(groups)}${b}`);
}

// Replaces everything in .brand-menu between its opening tag and the first
// .auth-area with the group submenus.
function setMenu(html, groups, hrefPrefix) {
  const re = /(<div class="dropdown-menu brand-menu"[^>]*>)[\s\S]*?(\s*<div class="auth-area")/;
  if (!re.test(html)) return html;
  return html.replace(re, (m, a, b) => `${a}\n          ${groupSubmenusHtml(groups, hrefPrefix)}${b}`);
}

const MENU_PAGES = ["index.html", "login.html", "register.html", "achievements.html", "scenes.html", "admin.html"];

module.exports = {
  PLAYER_VERSION, MENU_PAGES, escapeHtml, formatLessonJson, formatSiteJson, lessonShellHtml,
  newLessonData, groupPanelsHtml, groupSubmenusHtml, setIndexPanels, setMenu,
};
