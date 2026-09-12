// ========================================================
// PHYSICS STUDY BD - AUTH & SINGLE SESSION CLIENT (SOURCE)
// All authentication, hashing, permissions & DB calls are handled
// securely via Python Backend API (/api/auth)
// ========================================================

const BACKEND_API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? (window.location.port === '3000' || window.location.port === '8080' ? 'http://localhost:8000/api/auth' : '/api/auth')
  : '/api/auth';

class AuthEngine {
  constructor() {
    this.currentUser = null;
    try {
      const cached = localStorage.getItem('psbd_user_session');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.phone && parsed.session_token) {
          this.currentUser = {
            phone: parsed.phone,
            full_name: parsed.full_name,
            is_admin: parsed.is_admin === true,
            is_active: true,
            is_locked: false,
            session_token: parsed.session_token
          };
        }
      }
    } catch (e) {}
    this.listeners = [];
    this.heartbeatTimer = null;
    this.isCheckingSession = false;
    this.init();
  }

  async init() {
    // 1. Setup Visibility and Focus Listeners for Realtime Sync
    this.setupVisibilityListeners();

    // 2. Restore active session
    await this.restoreSession();
  }

  // ========================================================
  // 1. SECURE BACKEND API CALLS (WITH TIMEOUT TOLERANCE)
  // ========================================================
  async callBackendApi(endpoint, payload = {}) {
    const targetUrl = `${BACKEND_API_BASE}/${endpoint}`;
    payload.action = endpoint;
    let response;

    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (netErr) {
      const err = new Error('ইন্টারনেট সংযোগ পাওয়া যাচ্ছে না। সংযোগ চেক করুন।');
      err.isNetworkError = true;
      throw err;
    }

    if (!response.ok) {
      if (response.status === 504 || response.status === 502) {
        const err = new Error('সার্ভার সংযোগে সাময়িক বিলম্ব হচ্ছে (Gateway Timeout)।');
        err.isGatewayTimeout = true;
        throw err;
      }
    }

    let data;
    try {
      data = await response.json();
    } catch (e) {
      const err = new Error(`সার্ভার সংযোগে ত্রুটি (${response.status})`);
      err.isServerError = true;
      throw err;
    }

    return data;
  }

  // ========================================================
  // 2. AUTHENTICATION ACTIONS (PURE DYNAMIC SESSION)
  // ========================================================
  async register({ fullName, phone, password }) {
    const result = await this.callBackendApi('register', {
      fullName: fullName.trim(),
      phone: phone.trim(),
      password: password
    });

    if (!result.success) {
      throw new Error(result.message || 'রেজিস্ট্রেশন সম্পন্ন করা যায়নি।');
    }

    return result;
  }

  async login({ phone, password }) {
    const result = await this.callBackendApi('login', {
      phone: phone.trim(),
      password: password
    });

    if (!result.success) {
      const error = new Error(result.message || 'লগইন ব্যর্থ হয়েছে।');
      error.code = result.code;
      error.isActive = result.is_active;
      throw error;
    }

    // Save session locally
    this.currentUser = result.user;
    localStorage.setItem('psbd_user_session', JSON.stringify({
      phone: result.user.phone,
      full_name: result.user.full_name,
      is_admin: result.user.is_admin,
      session_token: result.user.session_token,
      logged_at: Date.now()
    }));

    this.startSessionHeartbeat();
    this.notifyStateChange(this.currentUser);
    return result;
  }

  async restoreSession() {
    try {
      const sessionRaw = localStorage.getItem('psbd_user_session');
      if (!sessionRaw) return null;

      const session = JSON.parse(sessionRaw);
      if (!session.phone || !session.session_token) return null;

      // Optimistically restore cached session immediately so UI is responsive
      this.currentUser = {
        phone: session.phone,
        full_name: session.full_name || '',
        is_admin: session.is_admin === true,
        is_active: true,
        is_locked: false,
        session_token: session.session_token
      };
      this.notifyStateChange(this.currentUser);
      this.startSessionHeartbeat();

      // Verify in background with Supabase / Backend API
      try {
        const verifyResult = await this.callBackendApi('verify-session', {
          phone: session.phone,
          sessionToken: session.session_token
        });

        if (verifyResult && verifyResult.valid && verifyResult.user) {
          this.currentUser = {
            ...verifyResult.user,
            session_token: session.session_token
          };
          this.notifyStateChange(this.currentUser);
          return this.currentUser;
        } else if (verifyResult && verifyResult.valid === false) {
          // Explicit revocation by DB
          if (verifyResult.code === 'SESSION_REVOKED' || verifyResult.code === 'ACCOUNT_LOCKED' || verifyResult.code === 'ACCOUNT_DEACTIVATED') {
            console.warn("Session revoked by server:", verifyResult.message);
            this.handleRevokedSession(verifyResult.message || 'অন্য ডিভাইসে লগইন করা হয়েছে। আপনার এই ডিভাইসটি স্বয়ংক্রিয়ভাবে লগআউট করা হয়েছে।');
            return null;
          }
        }
      } catch (verifyErr) {
        // Transient network error or Gateway timeout should NOT force logout on page load/refresh
        console.warn("Session background verification warning (ignored transient issue):", verifyErr);
        return this.currentUser;
      }

      return this.currentUser;
    } catch (e) {
      console.warn("Could not restore session:", e);
      return null;
    }
  }

  startSessionHeartbeat() {
    this.stopSessionHeartbeat();
    // Verify session every 30 seconds to prevent serverless timeout overload
    this.heartbeatTimer = setInterval(() => {
      this.checkActiveSession();
    }, 30000);
  }

  stopSessionHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async checkActiveSession() {
    if (!this.currentUser || !this.currentUser.phone || !this.currentUser.session_token) {
      this.stopSessionHeartbeat();
      return;
    }
    if (this.isCheckingSession) return;
    this.isCheckingSession = true;

    try {
      const res = await this.callBackendApi('verify-session', {
        phone: this.currentUser.phone,
        sessionToken: this.currentUser.session_token
      });

      // ONLY revoke if server explicitly returns valid === false with explicit revoke code
      if (res && res.valid === false) {
        if (res.code === 'SESSION_REVOKED' || res.code === 'ACCOUNT_LOCKED' || res.code === 'ACCOUNT_DEACTIVATED') {
          console.warn("Session revoked by server:", res.message);
          const reason = res.message || 'অন্য ডিভাইসে লগইন করা হয়েছে। আপনার এই ডিভাইসটি স্বয়ংক্রিয়ভাবে লগআউট করা হয়েছে।';
          this.handleRevokedSession(reason);
        }
      }
    } catch (err) {
      // Network issues / Gateway timeouts should NOT log out the user
      console.warn("Session heartbeat network check warning (transient):", err.message || err);
    } finally {
      this.isCheckingSession = false;
    }
  }

  handleRevokedSession(reason) {
    this.stopSessionHeartbeat();
    this.logout();

    // Pause video playback if any is currently active
    if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') {
      try { window.ytPlayer.pauseVideo(); } catch (e) {}
    }

    if (typeof window.showAuthAlert === 'function') {
      window.showAuthAlert(`<strong>⚠️ অন্য ডিভাইসে লগইন সনাক্ত হয়েছে!</strong><br>${reason}<br><span style="font-size:12px; opacity:0.85; margin-top:4px; display:inline-block;">একটি একাউন্ট একসাথে একাধিক ডিভাইসে ব্যবহার করা যায় না। পুনরায় ব্যবহারের জন্য আবার লগইন করুন।</span>`, 'warning');
    }
    if (typeof window.showToast === 'function') {
      window.showToast('⚠️ অন্য ডিভাইসে লগইন হওয়ায় এই ডিভাইসটি লগআউট হয়েছে!');
    }
  }

  setupVisibilityListeners() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.currentUser) {
        this.checkActiveSession();
      }
    });

    window.addEventListener('focus', () => {
      if (this.currentUser) {
        this.checkActiveSession();
      }
    });
  }

  logout() {
    this.stopSessionHeartbeat();
    this.currentUser = null;
    localStorage.removeItem('psbd_user_session');
    this.notifyStateChange(null);
  }

  isLoggedIn() {
    return !!this.currentUser && this.currentUser.is_active === true && this.currentUser.is_locked !== true;
  }

  isAdmin() {
    return !!this.currentUser && this.currentUser.is_admin === true;
  }

  isLocked() {
    return !!this.currentUser && this.currentUser.is_locked === true;
  }

  // ========================================================
  // 3. ADMIN PANEL ACTIONS (VERIFIED ON PYTHON SERVER)
  // ========================================================
  async adminGetUsers() {
    if (!this.isAdmin()) throw new Error('অ্যাডমিন অনুমতি নেই');

    const result = await this.callBackendApi('admin-get-users', {
      adminPhone: this.currentUser.phone,
      sessionToken: this.currentUser.session_token
    });

    if (!result.success) {
      throw new Error(result.message || 'ইউজার লিস্ট লোড করা যায়নি');
    }

    return result.users || [];
  }

  async adminUpdateUser(targetId, { isActive, isAdmin, isLocked, resetDevice = false }) {
    if (!this.isAdmin()) throw new Error('অ্যাডমিন অনুমতি নেই');

    const result = await this.callBackendApi('admin-update-user', {
      adminPhone: this.currentUser.phone,
      sessionToken: this.currentUser.session_token,
      targetId: targetId,
      isActive: !!isActive,
      isAdmin: !!isAdmin,
      isLocked: !!isLocked,
      resetDevice: !!resetDevice
    });

    if (!result.success) {
      throw new Error(result.message || 'আপডেট করা সম্ভব হয়নি');
    }

    return result;
  }

  async adminDeleteUser(targetId) {
    if (!this.isAdmin()) throw new Error('অ্যাডমিন অনুমতি নেই');

    const result = await this.callBackendApi('admin-delete-user', {
      adminPhone: this.currentUser.phone,
      sessionToken: this.currentUser.session_token,
      targetId: targetId
    });

    if (!result.success) {
      throw new Error(result.message || 'ডিলিট করা সম্ভব হয়নি');
    }

    return result;
  }

  getCurrentUser() {
    return this.currentUser;
  }

  getDeviceInfo() {
    return {};
  }

  onAuthStateChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
      callback(this.currentUser);
    }
  }

  notifyStateChange(user) {
    this.listeners.forEach(cb => {
      try {
        cb(user);
      } catch (e) {
        console.error("Auth listener error:", e);
      }
    });
  }
}

// Global Auth Singleton Instance
window.authService = new AuthEngine();
