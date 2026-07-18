import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Mascot } from "@/components/Mascot";
import { fetchAllAchievements, fetchUnlockedCodes, type Achievement } from "@/lib/daily";
import { deleteAccount, resetMyStats } from "@/lib/account.functions";
import { AVATARS, COLORS } from "@/lib/avatars";
import { setStored } from "@/lib/player-id";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "Meu perfil — Verbete" },
      { name: "description", content: "Acompanhe suas estatísticas, conquistas e histórico de partidas no Verbete." },
      { property: "og:url", content: "https://verbete.lovable.app/profile" },
      { name: "robots", content: "noindex,follow" },
    ],
    links: [{ rel: "canonical", href: "https://verbete.lovable.app/profile" }],
  }),
  component: ProfilePage,
});

type Stats = {
  games_played: number; games_won: number; total_score: number;
  best_match_score: number; rounds_coordinated: number;
  current_streak: number; best_streak: number;
  xp?: number; level?: number;
  total_truth_hits?: number; total_fooled?: number;
};

// Espelho de public.xp_to_level: level = floor(sqrt(xp/100)) + 1.
// XP necessário para o nível N: 100 * (N-1)^2.
function xpForLevel(level: number): number {
  return 100 * Math.pow(level - 1, 2);
}
type Match = { id: string; room_code: string; final_score: number; position: number; players_count: number; played_at: string };
type Profile = { display_name: string; avatar: string; color: string };

function ProfilePage() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<Match[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [isAdmin, setIsAdmin] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const runDelete = useServerFn(deleteAccount);
  const runReset = useServerFn(resetMyStats);
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [editingAvatar, setEditingAvatar] = useState(false);

  const updateAppearance = async (next: Partial<Pick<Profile, "avatar" | "color">>) => {
    if (!user || !profile) return;
    const merged = { ...profile, ...next };
    setProfile(merged);
    if (next.avatar) setStored("avatar", next.avatar);
    if (next.color) setStored("color", next.color);
    await supabase.from("profiles").update(next).eq("user_id", user.id);
  };


  useEffect(() => {
    if (loading) return;
    if (!user) { nav({ to: "/login" }); return; }
    (async () => {
      const [{ data: p }, { data: s }, { data: h }, ach, unl, { data: role }] = await Promise.all([
        supabase.from("profiles").select("display_name, avatar, color").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_stats").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("match_history").select("*").eq("user_id", user.id).order("played_at", { ascending: false }).limit(20),
        fetchAllAchievements(),
        fetchUnlockedCodes(user.id),
        supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
      ]);
      setProfile(p as Profile);
      setName(p?.display_name ?? "");
      setStats(s as Stats);
      setHistory((h as Match[]) ?? []);
      setAchievements(ach);
      setUnlocked(unl);
      setIsAdmin(!!role);
    })();
  }, [user, loading, nav]);

  const saveName = async () => {
    if (!user) return;
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed) return;
    await supabase.from("profiles").update({ display_name: trimmed }).eq("user_id", user.id);
    setProfile((p) => p ? { ...p, display_name: trimmed } : p);
    setEditing(false);
  };

  const signOut = async () => { await supabase.auth.signOut(); nav({ to: "/" }); };

  const handleDelete = async () => {
    if (!profile || deleting) return;
    const expected = profile.display_name.trim();
    if (deleteConfirm.trim() !== expected) {
      setDeleteError(`Digite exatamente "${expected}" para confirmar.`);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await runDelete();
      await supabase.auth.signOut();
      nav({ to: "/" });
    } catch (e) {
      console.error("[deleteAccount] failed", e);
      setDeleteError(e instanceof Error ? e.message : "Erro ao excluir conta.");
      setDeleting(false);
    }
  };

  if (loading || !user) return <div className="mobile-shell items-center justify-center"><Mascot mood="thinking" /></div>;

  const winRate = stats?.games_played ? Math.round((stats.games_won / stats.games_played) * 100) : 0;

  return (
    <div className="mobile-shell pt-4 gap-3 overflow-y-auto pb-8">
      <div className="flex items-center justify-between">
        <Link to="/" className="btn-pop bg-card text-xs px-3 py-2 font-display flex items-center gap-1">
          <span>←</span> Início
        </Link>
        <button
          onClick={signOut}
          className="btn-pop bg-gradient-to-br from-mint/30 to-sky/30 text-xs px-3 py-2 font-display flex items-center gap-1 border border-mint/50 relative"
          title="Sair da conta"
        >
          Sair <span>🚪</span>
          <span
            aria-hidden
            className="absolute top-1.5 right-2 w-2 h-2 rounded-full animate-pulse"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, #eaffef 0%, #4ade80 40%, #15803d 100%)",
              boxShadow:
                "0 0 3px 1px rgba(74,222,128,0.9), 0 0 6px 1px rgba(74,222,128,0.5), inset 0 1px 1px rgba(255,255,255,0.85)",
            }}
          />
        </button>
      </div>

      <div className="text-center">

        <button
          type="button"
          onClick={() => setEditingAvatar((v) => !v)}
          aria-label="Alterar avatar e cor"
          className="rounded-full w-24 h-24 mx-auto flex items-center justify-center text-5xl shadow-pop transition active:scale-95 relative"
          style={{ background: `radial-gradient(circle at 30% 25%, ${profile?.color ?? "#FFD166"}cc, ${profile?.color ?? "#FFD166"})` }}
        >
          {profile?.avatar ?? "🦊"}
          <span className="absolute -bottom-1 -right-1 bg-card border border-white/10 rounded-full w-7 h-7 flex items-center justify-center text-sm shadow-soft">✏️</span>
        </button>
        {editingAvatar && (
          <div className="mt-3 rounded-2xl bg-card p-3 border border-white/10 shadow-soft text-left">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mb-1">Avatar</div>
            <div className="grid grid-cols-8 gap-1 mb-3">
              {AVATARS.map((a) => (
                <button key={a} onClick={() => updateAppearance({ avatar: a })}
                  aria-label={`Escolher avatar ${a}`}
                  aria-pressed={profile?.avatar === a}
                  className={"text-2xl rounded-lg p-1 transition " + (profile?.avatar === a ? "bg-pink/30 ring-2 ring-pink" : "hover:bg-white/5")}>
                  {a}
                </button>
              ))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mb-1">Cor</div>
            <div className="flex gap-1 justify-center flex-wrap">
              {COLORS.map((c) => (
                <button key={c} onClick={() => updateAppearance({ color: c })}
                  aria-label={`Escolher cor ${c}`}
                  aria-pressed={profile?.color === c}
                  className="p-2 rounded-full transition active:scale-95"
                >
                  <span
                    className={"block w-6 h-6 rounded-full border-2 " + (profile?.color === c ? "border-white scale-110" : "border-black/40")}
                    style={{ background: c }}
                  />
                </button>
              ))}
            </div>
          </div>
        )}
        {editing ? (
          <div className="flex gap-2 justify-center mt-3">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24}
              className="bg-input rounded-xl px-3 py-2 font-display text-center border border-white/10" />
            <button onClick={saveName} className="btn-pop bg-gradient-fun text-white text-sm">Salvar</button>
          </div>
        ) : (
          <h1 onClick={() => setEditing(true)} className="font-display text-2xl mt-2 cursor-pointer">
            {profile?.display_name ?? "Jogador"}
          </h1>
        )}
        <p className="text-xs text-muted-foreground">{user.email}</p>
      </div>

      <div className="flex items-center justify-between mt-1">
        <h2 className="font-display text-sm uppercase tracking-wider text-muted-foreground">Estatísticas</h2>
        <button
          onClick={() => { setShowReset(true); setResetError(null); }}
          title="Zerar minhas estatísticas"
          aria-label="Zerar minhas estatísticas"
          className="text-muted-foreground hover:text-destructive transition text-base w-7 h-7 flex items-center justify-center rounded-full border border-white/10"
        >
          ♻️
        </button>
      </div>
      {(() => {
        const xp = stats?.xp ?? 0;
        const level = stats?.level ?? 1;
        const base = xpForLevel(level);
        const next = xpForLevel(level + 1);
        const pct = next > base ? Math.min(100, Math.round(((xp - base) / (next - base)) * 100)) : 0;
        return (
          <div className="sticker bg-gradient-to-r from-grape/25 to-pink/20 py-3 px-4 space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="font-display text-lg">⚡ Nível {level}</span>
              <span className="text-[11px] text-muted-foreground font-display tabular-nums">{xp} / {next} XP</span>
            </div>
            <div className="h-2 rounded-full bg-black/25 overflow-hidden border border-white/10">
              <div className="h-full rounded-full bg-gradient-fun transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Partidas" value={stats?.games_played ?? 0} />
        <Stat label="Vitórias" value={stats?.games_won ?? 0} />
        <Stat label="Taxa de vitória" value={`${winRate}%`} />
        <Stat label="Pontos totais" value={stats?.total_score ?? 0} />
        <Stat label="Acertos da verdade" value={stats?.total_truth_hits ?? 0} />
        <Stat label="Jogadores enganados" value={stats?.total_fooled ?? 0} />
      </div>


      <div className="sticker bg-gradient-to-r from-sun/20 to-pink/20 py-3 px-4 flex items-center gap-3">
        <span className="text-3xl">🔥</span>
        <div className="flex-1">
          <div className="font-display text-xl leading-none">{stats?.current_streak ?? 0} dia{(stats?.current_streak ?? 0) !== 1 ? "s" : ""}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">Streak atual · recorde {stats?.best_streak ?? 0}</div>
        </div>
        <Link to="/daily" search={{ from: "profile" }} className="btn-pop bg-gradient-fun text-white text-xs py-2 px-3">Desafio diário</Link>
      </div>

      <div className="flex gap-2">
        <Link to="/ranking" search={{ from: "profile" }} className="btn-pop bg-card flex-1 text-center text-sm border border-white/10">🏆 Ranking</Link>
      </div>


      {isAdmin && (
        <Link
          to="/admin/reports"
          search={{ from: "profile" }}
          className="btn-pop bg-gradient-to-r from-destructive/80 to-pink/80 text-white text-center text-sm"
        >
          🛡️ Painel de moderação
        </Link>
      )}

      <h2 className="font-display text-lg mt-2">Conquistas <span className="text-xs text-muted-foreground">({unlocked.size}/{achievements.length})</span></h2>
      <div className="grid grid-cols-5 gap-2">
        {achievements.map((a) => {
          const got = unlocked.has(a.code);
          return (
            <div key={a.code} title={`${a.name} — ${a.description}`}
              className={"sticker py-2 text-center transition " + (got ? "" : "opacity-30 grayscale")}>
              <div className="text-2xl">{a.emoji}</div>
              <div className="text-[9px] font-display leading-tight mt-1 truncate">{a.name}</div>
            </div>
          );
        })}
      </div>

      <h2 className="font-display text-lg mt-2">Últimas partidas</h2>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Nenhuma partida registrada ainda. Jogue logado para aparecer aqui!</p>
      ) : (
        <ul className="space-y-1.5">
          {history.map((m) => (
            <li key={m.id} className="sticker py-2 px-3 flex items-center gap-3 text-sm">
              <span className="font-display w-10">#{m.position}</span>
              <span className="flex-1">Sala {m.room_code} · {m.players_count} jog.</span>
              <span className="font-display text-primary">{m.final_score} pts</span>
            </li>
          ))}
        </ul>
      )}

      {/* Zona de perigo — obrigatório para Apple App Store (5.1.1(v)) */}
      <div className="mt-6 pt-4 border-t border-destructive/20">
        <h2 className="font-display text-sm text-destructive/80 uppercase tracking-wider mb-2">
          ⚠️ Zona de perigo
        </h2>
        <div className="sticker bg-destructive/5 border border-destructive/30 p-3 flex items-center justify-between gap-3">
          <div className="flex-1">
            <div className="font-display text-sm">Excluir minha conta</div>
            <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
              Remove perfil, estatísticas, conquistas e e-mail. Esta ação é irreversível.
            </div>
          </div>
          <button
            onClick={() => { setShowDelete(true); setDeleteConfirm(""); setDeleteError(null); }}
            className="btn-pop bg-destructive text-destructive-foreground text-xs py-2 px-3 shrink-0"
          >
            Excluir
          </button>
        </div>
      </div>

      {showDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur p-4"
          onClick={() => !deleting && setShowDelete(false)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-card border border-destructive/30 shadow-pop p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center">
              <div className="text-4xl mb-2">😢</div>
              <h3 className="font-display text-xl">Excluir conta?</h3>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Vamos apagar permanentemente seu perfil, e-mail, estatísticas, conquistas e
                histórico. Você não poderá desfazer.
              </p>
            </div>
            <label className="text-xs text-muted-foreground mt-2">
              Para confirmar, digite seu apelido: <strong className="text-foreground">{profile?.display_name}</strong>
            </label>
            <input
              autoFocus
              value={deleteConfirm}
              onChange={(e) => { setDeleteConfirm(e.target.value); setDeleteError(null); }}
              disabled={deleting}
              maxLength={48}
              className="bg-input rounded-xl px-3 py-2 font-display border border-white/10 disabled:opacity-50"
              placeholder={profile?.display_name ?? ""}
            />
            {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowDelete(false)}
                disabled={deleting}
                className="btn-pop bg-card border border-white/10 flex-1 text-sm disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || deleteConfirm.trim() !== (profile?.display_name.trim() ?? "")}
                className="btn-pop bg-destructive text-destructive-foreground flex-1 text-sm disabled:opacity-50"
              >
                {deleting ? "Excluindo…" : "Excluir tudo"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur p-4"
          onClick={() => !resetting && setShowReset(false)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-card border border-white/10 shadow-pop p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center">
              <div className="text-4xl mb-2">♻️</div>
              <h3 className="font-display text-xl">Zerar estatísticas?</h3>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Vamos resetar suas partidas, vitórias, pontos, streak, tentativas do desafio
                e conquistas desbloqueadas. Sua conta e perfil permanecem.
              </p>
            </div>
            {resetError && <p className="text-xs text-destructive text-center">{resetError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowReset(false)}
                disabled={resetting}
                className="btn-pop bg-card border border-white/10 flex-1 text-sm disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={async () => {
                  setResetting(true);
                  setResetError(null);
                  try {
                    await runReset();
                    setStats({
                      games_played: 0, games_won: 0, total_score: 0,
                      best_match_score: 0, rounds_coordinated: 0,
                      current_streak: 0, best_streak: 0,
                    });
                    setHistory([]);
                    setUnlocked(new Set());
                    setShowReset(false);
                  } catch (e) {
                    setResetError(e instanceof Error ? e.message : "Erro ao zerar.");
                  } finally {
                    setResetting(false);
                  }
                }}
                disabled={resetting}
                className="btn-pop bg-gradient-fun text-white flex-1 text-sm disabled:opacity-50"
              >
                {resetting ? "Zerando…" : "Zerar tudo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="sticker py-3 text-center">
      <div className="font-display text-2xl text-primary">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}


