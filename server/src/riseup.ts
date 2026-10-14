import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PAT_PATTERN = /^riseup_pat_[A-Za-z0-9_-]{20,}$/;

export function isValidPatFormat(pat: string): boolean {
  return PAT_PATTERN.test(pat.trim());
}

export interface RiseupTransaction {
  transactionId: string;
  transactionDate: string;
  cashflowDate: string;
  businessName: string;
  isIncome: boolean;
  amount: number;
  accountNickname: string | null;
  sourceType: string; // "creditCard" | "checkingAccount" | ...
  source: string; // provider identifier, e.g. "isracard" - NOT unique per account
  accountNumberHash?: string; // stable per-account hash; distinguishes multiple cards from the same provider
  categoryLabel: string;
  isInstallment: boolean;
  installmentNumber?: number;
  totalNumberOfInstallments?: number;
}

interface GetTransactionsResult {
  transactions: RiseupTransaction[];
}

export interface RiseupAccount {
  sourceId: string;
  nickname: string;
}

export interface SyncResult {
  accounts: RiseupAccount[];
  transactions: RiseupTransaction[];
  monthsSynced: string[];
}

function currentCashflowMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthsBack(n: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

// ---------------------------------------------------------------------------
// Secret hygiene: PATs must never reach logs or API responses.
// ---------------------------------------------------------------------------

const PAT_SCRUB = /riseup_pat_[A-Za-z0-9_-]*/g;

/** Replaces anything shaped like a RiseUp PAT (and the given literal secrets) with [REDACTED]. */
export function redactSecrets(text: unknown, ...secrets: string[]): string {
  let out = typeof text === 'string' ? text : String((text as any)?.message ?? text ?? '');
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  return out.replace(PAT_SCRUB, '[REDACTED]');
}

export type RiseupErrorCategory = 'auth' | 'network' | 'timeout' | 'unknown';

export const RISEUP_ERROR_MESSAGES: Record<RiseupErrorCategory, string> = {
  auth: 'הטוקן פג תוקף או לא תקין. צור טוקן חדש בעמוד ה-Developer Tokens של RiseUp והתחבר מחדש.',
  network: 'לא ניתן להתחבר ל-RiseUp כרגע. בדוק את החיבור לאינטרנט ונסה שוב.',
  timeout: 'RiseUp לא הגיב בזמן. נסה שוב מאוחר יותר.',
  unknown: 'שגיאה בתקשורת עם RiseUp. נסה שוב מאוחר יותר.',
};

/**
 * Error whose `message` is a fixed, client-safe Hebrew string chosen by category. The original
 * failure is kept in `detail` (token already scrubbed) for the server log only - never send it
 * to the client.
 */
export class RiseupError extends Error {
  constructor(public readonly category: RiseupErrorCategory, public readonly detail: string) {
    super(RISEUP_ERROR_MESSAGES[category]);
    this.name = 'RiseupError';
  }
}

export function classifyRiseupFailure(raw: string): RiseupErrorCategory {
  const msg = raw.toLowerCase();
  if (/expired|unauthori[sz]|\b401\b|\b403\b|invalid token|forbidden|invalid.*pat/.test(msg)) return 'auth';
  if (/timed? ?out|etimedout|esockettimedout/.test(msg)) return 'timeout';
  if (/enotfound|econnrefused|econnreset|eai_again|enetunreach|network|fetch failed|socket hang up|getaddrinfo/.test(msg)) return 'network';
  return 'unknown';
}

/** Converts any thrown value into a RiseupError (idempotent), scrubbing the PAT from the detail. */
export function toRiseupError(err: unknown, pat?: string): RiseupError {
  if (err instanceof RiseupError) return err;
  const detail = redactSecrets(err, ...(pat ? [pat] : []));
  return new RiseupError(classifyRiseupFailure(detail), detail);
}

// ---------------------------------------------------------------------------
// MCP child process
// ---------------------------------------------------------------------------

/**
 * Variables forwarded to the MCP subprocess besides RISEUP_PAT (proxy / CA / tmp settings that
 * npx and node need to reach the network). The SDK additionally merges its own safe defaults
 * (HOME, LOGNAME, PATH, SHELL, TERM, USER) - see getDefaultEnvironment in the SDK. Everything
 * else (TOKEN_ENC_KEY*, ADMIN_*, DB_PATH, cookie settings, ...) is deliberately NOT inherited.
 */
const FORWARDED_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TMPDIR', 'TEMP', 'TMP',
];

/** Minimal environment for the MCP subprocess. The explicit allow-list is the only source. */
export function buildChildEnv(pat: string, parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of FORWARDED_ENV) {
    const v = parentEnv[k];
    if (typeof v === 'string' && v !== '') env[k] = v;
  }
  env.RISEUP_PAT = pat;
  return env;
}

const MCP_TIMEOUT_MS = Number(process.env.RISEUP_MCP_TIMEOUT_MS) || 90_000;

async function withRiseupClient<T>(pat: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@riseup-oss/mcp'],
    env: buildChildEnv(pat),
    stderr: 'ignore', // the child's stderr could echo the token; never forward it to our logs
  });
  const client = new Client({ name: 'credit-card-spending-dashboard', version: '1.0.0' }, { capabilities: {} });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RiseupError('timeout', 'MCP operation timed out')), MCP_TIMEOUT_MS);
    timer.unref();
  });
  const work = (async () => {
    try {
      await client.connect(transport);
    } catch (err) {
      throw toRiseupError(err, pat);
    }
    return fn(client);
  })();
  work.catch(() => {}); // if the timeout wins, a late rejection must not be unhandled

  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    throw toRiseupError(err, pat);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

function extractText(result: any): string {
  const block = result?.content?.find((c: any) => c.type === 'text');
  if (!block) throw new RiseupError('unknown', 'empty MCP response');
  return block.text;
}

async function callGetTransactions(client: Client, cashflowMonth: string): Promise<RiseupTransaction[]> {
  const result = await client.callTool({ name: 'get_transactions', arguments: { cashflowMonth } });
  if ((result as any).isError) {
    throw toRiseupError(extractText(result));
  }
  let data: GetTransactionsResult;
  try {
    data = JSON.parse(extractText(result)) as GetTransactionsResult;
  } catch {
    throw new RiseupError('unknown', 'unparseable MCP response');
  }
  return data.transactions || [];
}

/**
 * Per-account grouping key. `source` alone only identifies the provider
 * (e.g. "isracard"), not the specific card - two cards from the same
 * issuer would collapse into one. `accountNumberHash` (shipped in
 * @riseup-oss/mcp v0.3.0, see riseup-oss/mcp#5) is the stable per-account
 * hash; fall back to `source` for older server versions.
 */
export function accountKey(t: RiseupTransaction): string {
  return t.accountNumberHash || t.source;
}

/** Verifies the PAT actually works by requesting the current month once. */
export async function testRiseupConnection(pat: string): Promise<void> {
  await withRiseupClient(pat, client => callGetTransactions(client, currentCashflowMonth()));
}

/** Fetches credit-card spending for the last `months` cashflow months. */
export async function fetchRiseupCreditCardData(pat: string, months = 3): Promise<SyncResult> {
  const monthList = monthsBack(Math.max(1, Math.min(months, 24)));
  const allTransactions: RiseupTransaction[] = [];

  await withRiseupClient(pat, async client => {
    for (const month of monthList) {
      const txns = await callGetTransactions(client, month);
      allTransactions.push(...txns);
    }
  });

  const creditCardTxns = allTransactions.filter(
    t => t.sourceType === 'creditCard' && !t.isIncome
  );

  const accountsMap = new Map<string, RiseupAccount>();
  for (const t of creditCardTxns) {
    const key = accountKey(t);
    if (!accountsMap.has(key)) {
      // When no nickname is set and the key isn't just the bare provider name,
      // append a short suffix so multiple same-provider cards stay visually distinct.
      const fallback = key !== t.source ? `${t.source} (${key.slice(-4)})` : t.source;
      accountsMap.set(key, { sourceId: key, nickname: t.accountNickname || fallback });
    }
  }

  return {
    accounts: Array.from(accountsMap.values()),
    transactions: creditCardTxns,
    monthsSynced: monthList,
  };
}
