import os
import sys
import json
import hashlib
import re
from http.server import BaseHTTPRequestHandler
import requests

# ----------------------------------------------------
# SUPABASE SECURE BACKEND CONFIGURATION
# ----------------------------------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://qdcffakrgqwcutvrxduz.supabase.co")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkY2ZmYWtyZ3F3Y3V0dnJ4ZHV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4OTYzNDUsImV4cCI6MjEwMzQ3MjM0NX0._IVl3F2i1TlSnLD6H7JqvVCgoTIy7jQaIdHIB_vAQLY")

def clean_phone(raw: str) -> str:
    if not raw:
        return ""
    digits = re.sub(r'[^0-9]', '', str(raw))
    if digits.startswith('880'):
        digits = digits[2:]
    elif digits.startswith('88') and len(digits) == 13:
        digits = digits[2:]
    elif len(digits) == 10 and digits.startswith('1'):
        digits = '0' + digits
    return digits

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

def call_supabase_rpc(function_name: str, params: dict):
    endpoint = f"{SUPABASE_URL}/rest/v1/rpc/{function_name}"
    headers = {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}"
    }
    try:
        response = requests.post(endpoint, headers=headers, json=params, timeout=15)
        try:
            return response.status_code, response.json()
        except Exception:
            return response.status_code, {"success": False, "message": response.text}
    except requests.exceptions.Timeout:
        return 504, {"success": False, "error_type": "TIMEOUT", "message": "সার্ভার সংযোগে অতিরিক্ত সময় লাগছে (Gateway Timeout)।"}
    except Exception as e:
        return 500, {"success": False, "error_type": "NETWORK_ERROR", "message": f"সার্ভার সংযোগে সমস্যা: {str(e)}"}

def handle_auth_request(path: str, body: dict):
    clean_path = path.split('?')[0].lower().rstrip('/')
    # action from body payload is the single source of truth (client always sends it)
    action = body.get("action", "").strip()
    # fallback: derive from URL path if payload action missing
    if not action:
        action = clean_path.split('/')[-1]

    # 1. REGISTER
    if action == "register":
        full_name = body.get("fullName", "").strip()
        phone = clean_phone(body.get("phone", ""))
        password = body.get("password", "")

        if len(phone) != 11 or not phone.startswith("01"):
            return 400, {"success": False, "message": "অনুগ্রহ করে সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 01XXXXXXXXX)"}
        if not password or len(password) < 6:
            return 400, {"success": False, "message": "পাসওয়ার্ড ন্যূনতম ৬ অক্ষরের হতে হবে।"}
        if not full_name:
            return 400, {"success": False, "message": "অনুগ্রহ করে আপনার পুরো নাম লিখুন।"}

        pwd_hash = hash_password(password)
        status_code, res = call_supabase_rpc("register_portal_user", {
            "p_phone": phone,
            "p_full_name": full_name,
            "p_password_hash": pwd_hash
        })
        return status_code, res

    # 2. LOGIN
    elif action == "login":
        phone = clean_phone(body.get("phone", ""))
        password = body.get("password", "")

        if len(phone) != 11 or not phone.startswith("01"):
            return 400, {"success": False, "message": "অনুগ্রহ করে সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 01XXXXXXXXX)"}
        if not password:
            return 400, {"success": False, "message": "পাসওয়ার্ড দিন।"}

        pwd_hash = hash_password(password)
        status_code, res = call_supabase_rpc("login_portal_user", {
            "p_phone": phone,
            "p_password_hash": pwd_hash
        })
        return status_code, res

    # 3. VERIFY SESSION
    elif action == "verify-session":
        phone = clean_phone(body.get("phone", ""))
        session_token = body.get("sessionToken", "")

        if not phone or not session_token:
            return 400, {"success": False, "valid": False, "message": "Invalid session data"}

        status_code, res = call_supabase_rpc("verify_user_session", {
            "p_phone": phone,
            "p_session_token": session_token
        })
        return status_code, res

    # 4. ADMIN GET USERS
    elif action == "admin-get-users":
        admin_phone = clean_phone(body.get("adminPhone", ""))
        session_token = body.get("sessionToken", "")

        if not admin_phone or not session_token:
            return 403, {"success": False, "message": "Invalid admin credentials"}

        status_code, res = call_supabase_rpc("admin_get_users", {
            "p_admin_phone": admin_phone,
            "p_session_token": session_token
        })
        return status_code, res

    # 5. ADMIN UPDATE USER
    elif action == "admin-update-user":
        admin_phone = clean_phone(body.get("adminPhone", ""))
        session_token = body.get("sessionToken", "")
        target_id = body.get("targetId", "")
        is_active = bool(body.get("isActive", False))
        is_admin = bool(body.get("isAdmin", False))
        is_locked = bool(body.get("isLocked", False))
        reset_device = bool(body.get("resetDevice", False))

        if not admin_phone or not session_token or not target_id:
            return 403, {"success": False, "message": "Invalid admin credentials or target"}

        status_code, res = call_supabase_rpc("admin_update_user", {
            "p_admin_phone": admin_phone,
            "p_session_token": session_token,
            "p_target_id": target_id,
            "p_is_active": is_active,
            "p_is_admin": is_admin,
            "p_is_locked": is_locked,
            "p_reset_device": reset_device
        })
        return status_code, res

    # 6. ADMIN DELETE USER
    elif action == "admin-delete-user":
        admin_phone = clean_phone(body.get("adminPhone", ""))
        session_token = body.get("sessionToken", "")
        target_id = body.get("targetId", "")

        if not admin_phone or not session_token or not target_id:
            return 403, {"success": False, "message": "Invalid admin credentials or target"}

        status_code, res = call_supabase_rpc("admin_delete_user", {
            "p_admin_phone": admin_phone,
            "p_session_token": session_token,
            "p_target_id": target_id
        })
        return status_code, res

    return 404, {"success": False, "message": f"Unknown API action: '{action}'"}


# Vercel Serverless Handler
class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8')
        try:
            body = json.loads(post_data) if post_data else {}
        except Exception:
            body = {}

        status_code, result = handle_auth_request(self.path, body)

        self.send_response(status_code if status_code in [200, 400, 401, 403, 404, 500] else 200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode('utf-8'))

    def do_GET(self):
        clean_path = self.path.split('?')[0].lstrip('/')
        if not clean_path:
            clean_path = 'index.html'

        # Look for static file in project root
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        file_path = os.path.join(base_dir, clean_path)

        # Only allow safe frontend static assets (strictly block .py, .sql, .env, api/ files)
        ALLOWED_EXTENSIONS = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.woff2': 'font/woff2'
        }

        # Block any access to api/ directory or hidden/sensitive files
        if clean_path.startswith('api/') or clean_path.startswith('.'):
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Not Found"}).encode('utf-8'))
            return

        ext = os.path.splitext(clean_path)[1].lower()
        if ext in ALLOWED_EXTENSIONS and os.path.isfile(file_path):
            mime = ALLOWED_EXTENSIONS[ext]
            try:
                with open(file_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception:
                pass

        # Fallback API status
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({"status": "Physics Study BD Python API Running"}).encode('utf-8'))


def run(port=8000):
    from http.server import HTTPServer
    server_address = ('', port)
    httpd = HTTPServer(server_address, handler)
    print(f"Physics Study BD Python API Server running on http://localhost:{port} or http://192.168.1.107:8000")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Python server...")
        httpd.server_close()

if __name__ == '__main__':
    run()
