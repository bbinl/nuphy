import os
import sys
import re
import json
import asyncio
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.responses import StreamingResponse, HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from telethon import TelegramClient

# Ensure root directory in sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from api.index import handle_auth_request

# Windows UTF-8 encoding
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# App Credentials (my.telegram.org Developer App ID)
API_ID = 38759720
API_HASH = "24edc166c16cd98638811b9344502b95"

# -------------------------------------------------------------
# 🤖 PURE TELEGRAM BOT CONFIGURATION (NO USER ACCOUNT NEEDED)
# -------------------------------------------------------------
BOT_TOKEN = os.getenv("BOT_TOKEN", "8214985015:AAHnBhdDmirrb6-5VXiWCmjxPCJuyIAVXsg") 
SESSION_NAME = os.path.join(BASE_DIR, "pure_bot_session")

client: Optional[TelegramClient] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    print("🔌 Connecting Pure Telegram Bot Client...")
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    
    if BOT_TOKEN and not BOT_TOKEN.startswith("7123456789"):
        print("🤖 Starting with Pure BOT TOKEN Authentication...")
        await client.start(bot_token=BOT_TOKEN)
        print("✅ Telegram Bot connected successfully (Zero User Account).")
    else:
        print("⚠️ BOT_TOKEN not set! Connecting session fallback...")
        await client.connect()
        print("✅ Client connected successfully.")

    yield
    if client:
        await client.disconnect()
        print("🔌 Telegram Client disconnected.")

app = FastAPI(title="Physics Study BD Streamer & Auth Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def parse_tg_url(url: str):
    url = url.strip()
    match = re.search(r'(?:t\.me/|telegram\.me/)?(?:c/)?([^/]+)/(\d+)', url)
    if match:
        channel_str, msg_id = match.group(1), int(match.group(2))
        if channel_str.isdigit():
            chat_id = int(f"-100{channel_str}")
        else:
            chat_id = channel_str
        return chat_id, msg_id
    raise ValueError("Invalid Telegram URL format")


# -------------------------------------------------------------
# 🔐 AUTH & USER SESSION ENDPOINTS
# -------------------------------------------------------------
@app.post("/api/auth")
@app.post("/api/auth/{action}")
async def auth_endpoint(request: Request, action: Optional[str] = None):
    """Handles register, login, verify-session, admin actions via Supabase RPC."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    path = request.url.path
    if action and "action" not in body:
        body["action"] = action
    status_code, result = handle_auth_request(path, body)
    return JSONResponse(content=result, status_code=status_code)


# -------------------------------------------------------------
# 🎥 VIDEO INFO & STREAMING ENDPOINTS
# -------------------------------------------------------------
@app.get("/api/info")
async def get_video_info(url: str = Query("https://t.me/nocodx/159")):
    global client
    if not client or not client.is_connected():
        raise HTTPException(status_code=500, detail="Telegram client not connected")

    try:
        chat_id, msg_id = parse_tg_url(url)
        msg = await client.get_messages(chat_id, ids=msg_id)
        if not msg or not msg.media or not hasattr(msg.media, 'document'):
            raise HTTPException(status_code=404, detail="No video/media found in this post")

        doc = msg.media.document
        filename = getattr(msg.file, 'name', f"video_{msg_id}.mp4") or f"video_{msg_id}.mp4"
        mime_type = getattr(msg.file, 'mime_type', 'video/mp4') or 'video/mp4'
        file_size = doc.size

        caption = msg.text or ""
        title = caption.split('\n')[0] if caption else filename

        return {
            "success": True,
            "url": url,
            "title": title,
            "caption": caption,
            "filename": filename,
            "mime_type": mime_type,
            "file_size": file_size,
            "formatted_size": f"{file_size / (1024*1024):.2f} MB",
            "mode": "Pure Telegram Bot Mode"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/stream")
async def stream_video(request: Request, url: str = Query("https://t.me/nocodx/159")):
    global client
    if not client or not client.is_connected():
        raise HTTPException(status_code=500, detail="Telegram client not connected")

    try:
        chat_id, msg_id = parse_tg_url(url)
        msg = await client.get_messages(chat_id, ids=msg_id)
        if not msg or not msg.media or not hasattr(msg.media, 'document'):
            raise HTTPException(status_code=404, detail="No video media found")

        doc = msg.media.document
        file_size = getattr(doc, 'size', 0)
        mime_type = getattr(msg.file, 'mime_type', 'video/mp4') or 'video/mp4'

        range_header = request.headers.get("range")
        start = 0
        end = file_size - 1

        if range_header:
            range_str = range_header.replace("bytes=", "").strip()
            parts = range_str.split("-")
            if parts[0]:
                start = int(parts[0])
            if len(parts) > 1 and parts[1]:
                end = int(parts[1])

        start = max(0, min(start, file_size - 1))
        end = max(start, min(end, file_size - 1))
        content_length = end - start + 1

        async def memory_chunk_generator(offset_start: int, total_to_read: int):
            bytes_read = 0
            chunk_request_size = 512 * 1024  # 512KB per RAM chunk
            
            async for chunk in client.iter_download(doc, offset=offset_start, request_size=chunk_request_size):
                if bytes_read >= total_to_read:
                    break
                needed = total_to_read - bytes_read
                if len(chunk) > needed:
                    yield chunk[:needed]
                    bytes_read += needed
                    break
                else:
                    yield chunk
                    bytes_read += len(chunk)

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
            "Content-Type": mime_type,
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        }
        status_code = 206 if range_header else 200
        return StreamingResponse(
            memory_chunk_generator(start, content_length),
            status_code=status_code,
            headers=headers,
            media_type=mime_type
        )

    except Exception as e:
        print(f"Error streaming video: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# -------------------------------------------------------------
# 📂 COURSE & LECTURE JSON BACKUP & AUTO-SAVE ENDPOINTS
# -------------------------------------------------------------
TG_JSON_FILE = os.path.join(BASE_DIR, "telegram_courses.json")
AUTO_JS_FILE = os.path.join(BASE_DIR, "courses_telegram_auto.js")

def normalize_node(node):
    if isinstance(node, list):
        out = []
        for item in node:
            if isinstance(item, dict):
                out.append({
                    'lecture': item.get('lecture', ''),
                    'url': item.get('url', ''),
                    'tg_url': item.get('tg_url', '')
                })
        return out
    elif isinstance(node, dict):
        out = {}
        for k, v in node.items():
            out[k] = normalize_node(v)
        return out
    return node

def get_initial_courses_from_auto_js():
    if not os.path.exists(AUTO_JS_FILE):
        return []
    with open(AUTO_JS_FILE, "r", encoding="utf-8") as f:
        text = f.read()
    start = text.find('[')
    end = text.rfind(']') + 1
    if start == -1 or end == 0:
        return []
    try:
        raw_courses = json.loads(text[start:end])
        return raw_courses
    except Exception:
        return []


@app.get("/api/courses")
async def get_courses():
    """Returns the full courses JSON structure."""
    if os.path.exists(TG_JSON_FILE):
        try:
            with open(TG_JSON_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading {TG_JSON_FILE}: {e}")
    
    courses = get_initial_courses_from_auto_js()
    if courses:
        with open(TG_JSON_FILE, "w", encoding="utf-8") as f:
            json.dump(courses, f, ensure_ascii=False, indent=2)
    return courses


@app.post("/api/courses")
async def save_courses(request: Request):
    """Saves the entire courses JSON structure."""
    try:
        data = await request.json()
        if not isinstance(data, list):
            raise HTTPException(status_code=400, detail="Expected a JSON array of courses")
        with open(TG_JSON_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return {"success": True, "message": "Saved successfully", "count": len(data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# -------------------------------------------------------------
# 🌐 STATIC FILES SERVING (UI & BUNDLES)
# -------------------------------------------------------------
@app.get("/")
async def get_index():
    index_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>Physics Study BD Streaming Server is Running</h1>")

# Mount workspace root for static assets (app.js, style.css, core.bundle.e3b1c9.js, runtime.chunk.08a7f4.js)
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static_root")


if __name__ == "__main__":
    import uvicorn
    print("🚀 Starting Physics Study BD Streamer & Auth Server on http://127.0.0.1:8000 ...")
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
