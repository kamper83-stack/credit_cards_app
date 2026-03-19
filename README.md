# מעקב הטבות כרטיסי אשראי

אפליקציה לניהול ומעקב אחר יעדי הוצאות בכרטיסי אשראי ישראליים.

## תכונות

- **ניהול כרטיסים** - הוסף כרטיסי אשראי מכל הספקים הישראליים
- **יעדי הטבות** - הגדר יעדי הוצאה חודשיים / רבעוניים / שנתיים
- **סנכרון אוטומטי** - מתחבר לאתרי כרטיסי האשראי ושואב עסקאות
- **ויזואליזציה** - טבעות progress וגרפים לעקוב אחר ההתקדמות
- **התראות דחיפות** - מציג יעדים שפגות תוקפם בקרוב

## ספקים נתמכים

- Max (מקס לשעבר לאומי קארד)
- Cal (ויזה כאל)
- Isracard (ישראכרט)
- American Express Israel
- בנק הפועלים
- בנק לאומי
- בנק מזרחי-טפחות
- בנק דיסקונט
- הזנה ידנית

## התקנה

```bash
# התקן dependencies
npm install
cd server && npm install
cd ../client && npm install

# הפעל development
cd .. && npm run dev
```

הפרונטאנד יעלה על http://localhost:5173
הבקאנד יעלה על http://localhost:3001

## אבטחה

פרטי הכניסה לכרטיסי אשראי נשמרים **מקומית בלבד** ב-SQLite על המחשב שלך.
הנתונים לא עוזבים את המחשב שלך.

## טכנולוגיות

- Frontend: React + TypeScript + Vite + Tailwind CSS
- Backend: Node.js + Express + SQLite
- Scraping: [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)
