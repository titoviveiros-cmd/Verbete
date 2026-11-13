// Portão SÓ DE LEITURA da janela do modo sem IA (docs/sem-ia-externa.md §4).
// Sai 0 = pode seguir; 1 = não pode ou banco ilegível (falha fechada). Não
// grava nada.
// Uso: DB_URL=... node scripts/check-sem-ia-prontidao.mjs
//        (sem --fase: daily_mode='escolha' + ≥ 168 aprovados jogáveis)
//      DB_URL=... node scripts/check-sem-ia-prontidao.mjs --fase <escolha|suspender|textos|revogar>
//        (portão da fase: ver avaliarFaseSemIa em scripts/lib/sem-ia-prontidao.mjs)
import pg from "pg";
import {
  checarFaseSemIa,
  checarProntidaoSemIa,
  FASES,
  META_APROVADOS_JOGAVEIS,
} from "./lib/sem-ia-prontidao.mjs";

const args = process.argv.slice(2);
const fase = args.includes("--fase") ? args[args.indexOf("--fase") + 1] : null;
if (!process.env.DB_URL || (args.includes("--fase") && !FASES.includes(fase))) {
  console.error(
    `uso: DB_URL=... node scripts/check-sem-ia-prontidao.mjs [--fase ${FASES.join("|")}]`,
  );
  process.exit(2);
}
const db = new pg.Client({
  connectionString: process.env.DB_URL,
  ssl: /supabase\.co/.test(process.env.DB_URL) ? { rejectUnauthorized: false } : false,
});
let r;
try {
  await db.connect();
  // só leitura também na sessão: qualquer escrita acidental falha
  await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  r = fase
    ? await checarFaseSemIa((sql) => db.query(sql), fase)
    : await checarProntidaoSemIa((sql) => db.query(sql));
} catch (e) {
  r = fase
    ? { ok: false, fase, bloqueios: [`conexão (${e?.code ?? "erro"})`], avisos: [], manuais: [] }
    : { ok: false, aprovadoJogavel: null, dailyMode: null, motivos: [`conexão (${e?.code ?? "erro"})`] };
} finally {
  await db.end().catch(() => {});
}

if (fase) {
  const d = r.dados ?? {};
  console.log(
    `fase ${fase} · aprovados jogáveis ${d.aprovado_jogavel ?? "?"}/${META_APROVADOS_JOGAVEIS} · daily_mode ${d.daily_mode ?? "?"} · ai_mode ${d.ai_mode ?? "?"} · ` +
      `jogadas 24h ${d.escolha_jogadas_24h ?? "?"} · sem_estoque 24h ${d.sem_estoque_24h ?? "?"} · IA desde a suspensão ${d.ia_desde_ai_mode ?? "?"}`,
  );
  for (const a of r.avisos) console.log(`⚠️  ${a}`);
  for (const m of r.manuais) console.log(`☐ conferir: ${m}`);
  if (r.ok) console.log(`✅ fase ${fase}: PODE SEGUIR (depois de conferir os itens ☐).`);
  else {
    console.error(`⛔ fase ${fase}: NÃO SEGUIR — ${r.bloqueios.join("; ")}`);
    process.exitCode = 1;
  }
} else {
  console.log(
    `aprovados jogáveis: ${r.aprovadoJogavel ?? "?"} (meta ${META_APROVADOS_JOGAVEIS}) · daily_mode: ${r.dailyMode ?? "?"}`,
  );
  if (r.ok) {
    console.log("✅ PRONTO para suspender a IA (janela do modo sem IA).");
  } else {
    console.error(`⛔ NÃO PRONTO: ${r.motivos.join("; ")}`);
    process.exitCode = 1;
  }
}
