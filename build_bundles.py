import os
import json
import base64
import re

def encrypt_auth():
    if not os.path.exists('auth.src.js'):
        print("[!] auth.src.js not found.")
        return
    with open('auth.src.js', 'r', encoding='utf-8') as f:
        js_code = f.read()

    key = [0x73, 0xA1, 0x4B, 0x92, 0xF5, 0x1E, 0xC8, 0x37, 0x6D, 0x84]
    utf8_bytes = js_code.encode('utf-8')

    encrypted_bytes = bytearray()
    for i, b in enumerate(utf8_bytes):
        encrypted_bytes.append(b ^ key[i % len(key)])

    b64_payload = base64.b64encode(encrypted_bytes).decode('ascii')

    obfuscated_js = f'''/**
 * @license Physics Study BD Core Auth Framework
 * Build: 2026.09.v4.0.min.js [Obfuscated / Production]
 */
!function(){{
  var _0x1a8f = "{b64_payload}";
  var _0x9c3d = [115, 161, 75, 146, 245, 30, 200, 55, 109, 132];
  try {{
    var _0x5b2e = (typeof atob === 'function') ? atob(_0x1a8f) : Buffer.from(_0x1a8f, 'base64').toString('binary');
    var _0x4d1a = new Uint8Array(_0x5b2e.length);
    for (var _0x3e7f = 0; _0x3e7f < _0x5b2e.length; _0x3e7f++) {{
      _0x4d1a[_0x3e7f] = _0x5b2e.charCodeAt(_0x3e7f) ^ _0x9c3d[_0x3e7f % _0x9c3d.length];
    }}
    var _0x8c2b = new TextDecoder('utf-8').decode(_0x4d1a);
    (0, eval)(_0x8c2b);
  }} catch(e) {{
    console.error("Auth Engine Init Error:", e);
  }}
}}();
'''
    with open('core.bundle.e3b1c9.js', 'w', encoding='utf-8') as f:
        f.write(obfuscated_js)
    print("[SUCCESS] Built core.bundle.e3b1c9.js from auth.src.js")


def encrypt_courses():
    if not os.path.exists('courses_telegram_auto.js'):
        print("[!] courses_telegram_auto.js not found.")
        return
    with open('courses_telegram_auto.js', 'r', encoding='utf-8') as f:
        content = f.read()

    idx = content.find('[')
    r_idx = content.rfind(']') + 1
    if idx == -1 or r_idx == 0:
        print("[!] Could not find JSON array in courses_telegram_auto.js")
        return
    json_str = content[idx:r_idx]

    data = json.loads(json_str)
    minified_json = json.dumps(data, ensure_ascii=False, separators=(',', ':'))

    key = [90, 63, 155, 18, 126, 196, 136, 45, 170, 81]
    utf8_bytes = minified_json.encode('utf-8')

    encrypted_bytes = bytearray()
    for i, b in enumerate(utf8_bytes):
        encrypted_bytes.append(b ^ key[i % len(key)])

    b64_payload = base64.b64encode(encrypted_bytes).decode('ascii')

    obfuscated_js = f'''/**
 * @license Production Bundle
 * Hash: 08a7f47e2b19c8d
 * Built with Rollup/Vite Webpack Engine
 */
!function(){{
  var _0x9a2b = "{b64_payload}";
  var _0x5c1d = [90, 63, 155, 18, 126, 196, 136, 45, 170, 81];
  try {{
    var _0x3f8e = (typeof atob === 'function') ? atob(_0x9a2b) : Buffer.from(_0x9a2b, 'base64').toString('binary');
    var _0x7e4a = new Uint8Array(_0x3f8e.length);
    for (var _0x1c9d = 0; _0x1c9d < _0x3f8e.length; _0x1c9d++) {{
      _0x7e4a[_0x1c9d] = _0x3f8e.charCodeAt(_0x1c9d) ^ _0x5c1d[_0x1c9d % _0x5c1d.length];
    }}
    var _0x2b4f = new TextDecoder('utf-8').decode(_0x7e4a);
    window.COURSES_DATA = JSON.parse(_0x2b4f);
    window.AUTO_COURSES_DATA = window.COURSES_DATA;
  }} catch(e) {{
    console.error("Runtime Chunk Error:", e);
  }}
}}();
'''
    with open('runtime.chunk.08a7f4.js', 'w', encoding='utf-8') as f:
        f.write(obfuscated_js)
    print("[SUCCESS] Built runtime.chunk.08a7f4.js from courses_telegram_auto.js")


if __name__ == '__main__':
    print("Building encrypted bundles...")
    encrypt_auth()
    encrypt_courses()
    print("Done!")
