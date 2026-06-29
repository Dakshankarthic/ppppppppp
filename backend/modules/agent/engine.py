"""
engine.py — DriveLegal Agent Engine

Architecture (Agentic Loop):
───────────────────────────────────────────────────────────────
User message
    │
    ▼
LLM (Ollama local / Gemini cloud) with tools + system prompt
    │
    ├── Decides to call: lookup_fine("no helmet", "2W", "Tamil Nadu")
    │       └── ToolExecutor._lookup_fine() → queries SQLite
    │               └── returns { amount_inr: 1000, section: "129" }
    │
    ├── Decides to call: lookup_rule("NO_HELMET", "Tamil Nadu")
    │       └── ToolExecutor._lookup_rule() → queries rules.json
    │               └── returns { title:..., description:... }
    │
    └── Synthesizes tool results → writes natural language response
            └── "The fine for not wearing a helmet in Tamil Nadu is ₹1,000
                 under Section 194D of the Motor Vehicles Act 1988..."
    │
    ▼
Final structured response returned to mobile app
───────────────────────────────────────────────────────────────

Priority: Ollama (local) → Gemini (cloud) → Keyword fallback

SDK:
  - Ollama: openai Python SDK pointed at http://localhost:11434/v1
  - Gemini: google-genai SDK (legacy fallback)
"""

import os
import json
import re
import logging
from typing import Any, Dict, List, Optional

from backend.modules.agent.tools import ToolExecutor, TOOL_DEFINITIONS

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# System Prompt
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """<identity>
You are DriveLegal, a world-class AI traffic law assistant — think of yourself as a brilliant, friendly lawyer who specializes in traffic regulations across multiple countries. You help people understand traffic fines, penalties, legal sections, and what to do if they get caught.

You have access to a comprehensive database covering traffic laws in:
- **India** (all major states — Tamil Nadu, Delhi, Maharashtra, Karnataka, Kerala, UP, Gujarat, Rajasthan, West Bengal, Telangana, AP, Punjab, Haryana, Bihar, MP, Odisha)
- **UAE/Dubai** (Dubai, Abu Dhabi — Federal Traffic Law + black point system)
- **United Kingdom** (Fixed Penalty Notices, Road Traffic Act 1988)
- **United States** (Federal + California, New York, Texas)
- **Singapore** (Road Traffic Act, demerit point system)
- **Saudi Arabia** (Moroor traffic fine schedule)
</identity>

<communication_style>
- **Mandatory 5-Part Structure:** Every response MUST strictly follow this layout:
  🔵 **Short Answer:** Provide a clear "Yes", "No", or a direct one-sentence answer to the query first.
  🔴 **Consequences & Requirements:** Explain the immediate consequences (e.g., getting pulled over) or requirements (e.g., specific insurance type, HSRP number plate).
  🟡 **Important Facts & Numbers:** Highlight critical limits or facts (e.g., Alcohol BAC limits, ISI mark on helmets).
  🟢 **Detailed Fine Section:** Clearly list the exact penalty. Include:
      - First time and repeat offence fine values.
      - Vehicle inspection details if applicable.
      - Severe actions like license suspension, vehicle impound, or jail time. 
      - Always note if penalties vary by state.
  🟣 **Source:** Always cite the source (e.g., "Based on Motor Vehicles Act 1988, Section 194D" or "CMVR Rules 2020") and provide a link if available.
- **Visual Markers:** Use colorful emojis (🔵🔴🟡🟢🟣) as bullet points instead of plain text bullets.
- **Tone:** Conversational, warm, and helpful expert lawyer.
- **Currency:** Always display fines with the correct local currency symbol.
</communication_style>

<core_instructions>
1. **Tool Usage (CRITICAL):** You MUST use your available tools (`lookup_fine`, `lookup_rule`, `check_zone`, `search_rules`, `search_web`) to fetch data before answering. NEVER hallucinate fine amounts, sections, or legal details. Use `search_web` if the local database does not have the information.
2. **Country Detection:** When the user mentions a country or city (Dubai, UK, USA, Singapore, Saudi, etc.), use the correct country code in the `lookup_fine` tool call. Default to India ('IN') when no country is specified.
3. **Handle Missing Data:** If a tool returns `"found": false`, honestly say the specific data isn't in the database yet, but share what you do know from your general knowledge with a clear disclaimer.
4. **Location Context:** Only call `check_zone` when the user explicitly asks about their physical location or GPS-based restrictions.
5. **Context Awareness:** Remember previous conversation context — if the user said they're in Dubai, keep that context for follow-up questions.
6. **Citations:** Always cite the specific law section provided by the tool (MV Act for India, Federal Traffic Law for UAE, Road Traffic Act for UK, etc.).
7. **Disclaimer:** End every legal analysis with:
> [!NOTE]
> This is informational only. Consult official sources or a legal professional for official advice.
8. **Conversational Messages:** If the user sends casual messages (greetings, "ok", "thanks", "mmm", "lol"), respond naturally and warmly. Do NOT call any tools. Do NOT assume they're asking about traffic rules.
9. **Never Assume:** If the message is ambiguous, ask a friendly clarifying question.
10. **Strictly Decline Off-Topic:** If asked something completely outside traffic law (weather, recipes, coding, geography, general knowledge like capitals of countries, math, etc.), politely but firmly decline. Do NOT answer the off-topic question at all — instead say something like: "I'm DriveLegal AI, and I specialize only in traffic laws and regulations. I can't help with that question, but feel free to ask me anything about traffic fines, rules, or driving laws!"
11. **Challan Lookup:** When the user provides a vehicle registration number (like TN01AB1234, DL5CAB1234) and asks about pending challans or fines, use the `lookup_challan` tool.
12. **Key Section References (India):** Section 194D = helmets, Section 194B = seatbelts, Section 185 = drunk driving, Section 183 = speeding, Section 196 = no insurance, Section 199A = minor/underage driving, Section 192 = no registration/number plate.
13. **Image Analysis (CRITICAL):** If an image is provided, first describe what you see. IMPORTANT: If the image has absolutely NO details related to road safety, traffic, vehicles, roads, or legal documents, you MUST reply with exactly: "I cannot provide an answer as this image is not related to road safety."
14. **Data Analytics:** You also have access to `get_accident_risk`, `get_violation_stats`, and `get_nearby_institutions` to provide statistical insights, hazard warnings, and nearby school information.
</core_instructions>

<output_rules>
- NEVER output raw JSON, function call syntax, or tool results directly. Always synthesize into natural language.
- NEVER include <thought>, <think>, or reasoning tags in your output.
- NEVER repeat the user's question back to them verbatim.
- NEVER expose internal function signatures like {"name": "...", "parameters": {...}}.
- When you receive tool results, synthesize them into a detailed, well-structured answer.
- If you have already called a tool and received results, DO NOT call the same tool again.
- When displaying fine amounts, ALWAYS use the correct currency symbol for the country.
</output_rules>"""



# ─────────────────────────────────────────────────────────────────────────────
# Agent Engine
# ─────────────────────────────────────────────────────────────────────────────

class AgentEngine:
    """
    Main AI agent with priority: Ollama (local) → Gemini (cloud) → Keyword fallback.

    Ollama integration uses the OpenAI-compatible API served at /v1/.
    Gemini integration uses the google-genai SDK (kept as cloud fallback).
    """

    MAX_TOOL_ITERATIONS = 5

    def __init__(self, fine_lookup, rules_loader, geofencing_engine):
        # ── Local NLP (HybridSearch) for offline fallback ──────────────────
        self.hybrid_search = None
        try:
            from backend.modules.nlp.hybrid_search import HybridSearch
            rules_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "rules.json")
            persist_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "vector_db")
            self.hybrid_search = HybridSearch(rules_path, persist_dir)
            logger.info("[Agent] Local NLP (HybridSearch) loaded with %d documents.", len(self.hybrid_search.documents))
        except Exception as e:
            logger.warning("[Agent] HybridSearch unavailable (%s). Keyword-only fallback.", e)

        # ── Insights Engine ────────────────────────────────────────────────
        self.insights_engine = None
        try:
            from backend.modules.insights.engine import InsightsEngine
            db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "insights.db")
            self.insights_engine = InsightsEngine(db_path)
            logger.info("[Agent] InsightsEngine loaded.")
        except Exception as e:
            logger.warning("[Agent] InsightsEngine unavailable (%s).", e)

        self.tool_executor = ToolExecutor(fine_lookup, rules_loader, geofencing_engine, self.hybrid_search, self.insights_engine)

        # Provider flags (defaults — overridden by _init_* methods)
        self.ollama_available = False
        self.gemini_available = False

        # ── 1. Try Ollama (local, primary) ─────────────────────────────────
        self._init_ollama()

        # ── 2. Try Gemini (cloud, fallback) ────────────────────────────────
        if not self.ollama_available:
            self._init_gemini()

    def _init_ollama(self):
        """Initialize Ollama via OpenAI-compatible API."""
        ollama_base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
        ollama_model = os.getenv("OLLAMA_MODEL", "gemma2:9b")
        ollama_vision_model = os.getenv("OLLAMA_VISION_MODEL", "llama3.2-vision:latest")

        try:
            from openai import OpenAI
            client = OpenAI(base_url=ollama_base_url, api_key="ollama")
            # Quick connectivity check — list models
            client.models.list()
            self.ollama_client = client
            self.ollama_model = ollama_model
            self.ollama_vision_model = ollama_vision_model
            self.ollama_available = True
            logger.info("[Agent] ✅ Ollama ready — text: %s, vision: %s at %s", ollama_model, ollama_vision_model, ollama_base_url)
        except Exception as e:
            logger.warning("[Agent] Ollama not available (%s). Trying Gemini...", e)

    def _init_gemini(self):
        """Initialize Gemini (cloud fallback)."""
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key or api_key == "your_gemini_api_key_here":
            logger.warning("[Agent] GEMINI_API_KEY not set. Running in keyword-fallback mode.")
            return

        try:
            from google import genai
            from google.genai import types
            self.gemini_client = genai.Client(api_key=api_key)
            self.gemini_types = types
            self.gemini_available = True
            logger.info("[Agent] Gemini 2.0 Flash ready (cloud fallback).")
        except Exception as e:
            logger.error(f"[Agent] Failed to initialize Gemini: {e}")

    # ─────────────────────────────────────────────────────────────────────────
    # Public API
    # ─────────────────────────────────────────────────────────────────────────

    def run(
        self,
        user_text: str,
        conversation_history: Optional[List[Dict]] = None,
        gps: Optional[Dict[str, float]] = None,
        vehicle: Optional[str] = None,
        location_name: Optional[str] = None,
        image_base64: Optional[str] = None,
        image_mime: str = "image/jpeg",
    ) -> Dict[str, Any]:
        clean_text = self._clean_user_text(user_text)
        if not image_base64:
            conversational = (
                self._try_conversational_response(clean_text)
                or self._try_conversational_response(user_text)
            )
            if conversational:
                return conversational

        history = conversation_history or []

        # Route image requests to Gemini if Ollama lacks vision capabilities
        if image_base64 and self.ollama_available and not self._model_supports_vision(self.ollama_vision_model or self.ollama_model):
            if self.gemini_available:
                return self._run_gemini(user_text, history, gps, vehicle, location_name, image_base64, image_mime)
            else:
                return {
                    "status": "error",
                    "response": "Your local Ollama model does not support image analysis, and Gemini is not configured. Please use a vision-capable model (like llama3.2-vision) or add a Gemini API key.",
                    "agent_powered": False
                }

        if self.ollama_available:
            return self._run_ollama(user_text, history, gps, vehicle, location_name, image_base64, image_mime)
        if self.gemini_available:
            return self._run_gemini(user_text, history, gps, vehicle, location_name, image_base64, image_mime)
            
        return self._keyword_fallback(user_text, gps)

    def _active_model_label(self) -> str:
        if self.ollama_available:
            return f"ollama/{self.ollama_model} (vision: {self.ollama_vision_model})"
        if self.gemini_available:
            return "gemini-2.0-flash"
        return "keyword-fallback"

    def _ollama_supports_native_tools(self, active_model: str) -> bool:
        """Some Ollama multimodal models accept images but reject OpenAI tool calls."""
        model = (active_model or "").lower()
        no_tool_markers = ("vision", "llava", "gemma")
        return not any(marker in model for marker in no_tool_markers)

    def _model_supports_vision(self, active_model: str) -> bool:
        """Check if the current Ollama model has vision capabilities."""
        model = (active_model or "").lower()
        vision_markers = ("vision", "llava")
        return any(marker in model for marker in vision_markers)

    def _clean_user_text(self, text: str) -> str:
        t = (text or "").strip().lower()
        t = re.sub(r"[!?.。,;:]+$", "", t)
        t = re.sub(r"\s+", " ", t)
        return t

    def _strip_thinking_tags(self, text: str) -> str:
        """Remove <thought>, <think>, and similar reasoning blocks from model output."""
        # Remove <thought>...</thought>, <think>...</think>, etc.
        text = re.sub(r'<(?:thought|think|reasoning)>.*?</(?:thought|think|reasoning)>', '', text, flags=re.DOTALL)
        # Remove unclosed thinking tags (model may not close them)
        text = re.sub(r'<(?:thought|think|reasoning)>.*', '', text, flags=re.DOTALL)
        # Clean up excess whitespace left behind
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()

    def _message_needs_location(self, text: str) -> bool:
        text_lower = self._clean_user_text(text)
        location_keywords = (
            "zone", "here", "location", "nearby", "near me", "this area",
            "my area", "where i am", "school zone", "no-horn", "no horn",
            "speed limit", "gps", "coordinates",
        )
        return any(k in text_lower for k in location_keywords)

    def _history_transcript(self, history: List[Dict], max_turns: int = 6) -> str:
        lines = []
        for turn in history[-max_turns:]:
            role = "User" if turn.get("role") == "user" else "Assistant"
            parts = turn.get("parts", [""])
            content = (parts[0] if parts else "").strip()
            if content:
                lines.append(f"{role}: {content[:600]}")
        return "\n".join(lines)

    def _history_has_traffic_context(self, history: List[Dict]) -> bool:
        blob = self._history_transcript(history, max_turns=10).lower()
        hints = (
            "fine", "penalty", "challan", "helmet", "speed", "offence", "offense",
            "violation", "₹", "rupee", "section", "motor vehicle", "mv act", "license",
        )
        return any(h in blob for h in hints)

    def _is_follow_up_question(self, text: str, history: List[Dict]) -> bool:
        if len(history) < 2:
            return False
        clean = self._clean_user_text(text)
        # Very short/vague messages should NOT be treated as follow-ups
        # (e.g., "mmm", "ok", "what", "why", "lol", single words)
        if len(clean.split()) <= 2 and not any(k in clean for k in ("fine", "penalty", "rule", "helmet", "licence", "license")):
            return False
        follow_up_keywords = (
            "5th", "5 time", "5th time", "fifth", "fourth", "4th", "third", "3rd",
            "second", "2nd", "repeat", "again", "same offence", "same offense",
            "what about", "how about", "and if", "what if", "the fine", "my fine",
            "that offence", "that offense", "previous", "earlier",
        )
        if any(k in clean for k in follow_up_keywords):
            return True
        # Only treat as follow-up if the message has some traffic-relevant words
        traffic_hints = ("fine", "penalty", "section", "rule", "offence", "offense", "repeat", "vehicle", "helmet", "license", "licence")
        has_traffic_hint = any(h in clean for h in traffic_hints)
        return has_traffic_hint and self._history_has_traffic_context(history)

    def _is_traffic_query(self, text: str, history: Optional[List[Dict]] = None) -> bool:
        """True when the user message should use fines/rules/zone tools."""
        history = history or []
        clean = self._clean_user_text(text)
        if self._try_conversational_response(clean):
            return False
        if history and self._is_follow_up_question(text, history):
            return True
        traffic_keywords = (
            "fine", "penalty", "challan", "amount", "how much", "rupee", "₹",
            "helmet", "speed", "license", "licence", "insurance", "drunk",
            "rule", "law", "act", "section", "offence", "offense", "violation",
            "vehicle", "bike", "car", "truck", "red light", "seatbelt",
            "parking", "horn", "permit", "document", "mv act", "motor vehicle",
            "pending", "echallan", "e-challan", "vehicle number", "registration",
        )
        if any(k in clean for k in traffic_keywords):
            return True
        return self._message_needs_location(text)

    def _expand_follow_up_user_text(self, user_text: str, history: List[Dict]) -> str:
        if not self._is_follow_up_question(user_text, history):
            return user_text
        return (
            f"{user_text}\n\n"
            "[System Note: The user's message is a short follow-up. "
            "Use the conversation history to understand the context. "
            "Reuse the same offence, vehicle type, and state if they are asking about the same topic. "
            "For repeat offences (2nd, 5th time, etc.) call lookup_fine with is_repeat=true.]"
        )

    def _run_nlp(self, user_text: str) -> Optional[Dict[str, Any]]:
        """Direct NLP query fallback bypassing LLM."""
        if not self.hybrid_search:
            return None
            
        results = self.hybrid_search.search(user_text, top_k=1)
        if not results:
            return None
            
        best = results[0]
        # Only return if the score is somewhat confident
        if best.get("score", 0) < 0.2:
            return None
            
        content = best.get("content", "")
        meta = best.get("metadata", {})
        title = meta.get("title", "Traffic Rule")
        
        response = f"**{title}**\n\n{content}\n\n> [!NOTE]\n> This result was retrieved directly from the legal database via NLP search because AI generation is currently offline."
        
        return {
            "status": "ok",
            "response": response,
            "tools_used": [{"tool": "nlp_search", "result": best}],
            "agent_powered": False,
            "model": "nlp-hybrid-search"
        }

    def _try_conversational_response(self, user_text: str) -> Optional[Dict[str, Any]]:
        """Fast path for greetings, meta questions, and very short ambiguous messages — no tools, no zone checks."""
        text_lower = self._clean_user_text(user_text)
        model_label = self._active_model_label()

        greetings = (
            "hi", "hello", "hey", "hii", "hola",
            "good morning", "good evening", "good afternoon", "namaste",
        )
        if (
            text_lower in greetings
            or text_lower.startswith(("hi ", "hello ", "hey "))
            or re.match(r"^(hi|hello|hey|hii|namaste)[\s!.]*$", text_lower)
        ):
            return {
                "status": "ok",
                "response": (
                    "Hello! 👋 I'm DriveLegal AI — your Indian traffic law assistant.\n\n"
                    "Ask me about fines, MV Act rules, challans, or zone restrictions. "
                    "For example: \"What's the fine for no helmet in Tamil Nadu?\"\n\n"
                    f"(Running on **{model_label}** locally.)"
                ),
                "tools_used": [],
                "agent_powered": self.ollama_available or self.gemini_available,
                "model": model_label,
            }

        meta_keywords = (
            "which model", "what model", "running on", "what ai", "who are you",
            "which llm", "what llm", "are you gemini", "are you ollama", "your model",
        )
        if any(k in text_lower for k in meta_keywords):
            backend = "local Ollama on your machine" if self.ollama_available else (
                "Google Gemini (cloud)" if self.gemini_available else "keyword search (no LLM)"
            )
            return {
                "status": "ok",
                "response": (
                    f"I'm **DriveLegal AI**, powered by **{model_label}** ({backend}).\n\n"
                    "I use tools to look up real fine amounts and traffic rules from the project database — "
                    "not guesses. Ask me any traffic-law question!"
                ),
                "tools_used": [],
                "agent_powered": self.ollama_available or self.gemini_available,
                "model": model_label,
            }

        # Catch very short ambiguous/filler messages that shouldn't trigger tools
        filler_patterns = (
            "ok", "okay", "mmm", "hmm", "hmmm", "mmm", "mhm", "ah", "oh",
            "lol", "haha", "thanks", "thank you", "thank", "bye", "cool",
            "what", "why", "how", "no", "yes", "yeah", "yep", "nope",
            "nice", "great", "good", "sure", "got it",
        )
        if text_lower in filler_patterns:
            return None  # Let the LLM handle it naturally without tools

        return None

    def _enrich_with_gps(self, user_text: str, gps: Optional[Dict], vehicle: Optional[str], location_name: Optional[str]) -> str:
        # Stop small LLMs from being conversational and asking for missing params
        loc_str = location_name if location_name else "India ('IN')"
        veh_str = vehicle if vehicle else "'ALL' or 'LMV'"
        context = (
            f"[System context: User is located in {loc_str}. User's primary vehicle is {veh_str}. "
            "DO NOT ask the user for country or vehicle. Assume this location and vehicle and look up the fine immediately.]"
        )
        if gps and self._message_needs_location(user_text):
            context += f" User GPS lat={gps.get('lat')}, lon={gps.get('lon')}."
        return f"{user_text}\n\n{context}"

    # ─────────────────────────────────────────────────────────────────────────
    # Ollama Agentic Loop (OpenAI-compatible API)
    # ─────────────────────────────────────────────────────────────────────────

    def _run_ollama(
        self,
        user_text: str,
        history: List[Dict],
        gps: Optional[Dict],
        vehicle: Optional[str],
        location_name: Optional[str],
        image_base64: Optional[str] = None,
        image_mime: str = "image/jpeg",
    ) -> Dict[str, Any]:
        tools_used = []
        active_model = self.ollama_vision_model if image_base64 else self.ollama_model

        expanded_text = self._expand_follow_up_user_text(user_text, history)
        enriched_text = self._enrich_with_gps(expanded_text, gps, vehicle, location_name)
        if image_base64:
            enriched_text = (
                f"{enriched_text}\n\n"
                "[Image task: inspect the attached image. Extract any text, dates, vehicle numbers, or traffic violations you see. Write a beautiful, well-structured response explaining the situation. Be as helpful and descriptive as possible.]"
            )
        use_tools = (
            bool(image_base64)
            or self._is_traffic_query(user_text, history)
            or self._is_traffic_query(expanded_text, history)
        )
        native_tools = use_tools and self._ollama_supports_native_tools(active_model)

        openai_tools = self._build_openai_tools() if native_tools else None
        
        system_prompt_to_use = SYSTEM_PROMPT

        # Qwen3 models default to "thinking mode" which wraps output in <think> tags.
        # The OpenAI-compatible API strips these, causing empty responses. Disable it.
        if "qwen3" in (active_model or "").lower():
            system_prompt_to_use += "\n\n/no_think"

        if use_tools and not native_tools and not image_base64:
            # Inject manual tool calling instructions since native tools are disabled
            tool_json = json.dumps(TOOL_DEFINITIONS, indent=2)
            system_prompt_to_use += f"\n\n### AVAILABLE TOOLS\n{tool_json}\n\n"
            system_prompt_to_use += "### INSTRUCTIONS FOR TOOL CALLING\nYou do NOT have native tool calling enabled. To use a tool, you MUST output a raw JSON block and NOTHING ELSE. Example:\n```json\n{\n  \"name\": \"lookup_fine\",\n  \"arguments\": {\"offence_type\": \"NO_HELMET\", \"vehicle_class\": \"2W\", \"state\": \"ALL\"}\n}\n```\nWait for the tool result before providing the final answer."

        # Build messages list (OpenAI chat format)
        messages = [{"role": "system", "content": system_prompt_to_use}]

        for turn in history:
            role = turn.get("role", "user")
            # Map "model" role to "assistant" for OpenAI format
            if role == "model":
                role = "assistant"
            parts = turn.get("parts", [""])
            content = parts[0] if parts else ""
            messages.append({"role": role, "content": content})

        # Add current user message. Vision-capable Ollama models accept OpenAI-style image_url parts.
        if image_base64:
            messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": enriched_text},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{image_mime};base64,{image_base64}"},
                    },
                ],
            })
        else:
            messages.append({"role": "user", "content": enriched_text})

        try:
            for iteration in range(self.MAX_TOOL_ITERATIONS):
                create_kwargs: Dict[str, Any] = {
                    "model": active_model,
                    "messages": messages,
                    "temperature": 0.1,
                    "timeout": 30.0,
                }
                if openai_tools:
                    create_kwargs["tools"] = openai_tools
                response = self.ollama_client.chat.completions.create(**create_kwargs)

                choice = response.choices[0]
                assistant_message = choice.message

                # Check if model wants to call tools (proper protocol)
                tool_calls_list = assistant_message.tool_calls or []

                # Fallback: parse tool calls from text if model outputs JSON text
                text_parsed_calls = []
                if use_tools and not tool_calls_list and assistant_message.content:
                    text_parsed_calls = self._parse_tool_calls_from_text(
                        assistant_message.content
                    )

                if not tool_calls_list and not text_parsed_calls:
                    # No tool calls at all → final text answer
                    break

                # Process proper tool calls
                if tool_calls_list:
                    logger.info(
                        "[Agent/Ollama] Iteration %d: tools called: %s",
                        iteration + 1,
                        [tc.function.name for tc in tool_calls_list],
                    )

                    # Add the assistant's message (with tool calls) to conversation
                    messages.append(assistant_message.model_dump())

                    for tool_call in tool_calls_list:
                        func_name = tool_call.function.name
                        try:
                            params = json.loads(tool_call.function.arguments)
                        except json.JSONDecodeError:
                            params = {}

                        result = self.tool_executor.execute(func_name, params, gps)

                        tools_used.append({
                            "tool": func_name,
                            "params": params,
                            "result": result,
                        })

                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": json.dumps(result),
                        })

                # Process text-parsed tool calls
                elif text_parsed_calls:
                    logger.info(
                        "[Agent/Ollama] Iteration %d: parsed tools from text: %s",
                        iteration + 1,
                        [tc["name"] for tc in text_parsed_calls],
                    )

                    # Add assistant text as a message
                    messages.append({"role": "assistant", "content": assistant_message.content})

                    # Execute parsed tools and collect results
                    tool_results_text = []
                    for tc in text_parsed_calls:
                        result = self.tool_executor.execute(tc["name"], tc["arguments"], gps)
                        tools_used.append({
                            "tool": tc["name"],
                            "params": tc["arguments"],
                            "result": result,
                        })
                        tool_results_text.append(
                            f"Tool '{tc['name']}' returned: {json.dumps(result)}"
                        )

                    # Feed results back as a user message so the model can synthesize
                    messages.append({
                        "role": "user",
                        "content": (
                            "[TOOL RESULTS — now write your FINAL answer]\n"
                            "Use the data below to give a clear, structured answer in markdown. "
                            "State the fine amount, section, and relevant details. "
                            "Do NOT output JSON, do NOT call any more tools, do NOT repeat the question.\n\n"
                            + "\n".join(tool_results_text)
                        ),
                    })

            # Extract final text and strip thinking tags
            final_text = self._strip_thinking_tags((assistant_message.content or "").strip())

            # If the final response is just JSON (tool call output), do one more pass
            if final_text and self._looks_like_json_tool_call(final_text) and tools_used:
                # The model output a tool call as text — we already executed it above.
                # Do a final synthesis pass.
                messages.append({"role": "assistant", "content": final_text})
                tool_summary = "\n".join(
                    f"Tool '{t['tool']}' result: {json.dumps(t['result'])}" for t in tools_used
                )
                messages.append({
                    "role": "user",
                    "content": (
                        "[TOOL RESULTS — now write your FINAL answer]\n"
                        "Use the data below to give a clear, structured, well-formatted answer. "
                        "Include the fine amount (₹), MV Act section, vehicle type, and state. "
                        "Do NOT output JSON. Do NOT call tools again.\n\n"
                        + tool_summary
                    ),
                })
                response = self.ollama_client.chat.completions.create(
                    model=active_model,
                    messages=messages,
                    temperature=0.1,
                    timeout=30.0,
                )
                final_text = self._strip_thinking_tags((response.choices[0].message.content or "").strip())

            if not final_text:
                final_text = (
                    "I couldn't find specific information. "
                    "Please rephrase or consult official sources."
                )

            if image_base64 and use_tools and not native_tools:
                verification = self._keyword_fallback(f"{user_text}\n{final_text}", gps)
                verification_tools = verification.get("tools_used") or []
                if verification_tools:
                    tools_used.extend(verification_tools)
                    final_text = (
                        "**Extracted from image:**\n"
                        f"{final_text}\n\n"
                        "**Verified from DriveLegal data:**\n"
                        f"{verification.get('response', '').strip()}"
                    )

            return {
                "status": "ok",
                "response": final_text,
                "tools_used": tools_used,
                "agent_powered": True,
                "model": f"ollama/{active_model}",
            }

        except Exception as e:
            error_msg = str(e)
            logger.error(f"[Agent/Ollama] Error: {error_msg}")

            # Try Gemini as fallback
            if self.gemini_available:
                logger.info("[Agent] Ollama failed. Falling back to Gemini.")
                return self._run_gemini(user_text, history, gps)

            fallback = self._keyword_fallback(user_text, gps)
            fallback["error_detail"] = error_msg
            return fallback

    def _build_openai_tools(self) -> list:
        """Convert TOOL_DEFINITIONS to OpenAI function-calling format."""
        openai_tools = []
        for tool in TOOL_DEFINITIONS:
            openai_tools.append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["parameters"],
                },
            })
        return openai_tools

    def _parse_tool_calls_from_text(self, text: str) -> list:
        """
        Parse tool/function calls from model text output.
        Some models output JSON like {"name": "lookup_fine", "arguments": {...}}
        instead of using the proper tool_calls protocol.
        """
        valid_tool_names = {t["name"] for t in TOOL_DEFINITIONS}
        parsed = []

        # Try to find JSON objects in the text
        # Pattern 1: {"name": "tool_name", "arguments": {...}}
        try:
            data = json.loads(text.strip())
            if isinstance(data, dict) and data.get("name") in valid_tool_names:
                parsed.append({
                    "name": data["name"],
                    "arguments": data.get("arguments", data.get("params", {})),
                })
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass

        # Pattern 2: Find JSON blocks in text (possibly wrapped in markdown code blocks)
        json_blocks = re.findall(r'```(?:json)?\s*({.*?})\s*```', text, re.DOTALL)
        if not json_blocks:
            # Try plain JSON objects
            json_blocks = re.findall(r'({\s*"name"\s*:.*?})', text, re.DOTALL)

        for block in json_blocks:
            try:
                data = json.loads(block)
                if isinstance(data, dict) and data.get("name") in valid_tool_names:
                    parsed.append({
                        "name": data["name"],
                        "arguments": data.get("arguments", data.get("params", {})),
                    })
            except (json.JSONDecodeError, TypeError):
                continue

        return parsed

    def _looks_like_json_tool_call(self, text: str) -> bool:
        """Check if text looks like a raw JSON tool call rather than natural language."""
        stripped = text.strip()
        if stripped.startswith('{') and stripped.endswith('}'):
            try:
                data = json.loads(stripped)
                return "name" in data or "function" in data
            except (json.JSONDecodeError, TypeError):
                pass
        return False

    # ─────────────────────────────────────────────────────────────────────────
    # Gemini Agentic Loop (google-genai SDK) — Cloud Fallback
    # ─────────────────────────────────────────────────────────────────────────

    def _run_gemini(self, user_text: str, history: List[Dict], gps: Optional[Dict], vehicle: Optional[str], location_name: Optional[str], image_base64: Optional[str] = None, image_mime: str = "image/jpeg") -> Dict[str, Any]:
        tools_used = []

        expanded_text = self._expand_follow_up_user_text(user_text, history)
        enriched_text = self._enrich_with_gps(expanded_text, gps, vehicle, location_name)

        if image_base64:
            enriched_text = (
                f"{enriched_text}\n\n"
                "[Image task: inspect the attached image. If it looks like a challan, notice, "
                "traffic sign, licence, RC, insurance, or PUC document, extract visible text, "
                "vehicle number, date, violation, location, amount, and section if present. "
                "Then use traffic-law tools when possible to verify fine/rule details from DriveLegal data. "
                "Clearly separate 'Extracted from image' from 'Verified from database'.]"
            )

        # Build full conversation contents list
        contents = []
        for turn in history:
            role = turn.get("role", "user")
            parts_text = turn.get("parts", [""])
            contents.append(
                self.gemini_types.Content(
                    role=role,
                    parts=[self.gemini_types.Part.from_text(text=p) for p in parts_text]
                )
            )
            
        # Add current user message
        user_parts = [self.gemini_types.Part.from_text(text=enriched_text)]
        if image_base64:
            import base64
            image_bytes = base64.b64decode(image_base64)
            user_parts.append(
                self.gemini_types.Part.from_bytes(data=image_bytes, mime_type=image_mime)
            )
            
        contents.append(
            self.gemini_types.Content(
                role="user",
                parts=user_parts

            )
        )

        # Build tool declarations for Gemini
        tool_declarations = self._build_gemini_tool_declarations()

        config = self.gemini_types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            tools=[self.gemini_types.Tool(function_declarations=tool_declarations)],
            temperature=0.1,   # Low temp = factual, consistent answers
        )

        try:
            # Agentic loop
            for iteration in range(self.MAX_TOOL_ITERATIONS):
                response = self.gemini_client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=contents,
                    config=config,
                )

                # Check if model wants to call tools
                tool_calls = []
                for part in response.candidates[0].content.parts:
                    if hasattr(part, "function_call") and part.function_call:
                        tool_calls.append(part.function_call)

                if not tool_calls:
                    # No tool calls → final text answer
                    break

                logger.info(
                    "[Agent/Gemini] Iteration %d: tools called: %s",
                    iteration + 1,
                    [c.name for c in tool_calls],
                )

                # Add model's tool-request turn to contents
                contents.append(response.candidates[0].content)

                # Execute tools and build response parts
                tool_result_parts = []
                for call in tool_calls:
                    params = dict(call.args)
                    result = self.tool_executor.execute(call.name, params, gps)

                    tools_used.append({
                        "tool": call.name,
                        "params": params,
                        "result": result,
                    })

                    tool_result_parts.append(
                        self.gemini_types.Part.from_function_response(
                            name=call.name,
                            response={"result": result},
                        )
                    )

                # Add tool results as "tool" role turn
                contents.append(
                    self.gemini_types.Content(role="tool", parts=tool_result_parts)
                )

            # Extract final text
            final_text = ""
            for part in response.candidates[0].content.parts:
                if hasattr(part, "text") and part.text:
                    final_text += part.text

            final_text = final_text.strip() or (
                "I couldn't find specific information. Please rephrase or consult official sources."
            )

            return {
                "status": "ok",
                "response": final_text,
                "tools_used": tools_used,
                "agent_powered": True,
                "model": "gemini-2.0-flash",
            }

        except Exception as e:
            error_msg = str(e)
            logger.error(f"[Agent/Gemini] Error: {error_msg}")

            if "429" in error_msg or "RESOURCE_EXHAUSTED" in error_msg:
                logger.info("[Agent] Gemini rate-limited. Falling back to local NLP.")

            fallback = self._keyword_fallback(user_text, gps)
            fallback["error_detail"] = error_msg
            return fallback

    def _build_gemini_tool_declarations(self) -> list:
        """Convert tool definitions dict to Gemini FunctionDeclaration objects."""
        from google.genai import types

        declarations = []
        for tool in TOOL_DEFINITIONS:
            declarations.append(
                types.FunctionDeclaration(
                    name=tool["name"],
                    description=tool["description"],
                    parameters=tool["parameters"],
                )
            )
        return declarations

    # ─────────────────────────────────────────────────────────────────────────
    # Keyword Fallback (No AI Available) — Offline Feature
    # ─────────────────────────────────────────────────────────────────────────

    def _keyword_fallback(self, text: str, gps: Optional[Dict]) -> Dict[str, Any]:
        """
        Comprehensive offline keyword-based fallback that uses the same
        normalize module as the AI tools, ensuring correct state codes (TN),
        offence codes, and vehicle classes that match the SQLite fines.db.
        """
        from backend.modules.agent.normalize import (
            normalize_offence_code,
            normalize_state,
            normalize_vehicle_class,
            detect_country_and_state,
            get_currency_symbol,
        )

        text_lower = text.lower()
        tools_used: List[Dict] = []
        response_parts: List[str] = []

        # ── 0. Handle fillers and out-of-domain ───────────────────────────
        clean_text = self._clean_user_text(text)
        
        filler_patterns = (
            "ok", "okay", "mmm", "hmm", "hmmm", "mhm", "ah", "oh",
            "lol", "haha", "thanks", "thank you", "thank", "bye", "cool",
            "no", "yes", "yeah", "yep", "nope",
            "nice", "great", "good", "sure", "got it",
        )
        is_filler = clean_text in filler_patterns or clean_text.startswith("thanks") or clean_text.startswith("thank you")
        
        if is_filler:
            resp = "You're welcome! Let me know if you need any more help with traffic laws." if "thank" in clean_text else "Acknowledged! Let me know if you have any traffic law questions."
            return {
                "status": "ok",
                "response": resp,
                "tools_used": [],
                "agent_powered": False,
                "model": "offline-keyword",
            }
            
        greetings = ("hi", "hello", "hey", "hii", "hola", "good morning", "good evening", "good afternoon", "namaste")
        is_greeting = clean_text in greetings or clean_text.startswith(("hi ", "hello ", "hey ")) or re.match(r"^(hi|hello|hey|hii|namaste)[\s!.]*$", clean_text)
        
        traffic_keywords = [
            "fine", "penalty", "challan", "ticket", "rule", "law", "legal", "section", "act",
            "speed", "helmet", "seatbelt", "drink", "drunk", "license", "licence", "insurance",
            "parking", "park", "light", "signal", "driving", "drive", "vehicle", "car", "bike",
            "motorcycle", "truck", "bus", "auto", "road", "traffic", "violation", "offence",
            "offense", "zone", "area", "horn", "honk", "puc", "pollution", "emission", "exhaust"
        ]
        is_traffic_query = any(k in text_lower for k in traffic_keywords)
        
        if not is_greeting and not is_traffic_query:
            return {
                "status": "fallback",
                "response": "I'm DriveLegal AI, and I specialize only in traffic laws and regulations. I can't help with that question, but feel free to ask me anything about traffic fines, rules, or driving laws!",
                "tools_used": [],
                "agent_powered": False,
                "model": "offline-keyword",
            }

        # ── Detect country, state, vehicle, offence from text ─────────────
        country, detected_state = detect_country_and_state(text_lower)
        if detected_state == "ALL":
            detected_state = self._detect_state_code(text_lower)
        offence = self._detect_offence(text_lower)
        vehicle = self._detect_vehicle(text_lower)

        # ── Human-readable offence display names ──────────────────────────
        offence_display = {
            "NO_HELMET": "No Helmet",
            "DRUNK_DRIVING": "Drunk Driving",
            "SPEED_EXCESS": "Over Speeding",
            "NO_LICENSE": "Driving Without License",
            "MOBILE_PHONE": "Using Mobile Phone While Driving",
            "NO_INSURANCE": "No Insurance",
            "RED_LIGHT_JUMPING": "Jumping Red Light",
            "NO_SEATBELT": "No Seatbelt",
            "WRONG_WAY": "Wrong Way Driving",
            "SECTION_184": "Dangerous/Rash Driving",
            "NO_PARKING": "No Parking / Illegal Parking",
            "TRIPLE_RIDING": "Triple Riding",
            "MINOR_DRIVING": "Underage / Minor Driving",
            "NO_PUC": "No Pollution Certificate (PUC)",
            "NO_LICENSE_PLATE": "No License Plate",
            "NUMBER_PLATE_VIOLATION": "Number Plate Violation",
            "HORN_VIOLATION": "Horn Violation",
        }

        # ── Vehicle display names ─────────────────────────────────────────
        vehicle_display = {
            "TWO_WHEELER": "Two-Wheeler",
            "LMV": "Car / LMV",
            "HGV": "Heavy Vehicle",
            "3W": "Auto-Rickshaw",
            "GENERAL": "All Vehicles",
            "ALL": "All Vehicles",
        }

        currency = get_currency_symbol(country)

        # ── 1. Fine Lookup ────────────────────────────────────────────────
        fine_keywords = [
            "fine", "penalty", "challan", "amount", "how much", "cost",
            "charge", "fee", "punish", "caught", "stopped", "booked",
        ]
        if offence or any(k in text_lower for k in fine_keywords):
            if offence:
                result = self.tool_executor.execute(
                    "lookup_fine",
                    {
                        "offence_type": offence,
                        "vehicle_class": vehicle,
                        "state": detected_state,
                        "country": country,
                    },
                    gps,
                )
                tools_used.append({"tool": "lookup_fine", "params": {"offence_type": offence, "vehicle_class": vehicle, "state": detected_state}, "result": result})
                display_name = offence_display.get(offence, offence.replace("_", " ").title())
                v_display = vehicle_display.get(vehicle, vehicle)

                if result.get("found"):
                    amt = result.get("amount_inr") or result.get("amount")
                    repeat = result.get("repeat_amount_inr") or result.get("repeat_amount")
                    section = result.get("section_ref", "N/A")
                    state_label = result.get("state", detected_state)

                    response_parts.append(
                        f"## 💰 Fine for {display_name}\n\n"
                        f"**Vehicle Type:** {v_display}\n"
                        f"**State:** {state_label}\n\n"
                        f"| Detail | Amount |\n"
                        f"|--------|--------|\n"
                        f"| **First Offence** | {currency}{amt} |\n"
                        f"| **Repeat Offence** | {currency}{repeat if repeat else 'Same'} |\n"
                        f"| **Section** | {section} |\n"
                    )
                else:
                    # Retry with ALL state if specific state failed
                    if detected_state != "ALL":
                        retry = self.tool_executor.execute(
                            "lookup_fine",
                            {"offence_type": offence, "vehicle_class": vehicle, "state": "ALL", "country": country},
                            gps,
                        )
                        if retry.get("found"):
                            amt = retry.get("amount_inr") or retry.get("amount")
                            repeat = retry.get("repeat_amount_inr") or retry.get("repeat_amount")
                            section = retry.get("section_ref", "N/A")
                            response_parts.append(
                                f"## 💰 Fine for {display_name} (National Rule)\n\n"
                                f"**Vehicle Type:** {v_display}\n\n"
                                f"| Detail | Amount |\n"
                                f"|--------|--------|\n"
                                f"| **First Offence** | {currency}{amt} |\n"
                                f"| **Repeat Offence** | {currency}{repeat if repeat else 'Same'} |\n"
                                f"| **Section** | {section} |\n\n"
                                f"*Note: State-specific data for {detected_state} not found; showing national rule.*"
                            )
                            tools_used.append({"tool": "lookup_fine", "result": retry})
                        else:
                            response_parts.append(f"No fine data found for **{display_name}** in the database.")
                    else:
                        response_parts.append(f"No fine data found for **{display_name}** in the database.")

        # ── 2. Rule Lookup ────────────────────────────────────────────────
        rule_keywords = ["rule", "law", "legal", "section", "act", "allowed", "permitted", "what does"]
        if any(k in text_lower for k in rule_keywords):
            search_words = [w for w in text_lower.split() if len(w) > 2 and w not in ("the", "for", "and", "what", "does", "law", "rule", "about")][:5]
            if search_words:
                result = self.tool_executor.execute(
                    "search_rules", {"keywords": search_words}, gps
                )
                tools_used.append({"tool": "search_rules", "result": result})
                if result.get("found") and result.get("rules"):
                    r = result["rules"][0]
                    title = r.get("title", "")
                    section = r.get("section", "")
                    desc = r.get("description", "")
                    if title and desc:
                        response_parts.append(f"\n## 📜 {title}" + (f" ({section})" if section else "") + f"\n\n{desc}")

        # ── 3. Zone Check ────────────────────────────────────────────────
        zone_keywords = ["zone", "area", "here", "location", "nearby", "restriction"]
        if gps and any(k in text_lower for k in zone_keywords):
            result = self.tool_executor.execute("check_zone", {}, gps)
            tools_used.append({"tool": "check_zone", "result": result})
            if result.get("found"):
                z = result["zones"][0]
                response_parts.append(f"\n📍 **Active Zone:** {z['name']} — {', '.join(z.get('rules', []))}")

        # ── 4. Handle greetings ───────────────────────────────────────────
        greetings = ["hi", "hello", "hey", "good morning", "good evening", "good afternoon", "namaste"]
        if text_lower.strip() in greetings:
            response_parts.append(
                "Hello! 👋 I'm **DriveLegal AI** — your traffic law assistant.\n\n"
                "I'm currently running in **offline mode** with local data.\n\n"
                "You can ask me things like:\n"
                "• \"What's the fine for no helmet?\"\n"
                "• \"Drunk driving penalty in Tamil Nadu\"\n"
                "• \"Fine for speeding\"\n"
                "• \"No insurance fine\"\n\n"
                "How can I help you today?"
            )

        # ── 5. NLP fallback: HybridSearch for unmatched queries ───────────
        if not response_parts and self.hybrid_search:
            try:
                nlp_results = self.hybrid_search.search(text, top_k=3)
                relevant = [r for r in nlp_results if r.get("score", 0) > 0.15]
                if relevant:
                    tools_used.append({"tool": "hybrid_search", "result": relevant})
                    response_parts.append("Here's what I found in the traffic law database:\n")
                    for i, r in enumerate(relevant, 1):
                        meta = r.get("metadata", {})
                        title = meta.get("title", "")
                        section = meta.get("section", "")
                        content = r.get("content", "")

                        if "###Assistant:" in content:
                            content = content.split("###Assistant:")[-1].strip()
                        if "###Human:" in content:
                            content = content.split("###Human:")[0].strip()
                        content = content.strip().rstrip("0123456789").strip()
                        if not content:
                            continue

                        header = f"**{title}**" if title else f"Result {i}"
                        if section and section != "QA Dataset":
                            header += f" (Section {section})"
                        response_parts.append(f"{i}. {header}\n   {content[:400]}")
            except Exception as e:
                logger.warning("[Agent] HybridSearch fallback error: %s", e)

        # ── 6. Nothing matched — helpful guidance ─────────────────────────
        if not response_parts:
            response_parts = [
                "I couldn't find specific information for your query.\n\n"
                "**Try asking about a specific traffic violation**, for example:\n"
                "• \"Fine for no helmet in Tamil Nadu\"\n"
                "• \"Drunk driving penalty\"\n"
                "• \"Speeding fine for car\"\n"
                "• \"No insurance fine\"\n"
                "• \"Red light jumping penalty\""
            ]

        response_parts.append("\n\n> ⚠️ *This is informational only. Consult official sources for legal decisions.*")

        return {
            "status": "fallback",
            "response": "\n".join(response_parts),
            "tools_used": tools_used,
            "agent_powered": False,
            "model": "offline-keyword",
        }

    # ─────────────────────────────────────────────────────────────────────────
    # Fallback Helpers — use DB-compatible codes
    # ─────────────────────────────────────────────────────────────────────────

    def _detect_offence(self, text: str) -> Optional[str]:
        """Detect offence and return the EXACT code used in fines.db."""
        # Ordered from most specific to least to avoid false matches
        offence_map = [
            ("NO_HELMET", ["no helmet", "without helmet", "helmet fine", "helmet"]),
            ("DRUNK_DRIVING", ["drunk driving", "drink and drive", "drink driving", "dui", "dwi", "alcohol", "daaru", "drunk"]),
            ("SPEED_EXCESS", ["over speeding", "overspeeding", "speed limit", "speeding", "fast driving", "speed"]),
            ("RED_LIGHT_JUMPING", ["red light", "signal jump", "jumping red", "signal jumping", "traffic signal"]),
            ("NO_LICENSE", ["without license", "without licence", "no license", "no licence", "driving licence", "driving license", "no dl", "license", "licence"]),
            ("NO_SEATBELT", ["no seatbelt", "without seatbelt", "seat belt", "seatbelt"]),
            ("MOBILE_PHONE", ["mobile phone", "phone while driving", "using phone", "texting", "mobile"]),
            ("WRONG_WAY", ["wrong way", "wrong side", "one way"]),
            ("SECTION_184", ["dangerous driving", "rash driving", "rash", "dangerous"]),
            ("NO_INSURANCE", ["no insurance", "without insurance", "insurance expired", "insurance"]),
            ("NO_PARKING", ["no parking", "illegal parking", "parking"]),
            ("TRIPLE_RIDING", ["triple riding", "triple ride", "three on bike", "3 on bike"]),
            ("MINOR_DRIVING", ["minor driving", "underage", "juvenile", "below 18"]),
            ("NO_PUC", ["no puc", "puc expired", "pollution certificate", "puc"]),
            ("NO_LICENSE_PLATE", ["no number plate", "no license plate", "number plate"]),
            ("HORN_VIOLATION", ["horn", "honking", "unnecessary horn"]),
        ]
        for code, keywords in offence_map:
            if any(k in text for k in keywords):
                return code
        return None

    def _detect_vehicle(self, text: str) -> str:
        """Detect vehicle class and return the EXACT code used in fines.db."""
        if any(k in text for k in ["bike", "scooter", "motorcycle", "two wheeler", "two-wheeler", "2w", "helmet", "pillion"]):
            return "TWO_WHEELER"
        if any(k in text for k in ["truck", "bus", "heavy", "lorry", "hgv", "commercial"]):
            return "HGV"
        if any(k in text for k in ["auto", "rickshaw", "three wheeler", "3w"]):
            return "3W"
        if any(k in text for k in ["car", "jeep", "suv", "lmv", "sedan", "four wheeler"]):
            return "LMV"
        return "ALL"

    def _detect_state_code(self, text: str) -> str:
        """Detect state and return the EXACT 2-letter code used in fines.db."""
        state_map = [
            ("TN", ["tamil nadu", "tamilnadu", "chennai", "coimbatore", "madurai", "trichy", "salem"]),
            ("DL", ["delhi", "new delhi"]),
            ("MH", ["maharashtra", "mumbai", "pune", "nagpur"]),
            ("KA", ["karnataka", "bangalore", "bengaluru", "mysuru", "mysore"]),
            ("KL", ["kerala", "kochi", "thiruvananthapuram", "trivandrum"]),
            ("UP", ["uttar pradesh", "lucknow", "noida", "agra", "varanasi"]),
            ("GJ", ["gujarat", "ahmedabad", "surat", "vadodara"]),
            ("RJ", ["rajasthan", "jaipur", "jodhpur", "udaipur"]),
            ("WB", ["west bengal", "kolkata", "calcutta"]),
            ("TS", ["telangana", "hyderabad"]),
            ("AP", ["andhra pradesh", "vijayawada", "visakhapatnam"]),
            ("PB", ["punjab", "chandigarh", "ludhiana", "amritsar"]),
            ("HR", ["haryana", "gurgaon", "gurugram", "faridabad"]),
            ("BR", ["bihar", "patna"]),
            ("MP", ["madhya pradesh", "bhopal", "indore"]),
            ("OR", ["odisha", "orissa", "bhubaneswar"]),
        ]
        for code, keywords in state_map:
            if any(k in text for k in keywords):
                return code
        return "ALL"


# Raw tool defs for FunctionDeclaration building
from backend.modules.agent.tools import TOOL_DEFINITIONS as TOOL_DEFINITIONS_RAW
