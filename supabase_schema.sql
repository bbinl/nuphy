-- ========================================================
-- PHYSICS STUDY BD - SUPABASE AUTH & SINGLE SESSION SCHEMA
-- (PURE DYNAMIC SESSION AUTO-LOGOUT - NO DEVICE TRACKING)
-- ========================================================

-- 1. Create or Update users_portal table
CREATE TABLE IF NOT EXISTS public.users_portal (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,      -- TRUE = Approved / Active, FALSE = Pending
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,       -- TRUE = Admin, FALSE = Student
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,      -- TRUE = Account Locked, FALSE = Unlocked
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_token TEXT
);

-- Clean up columns: ensure is_admin and is_locked exist, and drop device_id & device_name columns
DO $$ 
BEGIN 
    -- Add is_admin if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users_portal' AND column_name = 'is_admin') THEN
        ALTER TABLE public.users_portal ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;

    -- Add is_locked if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users_portal' AND column_name = 'is_locked') THEN
        ALTER TABLE public.users_portal ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;

    -- Drop device_id and device_name if they exist
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users_portal' AND column_name = 'device_id') THEN
        ALTER TABLE public.users_portal DROP COLUMN device_id;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users_portal' AND column_name = 'device_name') THEN
        ALTER TABLE public.users_portal DROP COLUMN device_name;
    END IF;

    -- If duplicate 'role' column exists, migrate data to is_admin and drop role
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users_portal' AND column_name = 'role') THEN
        BEGIN
            UPDATE public.users_portal 
            SET is_admin = CASE 
                WHEN role::text = 'admin' OR role::text = 'true' THEN TRUE 
                ELSE is_admin 
            END;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        ALTER TABLE public.users_portal DROP COLUMN IF EXISTS role;
    END IF;

    -- Standardize all existing phone numbers in table to 11 digits (01XXXXXXXXX)
    UPDATE public.users_portal 
    SET phone = '0' || phone 
    WHERE LENGTH(phone) = 10 AND phone LIKE '1%';
END $$;

-- Index for high-performance lookup
CREATE INDEX IF NOT EXISTS idx_users_portal_phone ON public.users_portal(phone);
DROP INDEX IF EXISTS idx_users_portal_device;

-- Enable Row Level Security (RLS)
ALTER TABLE public.users_portal ENABLE ROW LEVEL SECURITY;

-- Allow anon role to execute functions (Security Definer handles access)
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON TABLE public.users_portal TO anon, authenticated;

-- Drop old function signatures with device parameters
DROP FUNCTION IF EXISTS public.register_portal_user(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.login_portal_user(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.verify_user_session(TEXT, TEXT, TEXT);

-- ========================================================
-- 2. Stored Procedure: REGISTER USER
-- ========================================================
CREATE OR REPLACE FUNCTION public.register_portal_user(
    p_phone TEXT,
    p_full_name TEXT,
    p_password_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_clean_phone TEXT;
    v_existing_user RECORD;
    v_new_id UUID;
BEGIN
    v_clean_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    IF v_clean_phone LIKE '880%' THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF v_clean_phone LIKE '88%' AND LENGTH(v_clean_phone) = 13 THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF LENGTH(v_clean_phone) = 10 AND v_clean_phone LIKE '1%' THEN
        v_clean_phone := '0' || v_clean_phone;
    END IF;

    SELECT * INTO v_existing_user FROM public.users_portal WHERE phone = v_clean_phone;
    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'code', 'ALREADY_EXISTS',
            'message', 'এই ফোন নম্বর দিয়ে ইতোমধ্যে একটি একাউন্ট খোলা হয়েছে।'
        );
    END IF;

    INSERT INTO public.users_portal (
        phone,
        full_name,
        password_hash,
        is_active,
        is_admin,
        is_locked,
        created_at,
        last_login_at
    ) VALUES (
        v_clean_phone,
        p_full_name,
        p_password_hash,
        FALSE, -- Default: Inactive until admin approves
        FALSE, -- Default: Student
        FALSE, -- Default: Unlocked
        NOW(),
        NOW()
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'code', 'REGISTER_SUCCESS',
        'is_active', FALSE,
        'is_admin', FALSE,
        'is_locked', FALSE,
        'message', 'রেজিস্ট্রেশন সফল হয়েছে! অ্যাডমিন আপনার একাউন্টটি এক্টিভ করার পর আপনি লগইন করতে পারবেন।'
    );
END;
$$;

-- ========================================================
-- 3. Stored Procedure: LOGIN USER (SINGLE ACTIVE SESSION)
-- ========================================================
CREATE OR REPLACE FUNCTION public.login_portal_user(
    p_phone TEXT,
    p_password_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_clean_phone TEXT;
    v_user RECORD;
    v_new_session_token TEXT;
BEGIN
    v_clean_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    IF v_clean_phone LIKE '880%' THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF v_clean_phone LIKE '88%' AND LENGTH(v_clean_phone) = 13 THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF LENGTH(v_clean_phone) = 10 AND v_clean_phone LIKE '1%' THEN
        v_clean_phone := '0' || v_clean_phone;
    END IF;

    SELECT * INTO v_user 
    FROM public.users_portal 
    WHERE phone = v_clean_phone 
       OR phone = SUBSTRING(v_clean_phone FROM 2) 
       OR ('0' || phone) = v_clean_phone;

    IF NOT FOUND OR v_user.password_hash != p_password_hash THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'code', 'INVALID_CREDENTIALS',
            'message', 'ফোন নম্বর অথবা পাসওয়ার্ড ভুল হয়েছে।'
        );
    END IF;

    -- Approval Check
    IF v_user.is_active = FALSE THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'code', 'ACCOUNT_INACTIVE',
            'is_active', FALSE,
            'message', 'আপনার একাউন্টটি এখনও অ্যাডমিন দ্বারা একটিভ করা হয়নি। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।'
        );
    END IF;

    -- Account Locked Check
    IF v_user.is_locked = TRUE THEN
        RETURN jsonb_build_object(
            'success', FALSE,
            'code', 'ACCOUNT_LOCKED',
            'is_locked', TRUE,
            'message', 'আপনার একাউন্টটি অ্যাডমিন কর্তৃক লক করা হয়েছে। আপনি কোনো ভিডিও দেখতে পারবেন না।'
        );
    END IF;

    -- Dynamic Single Active Session: Generate a new session token on every login
    -- Any previous active session will be automatically invalidated
    v_new_session_token := encode(gen_random_bytes(32), 'hex');

    -- Refresh session token and update last login timestamp
    UPDATE public.users_portal
    SET 
        last_login_at = NOW(),
        session_token = v_new_session_token
    WHERE id = v_user.id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'code', 'LOGIN_SUCCESS',
        'user', jsonb_build_object(
            'id', v_user.id,
            'phone', v_user.phone,
            'full_name', v_user.full_name,
            'is_admin', COALESCE(v_user.is_admin, FALSE),
            'is_locked', COALESCE(v_user.is_locked, FALSE),
            'is_active', TRUE,
            'session_token', v_new_session_token
        ),
        'message', 'লগইন সফল হয়েছে!'
    );
END;
$$;

-- ========================================================
-- 4. Stored Procedure: VERIFY SESSION (SINGLE ACTIVE SESSION AUTO-LOGOUT)
-- ========================================================
CREATE OR REPLACE FUNCTION public.verify_user_session(
    p_phone TEXT,
    p_session_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user RECORD;
    v_clean_phone TEXT;
BEGIN
    v_clean_phone := regexp_replace(p_phone, '[^0-9]', '', 'g');
    IF v_clean_phone LIKE '880%' THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF v_clean_phone LIKE '88%' AND LENGTH(v_clean_phone) = 13 THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF LENGTH(v_clean_phone) = 10 AND v_clean_phone LIKE '1%' THEN
        v_clean_phone := '0' || v_clean_phone;
    END IF;

    SELECT * INTO v_user 
    FROM public.users_portal 
    WHERE phone = v_clean_phone;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('valid', FALSE, 'code', 'INVALID_USER', 'message', 'ইউজার পাওয়া যায়নি।');
    END IF;

    -- Realtime Active check
    IF v_user.is_active = FALSE THEN
        RETURN jsonb_build_object('valid', FALSE, 'code', 'ACCOUNT_DEACTIVATED', 'message', 'আপনার একাউন্টটি সাময়িকভাবে ডিএক্টিভ করা হয়েছে।');
    END IF;

    -- Realtime Lock check
    IF v_user.is_locked = TRUE THEN
        RETURN jsonb_build_object('valid', FALSE, 'code', 'ACCOUNT_LOCKED', 'message', 'আপনার একাউন্টটি লক করা হয়েছে।');
    END IF;

    -- Check Single Active Session Token:
    -- If user is an Admin (is_admin = TRUE), allow multi-device logins across admin devices
    -- If regular student (is_admin = FALSE), enforce Single Active Device restriction
    IF v_user.is_admin IS NOT TRUE THEN
        IF v_user.session_token IS NULL OR v_user.session_token != p_session_token THEN
            RETURN jsonb_build_object(
                'valid', FALSE, 
                'code', 'SESSION_REVOKED', 
                'message', 'অন্য ডিভাইসে লগইন করা হয়েছে। আপনার এই ডিভাইসটি স্বয়ংক্রিয়ভাবে লগআউট করা হয়েছে।'
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'valid', TRUE,
        'user', jsonb_build_object(
            'id', v_user.id,
            'phone', v_user.phone,
            'full_name', v_user.full_name,
            'is_admin', COALESCE(v_user.is_admin, FALSE),
            'is_locked', FALSE,
            'is_active', TRUE
        )
    );
END;
$$;

-- ========================================================
-- 5. ADMIN PROCEDURES: GET USERS & MANAGE STUDENTS
-- ========================================================

-- Admin Get All Users
CREATE OR REPLACE FUNCTION public.admin_get_users(
    p_admin_phone TEXT,
    p_session_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_admin RECORD;
    v_clean_phone TEXT;
    v_users JSONB;
BEGIN
    v_clean_phone := regexp_replace(p_admin_phone, '[^0-9]', '', 'g');
    IF v_clean_phone LIKE '880%' THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF v_clean_phone LIKE '88%' AND LENGTH(v_clean_phone) = 13 THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF LENGTH(v_clean_phone) = 10 AND v_clean_phone LIKE '1%' THEN
        v_clean_phone := '0' || v_clean_phone;
    END IF;

    SELECT * INTO v_admin 
    FROM public.users_portal 
    WHERE phone = v_clean_phone;

    IF NOT FOUND OR v_admin.is_admin IS NOT TRUE OR v_admin.is_active IS NOT TRUE THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'অ্যাডমিন অনুমতি নেই (Access Denied)');
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'phone', phone,
        'full_name', full_name,
        'is_active', is_active,
        'is_admin', is_admin,
        'is_locked', is_locked,
        'created_at', created_at,
        'last_login_at', last_login_at
    ) ORDER BY created_at DESC) INTO v_users
    FROM public.users_portal;

    RETURN jsonb_build_object('success', TRUE, 'users', COALESCE(v_users, '[]'::jsonb));
END;
$$;

-- Admin Update User (Approve, Role Change, Lock/Unlock, Reset Session)
CREATE OR REPLACE FUNCTION public.admin_update_user(
    p_admin_phone TEXT,
    p_session_token TEXT,
    p_target_id UUID,
    p_is_active BOOLEAN,
    p_is_admin BOOLEAN,
    p_is_locked BOOLEAN,
    p_reset_device BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_admin RECORD;
    v_clean_phone TEXT;
BEGIN
    v_clean_phone := regexp_replace(p_admin_phone, '[^0-9]', '', 'g');
    IF v_clean_phone LIKE '880%' THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF v_clean_phone LIKE '88%' AND LENGTH(v_clean_phone) = 13 THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF LENGTH(v_clean_phone) = 10 AND v_clean_phone LIKE '1%' THEN
        v_clean_phone := '0' || v_clean_phone;
    END IF;

    SELECT * INTO v_admin 
    FROM public.users_portal 
    WHERE phone = v_clean_phone;

    IF NOT FOUND OR v_admin.is_admin IS NOT TRUE OR v_admin.is_active IS NOT TRUE THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'অ্যাডমিন অনুমতি নেই');
    END IF;

    IF p_reset_device = TRUE THEN
        -- Force logout: clear session_token
        UPDATE public.users_portal
        SET 
            is_active = p_is_active,
            is_admin = p_is_admin,
            is_locked = p_is_locked,
            session_token = NULL
        WHERE id = p_target_id;
    ELSE
        UPDATE public.users_portal
        SET 
            is_active = p_is_active,
            is_admin = p_is_admin,
            is_locked = p_is_locked,
            session_token = CASE WHEN p_is_locked = TRUE OR p_is_active = FALSE THEN NULL ELSE session_token END
        WHERE id = p_target_id;
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'message', 'ব্যবহারকারীর তথ্য সফলভাবে আপডেট হয়েছে!');
END;
$$;

-- Admin Delete User
CREATE OR REPLACE FUNCTION public.admin_delete_user(
    p_admin_phone TEXT,
    p_session_token TEXT,
    p_target_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_admin RECORD;
    v_clean_phone TEXT;
BEGIN
    v_clean_phone := regexp_replace(p_admin_phone, '[^0-9]', '', 'g');
    IF v_clean_phone LIKE '880%' THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF v_clean_phone LIKE '88%' AND LENGTH(v_clean_phone) = 13 THEN
        v_clean_phone := SUBSTRING(v_clean_phone FROM 3);
    ELSIF LENGTH(v_clean_phone) = 10 AND v_clean_phone LIKE '1%' THEN
        v_clean_phone := '0' || v_clean_phone;
    END IF;

    SELECT * INTO v_admin 
    FROM public.users_portal 
    WHERE phone = v_clean_phone;

    IF NOT FOUND OR v_admin.is_admin IS NOT TRUE OR v_admin.is_active IS NOT TRUE THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'অ্যাডমিন অনুমতি নেই');
    END IF;

    DELETE FROM public.users_portal WHERE id = p_target_id;

    RETURN jsonb_build_object('success', TRUE, 'message', 'ইউজার সফলভাবে ডিলিট করা হয়েছে!');
END;
$$;

-- Grant execution permissions to anon and authenticated
GRANT EXECUTE ON FUNCTION public.register_portal_user(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_portal_user(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_user_session(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_users(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_user(TEXT, TEXT, UUID, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(TEXT, TEXT, UUID) TO anon, authenticated;

-- Force Schema Cache Reload in PostgREST
NOTIFY pgrst, 'reload schema';
