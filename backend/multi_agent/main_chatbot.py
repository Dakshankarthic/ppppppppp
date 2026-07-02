import asyncio
from typing import Dict, Any

from .query_classifier import QueryClassifier, QueryIntent
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
        self.classifier = QueryClassifier()
        self.aggregator = SourceAggregator(fine_lookup, rules_loader)
        self.judge = JudgeLLM()
        self.synthesizer = SmartSynthesizer()
        
        print("[INFO] DriveLegal FIXED initialized")
        print("   - Query classification: ENABLED")
        print("   - Broad query handling: ENABLED")
        print("   - Scope-aware judging: ENABLED")
        print("   - Smart confidence handling: ENABLED")
    
    async def process_query(self, user_question: str) -> Dict[str, Any]:
        """
        Main entry point - now handles ANY query type correctly
        """
        
        print(f"\n{'='*60}")
        print(f"PROCESSING: {user_question[:60]}...")
        print(f"{'='*60}")
        
        intent, metadata = self.classifier.classify(user_question)
        print(f"\n[INFO] Step 1: Intent = {intent.value}")
        
        sources = await self.aggregator.fetch_all_sources(user_question)
        print(f"[INFO] Step 2: Fetched sources")
        
        judge_result = await self.judge.evaluate_sources(
            sources=sources,
            user_question=user_question,
            query_intent=intent,
            current_iteration=1
        )
        
        if judge_result.get("fatal_flaw_detected"):
            print("[INFO] Fatal flaw detected - triggering research...")
            sources = await self._retry_with_corrected_scope(
                user_question, intent, judge_result
            )
        
        final_output = await self.synthesizer.synthesize(
            raw_evaluation=judge_result,
            user_question=user_question,
            query_intent=intent,
            all_sources=sources
        )
        
        result = {
            "answer": final_output["answer"],
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
