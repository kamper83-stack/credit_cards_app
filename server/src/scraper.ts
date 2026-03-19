import {
  createScraper,
  CompanyTypes,
  ScraperOptions,
  ScraperCredentials,
} from 'israeli-bank-scrapers';

export type SupportedProvider =
  | 'max'
  | 'cal'
  | 'isracard'
  | 'amex'
  | 'hapoalim'
  | 'leumi'
  | 'mizrahi'
  | 'discount'
  | 'behatsdaa'
  | 'beyahad'
  | 'beinleumi'
  | 'otsarHahayal'
  | 'manual';

const PROVIDER_MAP: Record<string, CompanyTypes> = {
  max: CompanyTypes.max,
  cal: CompanyTypes.visaCal,
  isracard: CompanyTypes.isracard,
  amex: CompanyTypes.amex,
  hapoalim: CompanyTypes.hapoalim,
  leumi: CompanyTypes.leumi,
  mizrahi: CompanyTypes.mizrahi,
  discount: CompanyTypes.discount,
  behatsdaa: CompanyTypes.behatsdaa,
  beyahad: CompanyTypes.beyahadBishvilha,
  beinleumi: CompanyTypes.beinleumi,
  otsarHahayal: CompanyTypes.otsarHahayal,
};

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  description: string;
  category?: string;
  originalCurrency?: string;
  originalAmount?: number;
  type: string;
}

export async function scrapeCard(
  provider: string,
  credentials: Record<string, string>,
  startDate: Date
): Promise<Transaction[]> {
  const companyType = PROVIDER_MAP[provider];
  if (!companyType) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const options: ScraperOptions = {
    companyId: companyType,
    startDate,
    combineInstallments: false,
    showBrowser: false,
  };

  const scraper = createScraper(options);
  const result = await scraper.scrape(credentials as ScraperCredentials);

  if (!result.success) {
    throw new Error(result.errorMessage || 'Scraping failed');
  }

  const transactions: Transaction[] = [];
  for (const account of result.accounts || []) {
    for (const txn of account.txns) {
      transactions.push({
        id: `${txn.date}-${txn.chargedAmount}-${txn.description}`.replace(/\s+/g, '-'),
        date: txn.date,
        amount: Math.abs(txn.chargedAmount),
        description: txn.description,
        originalCurrency: txn.originalCurrency,
        originalAmount: txn.originalAmount !== undefined ? Math.abs(txn.originalAmount) : undefined,
        type: txn.type || 'normal',
      });
    }
  }

  return transactions;
}

export const PROVIDERS: Array<{
  id: SupportedProvider;
  name: string;
  fields: Array<{ key: string; label: string; type: string }>;
}> = [
  {
    id: 'max',
    name: 'Max (מקס)',
    fields: [
      { key: 'username', label: 'שם משתמש', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'cal',
    name: 'Cal (ויזה כאל)',
    fields: [
      { key: 'username', label: 'שם משתמש', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'isracard',
    name: 'Isracard (ישראכרט)',
    fields: [
      { key: 'id', label: 'תעודת זהות', type: 'text' },
      { key: 'card6Digits', label: '6 ספרות ראשונות של הכרטיס', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'amex',
    name: 'American Express Israel',
    fields: [
      { key: 'id', label: 'תעודת זהות', type: 'text' },
      { key: 'card6Digits', label: '6 ספרות ראשונות של הכרטיס', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'hapoalim',
    name: 'בנק הפועלים',
    fields: [
      { key: 'userCode', label: 'קוד משתמש', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'leumi',
    name: 'בנק לאומי',
    fields: [
      { key: 'username', label: 'שם משתמש', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'mizrahi',
    name: 'בנק מזרחי-טפחות',
    fields: [
      { key: 'username', label: 'שם משתמש', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
    ],
  },
  {
    id: 'discount',
    name: 'בנק דיסקונט',
    fields: [
      { key: 'id', label: 'תעודת זהות', type: 'text' },
      { key: 'password', label: 'סיסמה', type: 'password' },
      { key: 'num', label: 'מספר חשבון', type: 'text' },
    ],
  },
  {
    id: 'manual',
    name: 'הזנה ידנית',
    fields: [],
  },
];
