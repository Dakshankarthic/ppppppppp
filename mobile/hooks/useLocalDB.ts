import * as SQLite from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { point, booleanPointInPolygon } from '@turf/turf';

let db: SQLite.SQLiteDatabase | null = null;

function getDB() {
  if (Platform.OS === 'web') return null;
  if (!db) {
    try {
      db = SQLite.openDatabaseSync('drivelegal.db');
    } catch (e) {
      console.warn('[LocalDB] Failed to open database:', e);
    }
  }
  return db;
}

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

/** Shapes returned by GET /challan/sync (backend/main.py) — used to bulk-replace local tables. */
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

const isPointInGeoJson = (lat: number, lon: number, geojson: any): boolean => {
  const geometry = geojson?.type === 'Feature' ? geojson.geometry : geojson;
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
    return false;
  }
  try {
    return booleanPointInPolygon(point([lon, lat]), geometry);
  } catch {
    return false;
  }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fines (
  id INTEGER PRIMARY KEY,
  offence_code TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  state TEXT NOT NULL,
  amount_inr INTEGER NOT NULL,
  repeat_amount_inr INTEGER,
  section_ref TEXT,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  version_hash TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'IN',
  currency TEXT NOT NULL DEFAULT 'INR'
);

CREATE TABLE IF NOT EXISTS rules (
  rule_id TEXT PRIMARY KEY,
  section TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ALL',
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  zone_id TEXT PRIMARY KEY,
  zone_type TEXT NOT NULL,
  state TEXT NOT NULL,
  rule_set_id TEXT,
  geometry_json TEXT NOT NULL,
  fine_multiplier REAL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL,
  module TEXT NOT NULL,
  rows_updated INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);
`;

export const useLocalDB = () => {
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    try {
      const _db = getDB();
      if (!_db) {
        setInitialized(true);
        return;
      }
      // Run each CREATE TABLE statement
      SCHEMA.split(';').forEach(stmt => {
        if (stmt.trim()) {
          try {
            _db.execSync(stmt);
          } catch (e) {
            console.warn('[LocalDB] Schema statement error:', e);
          }
        }
      });
      setInitialized(true);
    } catch (e) {
      console.error('[LocalDB] Failed to initialize:', e);
      setInitialized(true); // Don't block the app
    }
  }, []);

  const queryFine = async (offence: string, vehicleClass: string, state: string): Promise<Fine | null> => {
    try {
      const _db = getDB();
      if (!_db) return null;
      const rows = _db.getAllSync<Fine>(
        `SELECT * FROM fines
         WHERE offence_code = ? AND vehicle_class = ? AND (state = ? OR state = 'ALL')
         ORDER BY CASE WHEN state = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        [offence, vehicleClass, state, state]
      );
      return rows.length > 0 ? rows[0] : null;
    } catch (e) {
      console.warn('[LocalDB] queryFine error:', e);
      return null;
    }
  };

  /** Every cached fine, unfiltered — used to build a manual country/state jurisdiction picker
   * (letting a user check fines somewhere other than their current GPS location). */
  const getAllFines = async (): Promise<Fine[]> => {
    try {
      const _db = getDB();
      if (!_db) return [];
      return _db.getAllSync<Fine>('SELECT * FROM fines');
    } catch (e) {
      console.warn('[LocalDB] getAllFines error:', e);
      return [];
    }
  };

  /** All fines available in a state (plus nationwide 'ALL' rows) — used to populate the
   * violation-type dropdown in the challan calculator. */
  const getAllFinesForState = async (state: string): Promise<Fine[]> => {
    try {
      const _db = getDB();
      if (!_db) return [];
      return _db.getAllSync<Fine>(`SELECT * FROM fines WHERE state = ? OR state = 'ALL'`, [state]);
    } catch (e) {
      console.warn('[LocalDB] getAllFinesForState error:', e);
      return [];
    }
  };

  const queryRule = async (ruleId: string): Promise<Rule | null> => {
    try {
      const _db = getDB();
      if (!_db) return null;
      const rows = _db.getAllSync<Rule>(
        'SELECT * FROM rules WHERE rule_id = ?',
        [ruleId]
      );
      return rows.length > 0 ? rows[0] : null;
    } catch (e) {
      console.warn('[LocalDB] queryRule error:', e);
      return null;
    }
  };

  const getZonesForPoint = async (lat: number, lon: number): Promise<Zone[]> => {
    try {
      const _db = getDB();
      if (!_db) return [];
      const allZones = _db.getAllSync<Zone>('SELECT * FROM zones');

      return allZones.filter(z => {
        try {
          const geojson = JSON.parse(z.geometry_json);
          return isPointInGeoJson(lat, lon, geojson);
        } catch {
          return false;
        }
      });
    } catch (e) {
      console.warn('[LocalDB] getZonesForPoint error:', e);
      return [];
    }
  };

  /** Wholesale-replaces fines/rules/zones with a fresh GET /challan/sync snapshot. The dataset
   * is small (~400 rows total) so a full replace each sync is simpler than diffing, and this
   * data changes rarely enough that it doesn't cost much. */
  const replaceAllData = async (fines: SyncFine[], rules: SyncRule[], zones: SyncZone[]): Promise<void> => {
    const _db = getDB();
    if (!_db) return;
    _db.withTransactionSync(() => {
      _db.execSync('DELETE FROM fines');
      _db.execSync('DELETE FROM rules');
      _db.execSync('DELETE FROM zones');

      for (const f of fines) {
        _db.runSync(
          `INSERT INTO fines (id, offence_code, vehicle_class, state, amount_inr, repeat_amount_inr, section_ref, source_url, fetched_at, version_hash, country, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            f.id,
            f.offence_code,
            f.vehicle_class,
            f.state,
            f.amount_inr,
            f.repeat_amount_inr ?? null,
            f.section_ref ?? null,
            f.source_url,
            f.fetched_at,
            f.version_hash,
            f.country ?? 'IN',
            f.currency ?? 'INR',
          ]
        );
      }
      for (const r of rules) {
        _db.runSync(
          `INSERT INTO rules (rule_id, section, title, description, state, raw_json) VALUES (?, ?, ?, ?, ?, ?)`,
          [r.rule_id, r.section ?? null, r.title, r.description, r.state, r.raw_json]
        );
      }
      for (const z of zones) {
        _db.runSync(
          `INSERT INTO zones (zone_id, zone_type, state, rule_set_id, geometry_json, fine_multiplier) VALUES (?, ?, ?, ?, ?, ?)`,
          [z.zone_id, z.zone_type, z.state, z.rule_set_id ?? null, z.geometry_json, z.fine_multiplier ?? 1.0]
        );
      }
    });
  };

  const logSync = async (module: string, rowsUpdated: number, status: 'ok' | 'error', error?: string): Promise<void> => {
    try {
      const _db = getDB();
      if (!_db) return;
      _db.runSync(
        `INSERT INTO sync_log (synced_at, module, rows_updated, status, error) VALUES (?, ?, ?, ?, ?)`,
        [new Date().toISOString(), module, rowsUpdated, status, error ?? null]
      );
    } catch (e) {
      console.warn('[LocalDB] logSync error:', e);
    }
  };

  const getSyncStats = async (): Promise<SyncStats> => {
    try {
      const _db = getDB();
      if (!_db) return { fines: 0, rules: 0, zones: 0, lastSyncedAt: null };
      const fines = _db.getFirstSync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM fines');
      const rules = _db.getFirstSync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM rules');
      const zones = _db.getFirstSync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM zones');
      const lastSync = _db.getFirstSync<{ synced_at: string }>(
        "SELECT synced_at FROM sync_log WHERE status = 'ok' ORDER BY synced_at DESC LIMIT 1"
      );
      return {
        fines: fines?.cnt ?? 0,
        rules: rules?.cnt ?? 0,
        zones: zones?.cnt ?? 0,
        lastSyncedAt: lastSync?.synced_at ?? null,
      };
    } catch (e) {
      console.warn('[LocalDB] getSyncStats error:', e);
      return { fines: 0, rules: 0, zones: 0, lastSyncedAt: null };
    }
  };

  const clearAllData = async (): Promise<void> => {
    const _db = getDB();
    if (!_db) return;
    try {
      _db.withTransactionSync(() => {
        _db.execSync('DELETE FROM fines');
        _db.execSync('DELETE FROM rules');
        _db.execSync('DELETE FROM zones');
        _db.execSync('DELETE FROM sync_log');
      });
    } catch (e) {
      console.warn('[LocalDB] clearAllData error:', e);
    }
  };

  return {
    queryFine,
    getAllFines,
    getAllFinesForState,
    queryRule,
    getZonesForPoint,
    replaceAllData,
    logSync,
    getSyncStats,
    clearAllData,
    initialized,
  };
};
