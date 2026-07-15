import re
from typing import List, Dict

def clean_user_text(text: str) -> str:
    t = (text or "").strip().lower()
    t = re.sub(r"[!?.。,;:]+$", "", t)
    t = re.sub(r"\s+", " ", t)
    return t

def message_needs_location(text: str) -> bool:
    text_lower = clean_user_text(text)
    location_keywords = (
        "zone", "here", "location", "nearby", "near me", "this area",
        "my area", "where i am", "school zone", "no-horn", "no horn",
        "speed limit", "gps", "coordinates",
    )
    return any(k in text_lower for k in location_keywords)

def history_transcript(history: List[Dict], max_turns: int = 6) -> str:
    lines = []
    for turn in history[-max_turns:]:
        role = "User" if turn.get("role") == "user" else "Assistant"
        parts = turn.get("parts", [""])
        content = (parts[0] if parts else "").strip()
        if content:
            lines.append(f"{role}: {content[:600]}")
    return "\n".join(lines)

def history_has_traffic_context(history: List[Dict]) -> bool:
    blob = history_transcript(history, max_turns=10).lower()
    hints = (
        "fine", "penalty", "challan", "helmet", "speed", "offence", "offense",
        "violation", "₹", "rupee", "section", "motor vehicle", "mv act", "license",
    )
    return any(h in blob for h in hints)

def is_follow_up_question(text: str, history: List[Dict]) -> bool:
    if len(history) < 2:
        return False
    clean = clean_user_text(text)
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
    return has_traffic_hint and history_has_traffic_context(history)
