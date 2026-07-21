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

async function withRiseupClient<T>(pat: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@riseup-oss/mcp'],
    env: { ...process.env, RISEUP_PAT: pat } as Record<string, string>,
  });
  const client = new Client({ name: 'credit-card-spending-dashboard', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err: any) {
    throw new Error(`לא ניתן להתחבר לשרת ה-MCP של RiseUp: ${err.message || err}`);
  }

  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function extractText(result: any): string {
  const block = result?.content?.find((c: any) => c.type === 'text');
  if (!block) throw new Error('תגובה ריקה מ-RiseUp');
  return block.text;
}

async function callGetTransactions(client: Client, cashflowMonth: string): Promise<RiseupTransaction[]> {
  const result = await client.callTool({ name: 'get_transactions', arguments: { cashflowMonth } });
  if ((result as any).isError) {
    throw new Error(mapRiseupError(extractText(result)));
  }
  const data = JSON.parse(extractText(result)) as GetTransactionsResult;
  return data.transactions || [];
}

function mapRiseupError(rawMessage: string): string {
  const msg = rawMessage.toLowerCase();
  if (msg.includes('expired') || msg.includes('unauthoriz') || msg.includes('401') || msg.includes('invalid token')) {
    return 'הטוקן פג תוקף או לא תקין. צור טוקן חדש בעמוד ה-Developer Tokens של RiseUp והתחבר מחדש.';
  }
  return `שגיאה מ-RiseUp: ${rawMessage}`;
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
