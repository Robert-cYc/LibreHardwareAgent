import os
import json
import subprocess
import threading
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

SYSTEM_INFO_CACHE = "正在背景載入系統資訊..."

def load_system_info():
    global SYSTEM_INFO_CACHE
    try:
        output = subprocess.check_output("systeminfo", shell=True)
        try:
            SYSTEM_INFO_CACHE = output.decode("cp950")
        except:
            SYSTEM_INFO_CACHE = output.decode("utf-8", errors="ignore")
    except Exception as e:
        SYSTEM_INFO_CACHE = f"無法載入系統資訊: {e}"

threading.Thread(target=load_system_info, daemon=True).start()

import httpx

def parse_intent(user_input: str) -> dict:
    """
    Parses user input to either add/remove charts or answer general system questions.
    """
    api_key = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://openrouter.ai/api")
    
    if "openrouter.ai" in base_url and not base_url.endswith("/v1"):
        base_url += "/v1"
        
    if not api_key:
        return {"error": "未設定 API Key (ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY)。請確認環境變數。"}

    system_instruction = f"""
    You are an AI assistant for a hardware monitoring dashboard.
    
    Scenario 1: User wants to control the dashboard (e.g. add or remove charts).
    Return a JSON with this exact structure:
    {{
        "action": "add" | "remove",
        "target": "target_identifier",
        "timeframe": 15
    }}
    Valid target_identifier options include: "cpu_load", "cpu_temp", "gpu_load", "gpu_temp", "ram_used", "cpu_voltage", "cpu_power", "gpu_power", "fan_speed". Or infer a logical string.

    Scenario 2: User asks a general question about their system specs or status (e.g. boot time, OS version, RAM amount).
    Use the provided `systeminfo` data below to answer.
    Return a JSON with this exact structure:
    {{
        "action": "answer",
        "message": "Your direct, natural language answer in Traditional Chinese."
    }}
    
    Scenario 3: User wants to set a custom alert threshold (e.g. "如果 GPU 溫度超過 75 度請警告我").
    Return a JSON with this exact structure:
    {{
        "action": "set_alert",
        "target": "target_identifier",
        "threshold": 75
    }}
    
    --- SYSTEMINFO DATA ---
    {SYSTEM_INFO_CACHE}
    -----------------------

    Return ONLY valid JSON. No markdown backticks or explanations.
    """
    
    from tenacity import retry, wait_exponential, stop_after_attempt, retry_if_exception_type

    @retry(
        wait=wait_exponential(multiplier=1, min=2, max=10),
        stop=stop_after_attempt(3),
        retry=retry_if_exception_type(Exception),
        reraise=True
    )
    def fetch_intent():
        model_name = os.environ.get("ANTHROPIC_MODEL", "poolside/laguna-s-2.1:free")
        url = f"{base_url}/chat/completions" if "openrouter.ai" in base_url else "https://openrouter.ai/api/v1/chat/completions"
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": user_input}
            ]
        }
        
        # httpx is already in requirements.txt
        with httpx.Client() as client:
            response = client.post(url, headers=headers, json=payload, timeout=30.0)
            response.raise_for_status()
            return response.json()
        
    try:
        response_data = fetch_intent()
        # OpenRouter returns OpenAI compatible JSON
        text_response = response_data['choices'][0]['message']['content'].strip()
        
        # Clean up potential markdown formatting
        if text_response.startswith("```json"):
            text_response = text_response[7:]
        elif text_response.startswith("```"):
            text_response = text_response[3:]
            
        if text_response.endswith("```"):
            text_response = text_response[:-3]
            
        return json.loads(text_response.strip())
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            return {"error": "AI 解析錯誤: 您選擇的免費模型 (Free Model) 目前請求次數已達上限 (429 Too Many Requests)。建議稍後再試，或在 .env 檔案更換為其他免費模型（例如 meta-llama/llama-3.1-8b-instruct:free）。"}
        return {"error": f"AI 網路錯誤: {e.response.status_code} - {e.response.text}"}
    except Exception as e:
        return {"error": f"AI 解析錯誤: {str(e)}"}
