// Portão SÓ DE LEITURA da janela do modo sem IA (docs/sem-ia-externa.md §4):
// daily_mode='escolha' + ≥ 168 conjuntos aprovados jogáveis. Sai 0 = pronto;
// 1 = não pronto ou banco ilegível (falha fechada). Não grava nada.
// Uso: DB_URL=... node scripts/check-sem-ia-prontidao.mjs
import pg from "pg";
import { checarProntidaoSemIa, META_APROVADOS_JOGAVEIS } from "./lib/sem-ia-prontidao.mjs";

if (!process.env.DB_URL) {
  console.error("uso: DB_URL=... node scripts/check-sem-ia-prontidao.mjs");
  process.exit(2);
}
const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL) ? { rejectUnauthorized: false } : false,
});
let r;
try {
  await db.connect();
  r = await checarProntidaoSemIa((sql) => db.query(sql));
} catch (e) {
  r = { ok: false, aprovadoJogavel: null, dailyMode: null, motivos: [`conexão (${e?.code ?? "erro"})`] };
} finally {
  await db.end().catch(() => {});
}
console.log(
  `aprovados jogáveis: ${r.aprovadoJogavel ?? "?"} (meta ${META_APROVADOS_JOGAVEIS}) · daily_mode: ${r.dailyMode ?? "?"}`,
);
if (r.ok) {
  console.log("✅ PRONTO para suspender a IA (janela do modo sem IA).");
} else {
  console.error(`⛔ NÃO PRONTO: ${r.motivos.join("; ")}`);
  process.exitCode = 1;
}
