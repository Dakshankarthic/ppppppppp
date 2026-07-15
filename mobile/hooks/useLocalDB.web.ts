/**
 * Web build of useLocalDB. expo-sqlite's web implementation statically imports a .wasm file
 * in a way Metro's web bundler can't resolve ("Unable to resolve wa-sqlite.wasm"), and the
 * native useLocalDB.ts already treats web as unsupported (getDB() returns null there) — so on
 * web there's never a real local cache to query. Metro picks this .web.ts file automatically
 * for web builds (see metro.config.js's platform-extension config), keeping expo-sqlite (and
 * its .wasm import) out of the web bundle graph entirely instead of just guarding it at
 * runtime. useChallanCalculator.ts already has its own web-only in-memory fallback for
 * jurisdiction data, so these no-ops are never on the only path to an answer.
 */

export interface Fine {
  id: number;
  offence_code: string;
  vehicle_class: string;
  state: string;
  amount_inr: number;
  repeat_amount_inr?: number;
  section_ref?: string;
  source_url: string;
  fetched_at: string;
  country: string;
  currency: string;
}

export interface Rule {
  rule_id: string;
  section?: string;
  title: string;
  description: string;
  state: string;
  raw_json: string;
}

export interface Zone {
  zone_id: string;
  zone_type: string;
  state: string;
  rule_set_id?: string;
  geometry_json: string;
  fine_multiplier: number;
}

export interface SyncFine {
  id: number;
  offence_code: string;
  vehicle_class: string;
  state: string;
  amount_inr: number;
  repeat_amount_inr?: number | null;
  section_ref?: string | null;
  source_url: string;
  fetched_at: string;
  version_hash: string;
  country?: string;
  currency?: string;
}

export interface SyncRule {
  rule_id: string;
  section?: string | null;
  title: string;
  description: string;
  state: string;
  raw_json: string;
}

export interface SyncZone {
  zone_id: string;
  zone_type: string;
  state: string;
  rule_set_id?: string | null;
  geometry_json: string;
  fine_multiplier?: number;
}

export interface SyncStats {
  fines: number;
  rules: number;
  zones: number;
  lastSyncedAt: string | null;
}

export const useLocalDB = () => {
  return {
    queryFine: async (_offence: string, _vehicleClass: string, _state: string): Promise<Fine | null> => null,
    getAllFines: async (): Promise<Fine[]> => [],
    getAllFinesForState: async (_state: string): Promise<Fine[]> => [],
    queryRule: async (_ruleId: string): Promise<Rule | null> => null,
    getZonesForPoint: async (_lat: number, _lon: number): Promise<Zone[]> => [],
    replaceAllData: async (_fines: SyncFine[], _rules: SyncRule[], _zones: SyncZone[]): Promise<void> => {},
    logSync: async (_module: string, _rowsUpdated: number, _status: 'ok' | 'error', _error?: string): Promise<void> => {},
    getSyncStats: async (): Promise<SyncStats> => ({ fines: 0, rules: 0, zones: 0, lastSyncedAt: null }),
    clearAllData: async (): Promise<void> => {},
    initialized: true,
  };
};
