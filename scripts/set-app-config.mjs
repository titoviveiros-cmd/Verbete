// Grava (ou apaga) UMA chave operacional de app_config — canal de alertas,
// ping externo, versão mínima do app e modo manutenção — sem SQL na mão
// (PowerShell + arquivo .sql = risco de BOM/acentos). Só chaves da lista;
// valor validado; mostra antes/depois com URLs mascaradas (webhook é segredo).
// Uso: DB_URL=... node scripts/set-app-config.mjs <chave> <valor>
//      DB_URL=... node scripts/set-app-config.mjs <chave> --delete
import pg from "pg";

const RULES = {
  ops_alert_webhook_url: (v) => /^https:\/\/\S+$/.test(v),
  ops_heartbeat_ping_url: (v) => /^https:\/\/\S+$/.test(v),
  "client.maintenance": (v) => v === "on" || v === "off",
  "client.maintenance_message": (v) => v.trim().length > 0 && v.length <= 200,
  "client.min_native_build": (v) => /^[1-9]\d{0,8}$/.test(v),
  "client.store_url": (v) => /^https:\/\/\S+$/.test(v),
};

const [key, value] = process.argv.slice(2);
const del = value === "--delete";
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
await db.connect();
try {
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
} finally {
  await db.end();
}
