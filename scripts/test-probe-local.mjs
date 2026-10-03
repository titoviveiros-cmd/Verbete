// Valida a sonda pós-deploy de produção (scripts/probe-m1-prod.mjs) contra o
// banco local do CI, que está no M1: a ferramenta que vai conferir produção
// precisa dar "PRODUÇÃO M1 OK" num banco M1 correto — pelos DOIS transportes:
// conexão direta (DB_URL) e a CLI do Supabase (`db query`, o caminho usado
// quando a senha do banco não está na máquina). Sem a parte web (o CI não
// serve este build num domínio público).
// Envs: SUPA_URL, ANON, DB_URL.
import pg from "pg";
import { spawnSync } from "node:child_process";

// Um tick agora, como o cron faria (a sonda exige heartbeat recente; outras
// suítes envelhecem o heartbeat de propósito para testar o alerta).
const db = new pg.Client({ connectionString: process.env.DB_URL });
await db.connect();
await db.query("SELECT public.tick_stalled_rooms()");
await db.end();

let passed = 0;
const runs = [
  { name: "conexão direta (DB_URL)", env: {} },
  { name: "CLI do Supabase (PROBE_DB=local)", env: { PROBE_DB: "local", DB_URL: "" } },
];
for (const { name, env } of runs) {
  console.log(`\n— sonda via ${name}`);
  const r = spawnSync(process.execPath, ["scripts/probe-m1-prod.mjs"], {
    encoding: "utf8",
    env: { ...process.env, SKIP_WEB: "1", ...env },
  });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  const ok = r.status === 0 && /PRODUÇÃO M1 OK/.test(r.stdout);
  if (ok) passed++;
  else console.log(`❌ a sonda via ${name} falhou contra um banco M1 correto`);
}
console.log(
  passed === runs.length
    ? `\nSONDA DE PRODUÇÃO VALIDADA NO BANCO M1 — ${passed}/${runs.length}`
    : `\n${runs.length - passed}/${runs.length} FALHAS`,
);
process.exit(passed === runs.length ? 0 : 1);
