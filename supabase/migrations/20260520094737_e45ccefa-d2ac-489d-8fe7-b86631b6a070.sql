-- Fix the stuck attempt for the current hour bucket where guess is equivalent.
UPDATE public.daily_attempts
SET similarity = 95,
    is_correct = true,
    score = GREATEST(100 - COALESCE(time_seconds, 60), 20)
WHERE challenge_hour = date_trunc('hour', now())
  AND user_id = '0e8039b4-ec44-482d-ba29-669c0c5619c8'
  AND is_correct = false
  AND similarity = 0;


