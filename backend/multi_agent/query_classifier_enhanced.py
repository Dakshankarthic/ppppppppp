import re
from typing import Tuple, Dict, List
from backend.multi_agent.history_utils import is_follow_up_question, history_transcript

class EnhancedQueryClassifier:
    """
    Enhanced query classifier that handles edge cases properly
    """
    
    GREETING_PATTERNS = [
        r'^hi$', r'^hello$', r'^hey$', r'^good\s*(morning|afternoon|evening)$',
        r'^thanks', r'^thank you', r'^bye$', r'^ok$'
    ]
    
    BROAD_PATTERNS = [
        'teach', 'learn', 'explain', 'tell me about', 'guide',
        'overview', 'basics', 'basic', 'fundamental', 'introduction',
        'all rules', 'everything', 'complete', 'comprehensive',
        'list of', 'types of', 'kinds of'
    ]
    
    SPECIFIC_PATTERNS = [
        'fine', 'penalty', 'punishment', 'section', 'amount',
        'how much', 'what is the', 'can i', 'is it legal',
        'is it mandatory', 'do i need', 'requirement'
    ]
    
    RULE_CATEGORIES = [
        ("speed_limits", ["speed", "fast", "slow", "kmph", "limit", "overspeed"]),
        ("traffic_signals", ["signal", "light", "red light", "green", "stop sign"]),
        ("helmet_seatbelt", ["helmet", "seatbelt", "seat belt", "safety gear"]),
        ("lane_discipline", ["lane", "overtake", "wrong side", "change lane"]),
        ("parking_rules", ["park", "parking", "tow zone", "no parking"]),
        ("drunk_driving", ["drunk", "alcohol", "drink", "intoxicated", "dui"]),
        ("documents", ["license", "rc", "insurance", "puc", "registration"]),
        ("right_of_way", ["right of way", "yield", "give way", "priority"])
    ]
    
    SUPPORTED_COUNTRIES = {
        "india": ["india", "tamil nadu", "delhi", "mumbai", "bangalore", "chennai", "pune", "kerala", "karnataka", "maharashtra"],
        "saudi_arabia": ["saudi", "saudi arabia", "ksa", "riyadh", "jeddah", "moroor"],
        "uae": ["uae", "dubai", "abu dhabi", "emirates", "sharjah"],
        "uk": ["uk", "britain", "london", "england", "united kingdom"],
        "usa": ["usa", "america", "united states", "california", "texas", "new york"],
        "singapore": ["singapore", "sg"]
    }
    
    def classify(self, user_question: str, history: List[Dict] = None) -> Dict[str, any]:
        """
        Classify query with better edge case handling
        """
        
        question_lower = user_question.lower().strip()
        
        # Check for greetings FIRST (before anything else)
        if self._is_greeting(question_lower):
            return {
                "intent_type": "greeting",
                "categories": [],
                "fetch_strategy": "no_fetch",
                "keyword_scores": {"greeting": 1},
                "confidence": 1.0,
                "_should_respond": False
            }
        
        context_text = question_lower
        if history and is_follow_up_question(user_question, history):
            context_text = f"{history_transcript(history, max_turns=4).lower()} {question_lower}"
            
        # Check for broad educational queries
        broad_score = sum(1 for kw in self.BROAD_PATTERNS if kw in question_lower)
        specific_score = sum(1 for kw in self.SPECIFIC_PATTERNS if kw in question_lower)
        
        # Determine intent
        if broad_score > 0 and broad_score >= specific_score:
            intent_type = "broad_edu"
            categories = self._extract_categories(context_text)
            fetch_strategy = "multi_topic"
            
        elif specific_score > 0 or (history and is_follow_up_question(user_question, history)):
            intent_type = "specific_rule"
            categories = [self._detect_single_topic(context_text)]
            fetch_strategy = "single_topic"
            
        else:
            # Unknown query - treat as general question
            intent_type = "general_query"
            categories = self.RULE_CATEGORIES[:6]  # Default top 6
            fetch_strategy = "multi_topic"
        
        # Extract Country Jurisdiction
        detected_country = self._extract_country(context_text)
        
        return {
            "intent_type": intent_type,
            "categories": categories,
            "fetch_strategy": fetch_strategy,
            "keyword_scores": {"broad": broad_score, "specific": specific_score},
            "confidence": self._calculate_confidence(broad_score, specific_score, len(question_lower)),
            "detected_country": detected_country,
            "_should_respond": True
        }
    
    def _is_greeting(self, text: str) -> bool:
        """Check if query is just a greeting"""
        for pattern in self.GREETING_PATTERNS:
            if re.match(pattern, text.strip()):
                return True
        return False
    
    def _extract_country(self, text: str) -> str:
        """Extract requested country/jurisdiction"""
        for country, keywords in self.SUPPORTED_COUNTRIES.items():
            if any(kw in text for kw in keywords):
                return country
        return "unknown"
    
    def _extract_categories(self, question: str) -> List[str]:
        """Extract relevant categories"""
        relevant = []
        for cat_name, keywords in self.RULE_CATEGORIES:
            if any(kw in question for kw in keywords):
                relevant.append(cat_name)
        
        if not relevant:
            relevant = [cat[0] for cat in self.RULE_CATEGORIES]
        
        return relevant
    
    def _detect_single_topic(self, question: str) -> str:
        """Detect single topic"""
        best_match = "general"
        max_matches = 0
        
        for cat_name, keywords in self.RULE_CATEGORIES:
            matches = sum(1 for kw in keywords if kw in question)
            if matches > max_matches:
                max_matches = matches
                best_match = cat_name
        
        return best_match
    
    def _calculate_confidence(self, broad: int, specific: int, length: int) -> float:
        """Calculate classification confidence"""
        if broad + specific == 0:
            return 0.4  # Low confidence for unclear queries
        
        base_confidence = max(broad, specific) / max(broad + specific, 1)
        
        # Boost confidence for longer queries (more context)
        length_bonus = min(length / 50, 0.3)
        
        return min(base_confidence + length_bonus, 1.0)
