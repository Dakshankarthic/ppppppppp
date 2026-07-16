import asyncio
import json
import re
from typing import List, Dict, Any, Optional
from openai import AsyncOpenAI

from .models import SourceAnswer, SourceType
from .config import config
from .query_classifier import QueryClassifier, QueryIntent
from backend.modules.agent.normalize import (
    OFFENCE_ALIASES,
    detect_country_and_state,
    get_currency_symbol,
)

# Classifier category slug -> a representative offence_code in fines.db.
# Lets broad "teach me the rules" queries pull real DB facts per category.
CATEGORY_TO_OFFENCE: Dict[str, str] = {
    "speed_limits": "SPEED_EXCESS",
    "traffic_signals": "RED_LIGHT_JUMPING",
    "helmet_seatbelt": "NO_HELMET",
    "lane_discipline": "WRONG_WAY",
    "overtaking": "WRONG_WAY",
    "parking_rules": "NO_PARKING",
    "drunk_driving": "DRUNK_DRIVING",
    "drunk_drinking": "DRUNK_DRIVING",
    "documents": "NO_LICENSE",
    "document_requirements": "NO_LICENSE",
}

# Core spread used when a broad query doesn't name specific offences.
DEFAULT_BROAD_OFFENCES: List[str] = [
    "NO_HELMET", "NO_SEATBELT", "SPEED_EXCESS",
    "DRUNK_DRIVING", "RED_LIGHT_JUMPING", "NO_LICENSE",
]

# Ignored when falling back to free-text rule search.
_STOPWORDS = {
    "what", "whats", "the", "is", "are", "for", "and", "you", "your", "with",
    "about", "tell", "how", "much", "can", "should", "will", "does", "india",
    "indian", "rule", "rules", "law", "laws", "fine", "fines", "penalty",
}

class SourceAggregator:
    
    def __init__(self, fine_lookup=None, rules_loader=None, geofencing_engine=None):
        self.fine_lookup = fine_lookup
        self.rules_loader = rules_loader
        self.geofencing = geofencing_engine
        self.classifier = QueryClassifier()

        self.ollama_client = AsyncOpenAI(
            api_key="ollama",
            base_url=config.OLLAMA_BASE_URL
        )

    async def fetch_all_sources(self, user_question: str, user_state: str = None, gps: dict = None) -> List[SourceAnswer]:
        intent, metadata = self.classifier.classify(user_question)
        print(f"\n[INFO] Query Classified: {intent.value}")
        print(f"[INFO] Scope: {metadata['scope']}")

        tasks = [
            self._fetch_from_db(user_question, intent, metadata, user_state, gps),
            self._fetch_from_ollama(user_question, intent, metadata),
            self._fetch_from_google(user_question, intent, metadata)
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        valid_results = []
        for r in results:
            if isinstance(r, SourceAnswer):
                valid_results.append(r)
            else:
                print(f"Error fetching source: {r}")

        return valid_results

    async def _fetch_from_db(self, question: str, intent: QueryIntent, metadata: dict, user_state: str = None, gps: dict = None) -> SourceAnswer:
        """Ground the answer in the local fines.db + rules.json.

        Runs the (synchronous, SQLite) lookups in a worker thread so the
        parallel gather in fetch_all_sources stays non-blocking.
        """
        try:
            if not self.fine_lookup and not self.rules_loader:
                return SourceAnswer(
                    source=SourceType.DB,
                    answer="Database not connected.",
                    confidence=0.0,
                    metadata={"error": "no_db_client"},
                )

            return await asyncio.to_thread(self._query_local_db, question, intent, metadata, user_state, gps)
        except Exception as e:
            return SourceAnswer(source=SourceType.DB, answer=str(e), confidence=0.0, metadata={"error": str(e)})

    def _query_local_db(self, question: str, intent: QueryIntent, metadata: dict, user_state: str = None, gps: dict = None) -> SourceAnswer:
        country, state = detect_country_and_state(question)
        if state == "unknown" and user_state:
            state = user_state
        symbol = get_currency_symbol(country)

        # 0. GPS-based zone override (school/campus/etc zones from geofencing engine)
        #    takes priority over generic state-wide fines — e.g. IIT Madras campus
        #    has its own 20 km/h limit + Rs.10,000 speeding fine, higher than TN's
        #    standard speeding fine, so it must be surfaced ahead of that below.
        zone_lines: List[str] = []
        if self.geofencing and gps and gps.get("lat") is not None and gps.get("lon") is not None:
            try:
                zones = self.geofencing.get_applicable_rules(gps["lat"], gps["lon"])
            except Exception:
                zones = []
            for z in zones:
                name = z.get("zone_id", "Special zone").replace("_", " ")
                bits = [f"ZONE OVERRIDE — {name} ({z.get('zone_type', 'zone')})"]
                if z.get("speed_limit_kmh") is not None:
                    bits.append(f"Speed limit: {z['speed_limit_kmh']} km/h")
                if z.get("fine_amount_inr") is not None:
                    bits.append(f"Speeding fine here: {symbol}{z['fine_amount_inr']}")
                if z.get("fine_reason"):
                    bits.append(f"Reason: {z['fine_reason']}")
                zone_lines.append(" | ".join(bits))

        # 1. Which offences does the question actually mention?
        offence_codes = self._offences_in_question(question, intent, metadata)

        # 2. Scope fines to the detected country up front — FineLookup.query()
        #    ignores the country column, so we filter here to avoid returning
        #    Indian fines for a UK/US/Dubai question.
        country_fines = self.fine_lookup.get_all(country=country) if self.fine_lookup else []

        db_lines: List[str] = []
        fine_facts: List[Dict[str, Any]] = []

        for code in offence_codes:
            fine_row = self._best_fine(country_fines, code, state)
            rule = self.rules_loader.get_by_offence_code(code, state) if self.rules_loader else None

            title = (rule or {}).get("title") or code.replace("_", " ").title()
            section = (rule or {}).get("section") or (fine_row or {}).get("section_ref")
            header = f"{title} ({section})" if section else title
            parts = [header]

            if fine_row and fine_row.get("amount_inr") is not None:
                amount = f"{symbol}{fine_row['amount_inr']}"
                if fine_row.get("repeat_amount_inr"):
                    amount += f" (repeat: {symbol}{fine_row['repeat_amount_inr']})"
                parts.append(f"Fine: {amount}")
                fine_facts.append({
                    "offence_code": code,
                    "amount": fine_row.get("amount_inr"),
                    "section_ref": fine_row.get("section_ref"),
                    "state": fine_row.get("state"),
                })
            if rule and rule.get("description"):
                parts.append(rule["description"][:220])

            if fine_row or (rule and rule.get("description")):
                db_lines.append(" | ".join(parts))

        # 3. Nothing matched by offence code -> free-text search over rules.json.
        if not db_lines and self.rules_loader:
            tokens = [t for t in re.findall(r"[a-z]+", question.lower())
                      if len(t) > 3 and t not in _STOPWORDS]
            if tokens:
                for rule in self.rules_loader.search(tokens)[:4]:
                    sec = rule.get("section", "")
                    header = f"{rule.get('title', 'Rule')} ({sec})" if sec else rule.get("title", "Rule")
                    desc = (rule.get("description") or "")[:220]
                    db_lines.append(f"{header} | {desc}" if desc else header)

        # Zone overrides go first and win over the generic state-wide fine above.
        db_lines = zone_lines + db_lines

        if db_lines:
            answer_text = f"Local DriveLegal database ({country}):\n" + "\n".join(f"- {ln}" for ln in db_lines)
            if zone_lines:
                answer_text += (
                    "\n\nNOTE: A ZONE OVERRIDE is active at this GPS location — its speed limit "
                    "and fine amount take priority over the generic state-wide figures above."
                )
            confidence = 0.95 if zone_lines else (0.9 if fine_facts else 0.75)
        else:
            answer_text = f"No matching records in local database for this {country} query."
            confidence = 0.0

        return SourceAnswer(
            source=SourceType.DB,
            answer=answer_text,
            confidence=confidence,
            metadata={
                "source": "local_db",
                "intent": intent.value,
                "country": country,
                "state": state,
                "offence_codes": offence_codes,
                "fine_facts": fine_facts,
                "zone_override": bool(zone_lines),
            },
        )

    def _offences_in_question(self, question: str, intent: QueryIntent, metadata: dict) -> List[str]:
        """Resolve the offence codes a question is about, most-specific first."""
        q = " " + question.lower().replace("-", " ").replace("_", " ") + " "
        found: List[str] = []

        # Match plain-language phrases longest-first so "no seatbelt" wins over "belt".
        for phrase in sorted(OFFENCE_ALIASES.keys(), key=len, reverse=True):
            if phrase in q:
                code = OFFENCE_ALIASES[phrase]
                if code not in found:
                    found.append(code)

        # For broad educational queries, seed from the classifier's categories
        # and guarantee a core spread of topics.
        if intent == QueryIntent.BROAD_EDUCATIONAL:
            for cat in metadata.get("categories", metadata.get("categories_needed", [])):
                code = CATEGORY_TO_OFFENCE.get(cat)
                if code and code not in found:
                    found.append(code)
            if len(found) < 3:
                for code in DEFAULT_BROAD_OFFENCES:
                    if code not in found:
                        found.append(code)

        return found[:6]

    @staticmethod
    def _best_fine(country_fines: List[Dict[str, Any]], offence_code: str, state: str) -> Optional[Dict[str, Any]]:
        """Pick the best fine row for an offence: exact state > 'ALL' > any."""
        matches = [f for f in country_fines if f.get("offence_code") == offence_code]
        if not matches:
            return None
        for preferred in (state, "ALL"):
            for f in matches:
                if f.get("state") == preferred:
                    return f
        return matches[0]
    
    async def _fetch_from_ollama(self, question: str, intent: QueryIntent, metadata: dict) -> SourceAnswer:
        try:
            if intent == QueryIntent.BROAD_EDUCATIONAL:
                cats = metadata.get('categories', metadata.get('categories_needed', []))
                system_prompt = f"Provide a comprehensive overview of traffic rules for: {', '.join(cats)}."
            else:
                system_prompt = "You are a traffic law expert. Answer the specific question directly."
                
            response = await self.ollama_client.chat.completions.create(
                model=config.OLLAMA_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": question}
                ],
                temperature=0.3
            )
            
            answer_text = response.choices[0].message.content
            
            return SourceAnswer(
                source=SourceType.OLLAMA,
                answer=answer_text,
                confidence=0.7,
                metadata={"source": "ollama", "model": config.OLLAMA_MODEL}
            )
        except Exception as e:
            return SourceAnswer(
                source=SourceType.OLLAMA,
                answer=f"Ollama fetch failed: {str(e)}",
                confidence=0.0,
                metadata={"error": str(e)}
            )
    
    async def _fetch_from_google(self, question: str, intent: QueryIntent, metadata: dict) -> SourceAnswer:
        try:
            query = question
            if intent == QueryIntent.BROAD_EDUCATIONAL:
                cats = metadata.get('categories', metadata.get('categories_needed', ['']))
                first_cat = cats[0] if cats else ''
                query = f"India traffic rules comprehensive guide {first_cat}"
                
            if not config.SERPER_API_KEY:
                print("[WARN] SERPER_API_KEY not found. Please add it to your .env file to enable enterprise search.")
                return SourceAnswer(
                    source=SourceType.GOOGLE,
                    answer="Search API key missing. Please configure SERPER_API_KEY.",
                    confidence=0.0,
                    metadata={"error": "missing_api_key"}
                )

            import httpx
            import json
            
            headers = {
                'X-API-KEY': config.SERPER_API_KEY,
                'Content-Type': 'application/json'
            }
            payload = json.dumps({"q": query, "num": config.MAX_SEARCH_RESULTS})
            
            async with httpx.AsyncClient() as client:
                response = await client.post('https://google.serper.dev/search', headers=headers, data=payload)
                response.raise_for_status()
                data = response.json()
                
            results = data.get("organic", [])
            
            if not results:
                return SourceAnswer(
                    source=SourceType.GOOGLE,
                    answer="No search results found.",
                    confidence=0.0,
                    metadata={"source": "serper"}
                )
            
            urls = []
            compiled_answer = "Google Search Results (Serper.dev):\n"
            for idx, res in enumerate(results[:config.MAX_SEARCH_RESULTS]):
                compiled_answer += f"{idx+1}. {res.get('title')}: {res.get('snippet')}\n"
                if res.get('link'):
                    urls.append(res.get('link'))
                
            return SourceAnswer(
                source=SourceType.GOOGLE,
                answer=compiled_answer,
                confidence=0.8,
                metadata={"source": "serper", "raw_results": len(results), "urls": urls}
            )
        except Exception as e:
            return SourceAnswer(source=SourceType.GOOGLE, answer=f"Failed to fetch web results: {str(e)}", confidence=0.0, metadata={"error": str(e)})
    
    async def refetch_with_instructions(self, instructions: Dict[str, str]):
        print(f"Re-fetching with instructions: {instructions}")
        pass
