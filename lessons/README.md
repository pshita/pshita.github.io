# Lessons: how content is stored

| What | Where |
|---|---|
| Lesson list, order, page/amud groups | `lessons.json` (repo root) |
| One lesson's content | `lessons/data/<id>.json` |
| The page a reader opens | `lessons/<id>.html`: a thin shell with `<body data-lesson="<id>">` |
| Lesson engine (screens, questions, design) | `assets/js/lesson-player.js` and `assets/css/lesson-player.css`, shared by all lessons |
| Markup that lists lessons (home page panels, header menus) | generated from `lessons.json` by `functions/site.js` |

Lesson ids are numbers without hyphens: daf, amud, then the lesson's number in that amud, from 1 (`213` is the third lesson of דף ב, עמוד א). The server gives the next number when a lesson is created or a draft is published (`nextLessonId` in `functions/site.js`).

A paragraph marked on the text page to stay there only (select the whole paragraph, then "רק בטקסט") starts with `<!--text-only-->`; the player skips it, and a screen with nothing else is skipped too.

`lessons/preview.html` (a shell with no lesson id) shows the text page's "מעוצב": the player takes the lesson from the text page (`window.PSHITA_PREVIEW`) instead of a data file. Regenerate it with the other shells when `PLAYER_VERSION` changes.

The player loads `data/<id>.json`. It takes "previous / next lesson" from the order in `lessons.json`.

A lesson's JSON has `title`, `ref`, `stations` (the headings) and `screens`. Each screen has a `type`, such as intro, read, mc or summary, and `st`, the index of its station. Each screen sits on one line, so a diff shows exactly what changed.

## Editing
- In-lesson editing (admin, **✎ עריכה**) calls `replaceLessonText`. It replaces whole string values in the data file.
- `text.html` (admin) calls `getLessonData` and `saveLessonData`. These read and write the whole data file. The save is refused if the file changed since it was loaded.
- Adding, moving and deleting lessons from the text page ("תצוגה") call `createLesson`, `moveLesson` and `deleteLesson`. They update `lessons.json` and regenerate `index.html` and the header menus. Lesson pages are not touched.

## Adding a lesson built elsewhere (a full HTML file with its own engine and `const LESSON={...}`)
1. Take the `LESSON` object out of the file and remove its `prev` and `next`.
2. Write the object with `formatLessonJson` from `functions/site.js` to `lessons/data/<id>.json`.
3. Write the page with `lessonShellHtml`.
4. Add the lesson to `lessons.json`, then regenerate the pages with `setIndexPanels` and `setMenu`.
5. If the file's engine is newer than `lesson-player.js`, merge the change into the shared player once. Then bump `PLAYER_VERSION` in `site.js` and the `?v=` in the existing shells.

## Drafts
Lessons being written on the text page ("עריכה") are kept in `lessons/data/<id>.json`, with no page of their own (no link): they're seen as students will see them only on the text page ("מעוצב", through `lessons/preview.html`). A draft with a design (an opening screen) goes up to the site from its "העלאה" button there, under its own page and amud. They are not in `lessons.json`, so no list on the site shows them; `drafts.json` lists them. `listDrafts`, `saveDraft`, `deleteDraft` and `publishDraft` (which moves a draft into `lessons.json`, under a page/amud) are in `functions/index.js`.
