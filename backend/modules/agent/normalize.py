"""Normalize AI tool inputs to match fines.db / rules.json conventions."""

from __future__ import annotations

import re

# Plain-language offence phrases → offence_code in SQLite
OFFENCE_ALIASES: dict[str, str] = {
    "no helmet": "NO_HELMET",
    "helmet": "NO_HELMET",
    "without helmet": "NO_HELMET",
    "no license": "NO_LICENSE",
    "no licence": "NO_LICENSE",
    "driving without license": "NO_LICENSE",
    "driving without licence": "NO_LICENSE",
    "speeding": "SPEED_EXCESS",
    "over speeding": "SPEED_EXCESS",
    "overspeeding": "SPEED_EXCESS",
    "speed excess": "SPEED_EXCESS",
    "drunk driving": "DRUNK_DRIVING",
    "drink driving": "DRUNK_DRIVING",
    "dui": "DRUNK_DRIVING",
    "dwi": "DRUNK_DRIVING",
    "driving under influence": "DRUNK_DRIVING",
    "driving under the influence": "DRUNK_DRIVING",
    "no insurance": "NO_INSURANCE",
    "without insurance": "NO_INSURANCE",
    "driving without insurance": "NO_INSURANCE",
    "mobile phone": "MOBILE_PHONE",
    "phone while driving": "MOBILE_PHONE",
    "texting and driving": "MOBILE_PHONE",
    "texting while driving": "MOBILE_PHONE",
    "using mobile phone": "MOBILE_PHONE",
    "red light": "RED_LIGHT_JUMPING",
    "jumping red light": "RED_LIGHT_JUMPING",
    "running red light": "RED_LIGHT_JUMPING",
    "run red light": "RED_LIGHT_JUMPING",
    "signal jumping": "RED_LIGHT_JUMPING",
    "seatbelt": "NO_SEATBELT",
    "no seatbelt": "NO_SEATBELT",
    "seat belt": "NO_SEATBELT",
    "without seatbelt": "NO_SEATBELT",
    # License plate / number plate
    "no license plate": "NO_LICENSE_PLATE",
    "no number plate": "NUMBER_PLATE_VIOLATION",
    "without license plate": "NO_LICENSE_PLATE",
    "without number plate": "NUMBER_PLATE_VIOLATION",
    "number plate violation": "NUMBER_PLATE_VIOLATION",
    "no registration plate": "NUMBER_PLATE_VIOLATION",
    # Triple riding
    "triple riding": "TRIPLE_RIDING",
    "triple ride": "TRIPLE_RIDING",
    "three on a bike": "TRIPLE_RIDING",
    "overloading passengers": "TRIPLE_RIDING",
    # Minor / underage driving
    "minor driving": "MINOR_DRIVING",
    "underage driving": "MINOR_DRIVING",
    "juvenile driving": "MINOR_DRIVING",
    "minor caught driving": "MINOR_DRIVING",
    # Wrong way
    "wrong way": "WRONG_WAY",
    "wrong side": "WRONG_WAY",
    "wrong way driving": "WRONG_WAY",
    # Dangerous driving
    "dangerous driving": "SECTION_184",
    "rash driving": "SECTION_184",
    # PUC / Pollution
    "no puc": "NO_PUC",
    "puc": "NO_PUC",
    "pollution certificate": "NO_PUC",
    "without puc": "NO_PUC",
    # Parking
    "no parking": "NO_PARKING",
    "illegal parking": "NO_PARKING",
    "disabled parking": "DISABLED_PARKING",
    "handicap parking": "DISABLED_PARKING",
    "disabled spot": "DISABLED_PARKING",
    "parking in disabled": "DISABLED_PARKING",
    "parking in a disabled": "DISABLED_PARKING",
}


VEHICLE_CLASS_MAP: dict[str, str] = {
    "2W": "TWO_WHEELER",
    "TWO WHEELER": "TWO_WHEELER",
    "TWO-WHEELER": "TWO_WHEELER",
    "BIKE": "TWO_WHEELER",
    "MOTORCYCLE": "TWO_WHEELER",
    "SCOOTER": "TWO_WHEELER",
    "LMV": "LMV",
    "CAR": "LMV",
    "HGV": "HGV",
    "TRUCK": "HGV",
    "BUS": "HGV",
    "3W": "3W",
    "AUTO": "3W",
    "GENERAL": "GENERAL",
    "ALL": "ALL",
}

STATE_MAP: dict[str, str] = {
    "TAMIL NADU": "TN",
    "TAMILNADU": "TN",
    "DELHI": "DL",
    "NCT OF DELHI": "DL",
    "MAHARASHTRA": "MH",
    "KARNATAKA": "KA",
    "KERALA": "KL",
    "ANDHRA PRADESH": "AP",
    "TELANGANA": "TS",
    "WEST BENGAL": "WB",
    "GUJARAT": "GJ",
    "RAJASTHAN": "RJ",
    "UTTAR PRADESH": "UP",
    "PUNJAB": "PB",
    "HARYANA": "HR",
    "ODISHA": "OR",
    "BIHAR": "BR",
    "MADHYA PRADESH": "MP",
    # International regions/states
    "CALIFORNIA": "CALIFORNIA",
    "NEW YORK": "NEW_YORK",
    "TEXAS": "TEXAS",
    "ABU DHABI": "ABU_DHABI",
    "ABUDHABI": "ABU_DHABI",
}


# ─── Country detection ────────────────────────────────────────────────────────

COUNTRY_ALIASES: dict[str, str] = {
    "india": "IN",
    "indian": "IN",
    "bharat": "IN",
    "dubai": "AE",
    "uae": "AE",
    "abu dhabi": "AE",
    "abudhabi": "AE",
    "united arab emirates": "AE",
    "emirates": "AE",
    "sharjah": "AE",
    "ajman": "AE",
    "uk": "GB",
    "united kingdom": "GB",
    "england": "GB",
    "britain": "GB",
    "great britain": "GB",
    "london": "GB",
    "scotland": "GB",
    "wales": "GB",
    "usa": "US",
    "us": "US",
    "united states": "US",
    "america": "US",
    "california": "US",
    "new york": "US",
    "texas": "US",
    "florida": "US",
    "singapore": "SG",
    "saudi": "SA",
    "saudi arabia": "SA",
    "ksa": "SA",
    "riyadh": "SA",
    "jeddah": "SA",
}

# Map country codes to state defaults (when user says 'dubai' we know state=DUBAI, country=AE)
COUNTRY_STATE_MAP: dict[str, str] = {
    "dubai": "DUBAI",
    "abu dhabi": "ABU_DHABI",
    "abudhabi": "ABU_DHABI",
    "sharjah": "ALL",
    "california": "CALIFORNIA",
    "new york": "NEW_YORK",
    "texas": "TEXAS",
    "london": "ALL",
}

CURRENCY_MAP: dict[str, str] = {
    "IN": "INR",
    "AE": "AED",
    "GB": "GBP",
    "US": "USD",
    "SG": "SGD",
    "SA": "SAR",
}

CURRENCY_SYMBOL: dict[str, str] = {
    "INR": "₹",
    "AED": "AED ",
    "GBP": "£",
    "USD": "$",
    "SGD": "S$",
    "SAR": "SAR ",
}


def normalize_offence_code(offence_type: str) -> str:
    raw = (offence_type or "").strip()
    if not raw:
        return ""
    key = raw.lower().replace("-", " ").replace("_", " ")
    if key in OFFENCE_ALIASES:
        return OFFENCE_ALIASES[key]
    # Already snake case or single token
    return raw.upper().replace(" ", "_").replace("-", "_")


def normalize_vehicle_class(vehicle_class: str) -> str:
    vc = (vehicle_class or "GENERAL").strip().upper().replace("-", " ")
    return VEHICLE_CLASS_MAP.get(vc, vc.replace(" ", "_"))


def normalize_state(state: str) -> str:
    s = (state or "ALL").strip().upper()
    if s in ("ALL", "ANY", "INDIA", "NATIONAL"):
        return "ALL"
    if len(s) <= 3 and s.isalpha():
        return s
    compact = s.replace(" ", "")
    if compact in STATE_MAP:
        return STATE_MAP[compact]
    return STATE_MAP.get(s, s)


def _mentions(alias: str, text: str) -> bool:
    """Whole-word alias match, so 'us' doesn't match inside 'use'/'must'."""
    return re.search(r"\b" + re.escape(alias) + r"\b", text) is not None


def detect_country(text: str) -> str:
    """Detect country code from user text. Returns ISO 2-letter code or 'IN' default."""
    lower = (text or "").lower()
    # Check longest matches first to avoid 'us' matching inside other words
    for alias in sorted(COUNTRY_ALIASES.keys(), key=len, reverse=True):
        if _mentions(alias, lower):
            return COUNTRY_ALIASES[alias]
    return "IN"


def detect_country_and_state(text: str) -> tuple[str, str]:
    """Detect both country code and state/region from user text."""
    lower = (text or "").lower()
    country = "IN"
    state = "ALL"

    # Check for specific regions first (these imply both country and state)
    for region in sorted(COUNTRY_STATE_MAP.keys(), key=len, reverse=True):
        if _mentions(region, lower):
            state = COUNTRY_STATE_MAP[region]
            country = detect_country(region)
            return country, state

    # Then check for country-level mentions
    for alias in sorted(COUNTRY_ALIASES.keys(), key=len, reverse=True):
        if _mentions(alias, lower):
            country = COUNTRY_ALIASES[alias]
            return country, "ALL"

    return country, state


def get_currency_symbol(country: str) -> str:
    """Get currency symbol for display in responses."""
    currency = CURRENCY_MAP.get(country, "INR")
    return CURRENCY_SYMBOL.get(currency, currency + " ")


def get_currency_code(country: str) -> str:
    """Get ISO currency code for a country."""
    return CURRENCY_MAP.get(country, "INR")

