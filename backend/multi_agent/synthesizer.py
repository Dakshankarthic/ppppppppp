import re
import asyncio
from typing import Dict, Any, List
import json
from openai import AsyncOpenAI

from backend.multi_agent.history_utils import is_follow_up_question, history_transcript, message_needs_location

from .query_classifier import QueryIntent
from .config import config
from .models import SourceAnswer

COUNTRY_PROMPTS = {
    "india": "You are an expert Indian Traffic Police assistant.",
    "saudi_arabia": "You are an expert Saudi Arabian traffic law advisor. Cite Moroor (General Directorate of Traffic) regulations where applicable.",
    "uae": "You are an expert UAE traffic law advisor.",
    "uk": "You are an expert UK traffic law advisor.",
    "usa": "You are an expert US traffic law advisor.",
    "singapore": "You are an expert Singapore traffic law advisor.",
    "unknown": "You are an expert international traffic law advisor."
}

COUNTRY_FOOTERS = {
    "india": "\n---\n💡 For complete details: parivahan.gov.in | mParivahan app | Local RTO",
    "saudi_arabia": "\n---\n💡 For complete details: moroor.gov.sa | Absher portal",
    "uae": "\n---\n💡 For complete details: moi.gov.ae | Dubai Police app",
    "uk": "\n---\n💡 For complete details: gov.uk/browse/driving",
    "usa": "\n---\n💡 For complete details: Local DMV website",
    "singapore": "\n---\n💡 For complete details: police.gov.sg/advisories/traffic",
    "unknown": ""
}

# Transient DeepSeek hiccups (timeouts, rate limits, momentary 5xx) shouldn't surface as
# "An error occurred" on the first try — retry once before giving up.
_DEEPSEEK_ATTEMPTS = 2
_DEEPSEEK_RETRY_DELAY_SECONDS = 1.0

class SmartSynthesizer:
    
    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=config.DEEPSEEK_API_KEY,
            base_url=config.DEEPSEEK_BASE_URL
        )
        self.model_name = config.SYNTHESIZER_MODEL
    
    async def synthesize(self, raw_evaluation, user_question, query_intent, all_sources, user_country="unknown", user_state="unknown", history: List[Dict] = None, gps: Dict[str, float] = None, vehicle: str = None):
        # Convert all_sources (list of SourceAnswer) into the dictionary format expected by the logic
        sources_data = {
            'db_answers': [s for s in all_sources if s.source.value == 'db'],
            'ollama_answer': next((s for s in all_sources if s.source.value == 'ollama'), None),
            'google_answers': [s for s in all_sources if s.source.value == 'google'],
            'coverage_score': len([s for s in all_sources if len(str(s.answer)) > 50]) / 3.0
        }
        
        avg_score = self._calculate_internal_confidence(raw_evaluation)
        coverage = sources_data.get('coverage_score', 1.0)
        
        print(f"\n[SYNTHESIZER] Internal Score: {avg_score:.2f}, Coverage: {coverage:.0%}")
        
        has_db = len(sources_data.get('db_answers', [])) > 0
        has_ollama = sources_data.get('ollama_answer') is not None
        has_google = len(sources_data.get('google_answers', [])) > 0
        
        print(f"[SYNTHESIZER] Data available: DB={has_db}, Ollama={has_ollama}, Google={has_google}")
        
        if has_db and has_ollama:
            print("[SYNTHESIZER] Using full synthesis (DB + Ollama)")
            final_answer = await self._synthesize_full(raw_evaluation, sources_data, user_question, query_intent, user_country, user_state, history, gps, vehicle)
        elif has_google:
            print("[SYNTHESIZER] Using web-enhanced synthesis")
            final_answer = await self._synthesize_from_web_enhanced(sources_data, user_question, query_intent, user_country, user_state, history, gps, vehicle)
        elif has_db:
            print("[SYNTHESIZER] Using DB-only expansion")
            final_answer = await self._synthesize_db_expanded(sources_data, user_question, query_intent, user_country, user_state, history, gps, vehicle)
        else:
            print("[SYNTHESIZER] Using fallback generation")
            final_answer = await self._synthesize_fallback(user_question, query_intent, user_country, user_state, history, gps, vehicle)
            
        final_answer = self._ensure_formatting(final_answer, query_intent)
        
        urls = []
        for s in all_sources:
            if s.source.value == "google" and "urls" in s.metadata:
                urls.extend(s.metadata["urls"])
        
        if urls:
            final_answer += "\n\n**References:**\n"
            for u in urls:
                final_answer += f"• {u}\n"
        
        if not final_answer.endswith('!'):
            if user_country == "india" and user_state != "unknown":
                footer = f"\n---\n💡 For complete details, refer to the local transport authority in {user_state}, India."
            else:
                footer = COUNTRY_FOOTERS.get(user_country, COUNTRY_FOOTERS["unknown"])
            final_answer += f"{footer}\n🛡️ Drive safely! Your family wants you home alive."
            
        return {
            "answer": final_answer,
            "display_mode": "authoritative" if avg_score >= 0.7 else "helpful_cautious",
            "_internal": {
                "avg_score": avg_score,
                "coverage": coverage,
                "strategy_used": f"DB={has_db}+Ollama={has_ollama}+Google={has_google}"
            }
        }
        
    def _calculate_internal_confidence(self, eval_result: Dict) -> float:
        evaluations = eval_result.get("evaluation", {})
        if not evaluations:
            return 0.3
        
        scores = []
        for source_data in evaluations.values():
            if isinstance(source_data, dict):
                scores.append(source_data.get("score", 5))
        
        if not scores:
            return 0.3
        
        avg_score = sum(scores) / len(scores)
        return avg_score / 10.0
        
    def _build_context_str(self, history: list = None, gps: str = None, vehicle: str = None) -> str:
        context_parts = []
        if gps:
            context_parts.append(f"USER GPS LOCATION: {gps}")
        if vehicle:
            context_parts.append(f"USER VEHICLE INFO: {vehicle}")
        if history and isinstance(history, list) and len(history) > 0:
            history_lines = []
            for h in history:
                if isinstance(h, dict):
                    role = h.get("role", "user")
                    msg_parts = h.get("parts", [])
                    text = msg_parts[0] if msg_parts and isinstance(msg_parts, list) else str(msg_parts)
                    prefix = "User" if role == "user" else "Bot"
                    history_lines.append(f"{prefix}: {text}")
            if history_lines:
                history_str = "\n".join(history_lines)
                context_parts.append(f"CONVERSATION HISTORY:\n{history_str}")
        
        if context_parts:
            return "\n" + "\n".join(context_parts) + "\n"
        return ""
        
    def _google_text(self, sources) -> str:
        return "\n".join([
            f"- {str(r.answer)[:400]}"
            for r in sources.get("google_answers", [])[:5]
        ])

    def _enrich_question(self, question, history, gps, vehicle, country, state):
        enriched = question
        if history and is_follow_up_question(question, history):
            transcript = history_transcript(history)
            enriched = f"Transcript context:\n{transcript}\n\nCurrent question: {question}\n(Note: if this question refers back to the prior topic, carry that context forward.)"
        
        if gps and message_needs_location(question):
            enriched = f"{enriched}\n(Note: the user is currently at GPS {gps['lat']}, {gps['lon']} which resolved to {state}, {country}. Frame your answer context around their location.)"
            
        if vehicle:
            enriched = f"{enriched}\n(Note: the user is asking regarding a {vehicle}. Frame your answer context around their vehicle type.)"
            
        return enriched

    def _build_full_prompt(self, sources, question, user_country, user_state, history=None, gps=None, vehicle=None) -> str:
        question = self._enrich_question(question, history, gps, vehicle, user_country, user_state)
        partial_info = ""
        for s in sources.get("db_answers", []):
            partial_info += str(s.answer) + "\n"
        if sources.get("ollama_answer"):
            partial_info += str(sources["ollama_answer"].answer) + "\n"

        return f"""USER ASKED: "{question}"
        Here is data from DB and AI:
        {partial_info[:1500]}

        Synthesize a direct, helpful answer using ONLY this data.

        IMPORTANT FORMATTING RULES:
        - Use numbered sections (e.g., "1. PENALTY DETAILS")
        - Use **bold** for key terms or fines
        - Use • bullets for itemized rules
        - Keep it structured and easy to read."""

    def _build_web_enhanced_prompt(self, sources, question, user_country, user_state, history=None, gps=None, vehicle=None) -> str:
        question = self._enrich_question(question, history, gps, vehicle, user_country, user_state)
        google_text = self._google_text(sources)
        country_display = user_country.replace('_', ' ').title() if user_country != "unknown" else "international jurisdictions"
        if user_state and user_state != "unknown":
            country_display = f"{user_state}, {country_display}"
            
        context_str = self._build_context_str(history, gps, vehicle)
        return f"""You are a traffic law educator for {country_display}.

USER ASKED: "{question}"
{context_str}
We found information from web searches:
{google_text}

TASK: Create a comprehensive, professional answer following this EXACT format:

→ 1. SPEED LIMITS
   **Posted Limits:** [Extract from web info]
   • Residential areas: [info]
   • Highways: [info]

→ 2. TRAFFIC SIGNALS
   **Red Light Rules:** [info]
   • Yellow light meaning: [info]

→ 3. HELMET & SEATBELT RULES
   **Helmet Requirements:** [info]
   • Fine amounts: [info]

→ 4. LANE DISCIPLINE
   **Overtaking Rules:** [info]

→ 5. PARKING REGULATIONS
   **No-Parking Zones:** [info]

→ 6. DRUNK DRIVING LAWS
   **BAC Limits:** [info]
   **Penalties:** [info]

→ 7. REQUIRED DOCUMENTS
   **Must Carry:** [info]

IMPORTANT FORMATTING RULES:
- Use → arrows for main sections (NOT ###)
- Use **bold** for subheadings (NOT ##)
- Use • bullets for details
- Include specific numbers/fines where mentioned
- End with safety reminder

Length: 700-1000 words"""

    def _build_db_expanded_prompt(self, sources, question, user_country, user_state, history=None, gps=None, vehicle=None) -> str:
        question = self._enrich_question(question, history, gps, vehicle, user_country, user_state)
        db_text = "\n".join([str(s.answer) for s in sources.get("db_answers", [])])
        return f"USER ASKED: {question}\nDB DATA: {db_text}\nExpand this strictly based on DB facts."

    def _build_fallback_prompt(self, question, user_country, user_state, history=None, gps=None, vehicle=None) -> str:
        question = self._enrich_question(question, history, gps, vehicle, user_country, user_state)
        country_display = user_country.replace('_', ' ').title() if user_country != "unknown" else "general"
        if user_state and user_state != "unknown":
            country_display = f"{user_state}, {country_display}"
        context_str = self._build_context_str(history, gps, vehicle)
        return f"USER ASKED: {question}\n{context_str}\nAnswer directly based on general knowledge of {country_display} traffic laws."

    async def _synthesize_full(self, eval_result, sources, question, intent, user_country, user_state, history=None, gps=None, vehicle=None):
        prompt = self._build_full_prompt(sources, question, user_country, user_state, history, gps, vehicle)
        return await self._call_local_llm(prompt, stream=False, user_country=user_country, user_state=user_state)

    async def _synthesize_from_web_enhanced(self, sources, question, intent, user_country, user_state, history=None, gps=None, vehicle=None):
        enhancement_prompt = self._build_web_enhanced_prompt(sources, question, user_country, user_state, history, gps, vehicle)
        answer = await self._call_local_llm(enhancement_prompt, stream=False, user_country=user_country, user_state=user_state)
        return answer if answer else self._google_text(sources)

    async def _synthesize_db_expanded(self, sources, question, intent, user_country, user_state, history=None, gps=None, vehicle=None):
        prompt = self._build_db_expanded_prompt(sources, question, user_country, user_state, history, gps, vehicle)
        return await self._call_local_llm(prompt, stream=False, user_country=user_country, user_state=user_state)

    async def _synthesize_fallback(self, question, intent, user_country, user_state, history=None, gps=None, vehicle=None):
        prompt = self._build_fallback_prompt(question, user_country, user_state, history, gps, vehicle)
        return await self._call_local_llm(prompt, stream=False, user_country=user_country, user_state=user_state)
        return await self._call_local_llm(prompt, stream=False, user_country=user_country, user_state=user_state)

    async def _create_completion(self, system_prompt: str, prompt: str, stream: bool):
        """Calls DeepSeek with one retry on transient failures (timeouts, rate limits,
        momentary 5xx) before giving up. Raises the last error if every attempt fails."""
        last_err: Exception | None = None
        for attempt in range(_DEEPSEEK_ATTEMPTS):
            try:
                return await self.client.chat.completions.create(
                    model=self.model_name,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.4,
                    max_tokens=2048,
                    stream=stream,
                )
            except Exception as e:
                last_err = e
                print(f"DeepSeek API call failed (attempt {attempt + 1}/{_DEEPSEEK_ATTEMPTS}): {e}")
                if attempt + 1 < _DEEPSEEK_ATTEMPTS:
                    await asyncio.sleep(_DEEPSEEK_RETRY_DELAY_SECONDS)
        raise last_err if last_err is not None else RuntimeError("DeepSeek call failed with no exception captured")

    async def _call_local_llm(self, prompt: str, stream: bool = False, user_country: str = "unknown", user_state: str = "unknown"):
        """When stream=True, returns the raw async completion-chunk iterator instead of
        awaiting the full text — caller is responsible for consuming and error handling."""
        system_prompt = COUNTRY_PROMPTS.get(user_country, COUNTRY_PROMPTS["unknown"])
        if user_state and user_state != "unknown":
            system_prompt = system_prompt.replace("assistant.", f"assistant for {user_state}.")
            system_prompt = system_prompt.replace("advisor.", f"advisor for {user_state}.")
        if stream:
            return await self._create_completion(system_prompt, prompt, stream=True)
        try:
            response = await self._create_completion(system_prompt, prompt, stream=False)
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling DeepSeek Synthesizer API: {e}")
            return "An error occurred while generating the guide."

    async def synthesize_stream(self, raw_evaluation, user_question, query_intent, all_sources, user_country="unknown", user_state="unknown", history: List[Dict] = None, gps: Dict[str, float] = None, vehicle: str = None):
        """Streaming counterpart to synthesize(): same branching logic to pick a prompt, but
        yields text deltas as they arrive instead of returning one final string.

        Simplifications vs. synthesize(): skips the post-hoc _ensure_formatting pass (it needs
        the full text) and always appends the references/safety footer (synthesize() only skips
        it if the answer happens to already end in '!').
        """
        sources_data = {
            'db_answers': [s for s in all_sources if s.source.value == 'db'],
            'ollama_answer': next((s for s in all_sources if s.source.value == 'ollama'), None),
            'google_answers': [s for s in all_sources if s.source.value == 'google'],
        }

        has_db = len(sources_data.get('db_answers', [])) > 0
        has_ollama = sources_data.get('ollama_answer') is not None
        has_google = len(sources_data.get('google_answers', [])) > 0

        if has_db and has_ollama:
            prompt = self._build_full_prompt(sources_data, user_question, user_country, user_state, history, gps, vehicle)
        elif has_google:
            prompt = self._build_web_enhanced_prompt(sources_data, user_question, user_country, user_state, history, gps, vehicle)
        elif has_db:
            prompt = self._build_db_expanded_prompt(sources_data, user_question, user_country, user_state, history, gps, vehicle)
        else:
            prompt = self._build_fallback_prompt(user_question, user_country, user_state, history, gps, vehicle)

        try:
            stream = await self._call_local_llm(prompt, stream=True, user_country=user_country, user_state=user_state)
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    yield delta
        except Exception as e:
            print(f"Error streaming DeepSeek Synthesizer API: {e}")
            yield "An error occurred while generating the guide."
            return

        urls = []
        for s in all_sources:
            if s.source.value == "google" and "urls" in s.metadata:
                urls.extend(s.metadata["urls"])

        trailing = ""
        if urls:
            trailing += "\n\n**References:**\n"
            for u in urls:
                trailing += f"• {u}\n"
        if user_country == "india" and user_state != "unknown":
            footer = f"\n---\n💡 For complete details, refer to the local transport authority in {user_state}, India."
        else:
            footer = COUNTRY_FOOTERS.get(user_country, COUNTRY_FOOTERS["unknown"])
        trailing += f"{footer}\n🛡️ Drive safely! Your family wants you home alive."
        yield trailing
            
    def _ensure_formatting(self, answer, intent):
        if '→' in answer or '**' in answer:
            return answer
            
        lines = answer.split('\n')
        formatted = []
        
        section_num = 1
        for line in lines:
            stripped = line.strip()
            if not stripped:
                formatted.append('')
                continue
            
            if re.match(r'^\d+\.', stripped) or (len(stripped) < 50 and ':' in stripped):
                if not stripped.startswith('→'):
                    if re.match(r'^\d+\.', stripped):
                        formatted.append(f'→ {stripped.upper()}')
                        section_num += 1
                    else:
                        formatted.append(f'   **{stripped}**')
                    continue
            
            formatted.append(f'   {stripped}')
        
        return '\n'.join(formatted)
