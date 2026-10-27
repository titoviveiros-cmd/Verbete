import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANDROID_PACKAGE,
  CONTACT_EMAIL,
  DELETE_ACCOUNT_PATH,
  contactMailto,
} from "@/lib/legal";

// Páginas legais (rodada 2A da conformidade Google Play, 27/10/2026): o
// contato oficial é decisão do proprietário, os fatos do Suporte foram
// conferidos no código e as promessas sobre exclusão seguem o que
// deleteAccount REALMENTE faz. Estes testes barram a volta dos textos
// antigos (e-mails sem MX, "até 8 jogadores", login Apple, 12+, "fica só o
// apelido", chat como recurso ativo).

const ROOT = resolve(__dirname, "../../..");
/** Fonte com espaços colapsados: o JSX quebra frases em várias linhas. */
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8").replace(/\s+/g, " ");
const ROUTES = {
  privacy: "src/routes/privacy.tsx",
  terms: "src/routes/terms.tsx",
  support: "src/routes/support.tsx",
  download: "src/routes/download.tsx",
  deleteAccount: "src/routes/delete-account.tsx",
} as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("contato oficial", () => {
  it("é o e-mail decidido pelo proprietário (mudar exige mudar este teste)", () => {
    expect(CONTACT_EMAIL).toBe("titoviveiros@hotmail.com");
    expect(contactMailto("Suporte Verbete")).toBe(
      "mailto:titoviveiros@hotmail.com?subject=Suporte%20Verbete",
    );
    expect(contactMailto("A b", "linha 1\nlinha 2")).toBe(
      "mailto:titoviveiros@hotmail.com?subject=A%20b&body=linha%201%0Alinha%202",
    );
  });

  it("nenhum e-mail do domínio sem MX sobrou no app nem nos arquivos públicos", () => {
    const files = [
      ...walk(resolve(ROOT, "src")),
      ...walk(resolve(ROOT, "public")),
    ];
    const hits = files.filter((f) =>
      /@verbete\.app/i.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("toda página pública usa a constante — nenhum mailto escrito à mão", () => {
    for (const [name, path] of Object.entries(ROUTES)) {
      const src = read(path);
      expect(src, name).toMatch(/from "@\/lib\/legal"/);
      expect(src, name).not.toMatch(/mailto:[a-z0-9._%+-]+@/i);
    }
  });
});

describe("exclusão de conta — páginas dizem o que o código faz", () => {
  it("/delete-account existe, é pública e aponta para Privacidade e Suporte", () => {
    const page = read(ROUTES.deleteAccount);
    expect(DELETE_ACCOUNT_PATH).toBe("/delete-account");
    expect(page).toMatch(/createFileRoute\("\/delete-account"\)/);
    expect(page).not.toMatch(
      /useAuth|requireSupabaseAuth|nav\(\{ to: "\/login"/,
    );
    expect(page).toMatch(/to="\/privacy"/);
    expect(page).toMatch(/to="\/support"/);
    expect(page).toMatch(/contactMailto\(/);
  });

  it("os passos citados existem de verdade no Perfil", () => {
    const page = read(ROUTES.deleteAccount);
    const profile = read("src/routes/profile.tsx");
    for (const label of ["Zona de perigo", "Excluir tudo"]) {
      expect(page, label).toContain(label);
      expect(profile, label).toContain(label);
    }
    expect(profile).toMatch(/>\s*Excluir\s*</);
  });

  it("nenhuma página promete o que não acontece (fica mais que o apelido)", () => {
    for (const [name, path] of Object.entries(ROUTES)) {
      expect(read(path), name).not.toMatch(
        /fica só o apelido|sem vínculo com a conta/i,
      );
    }
    for (const path of [ROUTES.privacy, ROUTES.deleteAccount, ROUTES.support]) {
      expect(read(path), path).toMatch(/identificadores técnicos/);
    }
  });

  it("o que a página diz que é apagado bate com as tabelas de deleteAccountData", () => {
    const lib = read("src/lib/account-deletion.ts");
    for (const table of [
      "match_history",
      "daily_attempts",
      "user_achievements",
      "user_stats",
      "profiles",
    ])
      expect(lib, table).toMatch(
        new RegExp(`from\\("${table}"\\)\\.delete\\(\\)`),
      );
    expect(lib).toMatch(/auth\.admin\.deleteUser/);
    const page = read(ROUTES.deleteAccount);
    for (const item of [
      /Conquistas e histórico de partidas/,
      /Desafio Diário/,
      /Estatísticas, XP/,
      /nome exibido no ranking, avatar e cor/,
    ])
      expect(page).toMatch(item);
  });

  it("o pacote Android citado é o do app (capacitor.config.ts)", () => {
    expect(read("capacitor.config.ts")).toContain(
      `appId: "${ANDROID_PACKAGE}"`,
    );
  });

  it("o Suporte tem link visível para a página de exclusão", () => {
    expect(read(ROUTES.support)).toMatch(/to="\/delete-account"/);
    expect(read(ROUTES.privacy)).toMatch(/to="\/delete-account"/);
  });
});

describe("fatos do Suporte, Download e idade", () => {
  it("Suporte: 4 a 12 jogadores, sem Apple/iOS, sem 'até 8', sem prazo prometido", () => {
    const s = read(ROUTES.support);
    expect(s).toMatch(/De 4 a 12/);
    expect(s).not.toMatch(/até 8|8 jogadores/i);
    expect(s).not.toMatch(/Apple|iOS|iPhone/);
    expect(s).not.toMatch(/48h|horas úteis/i);
    expect(s).toMatch(/versão do sistema/);
  });

  it("Download: sem promessa de iPhone/TestFlight e sem dizer que já está na Play", () => {
    const d = read(ROUTES.download);
    expect(d).not.toMatch(/TestFlight|iPhone/);
    expect(d).not.toMatch(
      /dispon[ií]vel (na|no) (Google )?Play|Baixe (na|no) Google Play/i,
    );
    expect(d).toMatch(/em teste/);
  });

  it("idade: nenhuma página fala em 12+; Termos, Privacidade e Suporte dizem 13", () => {
    for (const [name, path] of Object.entries(ROUTES))
      expect(read(path), name).not.toMatch(/12\+/);
    for (const path of [ROUTES.terms, ROUTES.privacy, ROUTES.support])
      expect(read(path), path).toMatch(/13 anos ou mais/);
  });

  it("idade: público-alvo 13 anos ou mais, sem faixa que exclua quem tem 13 e sem classificação inventada", () => {
    // Decisão do proprietário (27/10/2026): público-alvo = 13 anos ou mais.
    // A classificação indicativa será a do IARC/ClassInd — as páginas não
    // podem afirmar nenhuma.
    for (const [name, path] of Object.entries(ROUTES)) {
      const src = read(path);
      expect(src, name).not.toMatch(/maiores de 1[0-9]|1[0-9]\+/);
      expect(src, name).not.toMatch(
        /classifica[çc][ãa]o (indicativa|et[áa]ria)/i,
      );
    }
  });

  it("chat removido (20/10/2026) não aparece como recurso ativo", () => {
    const p = read(ROUTES.privacy);
    expect(p).not.toMatch(/mensagens do chat/i);
    expect(p).toMatch(/chat das salas foi desativado/);
    expect(read(ROUTES.terms)).not.toMatch(/chat/i);
    expect(read(ROUTES.support)).not.toMatch(/chat/i);
  });
});

describe("Termos 2026-10-27 — o que a política de UGC exige", () => {
  it("cobrem conteúdo proibido, denúncia, moderação, IA, licença e novo aceite", () => {
    const t = read(ROUTES.terms);
    for (const topic of [
      /sexual explícito/,
      /envolvendo menores/,
      /ódio/,
      /Ameaças, assédio/,
      /Violência gráfica/,
      /automutilação/,
      /atividades ilícitas/,
      /dados pessoais de outras pessoas/,
      /Se passar por outra pessoa/,
      /Golpes/,
      /Spam/,
      /Links, inclusive maliciosos/,
      /Explorar bugs/,
      /acessar contas, salas ou sistemas sem permissão/,
      /bandeira 🚩/,
      /Denunciar jogador/,
      /banir/,
      /Gemini/,
      /novo aceite/,
      /licença gratuita e não exclusiva/,
    ])
      expect(t).toMatch(topic);
  });

  it("a Política cita o Gemini sem identificadores e os provedores reais", () => {
    const p = read(ROUTES.privacy);
    for (const fact of [
      /Gemini/,
      /Supabase/,
      /Cloudflare/,
      /fontes do jogo/,
      /Não enviamos/,
    ])
      expect(p).toMatch(fact);
  });
});

// Rodada 2B: os prazos só aparecem porque estão implementados e provados
// (migration 20261027200000 + scripts/test-data-retention.mjs). Mudar um
// prazo exige mudar a migration, a suíte e este teste juntos.
describe("retenção — Política e Excluir conta dizem os prazos implementados", () => {
  it("Política: salas 30 d, convidado 30 d sem uso, denúncias 180 d, bans sem apagamento", () => {
    const p = read(ROUTES.privacy);
    expect(p).toMatch(/apagada automaticamente 30 dias depois do encerramento/);
    expect(p).toMatch(/Sala em andamento nunca é apagada/);
    expect(p).toMatch(/depois de 30 dias sem uso/);
    expect(p).toMatch(/apagada automaticamente 180 dias depois da resolução/);
    expect(p).toMatch(/a pendente fica até ser analisada/);
    expect(p).toMatch(/não é apagado automaticamente/);
    expect(p).not.toMatch(/sem apagamento automático hoje/);
    expect(p).not.toMatch(/registros das salas não são apagados/);
  });

  it("Política: nome exibido nunca é o e-mail nem o nome do Google", () => {
    const p = read(ROUTES.privacy);
    expect(p).toMatch(/aparece como “Jogador”/);
    expect(p).toMatch(/nunca usamos o nome do Google nem a parte do e-mail/);
    expect(p).not.toMatch(/se não houver, com a parte do e-mail/);
  });

  it("Excluir conta: salas 30 d, denúncias 180 d, convidado 30 d", () => {
    const d = read(ROUTES.deleteAccount);
    expect(d).toMatch(
      /apagados automaticamente 30 dias depois que a sala é encerrada/,
    );
    expect(d).toMatch(/apagada 180 dias depois da resolução/);
    expect(d).toMatch(/30 dias sem uso/);
    expect(d).not.toMatch(/não são apagados automaticamente/);
  });

  it("a migration de retenção tem os mesmos prazos", () => {
    const m = read("supabase/migrations/20261027200000_data_retention.sql");
    expect(m.match(/now\(\) - interval '30 days'/g)).toHaveLength(2);
    expect(m.match(/now\(\) - interval '180 days'/g)).toHaveLength(1);
    expect(m).not.toMatch(/DELETE FROM public\.banned_players/);
    expect(read("scripts/run-integration.mjs")).toMatch(
      /test-data-retention\.mjs/,
    );
  });
});
