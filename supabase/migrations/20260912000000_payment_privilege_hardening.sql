-- ============================================================================
-- Migration: payment & privilege hardening (audit 2026-09-10 C8, C9, M4,
-- plus the C1 follow-ups: replay race + once_per_user coupon stacking).
--
--   1. REPLAY RACE  — unique index on completed (razorpay_order_id) +
--                     atomic fulfill_razorpay_order RPC (insert-first
--                     ON CONFLICT DO NOTHING, then grant), so N concurrent
--                     verify calls for one payment grant exactly once.
--   2. M4           — REVOKE EXECUTE on ALL public functions from
--                     anon/authenticated (billing RPCs become service-role
--                     only); negative-amount guard inside deduct_credit_hours.
--   3. C8           — users can no longer write sessions_balance, is_admin,
--                     trial_seconds_used, credits_used_total, held_credits,
--                     phone_sessions_balance on their own profile
--                     (column REVOKEs + a trigger that survives future GRANTs).
--                     NOTE: verified against the LIVE schema 2026-09-12 —
--                     profiles has NO subscription_status column on this
--                     project, so it is not revoked/guarded here. If that
--                     column is ever created, add it to the lists below.
--   4. C9           — drop the "Anon can read profiles" policy (email/balance
--                     disclosure to unauthenticated callers).
--
-- Idempotent: safe to re-run.
-- NOTE: this file targets the shared project weqwxoihdfsvjwwcgtat (the one
-- every app's SUPABASE_URL points at).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1a. Replay race: unique index (completed payments only)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS transactions_razorpay_order_id_uniq
  ON public.transactions (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL AND status = 'completed';

-- Reconcile duplicates that may already exist (keep the earliest completion
-- per order; extras are historical double-grants — their sessions were already
-- credited, this only fixes analytics/idempotency going forward).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY razorpay_order_id
           ORDER BY created_at ASC NULLS FIRST, id ASC
         ) AS rn
  FROM public.transactions
  WHERE razorpay_order_id IS NOT NULL AND status = 'completed'
)
UPDATE public.transactions t
   SET status = 'superseded'
  FROM ranked r
 WHERE t.id = r.id
   AND r.rn > 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. Atomic fulfillment RPC — the ONLY writer that both records the payment
--     and grants sessions. Called by razorpay-verify (service role) after it
--     has verified the checkout signature + order server-side.
--
--     Order of operations (single transaction):
--       * once_per_user coupon: advisory-lock (user, coupon) then recheck
--         completed transactions — closes the create-order TOCTOU that let a
--         coupon be redeemed once per stacked order.
--       * insert-first ON CONFLICT DO NOTHING — the unique index above makes
--         exactly one racer win; losers return already_fulfilled, grant nothing.
--       * grant, then return.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fulfill_razorpay_order(
  p_user_id             uuid,
  p_razorpay_order_id   text,
  p_razorpay_payment_id text,
  p_plan_id             text,
  p_amount_paise        integer,
  p_sessions            integer,
  p_coupon_code         text DEFAULT NULL,
  p_discount_paise      integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn_id  uuid;   -- transactions.id is uuid (gen_random_uuid) on this project
  v_once     boolean;
BEGIN
  -- once_per_user: serialize concurrent fulfills for the same (user, coupon)
  -- and recheck authoritatively — create-order's pre-check is racy.
  IF p_coupon_code IS NOT NULL THEN
    SELECT COALESCE(once_per_user, false) INTO v_once
      FROM public.coupons
     WHERE upper(code) = upper(p_coupon_code)
       AND is_active
     LIMIT 1;

    IF COALESCE(v_once, false) THEN
      PERFORM pg_advisory_xact_lock(
        hashtext(p_user_id::text || ':' || upper(p_coupon_code))
      );
      PERFORM 1
        FROM public.transactions
       WHERE user_id = p_user_id
         AND coupon_code IS NOT DISTINCT FROM upper(p_coupon_code)
         AND status IN ('completed', 'paid')
         -- Exclude only the CURRENT order's own completed row (a replay of the
         -- same payment must fall through to the already_fulfilled branch).
         -- Free-plan grants carry a NULL order id; for those, every prior
         -- redemption counts (p is NULL ⇒ nothing to exclude).
         AND (p_razorpay_order_id IS NULL OR razorpay_order_id <> p_razorpay_order_id)
       LIMIT 1;
      IF FOUND THEN
        -- Policy violation: the coupon was already redeemed on another order.
        -- The payment is real (Razorpay captured it) — reject fulfillment and
        -- let support reconcile/refund via the Razorpay dashboard.
        RETURN jsonb_build_object(
          'fulfilled', false,
          'reason', 'coupon_already_redeemed'
        );
      END IF;
    END IF;
  END IF;

  -- Insert-first claim. A concurrent verify of the same order loses here.
  INSERT INTO public.transactions (
    user_id, razorpay_order_id, razorpay_payment_id, amount, currency,
    plan_name, sessions_added, coupon_code, discount_amount, status
  ) VALUES (
    p_user_id, p_razorpay_order_id, p_razorpay_payment_id,
    p_amount_paise / 100.0, 'inr',
    p_plan_id, p_sessions,
    p_coupon_code, p_discount_paise / 100.0, 'completed'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_txn_id;

  IF v_txn_id IS NULL THEN
    RETURN jsonb_build_object('fulfilled', false, 'reason', 'already_fulfilled');
  END IF;

  -- Grant. Any failure rolls back the transaction row with it.
  UPDATE public.profiles
     SET sessions_balance = COALESCE(sessions_balance, 0) + p_sessions
   WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;

  RETURN jsonb_build_object('fulfilled', true, 'sessions_added', p_sessions);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fulfill_razorpay_order(uuid, text, text, text, integer, integer, text, integer)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.fulfill_razorpay_order(uuid, text, text, text, integer, integer, text, integer)
  FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. M4 — billing RPCs become service-role-only
-- ─────────────────────────────────────────────────────────────────────────────

-- Negative-amount guard (M4: a negative deduction used to RAISE the balance).
-- Signature identical to 20240825_fractional_credits.sql so this replaces it.
CREATE OR REPLACE FUNCTION public.deduct_credit_hours(
  p_user_id uuid,
  p_credits_to_deduct numeric,
  p_release_hold boolean DEFAULT false
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_balance numeric;
  v_new_balance     numeric;
BEGIN
  IF p_credits_to_deduct IS NULL OR p_credits_to_deduct < 0 THEN
    RAISE EXCEPTION 'invalid_credits_amount';
  END IF;

  SELECT sessions_balance INTO v_current_balance
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;

  v_new_balance := GREATEST(0, v_current_balance - p_credits_to_deduct);

  UPDATE public.profiles SET
    sessions_balance   = v_new_balance,
    credits_used_total = COALESCE(credits_used_total, 0) + p_credits_to_deduct,
    held_credits       = CASE
                          WHEN p_release_hold THEN GREATEST(0, COALESCE(held_credits, 0) - 1.0)
                          ELSE COALESCE(held_credits, 0)
                        END
  WHERE id = p_user_id;

  RETURN v_new_balance;
END;
$$;

-- Billing/privileged tables: clients have no business writing these directly.
REVOKE INSERT, UPDATE, DELETE ON public.transactions      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.coupons           FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.staff_permissions FROM anon, authenticated;

-- Functions: no public function is called by client code today (verified — all
-- .rpc() call sites run in service-role Edge Functions), so nothing is
-- re-granted to anon/authenticated. consume_session_balance's out-of-band
-- body is deliberately NOT overwritten (unknown semantics); the revoke below
-- is what closes its direct-call/injection surface.
-- NOTE: the PUBLIC revoke is REQUIRED — Postgres grants EXECUTE on every new
-- function to PUBLIC by default, so revoking only from anon/authenticated
-- leaves every function callable by both (proved empirically in the pgsec
-- harness: echo_probe stayed callable until PUBLIC was revoked). service_role
-- also inherits via PUBLIC, so it is re-granted explicitly below.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Future functions created via the SQL editor (as postgres) no longer leak
-- EXECUTE to client roles by default (PUBLIC is the default grantee).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. C8 — profile privilege columns are server-written only
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE UPDATE (is_admin, sessions_balance, phone_sessions_balance,
               trial_seconds_used, credits_used_total, held_credits)
  ON public.profiles FROM authenticated;

REVOKE INSERT (is_admin, sessions_balance, phone_sessions_balance, trial_seconds_used,
               credits_used_total, held_credits)
  ON public.profiles FROM authenticated;

-- Durable trigger: blocks privileged-column writes by client roles even if a
-- future blanket GRANT re-opens the column ACL (the audit's defense-in-depth).
-- Privileged writers: service_role (Edge Functions + electron mains with the
-- service key), postgres/supabase_admin (SQL editor), supabase_auth_admin
-- (GoTrue's handle_new_user trigger creates profile rows).
CREATE OR REPLACE FUNCTION public.guard_profile_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_priv_roles constant text[] := ARRAY['service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin'];
  v_privileged boolean;
BEGIN
  -- current_user is the EFFECTIVE identity: the SET ROLE target when a role
  -- switch is active (how PostgREST runs as authenticated/service_role), or
  -- the login role otherwise (SQL editor as postgres, GoTrue's trigger as
  -- supabase_auth_admin, SECURITY DEFINER owners). session_user is
  -- deliberately NOT consulted — it stays the login role across a SET ROLE
  -- and would let a privileged connection drop to `authenticated` and keep
  -- writing these columns.
  v_privileged := current_user = ANY (v_priv_roles);
  IF TG_OP = 'UPDATE' THEN
    IF NOT v_privileged AND (
         NEW.is_admin               IS DISTINCT FROM OLD.is_admin
      OR NEW.sessions_balance       IS DISTINCT FROM OLD.sessions_balance
      OR NEW.phone_sessions_balance IS DISTINCT FROM OLD.phone_sessions_balance
      OR NEW.trial_seconds_used     IS DISTINCT FROM OLD.trial_seconds_used
      OR NEW.credits_used_total     IS DISTINCT FROM OLD.credits_used_total
      OR NEW.held_credits           IS DISTINCT FROM OLD.held_credits
    ) THEN
      RAISE EXCEPTION 'profiles privilege columns are server-managed (audit C8)'
        USING ERRCODE = '42501';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NOT v_privileged AND (
         COALESCE(NEW.is_admin, false) IS TRUE
      OR COALESCE(NEW.sessions_balance, 0)       <> 0
      OR COALESCE(NEW.phone_sessions_balance, 0) <> 0
      OR COALESCE(NEW.trial_seconds_used, 0)     <> 0
      OR COALESCE(NEW.credits_used_total, 0)    <> 0
      OR COALESCE(NEW.held_credits, 0)           <> 0
    ) THEN
      RAISE EXCEPTION 'profiles privilege columns cannot be set by clients (audit C8)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_privilege_update ON public.profiles;
CREATE TRIGGER profiles_guard_privilege_update
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privilege_columns();

DROP TRIGGER IF EXISTS profiles_guard_privilege_insert ON public.profiles;
CREATE TRIGGER profiles_guard_privilege_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privilege_columns();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. C9 — anon can no longer read every user's email/balance
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anon can read profiles" ON public.profiles;
REVOKE SELECT ON public.profiles FROM anon;
