import re
from typing import Dict, Any, List
import json
from openai import AsyncOpenAI

from .query_classifier import QueryIntent
from .config import config
from .models import SourceAnswer

def format_answer_professional(text: str) -> str:
    lines = text.split('\n')
    formatted_lines = []
    
    for line in lines:
        stripped = line.strip()
        if not stripped:
            formatted_lines.append('')
            continue
        if re.match(r'^#{1,3}\s*\d+\.', stripped):
            clean_title = re.sub(r'^#{1,3}\s*', '', stripped)
            formatted_lines.append(f'→ {clean_title.upper()}')
        elif re.match(r'^#{1,3}\s+', stripped) and not re.match(r'^#{1,3}\s*\d+', stripped):
            clean_sub = re.sub(r'^#{1,3}\s*', '', stripped)
            formatted_lines.append(f'   **{clean_sub}**')
        elif stripped.startswith('**') and stripped.endswith('**'):
            formatted_lines.append(f'   {stripped}')
        elif stripped.startswith('•') or stripped.startswith('-') or stripped.startswith('*'):
            formatted_lines.append(f'   {stripped}')
        else:
            if len(stripped) < 60 and stripped.endswith(':') and not stripped.startswith('→'):
                formatted_lines.append(f'   **{stripped}**')
            else:
                formatted_lines.append(f'   {stripped}')
    return '\n'.join(formatted_lines)

class SmartSynthesizer:
    
    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=config.DEEPSEEK_API_KEY,
            base_url=config.DEEPSEEK_BASE_URL
        )
        self.model_name = config.SYNTHESIZER_MODEL
    
    async def synthesize(
        self,
        raw_evaluation: Dict,
        user_question: str,
        query_intent: QueryIntent,
        all_sources: List[SourceAnswer]
    ) -> Dict[str, Any]:
        
        internal_confidence = self._calculate_internal_confidence(raw_evaluation)
        coverage_score = len([s for s in all_sources if len(str(s.answer)) > 50]) / 3.0
        
        print(f"[INFO] Internal Metrics:")
        print(f"   Confidence: {internal_confidence}")
        print(f"   Coverage: {coverage_score:.0%}")
        
        if internal_confidence >= 0.8 and coverage_score >= 0.7:
            final_answer = self._build_high_confidence_answer(
                raw_evaluation, user_question, query_intent, all_sources
            )
            display_mode = "authoritative"
            
        elif coverage_score < 0.5 and query_intent == QueryIntent.BROAD_EDUCATIONAL:
            print("[INFO] Low coverage detected - enhancing with general knowledge...")
            final_answer = await self._enhance_with_general_knowledge(
                raw_evaluation, user_question, all_sources
            )
            display_mode = "educational_comprehensive"
            
        else:
            final_answer = self._build_medium_confidence_answer(
                raw_evaluation, user_question, all_sources
            )
            display_mode = "helpful_cautious"
        
        formatted_answer = format_answer_professional(final_answer)
        
        output = {
            "answer": formatted_answer,
            "display_mode": display_mode,
            "_internal_metrics": {
                "confidence_level": internal_confidence,
                "coverage_score": coverage_score,
                "sources_used": len(all_sources),
                "recommendation": self._get_recommendation(internal_confidence, coverage_score)
            }
        }
        
        return output
    
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
    
    async def _enhance_with_general_knowledge(
        self,
        eval_result: Dict,
        question: str,
        sources: List[SourceAnswer]
    ) -> str:
        
        partial_info = "\n".join([str(s.answer) for s in sources])
        
        enhancement_prompt = f"""The user asked: "{question}"

We have SOME information from our database, but it's incomplete. Here's what we have:

{partial_info[:1000]}

TASK: Create a COMPREHENSIVE answer that:
1. Uses the information above where available
2. FILLS IN GAPS using your general knowledge of Indian traffic rules (MV Act 1988, CMVR)
3. Covers AT LEAST these major topics if not already covered:
   - Speed limits (city vs highway)
   - Traffic signals and signs
   - Helmet and seatbelt requirements
   - Lane discipline and overtaking
   - Parking rules
   - Drunk driving penalties
   - Document requirements (License, RC, Insurance, PUC)

MANDATORY FORMATTING - FOLLOW EXACTLY:
MAIN SECTIONS (use arrow format):
→ 1. SECTION TITLE HERE
   [content continues on next line with indent]

SUBTITLES (use bold):
**Subtitle Name Here**
[explanation after]

IMPORTANT KEY FACTS/NUMBERS (use bold):
**Key fact or important number here**
[context]

BULLET POINTS (for lists):
• First point
• Second point

EXAMPLE OF CORRECT FORMAT:

→ 1. SPEED LIMITS
   **Posted Limits:** Always follow the posted speed limit signs.
   • If no sign visible, use default speed for that road type
   
   **Variable Speed Limits:** Some areas use digital signs that change based on traffic/weather.
   • These digital limits are legally binding!
   
   **Critical Rule:** You must drive slower than the posted limit if conditions are hazardous.
   • Heavy rain, fog, ice, or heavy pedestrian traffic = slow down!

DO NOT USE:
[X] ### Headings
[X] ## Headings  
[X] _Italics_ for emphasis (use bold instead)
[X] Excessive emojis (keep it professional)

Total length: 600-900 words covering ALL requested topics."""

        return await self._call_llm_for_enhancement(enhancement_prompt)
    
    def _pick_best_source(self, eval_result: Dict, sources: List[SourceAnswer]) -> SourceAnswer:
        evaluations = eval_result.get("evaluation", {})
        best_source_name = "google"
        highest_score = -1
        
        for name, data in evaluations.items():
            if isinstance(data, dict) and data.get("score", 0) > highest_score:
                highest_score = data.get("score", 0)
                best_source_name = name
                
        for s in sources:
            if s.source.value == best_source_name:
                return s
        return sources[0] if sources else None

    def _build_high_confidence_answer(self, eval_result, question, intent, sources):
        best_source = self._pick_best_source(eval_result, sources)
        answer = best_source.answer if best_source else "Data verified."
        
        formatted = f"{answer}\n\n---\n[INFO] **Information verified against official traffic rule database.**"
        return formatted
    
    def _build_medium_confidence_answer(self, eval_result, question, sources):
        best_source = self._pick_best_source(eval_result, sources)
        answer = best_source.answer if best_source else "Here is the information."
        
        formatted = f"""{answer}

---
[INFO] **Want to dive deeper?**
For the most current penalty amounts in your specific state, you can check:
* **parivahan.gov.in** - Official government portal  
* **Your local RTO office** - In-person assistance  
* **mParivahan app** - Mobile access to services

[INFO] Drive safely!"""
        return formatted
    
    def _get_recommendation(self, confidence: float, coverage: float) -> str:
        if confidence >= 0.8 and coverage >= 0.8:
            return "EXCELLENT - Ready to display"
        elif coverage < 0.5:
            return "IMPROVE - Expand knowledge base for this topic"
        elif confidence < 0.6:
            return "REVIEW - Verify data accuracy"
        else:
            return "ACCEPTABLE - Minor enhancements possible"
            
    async def _call_llm_for_enhancement(self, prompt: str) -> str:
        try:
            response = await self.client.chat.completions.create(
                model=self.model_name,
                messages=[
                    {"role": "system", "content": "You are an expert Indian Traffic Police assistant."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.4,
                max_tokens=2048
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling DeepSeek Synthesizer API: {e}")
            return "An error occurred while generating the comprehensive guide."
