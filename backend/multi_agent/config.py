import os
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

class Config(BaseModel):
    DEEPSEEK_API_KEY: str = os.getenv("DEEPSEEK_API_KEY", "your-deepseek-api-key")
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com"
    JUDGE_MODEL: str = "deepseek-chat"
    SYNTHESIZER_MODEL: str = "deepseek-chat"
    
    OLLAMA_BASE_URL: str = "http://localhost:11434/v1"
    OLLAMA_MODEL: str = "gemma4:31b-cloud"
    
    MAX_SEARCH_RESULTS: int = 3
    MAX_ITERATIONS: int = 3

config = Config()
