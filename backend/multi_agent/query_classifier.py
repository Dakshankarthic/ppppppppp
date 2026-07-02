import re
from typing import Tuple, List
from enum import Enum

class QueryIntent(Enum):
    SPECIFIC_RULE = "specific_rule"
    BROAD_EDUCATIONAL = "broad_edu"
    COMPARISON = "comparison"
    EXCEPTION_QUERY = "exception"
    PENALTY_DETAIL = "penalty_detail"
    GENERAL_SAFETY = "general_safety"

class QueryClassifier:
    
    BROAD_PATTERNS = [
        r'teach\s+me',
        r'basic\s+(road|traffic)\s*rules?',
        r'all\s+(the\s*)?rules',
        r'overview\s+of',
        r'guide\s+to\s+driving',
        r'(what|tell me about)\s+(road|traffic)\s*(rules|laws|regulations)',
        r'driving\s+tips',
        r'how\s+to\s+drive',
        r'complete\s+(list|set)',
        r'everything\s+(about|I need)\s+to\s+know'
    ]
    
    SPECIFIC_PATTERNS = [
        r'fine\s+(for|of|amount)',
        r'penalty\s+(for|of)',
        r'section\s+\d+',
        r'what\s+is\s+(the\s+)?(fine|penalty|rule|law)',
        r'(can|could|may|should)\s+I\s+(ride|drive|park|turn)',
        r'is\s+(it\s+)?(legal|illegal|mandatory|required)',
        r'(do|i)\s+(have\s+to|need\s+to)\s+(wear|use|carry)'
    ]
    
    ROAD_RULE_CATEGORIES = [
        "speed_limits",
        "traffic_signals",
        "lane_discipline",
        "parking_rules",
        "overtaking",
        "right_of_way",
        "helmet_seatbelt",
        "drunk_driving",
        "document_requirements",
        "pedestrian_rules",
        "school_zones",
        "highway_driving",
        "night_driving",
        "emergency_vehicles"
    ]
    
    def classify(self, user_question: str) -> Tuple[QueryIntent, dict]:
        question_lower = user_question.lower().strip()
        
        for pattern in self.BROAD_PATTERNS:
            if re.search(pattern, question_lower):
                return self._handle_broad_query(user_question)
        
        for pattern in self.SPECIFIC_PATTERNS:
            if re.search(pattern, question_lower):
                return (QueryIntent.SPECIFIC_RULE, {
                    "scope": "narrow",
                    "expected_categories": self._extract_topic(user_question),
                    "fetch_strategy": "single_topic"
                })
        
        if self._is_comparison(question_lower):
            return (QueryIntent.COMPARISON, {"scope": "comparative"})
        
        if self._is_exception_query(question_lower):
            return (QueryIntent.EXCEPTION_QUERY, {"scope": "exception"})
        
        return (QueryIntent.SPECIFIC_RULE, {
            "scope": "unknown_treated_as_specific",
            "fetch_strategy": "single_topic"
        })
    
    def _handle_broad_query(self, question: str) -> Tuple[QueryIntent, dict]:
        mentioned_categories = self._extract_mentioned_categories(question)
        
        if mentioned_categories:
            categories_to_fetch = mentioned_categories
        else:
            categories_to_fetch = self.ROAD_RULE_CATEGORIES[:8]
        
        return (QueryIntent.BROAD_EDUCATIONAL, {
            "scope": "broad",
            "categories_needed": categories_to_fetch,
            "fetch_strategy": "multi_topic",
            "expected_answer_length": "comprehensive (500-1000 words)",
            "min_topics_required": max(3, len(categories_to_fetch))
        })
    
    def _extract_topic(self, question: str) -> str:
        topic_keywords = {
            'helmet': ['helmet', 'head protection', 'riding gear'],
            'seatbelt': ['seatbelt', 'seat belt', 'safety belt', 'belt'],
            'speed': ['speed', 'overspeeding', 'fast', 'limit'],
            'parking': ['park', 'parking', 'no parking', 'tow zone'],
            'signal': ['signal', 'light', 'red light', 'green light'],
            'lane': ['lane', 'change lane', 'wrong side', 'overtake'],
            'drunk': ['drunk', 'alcohol', 'drink', 'DUI', 'DWI'],
            'document': ['license', 'RC', 'insurance', 'PUC', 'document']
        }
        
        question_lower = question.lower()
        for topic, keywords in topic_keywords.items():
            if any(kw in question_lower for kw in keywords):
                return topic
        return "general"
    
    def _extract_mentioned_categories(self, question: str) -> List[str]:
        mentioned = []
        question_lower = question.lower()
        
        category_keywords = {
            'speed_limits': ['speed', 'fast', 'slow', 'kmph', 'limit'],
            'traffic_signals': ['signal', 'light', 'red', 'green', 'stop'],
            'helmet_seatbelt': ['helmet', 'seatbelt', 'belt', 'safety gear'],
            'parking_rules': ['park', 'parking', 'zone', 'tow'],
            'lane_discipline': ['lane', 'overtake', 'wrong side', 'change'],
            'right_of_way': ['right of way', 'yield', 'give way', 'priority'],
            'drunk_drinking': ['drunk', 'alcohol', 'drink', 'intoxicated']
        }
        
        for category, keywords in category_keywords.items():
            if any(kw in question_lower for kw in keywords):
                mentioned.append(category)
        return mentioned
    
    def _is_comparison(self, question: str) -> bool:
        comparison_words = ['vs', 'versus', 'or', 'which is', 'compare', 
                          'difference between', 'better', 'worse']
        return any(word in question.lower() for word in comparison_words)
    
    def _is_exception_query(self, question: str) -> bool:
        exception_patterns = [
            r'exempt', r'exception', r'sikh', r'medical', r'emergency',
            r'can i (skip|avoid|not)', r'without (helmet|belt|license)'
        ]
        return any(re.search(p, question.lower()) for p in exception_patterns)
