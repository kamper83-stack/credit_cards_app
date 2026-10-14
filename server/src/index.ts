import 'dotenv/config';
import db from './db.js';
import { createApp } from './app.js';
import { runStartupMigrations } from './migrate.js';

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await runStartupMigrations(db);
} catch (err: any) {
  console.error(`Startup aborted: ${err.message}`);
  process.exit(1);
}

createApp().listen(Number(PORT), HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
