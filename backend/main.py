import os
import sys

# Production mode detection
IS_PRODUCTION = os.environ.get("PRODUCTION", "").lower() in ("1", "true", "yes")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, Body, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from datetime import datetime
from pydantic import BaseModel, Field
from typing import Optional, Dict, List
from dotenv import load_dotenv
import json
import base64
from fpdf import FPDF

# Load .env for GEMINI_API_KEY
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

# Import Modules
from backend.modules.agent.engine import AgentEngine
from backend.multi_agent.main_chatbot import TrafficPolicyChatbot
from backend.modules.fines.lookup import FineLookup
from backend.modules.rules.loader import RulesLoader
from backend.modules.geofencing.engine import GeofencingEngine
from backend.modules.sync.router import router as sync_router
from backend.auth import router as auth_router

class UTF8JSONResponse(JSONResponse):
    """Preserve ₹ and other Unicode in JSON responses."""

    def render(self, content) -> bytes:
        return json.dumps(content, ensure_ascii=False).encode("utf-8")


app = FastAPI(
    title="DriveLegal API",
    description="AI-powered Indian traffic law assistant with agentic tool calling.",
    version="2.0.0",
    default_response_class=UTF8JSONResponse,
)

# ── CORS (required for web/browser clients) ───────────────────────────────────
# In production, restrict to your Netlify domain; in dev, allow all
CORS_ORIGINS = [
    "https://*.netlify.app",
    "https://drivelegalv1.netlify.app",
    "http://localhost:8081",
    "http://localhost:3000",
    "*"
]

if IS_PRODUCTION:
    # Restrict CORS in production
    CORS_ORIGINS = [
        "https://drivelegalv1.netlify.app",
        # Add your own custom domain here if you have one
    ]
    print(f"Running in PRODUCTION mode. CORS restricted to: {CORS_ORIGINS}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {
        "message": "Welcome to DriveLegal API",
        "docs": "/docs",
        "health": "/health",
        "status": "online"
    }

# ── Data paths ────────────────────────────────────────────────────────────────
DATA_DIR   = os.path.join(os.path.dirname(__file__), "data")
FINES_DB   = os.path.join(DATA_DIR, "fines.db")
RULES_JSON = os.path.join(DATA_DIR, "rules.json")
ZONES_DIR  = os.path.join(DATA_DIR, "zones")
REPORTS_DIR = os.path.join(os.path.dirname(__file__), "reports")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

# ── Mount Static Files ────────────────────────────────────────────────────────
SIGNS_IMAGES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "Indian-Traffic Sign-Dataset", "Images")
if os.path.exists(SIGNS_IMAGES_DIR):
    app.mount("/api/signs/images", StaticFiles(directory=SIGNS_IMAGES_DIR), name="signs_images")


# ── Initialize backend modules ────────────────────────────────────────────────
fine_lookup    = FineLookup(FINES_DB)   if os.path.exists(FINES_DB)   else None
rules_loader   = RulesLoader(RULES_JSON)
geofencing     = GeofencingEngine(ZONES_DIR)

# ── Initialize the AI Agent ───────────────────────────────────────────────────
agent = AgentEngine(fine_lookup, rules_loader, geofencing)
multi_agent_bot = TrafficPolicyChatbot(fine_lookup, rules_loader)

# ── Request / Response Models ─────────────────────────────────────────────────

class QueryRequest(BaseModel):
    text: str
    gps: Optional[Dict[str, float]] = None
    vehicle: Optional[str] = None
    location_name: Optional[str] = None
    image_base64: Optional[str] = None
    image_mime: Optional[str] = "image/jpeg"
    # Conversation history for multi-turn context
    # Each entry: {"role": "user"|"model", "parts": ["message text"]}
    history: List[Dict] = Field(default_factory=list)


class ChallanRequest(BaseModel):
    vehicle_number: str

class ReportRequest(BaseModel):
    id: str
    type: str
    typeLabel: str
    location: str
    description: str
    image_base64: str
    timestamp: str
    vehicle_number: Optional[str] = None

# ── Routes ────────────────────────────────────────────────────────────────────

class TranscribeRequest(BaseModel):
    audio_base64: str
    mime_type: Optional[str] = "audio/webm"

@app.post("/transcribe")
async def transcribe_audio(request: TranscribeRequest = Body(...)):
    """
    Transcribe base64-encoded audio to text using Google Speech Recognition.
    Accepts audio/webm, audio/m4a, audio/wav from mobile clients.
    """
    import tempfile
    import io

    try:
        import speech_recognition as sr
    except ImportError:
        return {"status": "error", "text": "", "message": "SpeechRecognition not installed. Run: pip install SpeechRecognition pydub"}

    try:
        # Decode base64 audio
        audio_data = base64.b64decode(request.audio_base64)
        mime = request.mime_type or "audio/webm"

        # Determine file extension
        ext_map = {
            "audio/webm": ".webm",
            "audio/mp4": ".m4a",
            "audio/m4a": ".m4a",
            "audio/wav": ".wav",
            "audio/aac": ".aac",
            "audio/ogg": ".ogg",
        }
        ext = ext_map.get(mime, ".webm")

        # Write to temp file
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(audio_data)
            tmp_path = tmp.name

        wav_path = tmp_path
        # Convert non-WAV formats to WAV using pydub if needed
        if ext != ".wav":
            try:
                from pydub import AudioSegment
                audio_seg = AudioSegment.from_file(tmp_path)
                wav_path = tmp_path.replace(ext, ".wav")
                audio_seg.export(wav_path, format="wav")
            except Exception as conv_err:
                # pydub/ffmpeg not available — try feeding raw to recognizer
                wav_path = tmp_path

        # Run speech recognition
        recognizer = sr.Recognizer()
        with sr.AudioFile(wav_path) as source:
            audio_recorded = recognizer.record(source)

        transcript = recognizer.recognize_google(audio_recorded, language="en-IN")

        return {"status": "ok", "text": transcript}

    except sr.UnknownValueError:
        return {"status": "ok", "text": "", "message": "Could not understand audio"}
    except sr.RequestError as e:
        return {"status": "error", "text": "", "message": f"Speech service error: {e}"}
    except Exception as e:
        return {"status": "error", "text": "", "message": str(e)}
    finally:
        # Clean up temp files
        import os as _os
        for p in [tmp_path, wav_path]:
            try:
                _os.unlink(p)
            except Exception:
                pass

@app.post("/query")
async def handle_query(request: QueryRequest = Body(...)):
    """
    Main AI agent endpoint, now using the Multi-Agent Architecture.
    """
    try:
        # Multimodal Check: If the user uploaded an image (Challan/Ticket), use the Vision Agent
        if request.image_base64:
            vision_result = agent.run(
                user_text=request.text,
                conversation_history=request.history,
                gps=request.gps,
                vehicle=request.vehicle,
                location_name=request.location_name,
                image_base64=request.image_base64,
                image_mime=request.image_mime or "image/jpeg",
            )
            vision_result["citations"] = _citations_from_tools(vision_result.get("tools_used") or [])
            return vision_result
            
        # Otherwise, run the new Multi-Agent text pipeline
        result = await multi_agent_bot.process_query(request.text)
        
        # Map to the format expected by the frontend
        return {
            "response": result["answer"],
            "citations": [f"Source: {s}" for s in result["metadata"].get("sources_consulted", [])],
            "model": "Multi-Agent System",
            "metadata": result["metadata"]
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "response": f"Error running multi-agent: {e}",
            "citations": [],
            "model": "Error"
        }


def _citations_from_tools(tools_used: list) -> list:
    """Human-readable source lines for the mobile trust footer."""
    lines = []
    for entry in tools_used:
        tool = entry.get("tool")
        res = entry.get("result") or {}
        if tool == "lookup_fine" and res.get("found"):
            section = res.get("section_ref") or "Traffic Law"
            display = res.get("amount_display") or f"₹{res.get('amount_inr', '?')}"
            when = res.get("data_as_of") or res.get("fetched_at") or ""
            country = res.get("country", "IN")
            source = "local fines.db"
            lines.append(f"{section}: {display} ({source}{f', updated {when[:10]}' if when else ''})")
        elif tool == "lookup_rule" and res.get("found"):
            lines.append(f"{res.get('section') or res.get('rule_id')}: rules.json")
        elif tool == "search_rules" and res.get("found"):
            # Multiple rules might be returned
            rules = res.get("rules", [])
            for r in rules:
                lines.append(f"{r.get('section') or r.get('rule_id')}: rules.json")
    if not lines and tools_used:
        lines.append("AI synthesis — confirm on official portals")
    # De-duplicate
    return list(dict.fromkeys(lines))


@app.post("/challan/calculate")
def calculate_challan(request: ChallanRequest = Body(...)):
    """
    Look up pending challans by vehicle registration number.
    Currently uses mock data — integrate with official Parivahan API for production.
    """
    v_num = request.vehicle_number.upper().replace(" ", "").replace("-", "")

    demo_notice = (
        "Demo sample data only — not linked to Parivahan / eChallan. "
        "Do not use for real payment decisions."
    )

    if "TN" in v_num:
        return {
            "demo": True,
            "demo_notice": demo_notice,
            "vehicle_number": request.vehicle_number,
            "owner": "J*** S***",
            "vehicle_type": "Motor Car (LMV)",
            "pending_challans": [
                {"date": "2024-03-15", "violation": "Over Speeding",     "amount": 1000, "status": "Pending", "location": "Anna Salai, Chennai"},
                {"date": "2024-04-02", "violation": "No Helmet (Pillion)", "amount": 500,  "status": "Pending", "location": "OMR, Chennai"},
            ],
            "total_fine": 1500,
            "last_updated": datetime.now().isoformat(),
        }
    elif "DL" in v_num:
        return {
            "demo": True,
            "demo_notice": demo_notice,
            "vehicle_number": request.vehicle_number,
            "owner": "A*** K***",
            "vehicle_type": "Two Wheeler",
            "pending_challans": [
                {"date": "2024-02-10", "violation": "Red Light Jumping", "amount": 1000, "status": "Pending", "location": "Connaught Place, Delhi"},
            ],
            "total_fine": 1000,
            "last_updated": datetime.now().isoformat(),
        }
    else:
        return {
            "demo": True,
            "demo_notice": demo_notice,
            "vehicle_number": request.vehicle_number,
            "owner": "N/A",
            "vehicle_type": "Unknown",
            "pending_challans": [],
            "total_fine": 0,
            "last_updated": datetime.now().isoformat(),
            "message": "No pending challans found for this vehicle number.",
        }

import urllib.request
import xml.etree.ElementTree as ET
import time

_BRIEFS_CACHE = {"data": None, "timestamp": 0}

@app.get("/briefs")
def get_briefs():
    """
    Fetch live news about Indian traffic rules/road safety, and use Ollama/Gemini to summarize.
    """
    global _BRIEFS_CACHE
    now = time.time()
    if _BRIEFS_CACHE["data"] and (now - _BRIEFS_CACHE["timestamp"]) < 3600:
        return {"status": "ok", "briefs": _BRIEFS_CACHE["data"]}

    try:
        url = "https://news.google.com/rss/search?q=india+traffic+rules+OR+road+safety&hl=en-IN&gl=IN&ceid=IN:en"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            xml_data = response.read()
        
        root = ET.fromstring(xml_data)
        items = root.findall('.//item')[:3]
        
        raw_news = []
        for i, item in enumerate(items):
            title = item.find('title').text if item.find('title') is not None else ""
            link = item.find('link').text if item.find('link') is not None else ""
            raw_news.append(f"News {i+1}: {title} (Link: {link})")

        raw_text = "\n".join(raw_news)
        
        # Now ask the LLM to summarize
        prompt = (
            "Summarize the following 3 news items into short, punchy 1-sentence briefs for a mobile app home screen. "
            "For each item, provide a title, a 1-sentence description, an icon name (choose from MaterialCommunityIcons like 'alert', 'car', 'racing-helmet', 'police-badge', 'traffic-cone', 'newspaper', 'shield-car', 'speedometer'), "
            "an icon background color (hex, light shade), and an icon color (hex, dark shade). "
            "Format the output strictly as a JSON array of objects with keys: id (string), title, desc, icon, iconBg, iconColor, link.\n\n"
            f"{raw_text}\n\n"
            "Respond ONLY with the raw JSON array. Do not include markdown code blocks or any other text."
        )

        summarized_json = ""
        if agent.ollama_available:
            try:
                res = agent.ollama_client.chat.completions.create(
                    model=agent.ollama_model,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.1
                )
                summarized_json = res.choices[0].message.content.strip()
            except Exception as e:
                print(f"Ollama error: {e}")
                
        if not summarized_json and agent.gemini_available:
            try:
                res = agent.gemini_client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=prompt
                )
                summarized_json = res.text.strip()
            except Exception as e:
                print(f"Gemini error: {e}")

        if summarized_json:
            # Clean markdown if present
            if summarized_json.startswith("```json"):
                summarized_json = summarized_json[7:-3].strip()
            elif summarized_json.startswith("```"):
                summarized_json = summarized_json[3:-3].strip()
                
            try:
                briefs_data = json.loads(summarized_json)
                # Link is required, ensure it is set or add from raw
                for i, b in enumerate(briefs_data):
                    b["id"] = str(i + 1)
                    if "link" not in b and i < len(items):
                        b["link"] = items[i].find('link').text
                
                _BRIEFS_CACHE["data"] = briefs_data
                _BRIEFS_CACHE["timestamp"] = now
                return {"status": "ok", "briefs": briefs_data}
            except json.JSONDecodeError:
                pass # Fallback to raw

        # Fallback if LLM fails
        fallback_briefs = []
        for i, item in enumerate(items):
            title = item.find('title').text if item.find('title') is not None else ""
            link = item.find('link').text if item.find('link') is not None else ""
            title_clean = title.split(" - ")[0] if " - " in title else title
            fallback_briefs.append({
                "id": str(i + 1),
                "title": "News Update",
                "desc": title_clean,
                "icon": "newspaper",
                "iconBg": "#e0f2fe",
                "iconColor": "#0284c7",
                "link": link
            })
            
        _BRIEFS_CACHE["data"] = fallback_briefs
        _BRIEFS_CACHE["timestamp"] = now
        return {"status": "ok", "briefs": fallback_briefs}
        
    except Exception as e:
        print(f"Briefs error: {e}")
        return {"status": "error", "message": "Failed to fetch news."}

@app.post("/report/submit")
def submit_report(request: ReportRequest = Body(...)):
    """
    Receives incident reports from the mobile app and saves them as files.
    """
    report_id = request.id
    
    # Calculate Fine based on Incident Type
    # Mapping incident types to DB offence codes
    offence_map = {
        "traffic": "RED_LIGHT_JUMPING",
        "parking": "NO_PARKING",
        "accident": "SECTION_184" # Dangerous driving
    }
    
    fine_amount = 0
    rule_section = "N/A"
    
    db_code = offence_map.get(request.type)
    if db_code and fine_lookup:
        fine_data = fine_lookup.query(db_code, "ALL", "TN", country="IN") # Using TN for Tamil Nadu challan
        if fine_data:
            fine_amount = fine_data.get("amount_inr", 0)
            rule_section = fine_data.get("section_ref", "N/A")

    # Save Image
    image_path = os.path.join(REPORTS_DIR, f"{report_id}.jpg")
    try:
        base64_data = request.image_base64
        if "base64," in base64_data:
            base64_data = base64_data.split("base64,")[1]
            
        with open(image_path, "wb") as f:
            f.write(base64.b64decode(base64_data))
    except Exception as e:
        print(f"Error saving image: {e}")
        return {"status": "error", "message": "Failed to decode image base64."}
        
    # Save JSON data
    data_path = os.path.join(REPORTS_DIR, f"{report_id}.json")
    report_data = {
        "id": report_id,
        "type": request.type,
        "typeLabel": request.typeLabel,
        "location": request.location,
        "description": request.description,
        "vehicle_number": request.vehicle_number,
        "timestamp": request.timestamp,
        "image_file": f"{report_id}.jpg",
        "status": "unverified",
        "fine_amount": fine_amount,
        "rule_section": rule_section
    }
    
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=4, ensure_ascii=False)
        
    # Generate Official E-Challan PDF
    try:
        pdf_path = os.path.join(REPORTS_DIR, f"{report_id}.pdf")
        pdf = FPDF()
        pdf.add_page()
        
        # Header Box
        pdf.set_fill_color(240, 240, 240)
        pdf.set_font("Arial", 'B', 16)
        pdf.cell(190, 15, "TAMIL NADU POLICE DEPARTMENT", border=1, ln=True, align='C', fill=True)
        pdf.set_font("Arial", 'B', 14)
        pdf.set_text_color(200, 0, 0)
        pdf.cell(190, 10, "E-CHALLAN RECEIPT", border=1, ln=True, align='C')
        pdf.set_text_color(0, 0, 0)
        pdf.ln(5)
        
        # Helper for table rows
        def add_row(label, value, is_bold=False):
            pdf.set_font("Arial", 'B', 11)
            pdf.cell(60, 10, label, border=1)
            pdf.set_font("Arial", 'B' if is_bold else '', 11)
            pdf.cell(130, 10, str(value), border=1, ln=True)

        # Details Table
        add_row("E-Challan No:", report_id, True)
        add_row("Date & Time:", request.timestamp)
        add_row("Vehicle Number:", request.vehicle_number or 'N/A', True)
        add_row("Place of Offence:", request.location)
        add_row("Offence Type:", request.typeLabel)
        add_row("Violated Rule (Section):", rule_section)
        
        pdf.set_text_color(200, 0, 0)
        add_row("Total Fine Amount:", f"Rs. {fine_amount}", True)
        pdf.set_text_color(0, 0, 0)
        
        pdf.ln(5)
        
        # Evidence Image section
        pdf.set_font("Arial", 'B', 12)
        pdf.cell(190, 10, "PHOTO EVIDENCE", border=1, ln=True, align='C', fill=True)
        
        # Embed the image if it exists
        if os.path.exists(image_path):
            # Calculate aspect ratio to fit the image
            pdf.image(image_path, x=15, y=pdf.get_y() + 5, w=180, h=100, keep_aspect_ratio=True)
            pdf.set_y(pdf.get_y() + 110) # move cursor below the image
        else:
            pdf.cell(190, 50, "No Image Evidence Available", border=1, ln=True, align='C')
            
        pdf.ln(5)
        
        # Footer Status
        pdf.set_font("Arial", 'B', 14)
        pdf.cell(190, 15, "STATUS: PENDING REVIEW", border=1, ln=True, align='C')
        
        pdf.output(pdf_path)
    except Exception as e:
        print(f"Error generating PDF: {e}")
        
    return {
        "status": "success", 
        "message": f"Report {report_id} saved successfully.",
        "fine_amount": fine_amount,
        "rule_section": rule_section
    }


# ── Notifications ─────────────────────────────────────────────────────────────

@app.get("/briefs")
def get_briefs():
    """
    Returns a list of daily traffic news and updates for the home screen.
    """
    briefs = [
        {
            "id": "1",
            "title": "New Expressway Speed Limits",
            "desc": "The NHAI has updated the speed limits for LMVs to 120 kmph on major expressways starting this month.",
            "icon": "speedometer",
            "iconBg": "#ffedd5",
            "iconColor": "#c2410c"
        },
        {
            "id": "2",
            "title": "Digital RC & License Valid",
            "desc": "Traffic police across states are now mandated to accept digital documents stored in DigiLocker or mParivahan.",
            "icon": "cellphone-check",
            "iconBg": "#dcfce7",
            "iconColor": "#15803d"
        },
        {
            "id": "3",
            "title": "E-Challan Grace Period Extended",
            "desc": "Vehicle owners now have up to 45 days to dispute an e-challan through the virtual traffic courts.",
            "icon": "gavel",
            "iconBg": "#f3e8ff",
            "iconColor": "#7e22ce"
        }
    ]
    return {"status": "ok", "briefs": briefs}

@app.get("/notifications")
def get_notifications(
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    zone_type: Optional[str] = "general",
    speed_limit: Optional[int] = None,
):
    """
    Generate dynamic, context-aware notifications for the mobile home screen.
    Uses current server time, optional GPS context, and zone type to produce
    relevant traffic safety notifications.
    """
    now = datetime.now()
    hour = now.hour
    month = now.month
    day = now.weekday()
    result = []

    def add(nid, title, body, ntype, icon, icon_bg, icon_color, action_label=None, route=None):
        result.append({
            "id": nid,
            "title": title,
            "body": body,
            "time": now.isoformat(),
            "type": ntype,
            "icon": icon,
            "iconBg": icon_bg,
            "iconColor": icon_color,
            "actionLabel": action_label,
            "route": route,
        })

    # Time-of-day alerts (IDs are stable so dismissals persist correctly)
    if 6 <= hour < 9:
        add("morning_rush", "Morning Rush Hour",
            "Heavy traffic on city roads 7-9 AM. Leave early or use alternate routes.",
            "info", "time", "#E0F2FE", "#0369A1")

    if 8 <= hour < 16:
        add("school_zone_hours", "School Zone Active",
            "School zones enforce a 25 km/h speed limit between 8 AM - 4 PM. Speed cameras are active.",
            "warning", "school", "#FEF3C7", "#B45309", "Show Rules", "/(tabs)/fines")

    if 17 <= hour < 20:
        add("evening_rush", "Evening Rush Hour",
            "Peak traffic detected. Maintain safe following distances and avoid aggressive lane changes.",
            "info", "car", "#FFEDD5", "#C2410C")

    if hour >= 20 or hour < 5:
        add("night_advisory", "Night Driving Advisory",
            "Use high-beam responsibly and switch to low-beam for oncoming traffic. DUI enforcement is active.",
            "alert", "moon", "#EDE9FE", "#6D28D9")

    # Zone-type alerts (change dynamically with GPS location)
    if zone_type == "school_zone":
        add("zone_school", "School Zone Detected",
            "You are in a school zone. Speed limit is {} km/h. Honking is prohibited.".format(speed_limit or 25),
            "warning", "warning", "#FEE2E2", "#DC2626", "View Fine", "/(tabs)/fines")
    elif zone_type == "hospital_zone":
        add("zone_hospital", "Hospital Zone",
            "Hospital zone active. Horns prohibited. Speed limit: {} km/h.".format(speed_limit or 30),
            "warning", "medkit", "#FEE2E2", "#DC2626")
    elif zone_type == "campus_zone":
        add("zone_campus", "Campus Zone",
            "University/campus zone. Reduced speed limit: {} km/h. Frequent pedestrian crossings.".format(speed_limit or 20),
            "info", "book", "#E0F2FE", "#0369A1")

    # Seasonal alerts (change by month)
    if 6 <= month <= 9:
        add("monsoon", "Monsoon Safety Alert",
            "Wet roads reduce braking by up to 40%. Maintain 3-second gap and avoid waterlogged routes.",
            "alert", "rainy", "#DBEAFE", "#1D4ED8")

    if month in [11, 12, 1]:
        add("winter_fog", "Low Visibility Warning",
            "Winter fog may reduce visibility below 50 m. Use fog lights and reduce speed.",
            "alert", "partly-sunny", "#F3F4F6", "#374151")

    # Document reminder (always shown)
    add("doc_reminder", "Document Vault Reminder",
        "Keep your RC, Driving License, Insurance and PUC Certificate updated for quick access at checkpoints.",
        "info", "folder-open", "#D1FAE5", "#059669", "Open Vault", "/settings/documents")

    # Daily tip — ID includes weekday so each day is treated as a distinct notification
    tips = [
        ("Seatbelt Rule", "All occupants must wear seatbelts. Rear-seat violations: Rs.1,000 fine."),
        ("Helmet Law", "Helmets mandatory for rider and pillion. Sub-standard helmets also attract a fine."),
        ("Mobile Phone Ban", "Handheld phone while driving: Rs.5,000 fine + 3-month licence suspension."),
        ("Lane Discipline", "Keep left unless overtaking. Overtake only from the right. Zig-zag is penalised."),
        ("FasTag Compliance", "All NH vehicles must have FasTag. Non-FasTag vehicles pay double the toll."),
        ("Speed Limits", "Urban: 50 km/h. Highways: 80-120 km/h. Overspeeding fine: Rs.1,000-2,000."),
        ("Drunk Driving", "BAC limit: 30 mg/100 ml. First offence: Rs.10,000 fine + 6-month jail."),
    ]
    tip_title, tip_body = tips[day]
    add("tip_day_{}".format(day), "Traffic Tip: {}".format(tip_title),
        tip_body, "info", "bulb", "#FEF3C7", "#B45309", "Ask DriveLegal", "/(tabs)/ask")

    return {"status": "ok", "notifications": result, "generated_at": now.isoformat()}


@app.get("/health")
def get_health():
    """Server and database status."""
    db_age       = fine_lookup.get_db_age() if fine_lookup else "DB not found"
    rules_count  = len(rules_loader.rules)  if rules_loader else 0
    agent_mode = "keyword-fallback"
    if agent.ollama_available:
        agent_mode = f"ollama/{agent.ollama_model}"
    elif agent.gemini_available:
        agent_mode = "gemini-2.0-flash"
    return {
        "status":        "ok",
        "agent_mode":    agent_mode,
        "db_age":        db_age,
        "rules_count":   rules_count,
        "chat_handler":  "v3-memory",
    }


# ── Sync router (for mobile offline sync) --------------------------------------
app.include_router(sync_router)

# ── Auth router (for user authentication) -------------------------------------
app.include_router(auth_router)

@app.get("/api/signs")
def get_traffic_signs():
    """Returns a list of traffic signs with an image URL for each."""
    import csv
    signs = []
    csv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "Indian-Traffic Sign-Dataset", "traffic_sign.csv")
    
    if not os.path.exists(csv_path):
        return {"status": "error", "message": "Dataset not found"}
        
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                class_id = row.get("ClassId", "")
                name = row.get("Name", "")
                
                # Find the first image in the class directory
                class_dir = os.path.join(SIGNS_IMAGES_DIR, class_id)
                image_url = None
                if os.path.exists(class_dir):
                    images = [f for f in os.listdir(class_dir) if f.endswith('.png') or f.endswith('.jpg')]
                    if images:
                        image_url = f"/api/signs/images/{class_id}/{images[0]}"
                
                signs.append({
                    "id": class_id,
                    "name": name,
                    "image_url": image_url
                })
        return {"status": "ok", "signs": signs}
    except Exception as e:
        return {"status": "error", "message": str(e)}




if __name__ == "__main__":
    from multiprocessing import freeze_support
    freeze_support()
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    if IS_PRODUCTION:
        uvicorn.run("backend.main:app", host="127.0.0.1", port=port, reload=False, workers=2)
    else:
        uvicorn.run("backend.main:app", host="0.0.0.0", port=port, reload=True)
