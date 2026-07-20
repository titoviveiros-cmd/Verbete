// Helpers de client para o Daily Challenge — leituras públicas via Supabase
// (RLS já permite SELECT em daily_challenges, daily_attempts, words, achievements).
import { supabase } from "@/integrations/supabase/client";

export type DailyWord = { id: string; word: string; category: string | null };
export type DailyChallenge = {
  challenge: {
    id: string;
    challenge_date: string;
    challenge_hour: string;
    word_id: string;
  };
  word: DailyWord;
};

/** ISO da hora cheia atual (bucket horário usado no backend). */
function currentHourIso(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export async function fetchDailyChallenge(): Promise<DailyChallenge> {
  const { data, error } = await supabase.rpc("get_or_create_daily_challenge");
  if (error) throw new Error(error.message);
  return data as DailyChallenge;
}

export type DailyReview = {
  played: boolean;
  attempt?: {
    guess: string;
    is_correct: boolean;
    score: number;
    time_seconds: number;
    similarity: number;
    challenge_hour: string;
  };
  truth?: string;
  word?: string;
};

export async function fetchTodayAttempt(
  _userId?: string,
): Promise<DailyReview> {
  const { data, error } = await supabase.rpc("get_my_daily_review");
  if (error) return { played: false };
  return (data as DailyReview) ?? { played: false };
}

export async function fetchDailyLeaderboard(limit = 20) {
  const { data } = await supabase.rpc("get_daily_leaderboard", {
    p_limit: limit,
  });
  if (!data?.length) return [];
  const ids = Array.from(new Set(data.map((d: any) => d.user_id)));
  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, display_name, avatar, color")
    .in("user_id", ids);
  const byId = new Map((profiles ?? []).map((p) => [p.user_id, p]));
  return (data as any[]).map((d) => ({
    ...d,
    profile: byId.get(d.user_id) ?? null,
  }));
}

export type Achievement = {
  code: string;
  name: string;
  description: string;
  emoji: string;
  rarity: string;
};

export async function fetchAllAchievements(): Promise<Achievement[]> {
  const { data } = await supabase
    .from("achievements")
    .select("*")
    .order("rarity");
  return (data as Achievement[]) ?? [];
}

export async function fetchUnlockedCodes(userId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("user_achievements")
    .select("achievement_code")
    .eq("user_id", userId);
  return new Set((data ?? []).map((d) => d.achievement_code));
}

/** Tempo até o próximo desafio (próxima hora cheia). */
export function msUntilNextChallenge(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  return next.getTime() - now.getTime();
}

export function formatHMS(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
