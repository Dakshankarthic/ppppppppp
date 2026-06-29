"""
tools.py — Gemini-compatible tool (function) definitions for DriveLegal Agent.

Each tool wraps an existing backend module:
  - lookup_fine    → FineLookup (SQLite)
  - lookup_rule    → RulesLoader (rules.json)
  - check_zone     → GeofencingEngine (GeoJSON polygons)
  - search_rules   → RulesLoader.search()
"""

from typing import Any, Dict, List, Optional
import logging

from backend.modules.agent.normalize import (
    normalize_offence_code,
    normalize_state,
    normalize_vehicle_class,
    detect_country,
    get_currency_symbol,
    get_currency_code,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Gemini Function Declarations
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEFINITIONS = [
    {
        "name": "lookup_fine",
        "description": (
            "Look up the exact fine/penalty amount for a traffic violation. "
            "Supports India (all states), UAE/Dubai, UK, USA, Singapore, and Saudi Arabia. "
            "Use this when the user asks how much a challan costs, what the penalty is, "
            "or wants to know the fine for breaking a specific traffic rule in any supported country."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "offence_type": {
                    "type": "string",
                    "description": (
                        "The traffic violation in lowercase. "
                        "Examples: 'no helmet', 'speeding', 'drunk driving', "
                        "'jumping red light', 'wrong way', 'mobile phone use', "
                        "'no seatbelt', 'no license', 'dangerous driving'"
                    ),
                },
                "vehicle_class": {
                    "type": "string",
                    "description": (
                        "Type of vehicle. Use: "
                        "'2W' for bike/scooter/motorcycle, "
                        "'LMV' for car/jeep/light motor vehicle, "
                        "'HGV' for truck/bus/heavy vehicle, "
                        "'3W' for auto-rickshaw, "
                        "'GENERAL' if vehicle type is unspecified."
                    ),
                    "enum": ["2W", "LMV", "HGV", "3W", "GENERAL"],
                },
                "state": {
                    "type": "string",
                    "description": (
                        "State or region name. For India: 'Tamil Nadu', 'Delhi', 'Maharashtra', etc. "
                        "For UAE: 'Dubai', 'Abu Dhabi'. For USA: 'California', 'New York', 'Texas'. "
                        "Use 'ALL' for national/general rules when no state is mentioned."
                    ),
                },
                "country": {
                    "type": "string",
                    "description": (
                        "Country code. Use: "
                        "'IN' for India (default), 'AE' for UAE/Dubai, 'GB' for UK, "
                        "'US' for USA, 'SG' for Singapore, 'SA' for Saudi Arabia."
                    ),
                    "enum": ["IN", "AE", "GB", "US", "SG", "SA"],
                },
                "is_repeat": {
                    "type": "boolean",
                    "description": "True if this is a repeat/second offence by the same person.",
                },
            },
            "required": ["offence_type", "vehicle_class", "state"],
        },
    },
    {
        "name": "lookup_rule",
        "description": (
            "Get the legal rule, Motor Vehicles Act section reference, and full description "
            "for a traffic violation. Use when the user asks what the law says, "
            "which section of the MV Act applies, or wants to understand the legal basis."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "offence_type": {
                    "type": "string",
                    "description": (
                        "The traffic violation keyword. "
                        "Examples: 'NO_HELMET', 'DRUNK_DRIVING', 'SPEED_EXCESS', "
                        "'NO_LICENSE', 'RED_LIGHT_JUMPING', 'DANGEROUS_DRIVING'. "
                        "You can also pass plain text like 'helmet' or 'drunk driving'."
                    ),
                },
                "state": {
                    "type": "string",
                    "description": (
                        "Indian state for state-specific rule overrides. "
                        "Use 'ALL' for the national baseline rule."
                    ),
                },
            },
            "required": ["offence_type"],
        },
    },
    {
        "name": "check_zone",
        "description": (
            "Check what traffic zone restrictions (school zones, no-horn zones, "
            "speed-restricted areas, etc.) are active at a specific GPS location. "
            "Use when the user asks about restrictions at their current location "
            "or when GPS coordinates are available."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "lat": {
                    "type": "number",
                    "description": "Latitude of the location (e.g., 13.0827 for Chennai).",
                },
                "lon": {
                    "type": "number",
                    "description": "Longitude of the location (e.g., 80.2707 for Chennai).",
                },
            },
            "required": ["lat", "lon"],
        },
    },
    {
        "name": "search_rules",
        "description": (
            "Search through all traffic rules using keywords when you don't know the "
            "exact offence code. Use for general legal questions, multi-topic queries, "
            "or exploratory questions about Indian traffic law."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "List of search keywords. "
                        "Example: ['helmet', 'mandatory'] or ['drunk', 'driving', 'BAC']"
                    ),
                },
            },
            "required": ["keywords"],
        },
    },
    {
        "name": "lookup_challan",
        "description": (
            "Look up pending traffic challans (fines/tickets) for a specific vehicle "
            "registration number. Use when the user provides a vehicle number like "
            "'TN01AB1234' or 'DL5CAB1234' and asks to check their pending challans, "
            "fines, or e-challan status."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "vehicle_number": {
                    "type": "string",
                    "description": (
                        "The vehicle registration number. "
                        "Example: 'TN01AB1234', 'DL5CAB1234', 'MH02CD5678'"
                    ),
                },
            },
            "required": ["vehicle_number"],
        },
    },
    {
        "name": "get_accident_risk",
        "description": (
            "Analyzes historical accident data to give a safety risk score for a location. "
            "Use when the user asks about the safety or accident risk of a city, state, or road."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City or state name to check for accident risk.",
                },
                "weather": {
                    "type": "string",
                    "description": "Optional weather condition (e.g., 'rain', 'fog', 'clear').",
                },
            },
            "required": ["location"],
        },
    },
    {
        "name": "get_violation_stats",
        "description": (
            "Provides statistics on the most common traffic violations and challans in a specific state. "
            "Use when the user asks about common offences or challan trends."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "state": {
                    "type": "string",
                    "description": "State name to get stats for (e.g., 'Maharashtra').",
                },
                "vehicle_type": {
                    "type": "string",
                    "description": "Optional vehicle type (e.g., 'Car', 'Bike').",
                },
            },
            "required": ["state"],
        },
    },
    {
        "name": "get_nearby_institutions",
        "description": (
            "Looks up schools and colleges in a city/state to warn about potential school zones and speed limits. "
            "Use when the user asks about educational institutions or driving near schools."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "City name.",
                },
                "state": {
                    "type": "string",
                    "description": "State name.",
                },
            },
            "required": ["city", "state"],
        },
    },
    {
        "name": "search_web",
        "description": (
            "Search the internet for current traffic rules, news, or general information "
            "that might not be in the local database. Use this as a fallback if other tools "
            "do not yield results."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query.",
                },
            },
            "required": ["query"],
        },
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Tool Executor
# ─────────────────────────────────────────────────────────────────────────────

class ToolExecutor:
    """
    Bridges Gemini tool calls to the actual backend modules.
    Each method corresponds to one tool definition above.
    """

    def __init__(self, fine_lookup, rules_loader, geofencing_engine, hybrid_search=None, insights_engine=None):
        self.fine_lookup = fine_lookup
        self.rules_loader = rules_loader
        self.geofencing = geofencing_engine
        self.hybrid_search = hybrid_search
        self.insights_engine = insights_engine

    def execute(self, tool_name: str, params: dict, gps: Optional[dict] = None) -> dict:
        """Route a tool call to the right handler."""
        logger.info(f"[Agent Tool] {tool_name}({params})")
        try:
            handlers = {
                "lookup_fine": self._lookup_fine,
                "lookup_rule": self._lookup_rule,
                "check_zone": self._check_zone,
                "search_rules": self._search_rules,
                "lookup_challan": self._lookup_challan,
                "get_accident_risk": self._get_accident_risk,
                "get_violation_stats": self._get_violation_stats,
                "get_nearby_institutions": self._get_nearby_institutions,
                "search_web": self._search_web,
            }
            handler = handlers.get(tool_name)
            if not handler:
                return {"error": f"Unknown tool: {tool_name}"}
            return handler(params, gps)
        except Exception as e:
            logger.error(f"[Agent Tool] Error in {tool_name}: {e}")
            return {"error": str(e)}

    # ── Individual tool handlers ──────────────────────────────────────────────

    def _lookup_fine(self, params: dict, gps: Optional[dict]) -> dict:
        if not self.fine_lookup:
            return {"error": "Fine database not available"}

        clean_offence_code = normalize_offence_code(params.get("offence_type", ""))
        vehicle_class = normalize_vehicle_class(params.get("vehicle_class", "GENERAL"))
        state = normalize_state(params.get("state", "ALL"))
        country = params.get("country", "IN").upper()

        result = self.fine_lookup.query(
            offence_code=clean_offence_code,
            vehicle_class=vehicle_class,
            state=state,
            repeat=params.get("is_repeat", False),
            country=country,
        )

        if result:
            currency_sym = get_currency_symbol(country)
            currency_code = get_currency_code(country)
            return {
                "found": True,
                "amount": result.get("amount_inr"),
                "amount_display": f"{currency_sym}{result.get('amount_inr')}",
                "repeat_amount": result.get("repeat_amount_inr"),
                "currency": currency_code,
                "section_ref": result.get("section_ref"),
                "source_url": result.get("source_url"),
                "data_as_of": result.get("fetched_at"),
                "country": country,
                # Keep backward compat
                "amount_inr": result.get("amount_inr"),
                "repeat_amount_inr": result.get("repeat_amount_inr"),
            }

        # Soft fallback: search for similar offences in same country
        all_fines = self.fine_lookup.get_all(country=country)
        offence_key = params.get("offence_type", "").lower().replace("_", " ")
        similar = [
            f for f in all_fines
            if offence_key in f.get("offence_code", "").lower().replace("_", " ") or f.get("offence_code", "").lower().replace("_", " ") in offence_key
        ][:3]

        return {
            "found": False,
            "country": country,
            "message": "No exact match. Showing similar entries.",
            "similar": similar,
        }

    def _lookup_rule(self, params: dict, gps: Optional[dict]) -> dict:
        if not self.rules_loader:
            return {"error": "Rules database not available"}

        offence_input = normalize_offence_code(params.get("offence_type", ""))
        state = normalize_state(params.get("state", "ALL"))

        # Try exact offence code first (e.g., "NO_HELMET")
        result = self.rules_loader.get_by_offence_code(offence_input.upper(), state)

        # Fallback: keyword search
        if not result:
            keywords = offence_input.lower().split()
            results = self.rules_loader.search(keywords)
            result = results[0] if results else None

        if result:
            return {
                "found": True,
                "rule_id": result.get("rule_id"),
                "section": result.get("section"),
                "act": result.get("act"),
                "title": result.get("title"),
                "description": result.get("description"),
                "is_state_override": result.get("is_state_override", False),
                "state": state,
            }

        return {
            "found": False,
            "message": f"No specific rule found for '{offence_input}' in {state}.",
        }

    def _check_zone(self, params: dict, gps: Optional[dict]) -> dict:
        # Use provided params, fall back to request GPS
        lat = params.get("lat") or (gps.get("lat") if gps else None)
        lon = params.get("lon") or (gps.get("lon") if gps else None)

        if lat is None or lon is None:
            return {"error": "No GPS coordinates available"}

        if not self.geofencing:
            return {"error": "Geofencing engine not available"}

        zones = self.geofencing.get_applicable_rules(lat, lon)
        if not zones:
            return {
                "found": False,
                "lat": lat,
                "lon": lon,
                "message": "No special traffic zones found at this location.",
            }

        return {
            "found": True,
            "lat": lat,
            "lon": lon,
            "zone_count": len(zones),
            "zones": [
                {
                    "name": z.get("name") or z.get("zone_id", "Unknown Zone"),
                    "zone_type": z.get("zone_type"),
                    "active_hours": z.get("active_hours", "ALL"),
                    "rules": z.get("rules", []),
                }
                for z in zones
            ],
        }

    def _search_rules(self, params: dict, gps: Optional[dict]) -> dict:
        keywords = params.get("keywords", [])
        if not keywords:
            return {"error": "No keywords provided"}


        # Use NLP HybridSearch RAG if available
        if self.hybrid_search:
            query = " ".join(keywords)
            # Broad/generic queries (few keywords) benefit from more results
            top_k = 6 if len(keywords) <= 2 else 3
            results = self.hybrid_search.search(query, top_k=top_k)
            if not results:
                return {
                    "found": False,
                    "message": f"No rules found via semantic search for: {query}",
                }
            
            return {
                "found": True,
                "count": len(results),
                "rules": [
                    {
                        "rule_id": r.get("rule_id"),
                        "section": r.get("metadata", {}).get("section"),
                        "title": r.get("metadata", {}).get("title"),
                        "description": r.get("content"),
                        "score": r.get("score")
                    }
                    for r in results
                ]
            }

        # Fallback to basic lexical loader search
        if not self.rules_loader:
            return {"error": "Rules database not available"}

        results = self.rules_loader.search([k.lower() for k in keywords])
        if not results:
            return {
                "found": False,
                "message": f"No rules found for keywords: {keywords}",
            }

        return {
            "found": True,
            "count": len(results),
            "rules": [
                {
                    "rule_id": r.get("rule_id"),
                    "section": r.get("section"),
                    "title": r.get("title"),
                    "description": r.get("description"),
                }
                for r in results[:5]  # top 5 matches
            ],
        }

    def _lookup_challan(self, params: dict, gps: Optional[dict]) -> dict:
        """Look up pending challans for a vehicle number using the backend challan endpoint."""
        vehicle_number = (params.get("vehicle_number") or "").upper().replace(" ", "").replace("-", "")
        if not vehicle_number:
            return {"error": "No vehicle number provided"}

        from datetime import datetime

        demo_notice = (
            "Demo sample data only — not linked to Parivahan / eChallan. "
            "Do not use for real payment decisions."
        )

        if "TN" in vehicle_number:
            return {
                "found": True,
                "demo": True,
                "demo_notice": demo_notice,
                "vehicle_number": vehicle_number,
                "owner": "J*** S***",
                "vehicle_type": "Motor Car (LMV)",
                "pending_challans": [
                    {"date": "2024-03-15", "violation": "Over Speeding", "amount": 1000, "status": "Pending", "location": "Anna Salai, Chennai"},
                    {"date": "2024-04-02", "violation": "No Helmet (Pillion)", "amount": 500, "status": "Pending", "location": "OMR, Chennai"},
                ],
                "total_fine": 1500,
                "last_updated": datetime.now().isoformat(),
            }
        elif "DL" in vehicle_number:
            return {
                "found": True,
                "demo": True,
                "demo_notice": demo_notice,
                "vehicle_number": vehicle_number,
                "owner": "A*** K***",
                "vehicle_type": "Two Wheeler",
                "pending_challans": [
                    {"date": "2024-02-10", "violation": "Red Light Jumping", "amount": 1000, "status": "Pending", "location": "Connaught Place, Delhi"},
                ],
                "total_fine": 1000,
                "last_updated": datetime.now().isoformat(),
            }
        else:
            return {
                "found": False,
                "demo": True,
                "demo_notice": demo_notice,
                "vehicle_number": vehicle_number,
                "pending_challans": [],
                "total_fine": 0,
                "message": "No pending challans found for this vehicle number.",
            }

    def _get_accident_risk(self, params: dict, gps: Optional[dict]) -> dict:
        if not self.insights_engine:
            return {"error": "Insights engine not available"}
        return self.insights_engine.get_accident_risk(params.get("location", ""), params.get("weather"))

    def _get_violation_stats(self, params: dict, gps: Optional[dict]) -> dict:
        if not self.insights_engine:
            return {"error": "Insights engine not available"}
        return self.insights_engine.get_violation_stats(params.get("state", ""), params.get("vehicle_type"))

    def _get_nearby_institutions(self, params: dict, gps: Optional[dict]) -> dict:
        if not self.insights_engine:
            return {"error": "Insights engine not available"}
        return self.insights_engine.get_nearby_institutions(params.get("city", ""), params.get("state", ""))

    def _search_web(self, params: dict, gps: Optional[dict]) -> dict:
        query = params.get("query")
        if not query:
            return {"error": "No query provided"}
        try:
            import requests
            from bs4 import BeautifulSoup
            import urllib.parse
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
            url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                return {"error": f"Search failed with status {resp.status_code}"}
            soup = BeautifulSoup(resp.text, "html.parser")
            results = []
            for a in soup.find_all("a", class_="result__snippet", limit=5):
                results.append(a.text.strip())
            if not results:
                return {"found": False, "message": "No results found on the web."}
            return {"found": True, "results": results}
        except Exception as e:
            return {"error": f"Web search exception: {str(e)}"}

