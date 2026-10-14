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

ה-nginx דורס את `X-Forwarded-For` בכתובת הלקוח האמיתית (`$remote_addr`) כי הוא הקפיצה הראשונה, ושולח כותרות CSP לקבצי ה-HTML הסטטיים (השרת לא מגיש אותם בפריסה זו). הוסיפו HSTS רק אם אתם מגישים HTTPS.

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
- אם בעתיד תרצו לחשוף את זה גם מחוץ ל-Tailscale, **חובה** קודם להוסיף שכבת אימות (login/Basic Auth) - כרגע אין שום הגנה ברמת האפליקציה.
