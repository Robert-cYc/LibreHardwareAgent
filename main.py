import asyncio
import json
import time
import httpx
import re
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import database
import ai_agent

app = FastAPI(title="Hardware Monitor API")

app.mount("/static", StaticFiles(directory="static"), name="static")

active_connections = []

@app.on_event("startup")
async def startup_event():
    database.init_db()
    asyncio.create_task(data_logger_task())
    asyncio.create_task(ws_broadcaster())
    asyncio.create_task(db_cleanup_task())

async def db_cleanup_task():
    """Periodically delete data older than 24 hours to prevent DB bloating."""
    while True:
        try:
            with database.get_db_connection() as conn:
                cursor = conn.cursor()
                cutoff = time.time() - (24 * 60 * 60)
                cursor.execute("DELETE FROM sensor_data WHERE timestamp < ?", (cutoff,))
                conn.commit()
        except Exception as e:
            pass
        await asyncio.sleep(3600)

async def data_logger_task():
    """Background task to fetch data from LHM every 5 seconds."""
    async with httpx.AsyncClient() as client:
        while True:
            try:
                # Default LHM port is 8085
                response = await client.get("http://localhost:8085/data.json", timeout=2.0)
                if response.status_code == 200:
                    data = response.json()
                    records = []
                    current_ts = time.time()
                    parse_lhm_data(data, records, current_ts)
                    if records:
                        database.insert_sensor_data(records)
            except Exception as e:
                # Silently ignore errors (e.g. if LHM is not running)
                pass
            await asyncio.sleep(2)

def parse_lhm_data(node, records, current_timestamp, path=""):
    """Recursively parse LHM JSON to extract sensor values."""
    node_text = str(node.get('Text', 'unknown'))
    
    # LHM has SensorId for actual leaf sensors, fallback to 'id' if not found
    node_id = str(node.get('SensorId', node.get('id', str(path) + '/' + node_text)))
    val_str = str(node.get('Value', ''))
    
    if val_str and any(char.isdigit() for char in val_str):
        try:
            match = re.search(r"[-+]?\d*\.\d+|\d+", val_str.replace(',', '.'))
            if match:
                val = float(match.group())
                records.append((
                    current_timestamp,
                    node_id.lower(),
                    node_text,
                    node.get('Type', ''),
                    val
                ))
        except Exception:
            pass
            
    for child in node.get('Children', []):
        parse_lhm_data(child, records, current_timestamp, node_id)

@app.get("/")
async def get_index():
    return FileResponse("static/index.html")

class ChatRequest(BaseModel):
    message: str

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """Handle chat intent parsing and return the target chart action."""
    intent = ai_agent.parse_intent(request.message)
    if "error" in intent:
        return {"status": "error", "message": intent["error"]}
    
    target = intent.get("target")
    action = intent.get("action")
    timeframe = intent.get("timeframe", 15)
    
    if action == "answer":
        return {
            "status": "answer",
            "message": intent.get("message", "抱歉，我無法回答這個問題。")
        }
        
    if action == "set_alert":
        identifier = find_identifier_for_target(target)
        threshold = intent.get("threshold", 0)
        if identifier and threshold:
            custom_alert_thresholds[identifier] = float(threshold)
            return {"status": "success", "message": f"好的，我已經幫您將該感測器的警報閾值設定為 {threshold}。"}
        return {"status": "error", "message": "找不到指定的硬體感測器，無法設定警報。"}
        
    if action == "analyze":
        metric = intent.get("metric", "avg")
        timeframe = int(intent.get("timeframe", 60))
        identifier = find_identifier_for_target(target)
        
        if identifier:
            cutoff = time.time() - (timeframe * 60)
            with database.get_db_connection() as conn:
                c = conn.cursor()
                if metric == "max":
                    c.execute("SELECT MAX(value) FROM sensor_data WHERE identifier=? AND timestamp>?", (identifier, cutoff))
                elif metric == "min":
                    c.execute("SELECT MIN(value) FROM sensor_data WHERE identifier=? AND timestamp>?", (identifier, cutoff))
                else:
                    c.execute("SELECT AVG(value) FROM sensor_data WHERE identifier=? AND timestamp>?", (identifier, cutoff))
                
                val = c.fetchone()[0]
                if val is not None:
                    metric_tw = {"max": "最高", "min": "最低", "avg": "平均"}.get(metric, metric)
                    return {"status": "answer", "message": f"根據歷史資料庫紀錄，目標感測器在過去 {timeframe} 分鐘內的 **{metric_tw}值**為 **{val:.2f}**。"}
                return {"status": "answer", "message": f"過去 {timeframe} 分鐘內沒有找到任何相關的數據。"}
        return {"status": "error", "message": "找不到指定的硬體感測器，無法進行分析。"}
    
    identifier = None
    if action == "add":
        identifier = find_identifier_for_target(target)
        if not identifier:
             return {"status": "error", "message": f"資料庫中尚未收集到符合 {target} 的硬體感測器資料。請確認 LHM 是否有開啟相關監控。"}
    
    return {
        "status": "success",
        "action": action,
        "target": target,
        "identifier": identifier,
        "timeframe": timeframe
    }

def find_identifier_for_target(target: str):
    """Map logical AI target to actual database identifier using wildcards."""
    mapping = {
        "cpu_load": "%cpu%/load%",
        "cpu_temp": "%cpu%/temperature%",
        "gpu_load": "%gpu%/load%",
        "gpu_temp": "%gpu%/temperature%",
        "ram_used": "%ram%/load%",
        "cpu_voltage": "%cpu%/voltage%",
        "cpu_power": "%cpu%/power%",
        "gpu_power": "%gpu%/power%",
        "fan_speed": "%fan%"
    }
    
    # Use mapping if exists, else try to create a pattern from target (e.g. cpu_clock -> %cpu%/clock%)
    pattern = mapping.get(target)
    if not pattern:
        parts = target.split('_')
        pattern = "%" + "%/".join(parts) + "%"
    
    with database.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT identifier FROM sensor_data WHERE identifier LIKE ? COLLATE NOCASE LIMIT 1", (pattern,))
        row = cursor.fetchone()
        
        # Fallback: try searching the name column if identifier matching fails
        if not row:
            name_pattern = "%" + target.replace("_", " ") + "%"
            cursor.execute("SELECT identifier FROM sensor_data WHERE name LIKE ? COLLATE NOCASE LIMIT 1", (name_pattern,))
            row = cursor.fetchone()
            
        return row[0] if row else None

@app.get("/api/sensors")
async def get_sensors():
    """Fetch all unique sensors collected in the database."""
    with database.get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT identifier, name, sensor_type FROM sensor_data GROUP BY identifier ORDER BY sensor_type, name")
        sensors = []
        
        type_translation = {
            "Load": "負載/使用率",
            "Temperature": "溫度",
            "Clock": "時脈",
            "Voltage": "電壓",
            "Power": "功耗",
            "Fan": "風扇轉速",
            "Control": "控制",
            "Data": "數據容量",
            "SmallData": "數據",
            "Throughput": "傳輸速率"
        }
        
        for row in cursor.fetchall():
            ident, name, s_type = row[0], row[1], row[2]
            zh_type = type_translation.get(s_type, "")
            
            if s_type and zh_type:
                title = f"{s_type} ({zh_type}) - {name}"
            elif s_type:
                title = f"{s_type} - {name}"
            else:
                title = name
                
            sensors.append({"identifier": ident, "title": title})
        return sensors

@app.get("/api/history")
async def get_history(identifier: str, minutes: int = 15):
    """Fetch historical data for a specific identifier."""
    data = database.get_historical_data(identifier, minutes)
    return {
        "identifier": identifier, 
        "data": [{"timestamp": r[0]*1000, "value": r[1]} for r in data]
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    
    model_name = ai_agent.os.environ.get("ANTHROPIC_MODEL", "poolside/laguna-s-2.1:free")
    await websocket.send_text(json.dumps({"type": "welcome", "model": model_name}))
    
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_connections.remove(websocket)

last_alert_time = {}
custom_alert_thresholds = {}

async def broadcast_alert(msg):
    message = json.dumps({"type": "alert", "message": msg})
    for conn_ws in list(active_connections):
        try:
            await conn_ws.send_text(message)
        except Exception:
            pass

async def ws_broadcaster():
    """Broadcasts the latest database entries to all connected WebSockets and checks for alerts."""
    global last_alert_time, custom_alert_thresholds
    while True:
        await asyncio.sleep(2)
        if not active_connections:
            continue
            
        with database.get_db_connection() as conn:
            cursor = conn.cursor()
            # Get the most recent timestamp
            cursor.execute("SELECT timestamp FROM sensor_data ORDER BY timestamp DESC LIMIT 1")
            row = cursor.fetchone()
            if not row:
                continue
            latest_ts = row[0]
            
            # Fetch all records at this timestamp
            cursor.execute("SELECT identifier, name, value FROM sensor_data WHERE timestamp = ?", (latest_ts,))
            latest_data = {}
            for r in cursor.fetchall():
                ident, name, val = r[0], r[1], r[2]
                latest_data[ident] = {"timestamp": latest_ts*1000, "value": val}
                
                # Smart Alerts Logic
                current_time = time.time()
                if current_time - last_alert_time.get(ident, 0) > 60: # 60s cooldown per sensor
                    # Check custom threshold first, then fallback to defaults
                    threshold = custom_alert_thresholds.get(ident)
                    if threshold is not None:
                        if val >= threshold:
                            msg = f"⚠️ 自訂警報：{name} 已達到 {val} (設定值: {threshold})！"
                            asyncio.create_task(broadcast_alert(msg))
                            last_alert_time[ident] = current_time
                    else:
                        if 'temperature' in ident and val >= 85:
                            msg = f"⚠️ 警告：{name} 溫度過高 ({val}°C)，請注意散熱！"
                            asyncio.create_task(broadcast_alert(msg))
                            last_alert_time[ident] = current_time
                        elif 'load' in ident and val >= 95:
                            msg = f"⚡ 提醒：{name} 負載已達 {val}%！"
                            asyncio.create_task(broadcast_alert(msg))
                            last_alert_time[ident] = current_time
            
            message = json.dumps({"type": "update", "data": latest_data})
            
            # Broadcast to active connections
            for conn_ws in list(active_connections):
                try:
                    await conn_ws.send_text(message)
                except Exception:
                    active_connections.remove(conn_ws)
