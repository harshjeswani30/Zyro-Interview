-- Migration: Convert sessions_balance to fractional credits + add credit tracking columns
-- Run this in Supabase SQL Editor

-- 1. Change sessions_balance from integer to numeric for fractional billing
ALTER TABLE profiles 
  ALTER COLUMN sessions_balance TYPE numeric(10,4) USING sessions_balance::numeric(10,4);

-- 2. Set default to 0.0000
ALTER TABLE profiles 
  ALTER COLUMN sessions_balance SET DEFAULT 0.0000;

-- 3. Add credits_used_total column (lifetime credit hours consumed)
ALTER TABLE profiles 
  ADD COLUMN IF NOT EXISTS credits_used_total numeric(10,4) DEFAULT 0.0000;

-- 4. Add held_credits column (reserved for upcoming scheduled sessions)
ALTER TABLE profiles 
  ADD COLUMN IF NOT EXISTS held_credits numeric(10,4) DEFAULT 0.0000;

-- 5. Update the consume_session_balance RPC to handle float arithmetic
-- Drop old RPC first
DROP FUNCTION IF EXISTS consume_session_balance(uuid, text);

-- New RPC: deduct fractional credits atomically
CREATE OR REPLACE FUNCTION deduct_credit_hours(
  p_user_id uuid,
  p_credits_to_deduct numeric,
  p_release_hold boolean DEFAULT false
)
RETURNS numeric  -- returns new balance
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_balance numeric;
  v_new_balance numeric;
BEGIN
  -- Lock row for atomic update
  SELECT sessions_balance INTO v_current_balance
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;

  -- Calculate new balance (floor at 0)
  v_new_balance := GREATEST(0, v_current_balance - p_credits_to_deduct);

  -- Atomically update balance + usage stats
  UPDATE profiles SET
    sessions_balance = v_new_balance,
    credits_used_total = COALESCE(credits_used_total, 0) + p_credits_to_deduct,
    held_credits = CASE
      WHEN p_release_hold THEN GREATEST(0, COALESCE(held_credits, 0) - 1.0)
      ELSE COALESCE(held_credits, 0)
    END
  WHERE id = p_user_id;

  RETURN v_new_balance;
END;
$$;

-- 6. New RPC: hold_credit (reserves 1 credit for a scheduled session)
CREATE OR REPLACE FUNCTION hold_credit_for_session(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance numeric;
  v_held numeric;
  v_effective numeric;
BEGIN
  SELECT sessions_balance, COALESCE(held_credits, 0)
  INTO v_balance, v_held
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_not_found');
  END IF;

  v_effective := v_balance - v_held;

  IF v_effective < 1.0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'effective_balance', v_effective);
  END IF;

  -- Reserve the credit
  UPDATE profiles SET held_credits = v_held + 1.0 WHERE id = p_user_id;

  RETURN jsonb_build_object('ok', true, 'held_credits', v_held + 1.0, 'effective_balance', v_effective - 1.0);
END;
$$;

-- 7. New RPC: release_held_credit
CREATE OR REPLACE FUNCTION release_held_credit(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE profiles SET
    held_credits = GREATEST(0, COALESCE(held_credits, 0) - 1.0)
  WHERE id = p_user_id;
END;
$$;
