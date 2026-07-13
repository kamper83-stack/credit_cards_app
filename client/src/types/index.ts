export interface Card {
  id: string;
  name: string;
  provider: string;
  source: 'manual' | 'riseup';
  riseup_account_id?: string;
  last4?: string;
  color: string;
  goals_count: number;
  tx_count: number;
  last_synced?: number;
}

export interface Goal {
  id: string;
  card_id: string;
  name: string;
  description?: string;
  target_amount: number;
  period_type: 'monthly' | 'quarterly' | 'yearly' | 'custom';
  period_start?: string;
  period_end?: string;
  reward_description?: string;
  reward_value?: number;
  active: number;
  // computed
  spent: number;
  progress: number;
  remaining: number;
  current_period_start?: string;
  current_period_end?: string;
  days_left?: number;
  card_name: string;
  card_color: string;
  card_provider: string;
  card_last4?: string;
}

export interface Transaction {
  id: string;
  card_id: string;
  amount: number;
  date: string;
  description: string;
  category?: string;
  type: string;
  card_name: string;
  card_color: string;
}

export interface RiseupStatus {
  connected: boolean;
  tokenPreview: string | null;
  lastSyncedAt: number | null;
}

export interface RiseupSyncResult {
  success: boolean;
  accountsFound: number;
  transactionsSynced: number;
  monthsSynced: string[];
}
