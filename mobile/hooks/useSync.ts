import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { getApiBaseUrl } from '../lib/api';
import { checkCloudAvailable } from '../lib/tiers/smartSwitch';
import { useLocalDB, SyncFine, SyncRule, SyncZone } from './useLocalDB';

interface SyncStatus {
  lastSync: {
    fines: string | null;
    rules: string | null;
    zones: string | null;
  };
  counts: {
    fines: number;
    rules: number;
    zones: number;
  };
}

const EMPTY_STATUS: SyncStatus = {
  lastSync: { fines: null, rules: null, zones: null },
  counts: { fines: 0, rules: 0, zones: 0 },
};

/**
 * Populates the on-device SQLite cache (mobile/local_db/schema.sql) from
 * GET /challan/sync (backend/main.py) so the challan calculator works offline.
 *
 * Native only: expo-sqlite has no web backend (useLocalDB's getDB() returns null there),
 * so on web this is a no-op — useChallanCalculator falls back to fetching the live endpoint
 * directly instead of going through this local cache.
 */
export function useSync() {
  const { replaceAllData, logSync, getSyncStats, clearAllData, initialized } = useLocalDB();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(EMPTY_STATUS);

  const refreshStatus = useCallback(async () => {
    const stats = await getSyncStats();
    setSyncStatus({
      lastSync: { fines: stats.lastSyncedAt, rules: stats.lastSyncedAt, zones: stats.lastSyncedAt },
      counts: { fines: stats.fines, rules: stats.rules, zones: stats.zones },
    });
  }, [getSyncStats]);

  const triggerSync = useCallback(async () => {
    if (Platform.OS === 'web') return; // no local SQLite to populate on web
    setIsSyncing(true);
    try {
      const cloudUp = await checkCloudAvailable();
      if (!cloudUp) {
        await logSync('challan', 0, 'error', 'Cloud unreachable');
        return;
      }

      const res = await fetch(`${getApiBaseUrl()}/challan/sync`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { fines: SyncFine[]; rules: SyncRule[]; zones: SyncZone[] } = await res.json();

      await replaceAllData(data.fines, data.rules, data.zones);
      await logSync('challan', data.fines.length + data.rules.length + data.zones.length, 'ok');
    } catch (e: any) {
      console.warn('[useSync] triggerSync failed:', e);
      await logSync('challan', 0, 'error', e?.message || String(e));
    } finally {
      setIsSyncing(false);
      await refreshStatus();
    }
  }, [replaceAllData, logSync, refreshStatus]);

  const clearCache = useCallback(async () => {
    await clearAllData();
    await refreshStatus();
  }, [clearAllData, refreshStatus]);

  // Silently warm up the local cache in the background once the DB is ready, mirroring the
  // Tier 3 tiny-model warmup pattern (useSmartChat.ts) for consistency across the app.
  useEffect(() => {
    if (!initialized || Platform.OS === 'web') return;
    refreshStatus().then(() => {
      triggerSync();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);

  return { isSyncing, syncStatus, triggerSync, clearCache };
}
