import re
from typing import Tuple, List, Dict, Any

class ConstraintEnforcer:
    """
    Hard rules that CANNOT be violated
    Prevents dangerous or inaccurate outputs
    """
    
    CONSTRAINTS = {
        "max_fine_helmet": 1000,  # Cannot exceed this
        "mandatory_sections": ["Section 129", "MV Act"],
        "forbidden_phrases": [
            "you can ignore",
            "not necessary",
            "optional",
            "police won't catch",
            "it's okay"
        ],
        "required_phrases": ["fine", "mandatory", "penalty"]
    }
    
    def validate(
        self, 
        answer: str, 
        user_question: str
    ) -> Tuple[bool, List[str], str]:
        """
        Validate answer against hard constraints
        Returns: (is_valid, list_of_violations, corrected_draft_if_any)
        """
        violations = []
        
        # Check forbidden phrases
        for phrase in self.CONSTRAINTS["forbidden_phrases"]:
            if phrase.lower() in answer.lower():
                violations.append(f'FORBIDDEN PHRASE: "{phrase}"')
        
        # Fine amount validation (regex extract and compare)
        fines = re.findall(r'₹?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*', answer)
        for fine in fines:
            fine_int = int(fine.replace(',', ''))
            if fine_int > self.CONSTRAINTS["max_fine_helmet"]:
                # Basic check - if query mentions helmet, ensure fine is not > 1000
                if "helmet" in user_question.lower():
                    violations.append(f'FINE EXCEEDS MAX (Helmet): ₹{fine}')
        
        is_valid = len(violations) == 0
        return is_valid, violations, answer
    
    def auto_fix(
        self, 
        draft: str, 
        user_question: str, 
        violations: List[str]
    ) -> str:
        """Attempt automatic fixes for common violations"""
        
        fixed = draft
        
        for violation in violations:
            if "FORBIDDEN PHRASE" in violation:
                # Remove or replace forbidden phrases
                phrase = violation.split('"')[1]
                # Regex replace with case insensitivity
                fixed = re.sub(re.escape(phrase), "[removed]", fixed, flags=re.IGNORECASE)
            
            elif "FINE EXCEEDS MAX" in violation:
                # Replace excessive fines with max allowed
                fine_match = re.search(r'₹?[\s]*([\d,]+)', violation)
                if fine_match:
                    bad_fine = fine_match.group(1)
                    fixed = fixed.replace(bad_fine, "1,000")
                    if "(Note: Fine capped at legal maximum)" not in fixed:
                        fixed += "\n*(Note: Fine capped at legal maximum)*"
        
        return fixed

def check_required_fields(answer: str, sources: List[Any], intent) -> Tuple[bool, List[str], str]:
    """
    Ensure the synthesized answer hasn't dropped critical DB fields (fine amounts, sections).
    """
    if getattr(intent, 'value', intent) != "specific_rule":
        return True, [], answer
        
    db_sources = [str(s.answer) for s in sources if getattr(s.source, 'value', str(s.source)) == 'db']
    db_text = "\n".join(db_sources).lower()
    
    missing_fields = []
    
    if "₹" in db_text or "rs." in db_text or "rupees" in db_text or "raw_fine_data" in db_text:
        if not re.search(r'(₹|rs\.?|rupees?|\d{2,})', answer.lower()):
            missing_fields.append("Fine Amount")
            
    if "section" in db_text or "raw_fine_data" in db_text:
        if "section" not in answer.lower() and "sec." not in answer.lower():
            missing_fields.append("Legal Section")
            
    if missing_fields:
        fields_str = " and ".join(missing_fields)
        fixed_answer = answer + f"\n\n*(Note: According to our database, this rule involves a specific {fields_str} which was omitted in the summary. Please check your local RTO or the original data sources for the exact figures and sections.)*"
        return False, missing_fields, fixed_answer
        
    return True, [], answer
