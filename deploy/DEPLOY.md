# פריסה על VPS (גישה רק דרך Tailscale, בלי חשיפה לאינטרנט)

מדריך זה מניח VPS עם Ubuntu/Debian, בלי דומיין, וגישה רק דרך רשת Tailscale פרטית - האפליקציה לא תיחשף לאינטרנט הציבורי כלל.

## 1. התקנות בסיסיות ב-VPS

```bash
# Node.js LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs nginx git

# pm2 - מנהל תהליכים לשרת Node
sudo npm install -g pm2
```

## 2. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# רשמו את הכתובת שמתקבלת - תצטרכו אותה בהמשך
tailscale ip -4
```

התחברו גם למכשיר שממנו תרצו לגשת לאפליקציה (נייד/מחשב) לאותו tailnet.

## 3. הבאת הקוד ובנייה

```bash
cd /opt
sudo git clone <URL של הריפו שלכם> rewards-app
sudo chown -R $USER:$USER rewards-app
cd rewards-app

npm install
npm run build --workspace=client
npm run build --workspace=server

cp .env.example server/.env
```

ערכו את `server/.env`:
```
PORT=3001
HOST=127.0.0.1
CLIENT_URL=http://<TAILSCALE_IP>
```

`TRUST_PROXY` מוגדר ב-`deploy/ecosystem.config.cjs` ל-`loopback` (nginx רץ על אותו שרת ומתחבר דרך 127.0.0.1). אל תשתמשו במספר קפיצות (למשל `1`) כשהשרת נגיש ישירות: לקוח יכול לזייף `X-Forwarded-For` ולעקוף את ה-rate limit.

`HOST=127.0.0.1` חשוב - כך שרת ה-Node לא יאזין לממשק הציבורי של ה-VPS בכלל, רק ל-nginx המקומי.

## 3א. סודות והעלאת גרסה ממסד נתונים ישן (multi-user)

השרת מצפין את טוקן ה-RiseUp במסד (AES-256-GCM) ודורש מפתח הצפנה. **יצירת המפתח וגיבוי שלו:**

```bash
openssl rand -base64 32     # הערך ל-TOKEN_ENC_KEY
```

- שמרו עותק של המפתח **במקום נפרד מהמסד ומהגיבויים שלו** (מנהל סיסמאות וכד'). בלי המפתח אי אפשר לפענח את הטוקן; מי שמחזיק גם את המפתח וגם את קובץ המסד יכול לקרוא אותו.
- הגדירו ב-`.env`: `TOKEN_ENC_KEY`, ו-`ADMIN_EMAIL` + `ADMIN_PASSWORD` (לפחות 12 תווים). חלופה ל-`ADMIN_PASSWORD`: `ADMIN_PASSWORD_FILE=/path/to/file` (קובץ עם הסיסמה, שורה חדשה בסוף נחתכת; אין להגדיר את שניהם יחד). ב-Docker יש לעגן את הקובץ כ-volume.
- **מיקום ה-`.env`:** ב-pm2 ה-`cwd` הוא `server/`, ולכן הקובץ הוא `server/.env` (dotenv טוען מתיקיית העבודה). ב-Docker אין `.env` בתוך האימג'; `docker-compose.yml` מעביר את `TOKEN_ENC_KEY`, `TOKEN_ENC_KEY_VERSION`, `TOKEN_ENC_KEY_PREV`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PASSWORD_FILE`, וכן `COOKIE_SECURE`, `ALLOWED_ORIGINS`, `LOGIN_RATE_LIMIT_*`, `REGISTER_RATE_LIMIT_*`, `RATE_LIMIT_*` ממשתני הסביבה של המארח או מקובץ `.env` שלצד `docker-compose.yml`.

**מה קורה בהפעלה הראשונה על מסד ישן:** לפני כל שינוי השרת בודק (קריאה בלבד) שהמפתח ופרטי המנהל תקינים; אם לא - הוא יוצא עם הודעת שגיאה והמסד **לא משתנה** (לא נוצר גיבוי ולא משתנה סכמה, כך שגם לולאת restart לא מזיקה). רק אחרי שהבדיקה עברה נוצר גיבוי חד-פעמי `rewards.db.bak-<זמן>` (הרשאות 600), הסכמה מתעדכנת, הכרטיסים והסנכרונים משויכים למנהל והטוקן עובר להצפנה.

**אחרי ההפעלה הראשונה:**
1. ודאו שהאפליקציה עובדת (הגדרות > סטטוס RiseUp מחובר, סנכרון עובד).
2. **מחקו את ה-`ADMIN_PASSWORD`** (או את קובץ הסיסמה) מה-`.env`/הסביבה - הוא נדרש רק בריצה הראשונה.
3. **מחקו את קובץ הגיבוי `rewards.db.bak-*`** (וכל העתק שלו). הוא מכיל את טוקן ה-RiseUp **בטקסט גלוי**; השרת מזהיר על כך בלוג. המסד עצמו מנוקה מהטוקן הישן (`VACUUM`).

**Rollback:** חזרה לגרסה הקודמת של האפליקציה אינה אפשרית עם המסד החדש (הסכמה שונה). יש לעצור את השרת, לשחזר את קובץ הגיבוי `rewards.db.bak-*` במקום `rewards.db` (ולמחוק את קבצי `rewards.db-wal` / `rewards.db-shm`), ואז להריץ את הגרסה הקודמת. לכן מחקו את הגיבוי רק אחרי שהגרסה החדשה אומתה.

### החלפת מפתח הצפנה (rotation)

1. צרו מפתח חדש: `openssl rand -base64 32`, וגבו אותו בנפרד.
2. ב-`.env`: הערך הנוכחי של `TOKEN_ENC_KEY` עובר ל-`TOKEN_ENC_KEY_PREV`; המפתח החדש נכנס ל-`TOKEN_ENC_KEY`; העלו את `TOKEN_ENC_KEY_VERSION` ב-1 (ברירת מחדל 1, כלומר 1 -> 2).
3. הפעילו מחדש את השרת (`pm2 restart rewards-server --update-env` / `docker compose up -d`).
4. חכו להודעה בלוג: `N rows re-encrypted with key version <V>`. (שורות שלא טופלו מוצפנות מחדש גם בעת שימוש ראשון בהן.)
5. רק אז הסירו את `TOKEN_ENC_KEY_PREV`. אל תדלגו על גרסה: השרת מכיר רק את הגרסה הנוכחית ואת זו שלפניה, ולכן חייבים לסיים rotation (שלב 4) לפני rotation הבא.

אם השרת אינו מצליח לפענח טוקן שמור (מפתח חסר/שגוי/גרסה לא מוכרת) הוא מסרב לעלות ומציין את הסיבה בלוג, בלי לשנות את המסד.

## 3ב. אימות משתמשים (cookies, CSRF, איפוס סיסמה)

- ה-session נשמר ב-cookie בשם `__Host-sid` (דגל `Secure`) כש-`COOKIE_SECURE=true` (ברירת המחדל כש-`NODE_ENV=production`), אחרת `sid` בלי `Secure`. **פריסה ב-HTTP פשוט (כתובת Tailscale בלי TLS) חייבת `COOKIE_SECURE=false`** - אחרת הדפדפן יזרוק את ה-cookie וההתחברות לא תחזיק. עם HTTPS השאירו `true`.
- ה-nginx חייב להעביר `Host` מקורי (`proxy_set_header Host $host;`, כבר קיים בדוגמה) - בדיקת ה-CSRF משווה את `Origin` ל-`Host`. ה-nginx גם דורס את `X-Forwarded-Host` ב-`$http_host` (כולל פורט). בדיקת ה-CSRF משווה host בלבד ולא סכמה (http/https); זה מכוון, כי הסכמה מגיעה מכותרת שניתנת לזיוף אם `TRUST_PROXY` רחב מדי. מקורות נוספים: `ALLOWED_ORIGINS` (רשימה מופרדת בפסיקים). בקשות לא-דפדפן (curl) חייבות לשלוח `Origin`.
- `TRUST_PROXY` חייב להיות נכון כדי שה-rate limit לפי IP יעבוד (ראו סעיף nginx). מגבלות הכניסה/הרשמה: משתני `LOGIN_RATE_LIMIT_*` / `REGISTER_RATE_LIMIT_*` ב-`.env.example`.
- נעילת חשבון: 5 כשלונות רצופים נועלים ל-60 שניות; אחרי שהנעילה פגה המונה מתחיל מאפס (כשלון בודד לא נועל שוב). מגבלת ניסיונות לפי (אימייל + IP) ומגבלה גבוהה (`LOGIN_RATE_LIMIT_EMAIL_GLOBAL_MAX`, ברירת מחדל 100) לפי אימייל בלבד. סיכון שיורי: תוקף עם הרבה כתובות IP יכול עדיין להקשות על משתמש מסוים להתחבר. במקרה כזה נקו את הנעילה עם `reset-password` (למטה). סיסמאות מנורמלות ל-NFC לפני ה-hash.
- `COOKIE_SECURE` ב-`ecosystem.config.cjs` מוגדר `false` (HTTP פשוט); הגדירו `true` רק מאחורי TLS. אם הוא `true` והשרת רואה בקשת http, נרשמת אזהרה בלוג (פעם אחת).
- איפוס סיסמה למשתמש (למנהל השרת בלבד; מבטל את כל ה-sessions ומנקה נעילה; הסיסמה נקראת בהקלדה נסתרת או מ-stdin, לא מ-argv/env):

```bash
cd /opt/rewards-app
npm run build --workspace=server
npm run reset-password --workspace=server -- user@example.com
# Docker: docker compose exec <service> node server/dist/cli/reset-password.js user@example.com
# (עם stdin: docker compose exec -T ... < קובץ-סיסמה, או -it להקלדה)
```

## 4. הרצת השרת עם pm2

```bash
cd /opt/rewards-app
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup   # יריץ פקודה עם sudo - הריצו אותה כדי שהשרת יעלה אוטומטית אחרי reboot
```

## 5. nginx - הגשת הלקוח + proxy ל-API

```bash
sudo cp deploy/nginx-app.conf.example /etc/nginx/sites-available/rewards-app
sudo sed -i "s#<TAILSCALE_IP>#$(tailscale ip -4)#; s#<APP_PATH>#/opt/rewards-app#" /etc/nginx/sites-available/rewards-app
sudo ln -s /etc/nginx/sites-available/rewards-app /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

כותרות האבטחה משותפות ב-`deploy/nginx-security-headers.conf` (נטען ב-`include`; ההעתקה לנתיב `<APP_PATH>` כבר חלק מהפריסה). ה-nginx שולח `Cache-Control: no-store` על כל תשובות ה-API, `no-cache` על `index.html` ו-`immutable` על `/assets/`. ה-nginx דורס את `X-Forwarded-For` בכתובת הלקוח האמיתית (`$remote_addr`) כי הוא הקפיצה הראשונה, ושולח כותרות CSP לקבצי ה-HTML הסטטיים (השרת לא מגיש אותם בפריסה זו). הוסיפו HSTS רק אם אתם מגישים HTTPS.

**פריסת Docker:** ה-nginx של המארח (התצורה שלו לא בריפו) חייב גם הוא לשלוח `proxy_set_header X-Forwarded-For $remote_addr;` (או `$proxy_add_x_forwarded_for` אם הוא לא הקפיצה הראשונה) ו-`X-Forwarded-Proto $scheme`. ב-`docker-compose.yml` מוגדר `TRUST_PROXY=loopback,linklocal,uniquelocal` כי הבקשה מגיעה מכתובת ה-gateway הפרטית של רשת ה-bridge ולא מ-loopback. Express שולח HSTS רק ב-`NODE_ENV=production` (דפדפנים מתעלמים ממנו ב-HTTP פשוט) וללא `upgrade-insecure-requests`, כך שגישה ב-HTTP רגיל ממשיכה לעבוד. נתיב `/api/health` פטור מה-rate limit.

שימו לב: ה-`listen` בקובץ הוגדר על כתובת ה-Tailscale בלבד (לא `0.0.0.0`) - כך nginx בכלל לא מאזין על הממשק הציבורי של ה-VPS.

## 6. חומת אש (הגנה כפולה)

```bash
sudo ufw allow OpenSSH
sudo ufw allow in on tailscale0
sudo ufw enable
sudo ufw status
```

כך גם אם משהו יוגדר לא נכון ב-nginx, אין גישה מבחוץ ל-VPS מלבד SSH.

## 7. גישה לאפליקציה

מכל מכשיר שמחובר לאותו tailnet:
```
http://<TAILSCALE_IP>/
```

## עדכון האפליקציה בהמשך

```bash
cd /opt/rewards-app
git pull
npm install
npm run build --workspace=client
npm run build --workspace=server
pm2 restart rewards-server
```

## הערות

- טוקן ה-RiseUp (PAT) פג תוקף אחרי 30 יום - תצטרכו להתחבר מחדש בעמוד ההגדרות מדי פעם.
- מסד הנתונים (`server/data/rewards.db`) הוא קובץ SQLite מקומי על ה-VPS - גבו אותו אם חשוב לכם לשמר היסטוריה.
- יש חשבונות והתחברות (`/api/auth/*`), וכל נתיבי הנתונים (cards/goals/transactions/riseup) דורשים התחברות ומבודדים לפי משתמש (בקשה למשאב של משתמש אחר מחזירה 404). עדיין מומלץ להשאיר את השרת מאחורי Tailscale/HTTPS. ל-RiseUp: סנכרון אחד בו-זמנית למשתמש, ועד `RISEUP_MAX_CONCURRENT` (ברירת מחדל 3) תהליכי MCP במקביל בשרת; תהליך ה-MCP לא יורש את סודות השרת (`TOKEN_ENC_KEY`, `ADMIN_*` וכו').
- `@riseup-oss/mcp` הוא גבול האמון: השרת מפעיל אותו כתהליך משנה (`node` על הגרסה המותקנת מה-lockfile, ללא `npx` וללא הורדה בזמן ריצה) ומעביר לו את הטוקן של RiseUp. תהליך זה רץ תחת אותו משתמש מערכת (uid) כמו השרת, ולכן טכנית יכול לקרוא את סביבת השרת וקובץ ה-DB; הסביבה שלו מצומצמת, אך זה לא בידוד. יש לעדכן אותו רק דרך `package-lock.json` (`npm ci` / בנייה מחדש של ה-image) ולבדוק שינויי גרסה לפני פריסה.
- הגבלות RiseUp לכל משתמש: `RISEUP_USER_RATE_LIMIT_MAX` (ברירת מחדל 5) לכל `RISEUP_USER_RATE_LIMIT_WINDOW_MS` (ברירת מחדל 15 דקות) של בדיקות טוקן וסנכרונים, וקולדאון `RISEUP_TOKEN_COOLDOWN_MS` (30 שניות) אחרי בדיקת טוקן שנכשלה; חריגה מחזירה 429.
