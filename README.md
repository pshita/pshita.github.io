# פשיטא

אתר סטטי ללימוד גמרא לילדים (מסכת בבא קמא), מתארח ב-GitHub Pages: https://pshita.github.io

## הרצה מקומית

```bash
python3 -m http.server 8000
# ואז נכנסים ל-http://localhost:8000
```

## מבנה

```
index.html                 # דף הבית: השיעורים לפי דף ועמוד (נבנה מ-lessons.json)
lessons.json               # רשימת השיעורים, הסדר והחלוקה לדף ועמוד
lessons/<id>.html          # עמוד שיעור: מעטפת קטנה שטוענת את נגן השיעור
lessons/data/<id>.json     # התוכן של כל שיעור
lessons/README.md          # פירוט מבנה השיעורים ואיך מוסיפים שיעור שעוצב מחוץ לאתר
text.html                  # כל הטקסט ברצף (הכתובת: /text, קיצור: /t); עריכה למנהל
scenes.html                # ניסוי: בחירת שיעור בגלילה בין סצנות
login.html, register.html  # התחברות והרשמה
achievements.html          # הניקוד של התלמיד
admin.html                 # ניהול (למנהל): תלמידים, טלפונים של ההורים, ההודעה להורים
assets/css/style.css       # עיצוב דף הבית והעמודים הכלליים
assets/css/lesson-player.css, assets/js/lesson-player.js   # נגן השיעור המשותף
assets/js/content-editor.js  # עריכה למנהל: בתוך שיעור, ובדף הבית (הוספה, הזזה, מחיקה)
assets/js/auth.js, firebase-config.js, header-auth.js       # התחברות ותפריט
assets/js/score.js, progress.js, achievements.js            # ניקוד
functions/                 # Cloud Functions: שמירת עריכות ל-GitHub, SMS להורים
firestore.rules            # כללי אבטחה ל-Firestore
```

## עריכה

רק החשבון של המנהל רואה את כלי העריכה. כל שינוי נשמר ישירות ל-GitHub דרך Cloud Functions ומופיע באתר אחרי דקה-שתיים.

- **בתוך שיעור:** כפתור "✎ עריכה" בפינה.
- **טקסט רציף** (`text.html`, בתפריט של המנהל): עריכה של כותרות, קטעים ושאלות, והוספה של קטעים וכותרות חדשות.
- **דף הבית:** הוספה, הזזה ומחיקה של שיעורים.

לפרטים על המבנה ראו `lessons/README.md`.

## התחברות

גלישה באתר לא דורשת חשבון. ההתחברות היא לפי שם פרטי, שם משפחה וקוד אישי בן 4 ספרות. ראו `assets/js/auth.js`.

הנתונים נשמרים ב-Firebase (Authentication ו-Firestore), בפרויקט `avot-926d7`. רשימת הנרשמים נמצאת בקונסולת Firebase, תחת Firestore Database ← `users`.

## ניקוד ו-SMS להורים

כל שאלה שתלמיד מחובר עונה עליה נכון בשיעור נשמרת ב-`users/{uid}/progress/quiz`, פעם אחת לכל שאלה. שיעור שהגיע לסיכום נשמר ב-`users/{uid}/progress/lessons`. הנגן מדווח על זה, ו-`assets/js/student.js` כותב את הנתונים.

הפונקציה `notifyParentsOnQuizMilestone` שולחת SMS להורים דרך SMS4Free בכל פעם שהניקוד חוצה כפולה של מספר התשובות שהוגדר. הכול מוגדר בעמוד **ניהול** (`/admin`, רק למנהל):
- כל כמה תשובות נכונות נשלחת הודעה, ונוסח ההודעה (`settings/sms`). בנוסח, `{שם}` מוחלף בשם הפרטי, `{שם מלא}` בשם המלא ו-`{מספר}` במספר התשובות.
- לכל תלמיד: הטלפונים של ההורים והאם נשלחות הודעות (`users/{uid}.notify`).
- הודעת בדיקה, כדי לוודא שהחיבור ל-SMS4Free עובד.

התלמיד רואה כמה תשובות נכונות נשארו עד ההודעה הבאה. אחרי שנשלחה הודעה, הוא מקבל על כך הודעה באתר (`users/{uid}.lastSms`).

## פריסת הפונקציות

הפריסה אוטומטית: כל שינוי ב-`functions/` או ב-`firestore.rules` שמגיע ל-main נפרס דרך GitHub Actions (`.github/workflows/deploy-firebase.yml`). הסודות `GITHUB_TOKEN` ו-`SMS4FREE_*` מוגדרים ב-Secret Manager של הפרויקט.
