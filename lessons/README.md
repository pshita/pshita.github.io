# Lessons: how content is stored

| What | Where |
|---|---|
| Lesson list, order, page/amud groups | `lessons.json` (repo root) |
| One lesson's content | `lessons/data/<id>.json` |
| The page a reader opens | `lessons/<id>.html`: a thin shell with `<body data-lesson="<id>">` |
| Lesson engine (screens, questions, design) | `assets/js/lesson-player.js` and `assets/css/lesson-player.css`, shared by all lessons |
| Markup that lists lessons (home page panels, header menus) | generated from `lessons.json` by `functions/site.js` |

The player loads `data/<id>.json`. It takes "previous / next lesson" from the order in `lessons.json`.

A lesson's JSON has `title`, `ref`, `stations` (the headings) and `screens`. Each screen has a `type`, such as intro, read, mc or summary, and `st`, the index of its station. Each screen sits on one line, so a diff shows exactly what changed.

## Editing
- In-lesson editing (admin, **✎ עריכה**) calls `replaceLessonText`. It replaces whole string values in the data file.
- `text.html` (admin) calls `getLessonData` and `saveLessonData`. These read and write the whole data file. The save is refused if the file changed since it was loaded.
- Adding, moving and deleting lessons from the home page call `createLesson`, `moveLesson` and `deleteLesson`. They update `lessons.json` and regenerate `index.html` and the header menus. Lesson pages are not touched.

## Adding a lesson built elsewhere (a full HTML file with its own engine and `const LESSON={...}`)
1. Take the `LESSON` object out of the file and remove its `prev` and `next`.
2. Write the object with `formatLessonJson` from `functions/site.js` to `lessons/data/<id>.json`.
3. Write the page with `lessonShellHtml`.
4. Add the lesson to `lessons.json`, then regenerate the pages with `setIndexPanels` and `setMenu`.
5. If the file's engine is newer than `lesson-player.js`, merge the change into the shared player once. Then bump `PLAYER_VERSION` in `site.js` and the `?v=` in the existing shells.
