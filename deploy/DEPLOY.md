# פריסה ותפעול

מדריך הפריסה של האפליקציה (רב-משתמשים). הנתיב הראשי הוא **Docker + nginx של המארח + HTTPS** (כך רץ `https://rewards.erankam.dev`). חלופה ל-VPS פרטי עם pm2 ו-Tailscale מופיעה בסעיף 8.

| אני רוצה... | סעיף |
|---|---|
| להבין איך האבטחה בנויה | 1 |
| התקנה נקייה על שרת חדש | 3 |
| **לשדרג את rewards.erankam.dev מהגרסה הישנה (משתמש יחיד)** | **4** |
| גיבוי, החלפת מפתח, איפוס סיסמה, מפתח שאבד, ניטור | 5 |
| הגדרות ידניות ב-GitHub | 6 |
| פריסה עם pm2 + Tailscale | 8 |

## 1. ארכיטקטורה ואבטחה

```
דפדפן --HTTPS--> nginx (המארח) --HTTP--> 127.0.0.1:3006 --> קונטיינר (Node/Express :3000)
                                                              |-- מגיש את ה-SPA (client/dist) וה-API (/api)
                                                              |-- SQLite ב-/app/data (מעוגן מ-./data)
                                                              '-- תהליך משנה: @riseup-oss/mcp (stdio) עם הטוקן של המשתמש
```

- **אימות:** הרשמה בהזמנה בלבד (סעיף 5.4.1; משתמש מנהל ראשון נוצר מ-`ADMIN_*` בהפעלה הראשונה), סיסמאות ב-argon2id (10-128 תווים, נורמליזציית NFC). ה-session הוא cookie אטום (`HttpOnly`, `SameSite=Lax`, `Path=/`, בלי `Domain`); ב-DB נשמר רק ה-SHA-256 שלו. פג אחרי 7 ימי חוסר פעילות או 30 יום מוחלטים; כניסה/הרשמה/שינוי סיסמה מחליפים את ה-token, ושינוי סיסמה מבטל את כל ה-sessions. עם `COOKIE_SECURE=true` (ברירת המחדל ב-production) השם הוא `__Host-sid` ויש דגל `Secure`.
- **בידוד נתונים:** כל נתיב תחת `/api` דורש התחברות (חוץ מ-`register`, `login`, `logout`, `health`), וכל שאילתה מסוננת לפי המשתמש. משאב של משתמש אחר מחזיר 404 זהה למשאב שלא קיים.
- **CSRF:** לכל בקשה שאינה GET/HEAD/OPTIONS חייב להיות `Origin` (או `Referer`) התואם ל-`Host` של הבקשה (או ל-`ALLOWED_ORIGINS`), וגוף הבקשה חייב להיות `application/json`. לכן nginx חייב להעביר את ה-`Host` המקורי, ו-curl חייב לשלוח `Origin`.
- **הצפנה:** טוקן ה-RiseUp של כל משתמש מוצפן ב-AES-256-GCM (מפתח `TOKEN_ENC_KEY`, ה-id של המשתמש כ-AAD) ולא חוזר ללקוח (רק תצוגה מוסתרת). `ADMIN_*` ו-`TOKEN_ENC_KEY` לא מועברים לתהליך ה-MCP.
- **הגבלות קצב:** כניסה לפי IP (20), לפי אימייל+IP (10) ולפי אימייל (100) ב-15 דקות; הרשמה 10 לשעה ל-IP (`REGISTER_RATE_LIMIT_*`); ניסיונות הזמנה שגויה (לא קיימת/פגה/בוטלה/מוצתה) 10 לשעה ל-IP (`INVITE_FAIL_RATE_LIMIT_MAX`, `INVITE_FAIL_RATE_LIMIT_WINDOW_MS`; ראו הערה על IP משותף בסעיף 5.4.1); `/api` כללי 300 ב-15 דקות (`/api/health` פטור); RiseUp: 5 פעולות ל-15 דקות למשתמש, סנכרון אחד בו-זמנית למשתמש ו-`RISEUP_MAX_CONCURRENT` (3) בשרת. נעילת חשבון ל-60 שניות אחרי 5 כשלונות רצופים. הגבלות לפי IP תלויות ב-`TRUST_PROXY` נכון (סעיף 4.5).
- **כותרות:** CSP קפדני, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, HSTS ב-production, ו-`Cache-Control: no-store` על כל תשובת `/api`. מגיעות מהאפליקציה עצמה (helmet), כך שב-Docker nginx לא צריך להוסיף אותן.
- **`@riseup-oss/mcp` הוא גבול האמון:** השרת מפעיל אותו עם `node` על הגרסה שננעלה ב-`package-lock.json` (בלי `npx` ובלי הורדה בזמן ריצה) ומעביר לו את הטוקן. הוא רץ תחת אותו משתמש מערכת כמו השרת, ולכן זה לא בידוד מלא. מעדכנים אותו רק דרך ה-lockfile ובנייה מחדש.
- **קובץ המסד:** SQLite בהרשאות 600 (בבעלות uid 1000 בקונטיינר, ולכן פקודות `sqlite3` על `data/` במארח דורשות `sudo`). הגנה על הקובץ + המפתח (בנפרד) היא הגנת הטוקנים: מי שמחזיק את שניהם קורא את הטוקנים.

משתני הסביבה כולם מתועדים (עם ברירות מחדל) ב-[`.env.example`](../.env.example), המקור היחיד. אין כאן טבלה כפולה.

## 2. תנאים מקדימים בשרת

Docker Engine + Compose v2, nginx, `openssl`, `curl`, ומומלץ `sqlite3` (`sudo apt install sqlite3`) לבדיקות וגיבוי. תעודת TLS תקפה לדומיין (certbot). Git לשליפת הקוד.

## 3. התקנה חדשה (Docker)

```bash
cd /opt && sudo git clone <URL של הריפו> rewards-app && sudo chown -R $USER: rewards-app && cd rewards-app

openssl rand -base64 32          # שמרו את הפלט במנהל סיסמאות לפני שממשיכים

umask 077
nano .env                        # ראו התוכן למטה
chmod 600 .env

mkdir -p data && sudo chown -R 1000:1000 data   # הקונטיינר רץ כמשתמש node (uid 1000)
docker compose build && docker compose up -d
docker compose logs --tail=20 app               # צפוי: "Server running on http://0.0.0.0:3000"
```

תוכן `.env` להתקנה חדשה. **מסד נקי דורש `ADMIN_EMAIL`/`ADMIN_PASSWORD` בהפעלה הראשונה**: ההרשמה בהזמנה בלבד, ולכן זה החשבון (מנהל) שממנו יוצרים את ההזמנות. בלעדיהם, ב-production (`NODE_ENV=production`, כמו ב-Docker) השרת יוצא מיד עם `Startup aborted: No users exist and ADMIN_EMAIL ...`; בפיתוח/בדיקות הוא עולה עם אזהרה בולטת בלוג. ברגע שקיים משתמש כלשהו `ADMIN_*` מתעלמים ממנו (ואפשר למחוק את `ADMIN_PASSWORD`, סעיף 4.9):

```
TOKEN_ENC_KEY=<הפלט של openssl>
ADMIN_EMAIL=<האימייל שלכם>
ADMIN_PASSWORD='<לפחות 12 תווים>'
```

בלי `TOKEN_ENC_KEY` השרת עולה, אבל שמירת טוקן RiseUp תיכשל (500). ללא TLS (גישה ב-HTTP בלבד, רק לבדיקה מקומית) הוסיפו `COOKIE_SECURE=false`.

**שימו לב:** אחרי `umask 077` התיקייה `data` נוצרת בהרשאות 700 בבעלות המשתמש שלכם, והקונטיינר (uid 1000) לא יוכל לכתוב בה. לכן ה-`chown -R 1000:1000 data` למעלה הוא חובה, ויש להריץ אותו שוב אחרי כל פעולה כ-root על `data/` (למשל `sudo sqlite3` כשהקונטיינר עצור).

אחר כך הגדירו nginx (סעיף 4.5), הריצו את בדיקת העשן (4.8) ופתחו את האתר.

## 4. שדרוג מהגרסה הישנה (משתמש יחיד) ל-rewards.erankam.dev

הגרסה הישנה שומרת את הטוקן של RiseUp בטקסט גלוי ב-`data/rewards.db` ואין בה משתמשים. הגרסה החדשה, בהפעלה הראשונה על מסד כזה: בודקת תנאים (קריאה בלבד, בלי לשנות כלום), יוצרת גיבוי חד-פעמי, מוסיפה את הסכמה, יוצרת חשבון מנהל מ-`ADMIN_EMAIL`/`ADMIN_PASSWORD`, משייכת אליו את כל הכרטיסים/העסקאות/היעדים, מצפינה את הטוקן, מוחקת את הטקסט הגלוי (`VACUUM`).

**מה שקורה אם משהו חסר:** אם המפתח או פרטי המנהל חסרים/שגויים השרת יוצא עם `Startup aborted: ...` **והמסד לא משתנה** (גם לא נוצר גיבוי). ב-Docker (`restart: unless-stopped`) הקונטיינר ינסה שוב ושוב עד שתתקנו את `.env`; זה לא מזיק, רק מרעיש.

### 4.1 בדיקות מקדימות

```bash
cd /opt/rewards-app
docker compose version && df -h .          # יש מקום ל-2-3 עותקים של המסד
ls -la data/                                # rewards.db קיים (בבעלות root בגרסה הישנה)
git rev-parse HEAD                          # רשמו: זה ה-commit של הגרסה הישנה (לשחזור)
git status --short                          # צפוי נקי
docker inspect credit-cards-app --format '{{.Image}}'   # מזהה ה-image הישן
```

שמרו את ה-image הישן כדי שאפשר יהיה לחזור בלי לבנות מחדש (גם אם ה-registry לא זמין):

```bash
docker tag "$(docker inspect credit-cards-app --format '{{.Image}}')" credit-cards-app:legacy
```

בדקו את המסד הנוכחי ורשמו מספרים להשוואה אחרי השדרוג:

```bash
sudo sqlite3 data/rewards.db "PRAGMA integrity_check; SELECT count(*) FROM cards; SELECT count(*) FROM transactions; SELECT count(*) FROM goals;"
```

### 4.2 גיבוי ידני (לפני כל שינוי)

```bash
# א. גיבוי "חם" עם sqlite (בטוח גם כשהשרת רץ) לתיקייה מחוץ ל-data
mkdir -p -m 700 ~/rewards-backups
sudo sqlite3 data/rewards.db ".backup '$HOME/rewards-backups/rewards-legacy-$(date +%Y%m%d-%H%M%S).db'"
sudo chown "$USER": "$HOME"/rewards-backups/*.db && chmod 600 "$HOME"/rewards-backups/*.db

# ב. עצרו את הגרסה הישנה והעתיקו את כל התיקייה (כולל קבצי -wal/-shm והרשאות)
docker compose stop app
sudo cp -a data "data.bak-$(date +%Y%m%d-%H%M%S)"
sudo chmod 700 data.bak-*
```

שני הגיבויים מכילים את טוקן ה-RiseUp **בטקסט גלוי**; שמרו אותם בהרשאות מגבילות ואל תעלו לשום מקום. התיקייה `data.bak-*` כבר ב-`.gitignore` וב-`.dockerignore`. אם אין `sqlite3` במארח, דלגו על (א): ההעתקה (ב) בזמן שהקונטיינר עצור היא גיבוי עקבי.

### 4.3 מפתח הצפנה

```bash
openssl rand -base64 32
```

- שמרו את הערך **קודם** במנהל סיסמאות (או כספת אחרת) - **לא** באותו מקום שבו נשמרים גיבויי המסד, ולא בתיקיית `data/`. בלי המפתח אי אפשר לפענח את הטוקן שבמסד; מי שיש לו גם את המפתח וגם את המסד קורא אותו.
- אל תעתיקו את המפתח לצ'אט, לטיקט או ל-commit.

### 4.4 קובץ `.env`

ליד `docker-compose.yml`, בהרשאות 600 (ערכו בעורך, לא עם `echo` שנשמר בהיסטוריית ה-shell):

```bash
umask 077 && nano .env && chmod 600 .env
```

```
TOKEN_ENC_KEY=<המפתח מסעיף 4.3>
ADMIN_EMAIL=<האימייל שלכם>
ADMIN_PASSWORD='<לפחות 12 תווים>'
# COOKIE_SECURE לא מוגדר => true (נכון מאחורי HTTPS). false רק ל-HTTP פשוט.
```

- `ADMIN_PASSWORD` נדרש רק להפעלה הראשונה (סעיף 4.9). אם הסיסמה מכילה `$`, השאירו אותה בגרשיים בודדים. חלופה `ADMIN_PASSWORD_FILE` דורשת גם volume לקובץ ב-`docker-compose.yml`; הדרך הפשוטה היא `ADMIN_PASSWORD`.
- `COOKIE_SECURE=true` (ברירת המחדל כאן) נכון רק מאחורי HTTPS. מומלץ להעביר גם `X-Forwarded-Proto` (בלעדיו השרת רואה בקשות כ-http ורק רושם אזהרה בלוג; ה-cookie עדיין נשלח ונשמר בדפדפן שניגש ב-HTTPS). עם `false` ה-cookie נקרא `sid` בלי `Secure` ונשלח גם ב-HTTP: מתאים רק לבדיקה מקומית או ל-Tailscale בלי TLS. ב-`false` ה-session חשוף לצותת ברשת.
- `TRUST_PROXY=loopback,linklocal,uniquelocal` כבר מוגדר ב-`docker-compose.yml` (אין צורך ב-`.env`).
- ודאו שהערכים הגיעו לקונטיינר בלי להדפיס אותם (אחרי ההפעלה): `docker compose exec app sh -c 'test -n "$TOKEN_ENC_KEY" && echo key-set'`.

### 4.5 רשימת בדיקה ל-nginx של המארח

תבנית מלאה: [`nginx-docker.conf.example`](nginx-docker.conf.example). לפני השדרוג ודאו בקובץ הקיים (`sudo nginx -T | less`):

- [ ] `proxy_pass http://127.0.0.1:3006;`
- [ ] `proxy_set_header Host $host;` - הערך המקורי, בלי שינוי (בדיקת CSRF משווה `Origin` ל-`Host`).
- [ ] `proxy_set_header X-Forwarded-For $remote_addr;` - **דורס**, לא `$proxy_add_x_forwarded_for`, כש-nginx הוא הקפיצה הראשונה. אחרת לקוח יזייף כתובת ויעקוף את ה-rate limit. (אם יש CDN לפני nginx, הגדירו `real_ip` קודם.)
- [ ] `proxy_set_header X-Forwarded-Proto $scheme;` - בלעדיו עם `COOKIE_SECURE=true` יופיע בלוג `WARNING: COOKIE_SECURE is on but a request arrived over plain http`. זו אזהרה בלבד: היא לא מונעת את שמירת ה-cookie בדפדפן, אבל היא מסמנת הגדרה שגויה שכדאי לתקן.
- [ ] `proxy_set_header X-Forwarded-Host $http_host;` (דורס).
- [ ] **בלי** `proxy_hide_header`/`add_header` שמשכפלים כותרות אבטחה: האפליקציה שולחת CSP, `nosniff`, `Referrer-Policy`, HSTS ו-`Cache-Control: no-store` על `/api`. אל תוסיפו `expires`/`proxy_cache` על `/api`.
- [ ] TLS תקף, הפניה מ-80 ל-443, `ssl_protocols TLSv1.2 TLSv1.3`. HSTS נשלח מהאפליקציה; אל תוסיפו עוד אחד.
- [ ] `client_max_body_size 256k;` (ה-API מקבל JSON קטן, עד 100kb) ו-`proxy_read_timeout 120s` (סנכרון RiseUp יכול לקחת עד 90 שניות).
- [ ] הפורט `3006` מפורסם רק על `127.0.0.1` (כך ב-`docker-compose.yml`); בדקו שהוא לא נגיש מבחוץ: `curl -m 3 http://<IP ציבורי>:3006` צריך להיכשל.

אחרי שינוי: `sudo nginx -t && sudo systemctl reload nginx`.

### 4.6 בנייה והפעלה

```bash
git pull --ff-only                      # או: git checkout <תג/commit של השחרור>
docker compose build                    # משחזר את כל התלויות מ-package-lock (npm ci)

sudo chown -R 1000:1000 data            # הקונטיינר החדש רץ כ-node (uid 1000); גיבויי data.bak-* לא משתנים
docker compose up -d
docker compose logs -f app              # Ctrl-C ליציאה
```

בלי ה-`chown` הקונטיינר החדש לא יצליח לפתוח את המסד ויקרוס (`unable to open database file`), בלי לשנות אותו. תקנו עם הפקודה למעלה והפעילו שוב. אם ה-`chown` דולג, ההפעלה נעצרת עם שגיאה מהצורה `Startup aborted: EACCES: permission denied, open '/app/data/rewards.db.bak-<חותמת-זמן>'` (השרת לא הצליח לכתוב את הגיבוי לפני המיגרציה, והמסד לא שונה); הפתרון הוא אותו `chown`.

### 4.7 אימות

שורות צפויות בלוג בהפעלה הראשונה (בדיוק סדר זה):

```
Legacy database detected; backup written to /app/data/rewards.db.bak-<חותמת-זמן>
WARNING: the RiseUp token was encrypted and the plaintext removed from the database, but the pre-migration backup /app/data/rewards.db.bak-<...> still contains the PLAINTEXT token. Verify the app works, then delete the backup (and any copies of it).
Server running on http://0.0.0.0:3000
```

האזהרה היא מכוונת. בהפעלות הבאות רק `Server running ...`. אם מופיע `Startup aborted: ...` - קראו את הסיבה, תקנו את `.env`, והפעילו `docker compose up -d` (המסד לא נגע).

```bash
docker compose ps                        # STATUS: Up ... (healthy)
curl -s https://rewards.erankam.dev/api/health            # {"ok":true}
scripts/smoke-test.sh https://rewards.erankam.dev --no-register   # בדיקות אנונימיות, לא יוצר משתמש
```

אחר כך בדפדפן:

1. היכנסו עם `ADMIN_EMAIL`/`ADMIN_PASSWORD`. הכרטיסים, העסקאות והיעדים הישנים מופיעים (השוו למספרים מסעיף 4.1).
2. הגדרות: סטטוס RiseUp מחובר (תצוגה מוסתרת של הטוקן), "סנכרן עכשיו" עובד.
3. הרשמה והתחברות עם משתמש בדיקה שני בעזרת הזמנה (סעיף 5.4.1), או `SMOKE_INVITE=<טוקן הזמנה חד-פעמי> scripts/smoke-test.sh https://rewards.erankam.dev` (יוצר משתמש זמני `smoke-<hex>@example.com`; בלי `SMOKE_INVITE` בדיקות החשבון מדולגות): המשתמש החדש רואה רשימות ריקות ולא את נתוני המנהל.
4. בדיקת cookie: בכלי המפתחים, `__Host-sid` עם `HttpOnly`, `Secure`, `SameSite=Lax`.

אם ההתחברות "מצליחה" אבל נזרקים בחזרה למסך הכניסה: ה-cookie לא נשמר. סיבה נפוצה: `COOKIE_SECURE=true` בגישה ב-HTTP פשוט (הדפדפן זורק cookie עם `Secure`). אזהרה בלוג על `X-Forwarded-Proto` חסר מצביעה על הגדרת nginx שגויה, אך כשלעצמה אינה גורמת לאובדן ה-cookie בגישת HTTPS.

### 4.8 בדיקת עשן

```bash
SMOKE_INVITE=<טוקן הזמנה חד-פעמי> scripts/smoke-test.sh https://rewards.erankam.dev   # מלא: יוצר משתמש בדיקה
scripts/smoke-test.sh https://rewards.erankam.dev              # בלי SMOKE_INVITE: בדיקות החשבון מדולגות (רק אנונימיות)
scripts/smoke-test.sh https://rewards.erankam.dev --no-register   # רק בדיקות אנונימיות
```

הסקריפט בודק: health, 401 לבקשה אנונימית, כותרות אבטחה (CSP, nosniff, `no-store` על `/api`), הגשת ה-SPA, דחיית POST חוצה-מקור (403), **בלי `SMOKE_INVITE` בדיקות החשבון מדולגות במפורש** (ההרשמה בהזמנה בלבד; הסקריפט מדפיס על כך הערה), וה-0 אומר רק שהבדיקות האנונימיות עברו. את הטוקן מפיקים עם `create-invite` (סעיף 5.4.1; ה-CLI מדפיס `/register#invite=<token>`, מעבירים לסקריפט רק את ה-`<token>`). במצב המלא (עם `SMOKE_INVITE`) נבדקים גם הרשמה, כניסה, `me`, יציאה, דגלי ה-cookie (`HttpOnly`, `Secure` ב-https, `SameSite`), וביטול ה-session בצד השרת (הצגה חוזרת של ה-token הישן מחזירה 401). קוד יציאה 0 = הכול עבר. משתמש הבדיקה **אינו נמחק** (אין מחיקת חשבון באפליקציה); למחיקה ידנית (כשהקונטיינר עצור או דרך הקוד בסעיף 5.2):

```bash
sudo sqlite3 data/rewards.db "PRAGMA foreign_keys=ON; DELETE FROM users WHERE email LIKE 'smoke-%@example.com'"
```

(`foreign_keys=ON` נדרש כדי שה-sessions של המשתמש יימחקו איתו; משתמש בדיקה לא מחזיק כרטיסים.)

מחיקה עם `sudo sqlite3` מבוצעת כשהקונטיינר **עצור** (`docker compose stop app`), ואחריה חובה להחזיר בעלות לפני ההפעלה: `sudo chown -R 1000:1000 data && docker compose up -d`. בלי זה קבצי `-wal`/`-shm` שנוצרו כ-root יגרמו לקונטיינר (uid 1000) להיכשל בפתיחת המסד.

### 4.9 ניקיון אחרי אימות

**מיד** אחרי שהכול עובד:

```bash
nano .env                                # מחקו את השורה ADMIN_PASSWORD (ADMIN_EMAIL אפשר להשאיר)
docker compose up -d                     # יוצר את הקונטיינר מחדש בלי הסיסמה
```

אחר כך מחיקת הגיבוי עם הטוקן בטקסט גלוי שהשרת יצר (אחרי שוידאתם ש-RiseUp מסונכרן), ושל כל העתק שלו:

```bash
sudo rm -i data/rewards.db.bak-*         # הגיבוי של האפליקציה, בתוך data/
```

הגיבוי הידני (`data.bak-*` ו-`~/rewards-backups/rewards-legacy-*.db`) משאירים **מספר ימים** (למשל 7) כדי שיהיה לאן לחזור אם תתגלה בעיה, ואז מוחקים אותו (`sudo rm -r data.bak-*`, `rm ~/rewards-backups/rewards-legacy-*.db`). הם מכילים את הטוקן בטקסט גלוי, ולכן אל תשאירו אותם לטווח ארוך. אם יש חשש שהם דלפו, בטלו את הטוקן בעמוד Developer Tokens של RiseUp וצרו חדש.

### 4.10 Rollback

הגרסה הישנה לא יכולה לרוץ על המסד החדש (הסכמה שונה; היא תקרוס או תפגע בנתונים), ולכן שחזור הקוד חייב להיות מלווה בשחזור המסד:

```bash
cd /opt/rewards-app
docker compose down
sudo mv data data.failed-$(date +%Y%m%d-%H%M%S)          # שומרים לבדיקה, לא מוחקים
sudo cp -a data.bak-<החותמת-שלכם> data                   # הגיבוי מסעיף 4.2 (בבעלות root כמו המקור)

# גרסת הקוד הקודמת - הדרך המומלצת: compose, כך שהקונטיינר נשאר מנוהל (restart policy, healthcheck)
git checkout <ה-commit הישן מסעיף 4.1> && docker compose up -d --build
```

חלופה (אם אי אפשר לבנות מחדש): להריץ את ה-image ששמרנו בסעיף 4.1. זה יוצר קונטיינר ידני ש-`docker compose` לא מנהל:

```bash
docker run -d --name credit-cards-app --restart unless-stopped \
  -p 127.0.0.1:3006:3000 -v "$PWD/data:/app/data" \
  -e NODE_ENV=production -e PORT=3000 -e HOST=0.0.0.0 -e TZ=Asia/Jerusalem \
  credit-cards-app:legacy
```

כשרוצים לנסות שוב את השדרוג (או לחזור ל-compose), קודם מסירים את הקונטיינר הידני ואחר כך חוזרים לקוד החדש (`git checkout` של הענף/התג החדש):

```bash
docker rm -f credit-cards-app
```

הערות: (1) ה-image הישן והמסד הישן רצים כ-root ולכן אין צורך ב-`chown` לאחר השחזור. (2) כל מה שנוצר אחרי השדרוג (משתמשים חדשים, נתונים שהוזנו) הולך לאיבוד בשחזור; שמרו את `data.failed-*` אם צריך לחלץ משם. (3) ה-cookie של הדפדפן לא תקף בגרסה הישנה, וזה בסדר. (4) אחרי שחזור, כשרוצים לנסות שוב, אם הרצתם `docker run` ידני הריצו קודם `docker rm -f credit-cards-app` (אחרת השם תפוס והקונטיינר הידני ימשיך לתפוס את פורט 3006), ואז התחילו מסעיף 4.2 (גיבוי חדש) ומשם 4.6 (כולל `chown -R 1000:1000 data`).

## 5. תפעול שוטף

### 5.1 גיבויים שוטפים

המסד כולו בקובץ אחד. גיבוי עקבי גם כשהשרת רץ:

```bash
sudo sqlite3 data/rewards.db ".backup '$HOME/rewards-backups/rewards-$(date +%F).db'" && sudo chown "$USER": "$HOME"/rewards-backups/*.db && chmod 600 "$HOME"/rewards-backups/*.db
```

בלי `sqlite3` במארח (נשמר ל-`data/` ולכן יש להעביר החוצה; ה-`node` בקונטיינר רץ כמשתמש node):

```bash
docker compose exec app node -e "require('better-sqlite3')('/app/data/rewards.db',{readonly:true}).backup('/app/data/rewards-backup.db').then(()=>console.log('ok'))"
sudo mv data/rewards-backup.db "$HOME/rewards-backups/rewards-$(date +%F).db" && sudo chmod 600 "$HOME"/rewards-backups/rewards-*.db
```

- הוסיפו ל-cron של root (למשל יומי, בלי `sudo` בפקודה) ושמרו כמה ימים אחורה. אל תעתיקו רק את `rewards.db` בזמן שהשרת רץ (יש גם `-wal`).
- הגיבוי מכיל טוקנים **מוצפנים**, אבל מפתח ההצפנה **לא** צריך להיות איתו: שמרו אותו נפרד (מנהל סיסמאות). גיבוי בלי המפתח = טוקנים אבודים, אבל כרטיסים/עסקאות/יעדים/משתמשים נשמרים.
- בדקו שחזור מפעם לפעם: `sqlite3 <גיבוי> "PRAGMA integrity_check"`. לשחזור: עצרו את הקונטיינר, העבירו את `data/rewards.db*` הנוכחי הצידה, העתיקו את הגיבוי ל-`data/rewards.db`, `sudo chown 1000:1000` ו-`docker compose up -d`.

### 5.2 גישה ישירה למסד

כשיש `sqlite3` במארח: `sudo sqlite3 data/rewards.db` (כשמשנים נתונים, עצרו קודם את הקונטיינר, והוסיפו `PRAGMA foreign_keys=ON;` לפני `DELETE`). בלעדיו אפשר להריץ קוד דרך הקונטיינר:

```bash
docker compose stop app
docker compose run --rm --no-deps app node -e "const d=require('better-sqlite3')('/app/data/rewards.db');console.log(d.prepare(\"DELETE FROM users WHERE email LIKE 'smoke-%@example.com'\").run())"
sudo chown -R 1000:1000 data
docker compose up -d
```

אותו כלל חל על `sudo sqlite3` שכותב ל-`data/rewards.db`: עצרו את הקונטיינר, ובסיום `sudo chown -R 1000:1000 data` לפני `docker compose up -d` (קבצי `-wal`/`-shm` בבעלות root יחסמו את הקונטיינר).

### 5.3 החלפת מפתח הצפנה (rotation)

1. מפתח חדש: `openssl rand -base64 32`, ושמרו אותו בנפרד במנהל הסיסמאות **לפני** הצעד הבא (המפתח הישן נשאר שמור עד סוף התהליך).
2. ב-`.env`: הערך הנוכחי של `TOKEN_ENC_KEY` עובר ל-`TOKEN_ENC_KEY_PREV`; המפתח החדש נכנס ל-`TOKEN_ENC_KEY`; `TOKEN_ENC_KEY_VERSION` עולה ב-1 (ברירת מחדל 1, כלומר 1 -> 2).
3. `docker compose up -d` (pm2: `pm2 restart rewards-server --update-env`).
4. חכו לשורה בלוג: `N rows re-encrypted with key version <V>`.
5. רק אז מחקו את `TOKEN_ENC_KEY_PREV` מה-`.env` והפעילו שוב. אל תדלגו על גרסה: השרת מכיר רק את הנוכחית ואת הקודמת לה, לכן מסיימים rotation (שלב 4) לפני rotation הבא.
6. גיבויים ישנים נשארים מוצפנים במפתח הישן; כדי שיהיה אפשר לקרוא אותם, שמרו את המפתחות הישנים כל עוד הגיבויים קיימים.

### 5.4 איפוס סיסמה / ניקוי נעילה (למנהל השרת)

מבטל את כל ה-sessions של המשתמש ומנקה נעילה. הסיסמה נקראת בהקלדה נסתרת או מ-stdin, לא מ-argv:

```bash
docker compose exec app node server/dist/cli/reset-password.js user@example.com              # אינטראקטיבי (בקשה לסיסמה פעמיים)
printf '%s\n' 'הסיסמה-החדשה' | docker compose exec -T app node server/dist/cli/reset-password.js user@example.com   # מ-stdin (יופיע בהיסטוריה; עדיף הקלדה)
```

ה-CLI משתמש במשתני הסביבה של הקונטיינר (נדרש `TOKEN_ENC_KEY` כשיש טוקנים שמורים). הוא מקבל בדיוק אימייל אחד (דגל לא מוכר או ארגומנט נוסף = שגיאה וקוד יציאה 2). **איפוס סיסמה אינו מפעיל מחדש משתמש מושבת** (`disabled_at`): ה-CLI מדפיס אזהרה כשהיעד מושבת, והוא עדיין לא יוכל להיכנס עד `enable` (`POST /api/admin/users/:id/enable` על ידי מנהל). ללא Docker: `npm run build --workspace=server && npm run reset-password --workspace=server -- user@example.com` (ב-`server/` עם `.env`).

### 5.4.1 הזמנות והמנהל הראשון (הרשמה בהזמנה בלבד)

ההרשמה סגורה בלי הזמנה: `POST /api/auth/register` דורש טוקן הזמנה תקף (תפוגה 1-90 ימים, 1-100 שימושים, ניתן לביטול). משתמשים קיימים לא מושפעים.

**אין הזמנות בלי מנהל.** בהתקנה חדשה המנהל הראשון נוצר מ-`ADMIN_EMAIL`/`ADMIN_PASSWORD` בהפעלה הראשונה (סעיף 3; בלעדיהם השרת ב-production לא עולה). אם יש משתמשים אבל אין מנהל פעיל (למשל מסד שהועתק, או המנהל הושבת), השרת עולה עם אזהרה בלוג; בדקו ואז קדמו משתמש קיים:

```bash
sudo sqlite3 data/rewards.db "SELECT email FROM users WHERE is_admin=1 AND disabled_at IS NULL"   # ריק = אין מנהל פעיל
docker compose exec app node server/dist/cli/promote-admin.js user@example.com [--as admin@example.com]
# ללא Docker: npm run build --workspace=server && npm run promote-admin --workspace=server -- user@example.com
```

`promote-admin` מקדם משתמש קיים **ופעיל** (משתמש לא קיים או מושבת = שגיאה, קוד יציאה 1, ללא שינוי) ורושם שורה ב-`admin_audit` (`user.promote_cli`). הפועל בשורת הביקורת הוא המנהל שנתון ב-`--as <email>`, אחרת המנהל הפעיל הוותיק ביותר, ואם אין אף אחד, המשתמש המקודם עצמו. אם המשתמש מושבת, הפעילו אותו קודם ידנית: `sudo sqlite3 data/rewards.db "UPDATE users SET disabled_at=NULL, failed_attempts=0, locked_until=NULL WHERE email='user@example.com'"` (הקונטיינר עצור, ואז `chown -R 1000:1000 data`).

עכשיו יוצרים את ההזמנה הראשונה מה-CLI (הקישור מודפס פעם אחת ורק ה-hash נשמר), ואחר כך אפשר דרך ממשק הניהול או ה-API של המנהל (`/api/admin/invites`):

```bash
docker compose exec app node server/dist/cli/create-invite.js --days 7 --uses 1 --label "שם" [--as admin@example.com]
# מדפיס: /register#invite=<token>  -> מצרפים לכתובת האתר: https://rewards.erankam.dev/register#invite=<token>
```

ה-CLI קפדני: דגל לא מוכר (`--use`), דגל בלי ערך (`--label --days 3`), ערך מחוץ לטווח או ארגומנט מיותר מדפיסים שגיאה עם שורת Usage ויוצאים בקוד 2 בלי לשנות כלום. שורת `admin_audit` של `create-invite` (`invite.create_cli`) נרשמת על שם המנהל מ-`--as <email>` או, כברירת מחדל, המנהל הפעיל הוותיק ביותר. ללא Docker: `npm run build --workspace=server && npm run create-invite --workspace=server -- --days 7 --uses 1`.

**הטוקן בפרגמנט ולא ב-query.** הקישור הוא `/register#invite=<token>`: דפדפנים לא שולחים את ה-fragment לשרת, ולכן הטוקן לא מופיע ב-access log של nginx (ולא ב-`Referer`; השרת שולח `Referrer-Policy: no-referrer`). האפליקציה קוראת אותו וממחקת אותו מהכתובת מיד (`replaceState`). קישורים ישנים בצורת `?invite=<token>` עדיין עובדים, אבל הם כן נרשמים ב-access log, ולכן עדיף ליצור קישור חדש. מגבלה: היסטוריית הדפדפן וסנכרון ההיסטוריה בין מכשירים שומרים את הכתובת המקורית (כולל ה-fragment), והטוקן נשאר בערוץ שבו שלחתם אותו (הודעה וכד'). לכן תנו להזמנות תוקף קצר (`--days 1-2`) ושימוש יחיד (`--uses 1`), וביטלו הזמנה שנחשפה (ממשק הניהול או `POST /api/admin/invites/:id/revoke`).

**הגבלת ניסיונות הזמנה שגויה.** כל הזמנה לא תקפה נספרת נגד מגבילה לפי IP (`INVITE_FAIL_RATE_LIMIT_MAX`, ברירת מחדל 10, ב-`INVITE_FAIL_RATE_LIMIT_WINDOW_MS`, ברירת מחדל שעה). משתמשים מאחורי אותו IP (משרד, NAT, VPN) חולקים את המכסה, ולכן כמה כשלונות של אחד עלולים לחסום מוזמן תקף (429) עד שהחלון נגמר. אם זה קורה, הגדילו את `INVITE_FAIL_RATE_LIMIT_MAX` ב-`.env` והפעילו מחדש (הספירה בזיכרון, אז גם restart מאפס אותה). ודאו ש-`TRUST_PROXY` נכון, אחרת כל המשתמשים נראים כ-IP של nginx (סעיף 4.5).

השבתת משתמש (`POST /api/admin/users/:id/disable`) מנתקת אותו מיד וחוסמת כניסה; `enable` מחזיר. פעולות הזמנה/השבתה/קידום נרשמות בטבלה `admin_audit`. בדיקת העשן יוצרת משתמש רק כש-`SMOKE_INVITE=<טוקן חד-פעמי>` מוגדר; **בלעדיו היא מדלגת על בדיקות החשבון** (סעיף 4.8).

### 5.5 אם `TOKEN_ENC_KEY` אבד

הסימפטום: `Startup aborted: Cannot decrypt the stored RiseUp token ...`.

1. חפשו קודם: מנהל סיסמאות, `.env` ישן/גיבוי של השרת, היסטוריית פריסה. המפתח הישן עדיין יכול להיות ב-`TOKEN_ENC_KEY_PREV` או בגיבוי של `.env`.
2. אם אי אפשר לשחזר אותו, הטוקנים אבודים, אבל **שאר הנתונים נשמרים**: עצרו את הקונטיינר, גבו את המסד (סעיף 5.1/4.2), מחקו את הטוקנים המוצפנים, צרו מפתח חדש, והפעילו:

```bash
docker compose stop app
sudo sqlite3 data/rewards.db "DELETE FROM user_riseup"       # או הקטע של node בסעיף 5.2
# .env: TOKEN_ENC_KEY=<מפתח חדש>, TOKEN_ENC_KEY_VERSION=1, בלי TOKEN_ENC_KEY_PREV
sudo chown -R 1000:1000 data                           # sqlite3 עם sudo עלול להשאיר קבצים בבעלות root
docker compose up -d
```

כל משתמש יזין מחדש את טוקן ה-RiseUp בהגדרות (ואפשר לבטל את הישן ב-Developer Tokens). כרטיסים, עסקאות, יעדים וחשבונות נשארים.

### 5.6 ניטור ולוגים

```bash
docker compose logs -f app            # לוג חי
docker compose logs --since 1h app | grep -E "WARNING|Startup aborted|Unhandled|failed"
docker compose ps                     # חייב להיות (healthy)
docker inspect credit-cards-app --format '{{.State.Health.Status}} restarts={{.RestartCount}}'
```

הודעות שכדאי להכיר: `Startup aborted: ...` (תצורה שגויה, המסד לא נגע), `WARNING: COOKIE_SECURE is on but a request arrived over plain http` (גישה ב-HTTP פשוט, או nginx בלי `X-Forwarded-Proto` / `TRUST_PROXY` שגוי; אזהרה בלבד), `Session cleanup: removed N expired session(s)` (תקין), `Unhandled error: ...` (באג; הלקוח מקבל רק 500 כללי), `N rows re-encrypted ...` (rotation). לוגים של Docker לא מכילים סיסמאות או טוקנים (הטוקן מוסתר גם בשגיאות RiseUp). הגדירו ניטור חיצוני פשוט (UptimeRobot / cron עם `curl -fsS https://rewards.erankam.dev/api/health`) והגבילו את גודל הלוגים (`logging: driver: json-file, options: max-size` ב-compose או `/etc/docker/daemon.json`).

### 5.7 עדכון גרסה

```bash
cd /opt/rewards-app && git pull --ff-only
docker compose build && docker compose up -d
scripts/smoke-test.sh https://rewards.erankam.dev --no-register
```

לפני עדכון שמשנה סכמה, קחו גיבוי (5.1). ה-image נבנה מ-`package-lock.json` (`npm ci`), כולל הגרסה של `@riseup-oss/mcp`.

## 6. הגדרות ידניות ב-GitHub (פעם אחת)

אלה הגדרות בממשק של GitHub, שאי אפשר לעשות מהקוד:

- [ ] **GitHub Pages הופסק:** האתר עובד רק מהשרת. ב-Settings > Pages שנו את Source ל-**None** (כבו Pages), ומחקו את הענף `gh-pages`: `git push origin --delete gh-pages` (או Code > Branches). כך לא נשארת עותק ישן של הלקוח שמצביע לשרת שלא קיים.
- [ ] **Branch protection** ל-`main` (Settings > Branches): Require a pull request, **Require status checks to pass** עם הבדיקות `build-and-test` ו-`docker-build` מ-CI, ו-Require branches to be up to date; חסמו force-push ומחיקה.
- [ ] **Secret scanning + Push protection** (Settings > Code security): הפעלה של שניהם.
- [ ] **Dependabot alerts** (ורצוי גם Dependabot security updates) לאותה מטרה; בנוסף ה-CI מריץ `npm audit --omit=dev` (כרגע לא חוסם).
- [ ] הרשאות Actions: Settings > Actions > General: Workflow permissions = Read repository contents (ה-CI כבר מצהיר `contents: read`).
- [ ] ודאו שאין סודות ב-Actions/Variables שלא נחוצים, ושה-`.env` ו-`data/` לא נכנסו ל-git (`git status`, ו-`git log --all -- .env data` ריק).

## 7. הערות כלליות

- טוקן ה-RiseUp (PAT) הוא read-only ופג תוקף אחרי 30 יום: יש לחדש אותו בהגדרות מדי פעם.
- הקונטיינר רץ כמשתמש לא-root (`node`, uid 1000) ועם HEALTHCHECK. התיקייה `./data` חייבת להיות בבעלותו (`sudo chown -R 1000:1000 data`). ה-CLI שמורץ עם `docker compose exec` רץ באותו משתמש, ולכן הקבצים שהוא יוצר ב-`data/` נשארים תקינים (אל תריצו אותו עם `-u root`, כדי לא ליצור קבצי `-wal` בבעלות root).
- שרת בודד בלבד: הגבלות הקצב ומנגנון ה-RiseUp בזיכרון, ולכן אין להריץ כמה עותקים של השרת על אותו מסד.

## 8. חלופה: VPS פרטי עם pm2 ו-Tailscale (בלי Docker)

מתאים לגישה רק דרך רשת Tailscale פרטית, בלי דומיין ובלי TLS ציבורי. אותה אפליקציה ואותם סודות (סעיפים 1, 4.3, 5), עם ההבדלים הבאים.

```bash
# התקנות: Node.js LTS, nginx, git, pm2; ו-Tailscale (sudo tailscale up; tailscale ip -4)
cd /opt && sudo git clone <URL> rewards-app && sudo chown -R $USER: rewards-app && cd rewards-app
npm ci
npm run build
cp .env.example server/.env && chmod 600 server/.env
```

ערכו את `server/.env` (dotenv טוען מתיקיית העבודה של השרת, כלומר `server/`): לפחות `TOKEN_ENC_KEY` (ו-`ADMIN_EMAIL`/`ADMIN_PASSWORD` בשדרוג מגרסה ישנה, ראו סעיף 4). ב-`deploy/ecosystem.config.cjs` כבר מוגדרים `HOST=127.0.0.1`, `PORT=3001`, `TRUST_PROXY=loopback` ו-`COOKIE_SECURE=false`:

- **`COOKIE_SECURE=false` נכון כאן רק כי הגישה ב-HTTP פשוט** (כתובת Tailscale בלי TLS); הדפדפן היה זורק cookie עם `Secure`. אם מוסיפים TLS, שנו ל-`true`.
- `TRUST_PROXY=loopback`: nginx רץ באותו שרת. אל תשתמשו בספירת קפיצות (`1`) כשהשרת נגיש ישירות.

```bash
pm2 start deploy/ecosystem.config.cjs && pm2 save
pm2 startup          # מריץ פקודה עם sudo, כדי לעלות אחרי reboot
```

nginx מגיש את הלקוח הסטטי (`client/dist`) ומעביר `/api` לשרת. התבנית [`nginx-app.conf.example`](nginx-app.conf.example) כוללת את הכותרות ([`nginx-security-headers.conf`](nginx-security-headers.conf), שמשכפלות את ה-CSP של האפליקציה כי nginx מגיש את ה-HTML בעצמו), `Cache-Control: no-store` על `/api`, ודריסת `X-Forwarded-For`/`Host`/`X-Forwarded-Host`:

```bash
sudo cp deploy/nginx-app.conf.example /etc/nginx/sites-available/rewards-app
sudo sed -i "s#<TAILSCALE_IP>#$(tailscale ip -4)#; s#<APP_PATH>#/opt/rewards-app#" /etc/nginx/sites-available/rewards-app
sudo ln -s /etc/nginx/sites-available/rewards-app /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

ה-`listen` מוגדר על כתובת ה-Tailscale בלבד (לא `0.0.0.0`), כך ש-nginx לא מאזין לממשק הציבורי. חומת אש כהגנה כפולה:

```bash
sudo ufw allow OpenSSH && sudo ufw allow in on tailscale0 && sudo ufw enable
```

גישה: `http://<TAILSCALE_IP>/`. בדיקת עשן: `scripts/smoke-test.sh http://<TAILSCALE_IP>` (תראו אזהרה על cookie בלי `Secure`, וזה צפוי כאן).

עדכון: `git pull --ff-only && npm ci && npm run build && pm2 restart rewards-server --update-env`. איפוס סיסמה: `npm run build --workspace=server && npm run reset-password --workspace=server -- user@example.com`. גיבוי: `sqlite3 data/rewards.db ".backup ..."`. המסד נמצא ב-`data/rewards.db` בשורש הריפו (או לפי `DB_PATH`), לא ב-`server/`.
