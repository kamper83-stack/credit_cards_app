import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { riseupApi } from '../api';

/**
 * Runs once on app load: if RiseUp is connected, triggers an automatic sync.
 * The server throttles non-forced syncs to once per 24h, so a fresh tab/visit
 * does not hammer the RiseUp MCP. After a real sync it invalidates the data
 * queries so cards/goals/transactions reflect freshly pulled data.
 */
export function AutoSync() {
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await riseupApi.status();
        if (!status.connected) return; // nothing to keep fresh
        const res = await riseupApi.sync(3, false); // auto sync, not forced
        if (cancelled || res.skipped) return; // already synced recently
        qc.invalidateQueries({ queryKey: ['cards'] });
        qc.invalidateQueries({ queryKey: ['goals'] });
        qc.invalidateQueries({ queryKey: ['transactions'] });
        qc.invalidateQueries({ queryKey: ['riseup-status'] });
      } catch {
        // background auto-sync failures are silent; the manual button reports errors
      }
    })();
    return () => { cancelled = true; };
  }, [qc]);

  return null;
}
