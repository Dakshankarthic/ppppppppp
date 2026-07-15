import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { useLocalDB } from './useLocalDB';
import { getApiBaseUrl } from '../lib/api';
import { checkCloudAvailable } from '../lib/tiers/smartSwitch';

// Mirrors backend/modules/agent/normalize.py's STATE_MAP — GPS reverse-geocoding gives a full
// region name ("Tamil Nadu"), but fines.db keys on the short code ("TN").
const STATE_MAP: Record<string, string> = {
  'TAMIL NADU': 'TN',
  TAMILNADU: 'TN',
  DELHI: 'DL',
  'NCT OF DELHI': 'DL',
  MAHARASHTRA: 'MH',
  KARNATAKA: 'KA',
  KERALA: 'KL',
  'ANDHRA PRADESH': 'AP',
  TELANGANA: 'TS',
  'WEST BENGAL': 'WB',
  GUJARAT: 'GJ',
  RAJASTHAN: 'RJ',
  'UTTAR PRADESH': 'UP',
  PUNJAB: 'PB',
  HARYANA: 'HR',
  ODISHA: 'OR',
  BIHAR: 'BR',
  'MADHYA PRADESH': 'MP',
  CALIFORNIA: 'CALIFORNIA',
  'NEW YORK': 'NEW_YORK',
  TEXAS: 'TEXAS',
  'ABU DHABI': 'ABU_DHABI',
  ABUDHABI: 'ABU_DHABI',
};

function normalizeState(region?: string | null): string {
  const s = (region || '').trim().toUpperCase();
  if (!s) return 'ALL';
  if (STATE_MAP[s]) return STATE_MAP[s];
  const compact = s.replace(/\s+/g, '');
  if (STATE_MAP[compact]) return STATE_MAP[compact];
  return s.length <= 3 ? s : s.replace(/\s+/g, '_');
}

const OFFENCE_LABELS: Record<string, string> = {
  NO_HELMET: 'No Helmet',
  NO_LICENSE: 'Driving Without License',
  SPEED_EXCESS: 'Overspeeding',
  SPEED_EXCESS_20: 'Overspeeding (20+ km/h over)',
  SPEED_EXCESS_40: 'Overspeeding (40+ km/h over)',
  SPEED_EXCESS_60: 'Overspeeding (60+ km/h over)',
  SPEED_EXCESS_80: 'Overspeeding (80+ km/h over)',
  DRUNK_DRIVING: 'Drunk Driving',
  NO_INSURANCE: 'No Insurance',
  MOBILE_PHONE: 'Mobile Phone Use While Driving',
  RED_LIGHT_JUMPING: 'Red Light Jumping',
  NO_SEATBELT: 'No Seatbelt',
  NO_LICENSE_PLATE: 'No License Plate',
  NUMBER_PLATE_VIOLATION: 'Number Plate Violation',
  TRIPLE_RIDING: 'Triple Riding',
  MINOR_DRIVING: 'Minor / Underage Driving',
  WRONG_WAY: 'Wrong Way Driving',
  NO_PUC: 'No Pollution Certificate',
  NO_PARKING: 'Illegal Parking',
  DISABLED_PARKING: 'Parking in Disabled Spot',
  HORN_VIOLATION: 'Horn Violation',
  HGV_LANE_VIOLATION: 'Heavy Vehicle Lane Violation',
  NO_REFLECTIVE_STICKER: 'Missing Reflective Sticker (Heavy Vehicle)',
  WEIGH_STATION_SKIP: 'Skipped Weigh Station',
  SPEED_LIMITER_VIOLATION: 'Non-Compliant Speed Limiter',
  HGV_ROADWORTHINESS: 'Roadworthiness / Load Violation (Heavy Vehicle)',
};

export function labelForOffence(code: string): string {
  if (OFFENCE_LABELS[code]) return OFFENCE_LABELS[code];
  return code
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// fines.db has several raw spellings for the same real-world vehicle class (seed-data
// inconsistency, e.g. '2W' / 'TWO_WHEELER' / 'TWO-WHEELER' are all "two-wheeler"). Collapse
// them to one canonical bucket so the dropdown doesn't show near-duplicate options and so
// picking one pulls in fines filed under any of its raw spellings.
const VEHICLE_CLASS_CANONICAL: Record<string, string> = {
  '2W': 'TWO_WHEELER',
  TWO_WHEELER: 'TWO_WHEELER',
  'TWO-WHEELER': 'TWO_WHEELER',
  '3W': 'THREE_WHEELER',
  THREE_WHEELER: 'THREE_WHEELER',
  LMV: 'LMV',
  'LMV/CAR': 'LMV',
  CAR: 'LMV',
  HGV: 'HGV',
  'HGV/MGV': 'HGV',
  COMMERCIAL: 'COMMERCIAL',
};

export function canonicalVehicleClass(raw: string): string {
  return VEHICLE_CLASS_CANONICAL[raw] || raw;
}

const VEHICLE_CLASS_LABELS: Record<string, string> = {
  TWO_WHEELER: 'Two-Wheeler',
  THREE_WHEELER: 'Three-Wheeler / Auto',
  LMV: 'Car (LMV)',
  HGV: 'Heavy Vehicle (HGV)',
  COMMERCIAL: 'Commercial Vehicle',
  ALL: 'All Vehicles',
};

export function labelForVehicleClass(code: string): string {
  return VEHICLE_CLASS_LABELS[code] || code.replace(/[_/]/g, ' ');
}

// fines.db covers these 6 countries (backend/modules/fines/lookup.py) — used for the manual
// "check a different jurisdiction" picker.
const COUNTRY_LABELS: Record<string, string> = {
  IN: 'India',
  AE: 'UAE',
  GB: 'United Kingdom',
  US: 'United States',
  SG: 'Singapore',
  SA: 'Saudi Arabia',
};

export function labelForCountry(code: string): string {
  return COUNTRY_LABELS[code] || code;
}

const STATE_LABELS: Record<string, string> = {
  ALL: 'Nationwide',
  TN: 'Tamil Nadu',
  DL: 'Delhi',
  MH: 'Maharashtra',
  KA: 'Karnataka',
  KL: 'Kerala',
  AP: 'Andhra Pradesh',
  TS: 'Telangana',
  WB: 'West Bengal',
  GJ: 'Gujarat',
  RJ: 'Rajasthan',
  UP: 'Uttar Pradesh',
  PB: 'Punjab',
  HR: 'Haryana',
  OR: 'Odisha',
  BR: 'Bihar',
  MP: 'Madhya Pradesh',
  CALIFORNIA: 'California',
  NEW_YORK: 'New York',
  TEXAS: 'Texas',
  ABU_DHABI: 'Abu Dhabi',
};

export function labelForState(code: string): string {
  return STATE_LABELS[code] || code.replace(/_/g, ' ');
}

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹',
  AED: 'AED ',
  GBP: '£',
  USD: '$',
  SGD: 'S$',
  SAR: 'SAR ',
};

export function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOL[currency] || `${currency} `;
  return `${symbol}${Math.round(amount).toLocaleString()}`;
}

export interface Violation {
  offence_code: string;
  vehicle_class: string;
  state: string;
  country: string;
  amount_inr: number;
  repeat_amount_inr?: number | null;
  section_ref?: string | null;
  currency: string;
}

export interface JurisdictionZone {
  zone_id: string;
  zone_type: string;
  fine_multiplier: number;
}

export interface ChallanResult {
  amount: number;
  baseAmount: number;
  repeatAmount?: number | null;
  currency: string;
  sectionRef?: string | null;
  zoneMultiplier: number;
}

const DEFAULT_COORDS = { latitude: 13.0827, longitude: 80.2707 }; // Chennai — matches ask.tsx's fallback

// Web has no local SQLite (expo-sqlite has no web backend), so the last-fetched jurisdiction
// snapshot is kept in memory for the session instead — works while the tab stays open even if
// the connection drops mid-session, but doesn't survive a page reload while offline.
let webViolationsCache: Violation[] | null = null;

function normalizeSyncFine(f: any): Violation {
  return {
    offence_code: f.offence_code,
    vehicle_class: f.vehicle_class,
    state: f.state,
    country: f.country || 'IN',
    amount_inr: f.amount_inr,
    repeat_amount_inr: f.repeat_amount_inr,
    section_ref: f.section_ref,
    currency: f.currency || 'INR',
  };
}

function filterForJurisdiction(all: Violation[], state: string, country: string): Violation[] {
  return all.filter(
    (v) => v.country === country && (v.state === state || v.state === 'ALL')
  );
}

export function useChallanCalculator() {
  const { getAllFines, getZonesForPoint, initialized } = useLocalDB();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState('ALL');
  const [country, setCountry] = useState('IN');
  const [locationLabel, setLocationLabel] = useState('Detecting location…');
  const [zones, setZones] = useState<JurisdictionZone[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  // Full, unfiltered dataset (all countries/states) — lets a user manually check a jurisdiction
  // other than where their GPS says they are, without a second network round trip.
  const [allViolations, setAllViolations] = useState<Violation[]>([]);
  const [isOffline, setIsOffline] = useState(false);
  const [isManualJurisdiction, setIsManualJurisdiction] = useState(false);

  const loadJurisdiction = useCallback(async () => {
    setLoading(true);
    setError(null);
    setIsManualJurisdiction(false);

    let coords = DEFAULT_COORDS;
    let detectedState = 'ALL';
    let detectedCountry = 'IN';
    let label = 'Chennai, Tamil Nadu';

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos =
          Platform.OS === 'web'
            ? ((await Promise.race([
                Location.getCurrentPositionAsync({}),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
              ])) as any)
            : await Location.getCurrentPositionAsync({});
        coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };

        // expo-location's reverseGeocodeAsync has no real implementation on web (it silently
        // fails/returns nothing there) — mirror index.tsx's approach: use a free reverse-geocode
        // REST API on web, and the native geocoder everywhere else.
        if (Platform.OS === 'web') {
          const res = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${coords.latitude}&longitude=${coords.longitude}&localityLanguage=en`
          );
          const data = await res.json();
          detectedCountry = data.countryCode || 'IN';
          detectedState = normalizeState(data.principalSubdivision);
          label =
            [data.city || data.locality, data.principalSubdivision, data.countryName]
              .filter(Boolean)
              .join(', ') || label;
        } else {
          const geocode = await Location.reverseGeocodeAsync(coords);
          if (geocode.length > 0) {
            const place = geocode[0];
            detectedCountry = place.isoCountryCode || 'IN';
            detectedState = normalizeState(place.region);
            label = [place.city, place.region, place.country].filter(Boolean).join(', ') || label;
          }
        }
      }
    } catch (e) {
      console.log('[useChallanCalculator] location detection failed, using default:', e);
    }

    setState(detectedState);
    setCountry(detectedCountry);
    setLocationLabel(label);

    const cloudUp = await checkCloudAvailable();
    setIsOffline(!cloudUp);

    if (Platform.OS !== 'web') {
      const localZones = await getZonesForPoint(coords.latitude, coords.longitude);
      setZones(localZones.map((z) => ({ zone_id: z.zone_id, zone_type: z.zone_type, fine_multiplier: z.fine_multiplier })));

      const allFines = (await getAllFines()).map(normalizeSyncFine);
      setAllViolations(allFines);
      const jurisdictionFines = filterForJurisdiction(allFines, detectedState, detectedCountry);
      setViolations(jurisdictionFines.length > 0 ? jurisdictionFines : allFines);
      setLoading(false);
      return;
    }

    // Web: no local cache — fetch live when online, else fall back to this session's last fetch.
    if (cloudUp) {
      try {
        const res = await fetch(`${getApiBaseUrl()}/challan/sync`);
        if (res.ok) {
          const data = await res.json();
          webViolationsCache = (data.fines || []).map(normalizeSyncFine);
        }
      } catch (e) {
        console.log('[useChallanCalculator] live sync fetch failed:', e);
      }
    }

    if (webViolationsCache) {
      setAllViolations(webViolationsCache);
      const jurisdictionFines = filterForJurisdiction(webViolationsCache, detectedState, detectedCountry);
      setViolations(jurisdictionFines.length > 0 ? jurisdictionFines : webViolationsCache);
    } else {
      setError('No jurisdiction data available yet — connect once to enable this offline.');
      setViolations([]);
    }
    setLoading(false);
  }, [getAllFines, getZonesForPoint]);

  /** Manually switch to a different country/state without re-detecting GPS — used by the
   * jurisdiction picker so a user can check fines somewhere they aren't physically standing. */
  const setJurisdiction = useCallback(
    (newState: string, newCountry: string) => {
      setIsManualJurisdiction(true);
      setState(newState);
      setCountry(newCountry);
      setLocationLabel(`${labelForState(newState)}, ${labelForCountry(newCountry)}`);
      setZones([]); // no GPS fix for a manually picked jurisdiction, so no zone data to show
      const jurisdictionFines = filterForJurisdiction(allViolations, newState, newCountry);
      setViolations(jurisdictionFines);
    },
    [allViolations]
  );

  const availableCountries = Array.from(new Set(allViolations.map((v) => v.country))).sort(
    (a, b) => labelForCountry(a).localeCompare(labelForCountry(b))
  );

  const availableStatesFor = useCallback(
    (forCountry: string) => {
      const states = Array.from(
        new Set(allViolations.filter((v) => v.country === forCountry).map((v) => v.state))
      );
      // 'ALL' (nationwide) first, then alphabetical by label.
      return states.sort((a, b) => (a === 'ALL' ? -1 : b === 'ALL' ? 1 : labelForState(a).localeCompare(labelForState(b))));
    },
    [allViolations]
  );

  useEffect(() => {
    if (Platform.OS !== 'web' && !initialized) return;
    loadJurisdiction();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized]);

  // Vehicle-agnostic fines (vehicle_class='ALL' — drunk driving, no license, etc.) apply no
  // matter which vehicle type is selected, so they're excluded from the pickable list itself
  // (not a real "vehicle type") but included in every vehicle type's applicable violations.
  const vehicleClasses = Array.from(
    new Set(
      violations
        .map((v) => canonicalVehicleClass(v.vehicle_class))
        .filter((vc) => vc !== 'ALL')
    )
  );

  const offencesFor = useCallback(
    (vehicleClass: string | null) => {
      const matches = violations.filter(
        (v) => vehicleClass === null || canonicalVehicleClass(v.vehicle_class) === vehicleClass || v.vehicle_class === 'ALL'
      );
      // A given offence can have both a vehicle-specific row and a generic 'ALL' row (e.g.
      // Mobile Phone has one for '2W' and one for 'ALL') — dedupe, preferring the specific one.
      const byCode = new Map<string, Violation>();
      for (const v of matches) {
        const existing = byCode.get(v.offence_code);
        if (!existing || (existing.vehicle_class === 'ALL' && v.vehicle_class !== 'ALL')) {
          byCode.set(v.offence_code, v);
        }
      }
      return Array.from(byCode.values());
    },
    [violations]
  );

  const calculate = useCallback(
    (offenceCode: string, vehicleClass: string | null, repeat: boolean): ChallanResult | null => {
      const candidates = violations.filter(
        (v) =>
          v.offence_code === offenceCode &&
          (vehicleClass === null || canonicalVehicleClass(v.vehicle_class) === vehicleClass || v.vehicle_class === 'ALL')
      );
      if (candidates.length === 0) return null;
      const match = candidates.find((v) => v.vehicle_class !== 'ALL') || candidates[0];
      const zoneMultiplier = zones.reduce((m, z) => Math.max(m, z.fine_multiplier || 1), 1);
      const baseAmount = repeat && match.repeat_amount_inr ? match.repeat_amount_inr : match.amount_inr;
      return {
        amount: Math.round(baseAmount * zoneMultiplier),
        baseAmount,
        repeatAmount: match.repeat_amount_inr,
        currency: match.currency,
        sectionRef: match.section_ref,
        zoneMultiplier,
      };
    },
    [violations, zones]
  );

  return {
    loading,
    error,
    locationLabel,
    state,
    country,
    zones,
    violations,
    vehicleClasses,
    offencesFor,
    isOffline: isOffline && !isManualJurisdiction,
    isManualJurisdiction,
    calculate,
    refresh: loadJurisdiction,
    setJurisdiction,
    availableCountries,
    availableStatesFor,
  };
}
