import asyncio
from typing import Dict, Any

from .query_classifier import QueryClassifier, QueryIntent
from .query_classifier_enhanced import EnhancedQueryClassifier
from .source_aggregator import SourceAggregator
from .judge_llm import JudgeLLM
from .synthesizer import SmartSynthesizer

class TrafficPolicyChatbot:
    """
    FIXED VERSION: Handles broad AND specific queries correctly
    Never shows weakness to users
    Uses general knowledge fallback
    """

    MAX_ITERATIONS = 3
    
    def __init__(self, fine_lookup=None, rules_loader=None):
        self.classifier = EnhancedQueryClassifier()
        self.aggregator = SourceAggregator(fine_lookup, rules_loader)
        self.judge = JudgeLLM()
        self.synthesizer = SmartSynthesizer()
        
        print("[INFO] DriveLegal FIXED initialized")
        print("   - Enhanced Query classification: ENABLED")
        print("   - Broad query handling: ENABLED")
        print("   - Scope-aware judging: ENABLED")
        print("   - Smart confidence handling: ENABLED")
    
    async def process_query(self, user_question: str, user_profile_country: str = None, user_profile_state: str = None, history: list = None, gps: str = None, vehicle: str = None) -> Dict[str, Any]:
        print(f"\n{'='*60}")
        print(f"PROCESSING: {user_question[:60]}...")
        print(f"{'='*60}")
        
        intent_info = self.classifier.classify(user_question)
        
        # Handle greetings immediately
        if intent_info.get("_should_respond") == False:
            return {
                "answer": "Hello! I'm DriveLegal, your AI traffic law assistant.\n\nI can help you with:\n\n→ Traffic fines and penalties\n→ Helmet & seatbelt rules\n→ Speed limits by zone\n→ Drunk driving laws\n→ Parking regulations\n→ Document requirements\n\nWhat would you like to know? Ask me any traffic law question!",
                "metadata": {
                    "query_type": "greeting",
                    "iterations_used": 0,
                    "architecture": "local_first_privacy_preserved"
                }
            }
            
        intent_str = intent_info['intent_type']
        
        # Map string back to QueryIntent enum to maintain compatibility with existing judge/synthesizer
        if intent_str == "broad_edu" or intent_str == "general_query":
            intent = QueryIntent.BROAD_EDUCATIONAL
        else:
            intent = QueryIntent.SPECIFIC_RULE
            
        print(f"\n[INFO] Step 1: Intent = {intent.value}")
        
        sources = await self.aggregator.fetch_all_sources(user_question)
        print(f"[INFO] Step 2: Fetched sources")
        
        judge_result = await self.judge.evaluate_sources(
            sources=sources,
            user_question=user_question,
            query_intent=intent,
            current_iteration=1
        )
        
        # CRITICAL FIX: Don't let scope mismatch kill simple queries!
        if judge_result.get("fatal_flaw_detected") and intent_str == "general_query":
            print("[WARN] Scope flaw detected but query is general - relaxing check")
            judge_result["fatal_flaw_detected"] = False
            judge_result["needs_research"] = False
            
        if judge_result.get("fatal_flaw_detected"):
            print("[INFO] Fatal flaw detected - triggering research...")
            sources = await self._retry_with_corrected_scope(
                user_question, intent, judge_result
            )
        
        detected_country = intent_info.get("detected_country", "unknown")
        
        # If NLP didn't detect a country, fallback to user's profile country if provided
        final_country = detected_country
        if final_country == "unknown" and user_profile_country:
            final_country = user_profile_country.lower().replace(" ", "_")
            
        final_state = user_profile_state or "unknown"
        
        final_output = await self.synthesizer.synthesize(
            raw_evaluation=judge_result,
            user_question=user_question,
            query_intent=intent,
            all_sources=sources,
            user_country=final_country,
            user_state=final_state,
            history=history,
            gps=gps,
            vehicle=vehicle
        )
        
        final_answer = final_output["answer"]
        
        # Apply formatting fix
        if not final_answer.startswith("→") and not final_answer.startswith("**Hello"):
            final_answer = self._apply_professional_formatting(final_answer, intent.value)
            
        result = {
            "answer": final_answer,
            "display_mode": final_output["display_mode"],
            "metadata": {
                "query_type": intent.value,
                "topics_covered": len(sources),
                "processing_time": "optimized",
                "sources_consulted": [s.source.value for s in sources] if sources else []
            }
        }
        
        print(f"\n[INFO] SUCCESS: Answer ready (mode: {final_output['display_mode']})")
        return result
    
    async def _retry_with_corrected_scope(
        self,
        question: str,
        intent: QueryIntent,
        failed_eval: Dict
    ):
        print("[INFO] Correcting scope mismatch...")
        if intent == QueryIntent.BROAD_EDUCATIONAL:
            return await self.aggregator.fetch_all_sources(
                user_question=question + " [FORCE COMPREHENSIVE]"
            )
        return await self.aggregator.fetch_all_sources(question)

    async def process_query_stream(self, user_question: str, user_profile_country: str = None, user_profile_state: str = None, history: list = None, gps: str = None, vehicle: str = None):
        """Streaming counterpart to process_query(): runs the same classify → aggregate →
        judge pipeline (not streamed — same latency as today), then yields the synthesizer's
        answer as it's generated instead of returning one final string.

        Yields ("delta", text) chunks as they arrive, followed by exactly one
        ("done", sources_consulted) tuple at the end.
        """
        intent_info = self.classifier.classify(user_question)

        if intent_info.get("_should_respond") == False:
            yield ("delta", "Hello! I'm DriveLegal, your AI traffic law assistant.\n\nI can help you with:\n\n"
                   "→ Traffic fines and penalties\n→ Helmet & seatbelt rules\n→ Speed limits by zone\n"
                   "→ Drunk driving laws\n→ Parking regulations\n→ Document requirements\n\n"
                   "What would you like to know? Ask me any traffic law question!")
            yield ("done", [])
            return

        intent_str = intent_info['intent_type']
        if intent_str == "broad_edu" or intent_str == "general_query":
            intent = QueryIntent.BROAD_EDUCATIONAL
        else:
            intent = QueryIntent.SPECIFIC_RULE

        sources = await self.aggregator.fetch_all_sources(user_question)

        judge_result = await self.judge.evaluate_sources(
            sources=sources,
            user_question=user_question,
            query_intent=intent,
            current_iteration=1
        )

        if judge_result.get("fatal_flaw_detected") and intent_str == "general_query":
            judge_result["fatal_flaw_detected"] = False
            judge_result["needs_research"] = False

        if judge_result.get("fatal_flaw_detected"):
            sources = await self._retry_with_corrected_scope(user_question, intent, judge_result)

        detected_country = intent_info.get("detected_country", "unknown")
        
        final_country = detected_country
        if final_country == "unknown" and user_profile_country:
            final_country = user_profile_country.lower().replace(" ", "_")
            
        final_state = user_profile_state or "unknown"

        async for chunk in self.synthesizer.synthesize_stream(
            raw_evaluation=judge_result,
            user_question=user_question,
            query_intent=intent,
            all_sources=sources,
            user_country=final_country,
            user_state=final_state,
            history=history,
            gps=gps,
            vehicle=vehicle
        ):
            yield ("delta", chunk)

        yield ("done", [s.source.value for s in sources] if sources else [])

    def _apply_professional_formatting(self, answer: str, intent_type: str) -> str:
        """
        Apply → arrows, **bold**, • bullets formatting
        """
        import re
        
        lines = answer.split('\n')
        formatted_lines = []
        
        for line in lines:
            stripped = line.strip()
            
            if not stripped:
                formatted_lines.append('')
                continue
            
            # Convert ### headings → → arrows
            if re.match(r'^#{1,3}\s*\d+\.', stripped):
                clean_title = re.sub(r'^#{1,3}\s*', '', stripped)
                formatted_lines.append(f'→ {clean_title.upper()}')
            
            # Convert ## subtitles → **bold**
            elif re.match(r'^#{1,3}\s+', stripped) and not re.match(r'^#{1,3}\s*\d+', stripped):
                clean_sub = re.sub(r'^#{1,3}\s*', '', stripped)
                formatted_lines.append(f'   **{clean_sub}**')
            
            # Keep existing bold
            elif stripped.startswith('**') and stripped.endswith('**'):
                formatted_lines.append(f'   {stripped}')
            
            # Keep bullets
            elif stripped.startswith('•') or stripped.startswith('-'):
                formatted_lines.append(f'   {stripped}')
            
            # Regular content - detect subtitles (short, ends with colon)
            elif len(stripped) < 60 and stripped.endswith(':') and not stripped.startswith('→'):
                formatted_lines.append(f'   **{stripped}**')
            
            else:
                formatted_lines.append(f'   {stripped}')
        
        return '\n'.join(formatted_lines)
