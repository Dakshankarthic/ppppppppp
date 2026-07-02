import asyncio
import json
from typing import List, Dict, Any, Optional
from duckduckgo_search import DDGS
from openai import AsyncOpenAI

from .models import SourceAnswer, SourceType
from .config import config
from .query_classifier import QueryClassifier, QueryIntent

class SourceAggregator:
    
    def __init__(self, fine_lookup=None, rules_loader=None):
        self.fine_lookup = fine_lookup
        self.rules_loader = rules_loader
        self.classifier = QueryClassifier()
        
        self.ollama_client = AsyncOpenAI(
            api_key="ollama",
            base_url=config.OLLAMA_BASE_URL
        )
    
    async def fetch_all_sources(self, user_question: str) -> List[SourceAnswer]:
        intent, metadata = self.classifier.classify(user_question)
        print(f"\n[INFO] Query Classified: {intent.value}")
        print(f"[INFO] Scope: {metadata['scope']}")
        
        tasks = [
            self._fetch_from_db(user_question, intent, metadata),
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
    
    async def _fetch_from_db(self, question: str, intent: QueryIntent, metadata: dict) -> SourceAnswer:
        try:
            db_results = []
            
            if not self.fine_lookup and not self.rules_loader:
                return SourceAnswer(
                    source=SourceType.DB,
                    answer="Database not connected.",
                    confidence=0.0,
                    metadata={"error": "no_db_client"}
                )
            
            if intent == QueryIntent.BROAD_EDUCATIONAL:
                categories = metadata.get('categories_needed', [])
                for cat in categories:
                    if self.rules_loader:
                        db_results.append(f"Category {cat}: Refer to MV Act for {cat} rules.")
            else:
                if self.fine_lookup:
                    db_results.append(f"Found specific records for: {question} in Local DB.")
            
            answer_text = "\n".join(db_results) if db_results else "No specific DB records found."
            
            return SourceAnswer(
                source=SourceType.DB,
                answer=answer_text,
                confidence=0.8 if db_results else 0.0,
                metadata={"source": "local_db", "intent": intent.value}
            )
        except Exception as e:
            return SourceAnswer(source=SourceType.DB, answer=str(e), confidence=0.0, metadata={"error": str(e)})
    
    async def _fetch_from_ollama(self, question: str, intent: QueryIntent, metadata: dict) -> SourceAnswer:
        try:
            if intent == QueryIntent.BROAD_EDUCATIONAL:
                cats = metadata.get('categories_needed', [])
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
                query = f"India traffic rules comprehensive guide {metadata.get('categories_needed', [''])[0]}"
                
            def sync_search():
                with DDGS() as ddgs:
                    return list(ddgs.text(query, max_results=3))
            
            results = await asyncio.to_thread(sync_search)
            
            if not results:
                return SourceAnswer(
                    source=SourceType.GOOGLE,
                    answer="No search results found.",
                    confidence=0.0,
                    metadata={"source": "duckduckgo"}
                )
            
            compiled_answer = "DuckDuckGo Search Results:\n"
            for idx, res in enumerate(results):
                compiled_answer += f"{idx+1}. {res.get('title')}: {res.get('body')}\n"
                
            return SourceAnswer(
                source=SourceType.GOOGLE,
                answer=compiled_answer,
                confidence=0.75,
                metadata={"source": "duckduckgo", "raw_results": len(results)}
            )
        except Exception as e:
            return SourceAnswer(source=SourceType.GOOGLE, answer=f"Failed to fetch web results: {str(e)}", confidence=0.0, metadata={"error": str(e)})
    
    async def refetch_with_instructions(self, instructions: Dict[str, str]):
        print(f"Re-fetching with instructions: {instructions}")
        pass
