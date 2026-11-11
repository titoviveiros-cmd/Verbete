// Grava (ou apaga) UMA chave operacional de app_config — canal de alertas,
// ping externo, versão mínima do app e modo manutenção — sem SQL na mão
// (PowerShell + arquivo .sql = risco de BOM/acentos). Só chaves da lista;
// valor validado; mostra antes/depois com URLs mascaradas (webhook é segredo).
// Uso: DB_URL=... node scripts/set-app-config.mjs <chave> <valor>
//      DB_URL=... node scripts/set-app-config.mjs <chave> --delete
// Trava dos 168 (scripts/lib/sem-ia-prontidao.mjs): ai_mode=suspenso exige
// daily_mode='escolha' + ≥ 168 aprovados jogáveis; daily_mode=escolha exige
// ≥ 168. Falha FECHADA. Contenção de emergência: ai_mode suspenso --emergencia.
import pg from "pg";
import { travaAppConfig } from "./lib/sem-ia-prontidao.mjs";

const RULES = {
  ops_alert_webhook_url: (v) => /^https:\/\/\S+$/.test(v),
  ops_heartbeat_ping_url: (v) => /^https:\/\/\S+$/.test(v),
  "client.maintenance": (v) => v === "on" || v === "off",
  "client.maintenance_message": (v) => v.trim().length > 0 && v.length <= 200,
  "client.min_native_build": (v) => /^[1-9]\d{0,8}$/.test(v),
  "client.store_url": (v) => /^https:\/\/\S+$/.test(v),
  // contenção da IA (docs/contencao-ia.md) — 'suspenso' exige autorização
  ai_mode: (v) => v === "ligado" || v === "suspenso",
  // Diário D1 (docs/diario-d1.md) — 'escolha' liga o modo de múltipla escolha: exige autorização
  daily_mode: (v) => v === "juiz" || v === "escolha" || v === "pausa",
};

const [key, value, ...flags] = process.argv.slice(2);
const del = value === "--delete";
const emergencia = flags.includes("--emergencia");
if (!process.env.DB_URL || !key || value === undefined) {
  console.error("uso: DB_URL=... node scripts/set-app-config.mjs <chave> <valor|--delete>");
  process.exit(2);
}
if (!(key in RULES)) {
  console.error(`chave não permitida: ${key}\npermitidas: ${Object.keys(RULES).join(", ")}`);
  process.exit(2);
}
if (!del && !RULES[key](value)) {
  console.error(`valor inválido para ${key}`);
  process.exit(2);
}
const mask = (v) =>
  v == null ? "(ausente)" : /^https:\/\//.test(v) ? `${new URL(v).host}/…(${v.length} caracteres)` : JSON.stringify(v);

const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL) ? { rejectUnauthorized: false } : false,
});
// Trava dos 168 ANTES de qualquer escrita (falha fechada; só a gravação de
// valor passa por ela — --delete de ai_mode/daily_mode é rollback).
async function travaOk() {
  if (del) return true;
  const trava = await travaAppConfig({ key, value, emergencia, query: (sql) => db.query(sql) });
  if (trava.prontidao) {
    console.log(
      `prontidão: aprovados jogáveis=${trava.prontidao.aprovadoJogavel ?? "?"} · daily_mode=${trava.prontidao.dailyMode ?? "?"}`,
    );
  }
  if (trava.aviso) console.warn(`⚠️  ${trava.aviso}`);
  if (trava.ok) return true;
  console.error(
    `⛔ ${trava.erro}\nNada foi gravado.` +
      (key === "ai_mode" ? " Contenção de emergência: ai_mode suspenso --emergencia" : ""),
  );
  return false;
}

await db.connect();
try {
  if (!(await travaOk())) {
    process.exitCode = 3;
  } else {
    await gravar();
  }
} finally {
  await db.end();
}

async function gravar() {
  const before = (await db.query(`SELECT value FROM public.app_config WHERE key = $1`, [key])).rows[0]?.value;
  if (del) {
    await db.query(`DELETE FROM public.app_config WHERE key = $1`, [key]);
  } else {
    await db.query(
      `INSERT INTO public.app_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
  const after = (await db.query(`SELECT value FROM public.app_config WHERE key = $1`, [key])).rows[0]?.value;
  console.log(`✅ ${key}: ${mask(before)} → ${mask(after)}`);
}
