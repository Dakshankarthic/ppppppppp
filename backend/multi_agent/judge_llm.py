import json
import asyncio
from typing import List, Dict, Any
from openai import AsyncOpenAI
from .models import SourceAnswer, JudgeEvaluation, SourceType
from .config import config
from .query_classifier import QueryIntent

class JudgeLLM:
    
    ENHANCED_JUDGE_PROMPT = """You are a Senior Traffic Policy Judge evaluating AI-generated responses.

## CRITICAL NEW METRIC: SCOPE MATCH

Before scoring anything else, determine:

**QUESTION SCOPE:** Is the user asking for:
- A) ONE specific rule/fine/penalty?
- B) A COMPREHENSIVE overview/guide/list?

**ANSWER SCOPE:** Does the response provide:
- A) Information about ONE narrow topic?
- B) Coverage of MULTIPLE related topics?

### SCOPE MATCH RULES:
- If Question=BROAD but Answer=NARROW -> MAX SCORE 3/10 (FATAL FLAW!)
- If Question=SPECIFIC but Answer=BROAD -> Score 7/10 (wastes time but not wrong)
- If Scope MATCHES -> Proceed to normal scoring (up to 10/10)

## EVALUATION CRITERIA (Score 1-10 Each):

### 1. SCOPE ALIGNMENT (NEW - Most Important!)
- Does answer breadth match question breadth?
- Did they address ALL parts of multi-part questions?
- Is the level of detail appropriate?

### 2. ACCURACY
- Correct sections, fines, penalties per MV Act 1988 + amendments?

### 3. COMPLETENESS (Relative to Scope!)
- For BROAD queries: Covered 3+ different rule categories?
- For SPECIFIC queries: All required elements present?

### 4. CURRENCY
- Up-to-date (2026 rules)?

### 5. RELEVANCE
- Directly addresses user's actual question?

### 6. SAFETY
- Promotes safe behavior? No dangerous suggestions?

## OUTPUT FORMAT (STRICT JSON):

{
  "scope_analysis": {
    "question_scope": "broad_educational OR specific_rule",
    "answer_scope": "narrow OR comprehensive",
    "scope_match": true,
    "match_score": 10
  },
  "evaluation": {
    "db": {
      "score": 8,
      "criteria_breakdown": {
        "scope_alignment": 10,
        "accuracy": 9,
        "completeness": 8,
        "currency": 7,
        "relevance": 9,
        "safety": 8
      },
      "issues": [],
      "strengths": []
    },
    "ollama": { },
    "google": { }
  },
  "needs_research": false,
  "research_instructions": {},
  "fatal_flaw_detected": false,
  "max_iterations": 3,
  "current_iteration": 1
}"""

    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=config.DEEPSEEK_API_KEY,
            base_url=config.DEEPSEEK_BASE_URL
        )
        self.model_name = config.JUDGE_MODEL
        self.temperature = 0.1
        
    async def evaluate_sources(
        self,
        sources: List[SourceAnswer],
        user_question: str,
        query_intent: QueryIntent,
        current_iteration: int = 1
    ) -> Dict[str, Any]:
        
        prompt = self._build_enhanced_prompt(
            sources=sources,
            question=user_question,
            intent=query_intent,
            iteration=current_iteration
        )
        
        raw_eval = await self._call_llm(prompt)
        
        try:
            cleaned_response = raw_eval.strip()
            if cleaned_response.startswith("```json"):
                cleaned_response = cleaned_response[7:]
            if cleaned_response.endswith("```"):
                cleaned_response = cleaned_response[:-3]
                
            evaluation = json.loads(cleaned_response)
            
            scope_analysis = evaluation.get("scope_analysis", {})
            if not scope_analysis.get("scope_match", True):
                print("[ERROR] FATAL: Scope mismatch detected!")
                print(f"   Question: {scope_analysis.get('question_scope')}")
                print(f"   Answer: {scope_analysis.get('answer_scope')}")
                
                evaluation["needs_research"] = True
                evaluation["fatal_flaw_detected"] = True
                evaluation["research_instructions"] = {
                    "all_sources": f"CRITICAL ERROR: User asked {query_intent.value} query but you provided narrow/single-topic answer. You MUST provide comprehensive multi-topic overview covering ALL relevant aspects."
                }
                
                for source_key, source_data in evaluation.get("evaluation", {}).items():
                    if isinstance(source_data, dict) and source_data.get("score", 10) > 3:
                        source_data["score"] = 3
                        source_data.setdefault("issues", []).append("FATAL: Answer scope doesn't match question scope")
            
            return self._validate_evaluation(evaluation, current_iteration)
            
        except json.JSONDecodeError as e:
            print(f"JSON Parsing Error: {e}")
            return self._fallback_evaluation(sources, current_iteration)

    def _build_enhanced_prompt(
        self,
        sources: List[SourceAnswer],
        question: str,
        intent: QueryIntent,
        iteration: int
    ) -> str:
        prompt = f"## QUERY INTENT (Pre-classified):\n"
        prompt += f"- Intent Type: **{intent.value}**\n"
        prompt += f"- Expected Scope: BROAD (multiple topics) OR SPECIFIC (single focused answer)\n\n"
        
        prompt += f"## USER QUESTION:\n{question}\n\n"
        prompt += f"## SOURCES TO EVALUATE (Iteration {iteration}):\n\n"
        
        for idx, source in enumerate(sources, 1):
            source_type = source.source.value.upper() if hasattr(source, 'source') else "UNKNOWN"
            prompt += f"### Source {idx}: {source_type}\n"
            prompt += f"```\n{str(source.answer)[:800]}...\n```\n\n"
        
        prompt += "\n## EVALUATE NOW (Pay special attention to SCOPE MATCH). Provide STRICT JSON output ONLY.\n"
        return prompt
        
    async def _call_llm(self, prompt: str) -> str:
        try:
            response = await self.client.chat.completions.create(
                model=self.model_name,
                messages=[
                    {"role": "system", "content": self.ENHANCED_JUDGE_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                temperature=self.temperature,
                max_tokens=2048,
                response_format={"type": "json_object"}
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling DeepSeek Judge API: {e}")
            return "{}"

    def _validate_evaluation(self, eval_dict: Dict, current_iteration: int) -> Dict:
        if "evaluation" not in eval_dict:
            eval_dict["evaluation"] = {}
        if "needs_research" not in eval_dict:
            eval_dict["needs_research"] = False
            
        scores = [v.get("score", 0) for v in eval_dict.get("evaluation", {}).values() if isinstance(v, dict)]
        min_score = min(scores) if scores else 0
        
        if min_score >= 8:
            eval_dict["confidence_level"] = "high"
        elif min_score >= 5:
            eval_dict["confidence_level"] = "medium"
        else:
            eval_dict["confidence_level"] = "low"
            
        eval_dict["current_iteration"] = current_iteration
        return eval_dict
    
    def _fallback_evaluation(self, sources, current_iteration: int):
        return {
            "evaluation": {
                s.source.value: {"score": 5, "issues": ["LLM evaluation failed"], "strengths": []}
                for s in sources
            },
            "needs_research": False,
            "research_instructions": {},
            "confidence_level": "low",
            "current_iteration": current_iteration
        }
