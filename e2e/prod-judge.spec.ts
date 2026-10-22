import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🧠 de ponta a ponta num deploy (E2E_BASE_URL) — só com JUDGE_E2E=1.
// Um humano escreve uma PARÁFRASE da verdade (o significado vem do banco,
// só para o teste); o juiz aprova e o +3 entra. Depois simulamos a PERDA
// desse bônus (como na sala 3361: juiz fora do ar) e o reenvio do banco
// (cron a cada minuto) precisa recuperar o +3 — uma vez só, com o Gemini
// de verdade. O banco é lido/escrito pela CLI (`--linked`), só na sala do
// teste; no fim o host reseta a sala para o lobby.
test.skip(
  !process.env.E2E_BASE_URL || !process.env.JUDGE_E2E,
  "só contra um deploy (E2E_BASE_URL) com JUDGE_E2E=1",
);
test.setTimeout(900_000);

const NICK = "Ex: Bia, Zé, Dudu...";
const WRITE = "escreva sua definicao mirabolante...";
const dir = mkdtempSync(join(tmpdir(), "judge-e2e-"));
let n = 0;
function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, `q${n++}.sql`);
  writeFileSync(f, q);
  const out = execSync(`npx supabase db query --linked -f "${f}"`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (JSON.parse(out.slice(out.indexOf("{"))) as { rows: T[] }).rows;
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

test("🧠: paráfrase aprovada (+3) e bônus perdido recuperado pelo reenvio", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  let code = "";
  const humans = () =>
    [
      ["host", host],
      ["convidado", guest],
    ] as const;
  try {
    await host.goto("/");
    await expect(async () => {
      await host.getByRole("button", { name: /Criar sala/ }).click();
      await expect(host.getByPlaceholder(NICK)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await host.getByPlaceholder(NICK).fill("Host J");
    await expect(async () => {
      if (!/\/room\/\d{4}/.test(host.url()))
        await host
          .getByRole("button", { name: /Criar!/ })
          .click({ timeout: 3_000 });
      await expect(host).toHaveURL(/\/room\/\d{4}/, { timeout: 8_000 });
    }).toPass({ timeout: 45_000 });
    code = host.url().match(/room\/(\d{4})/)![1]!;
    console.log(`SALA ${code}`);
    await guest.goto(`/room/${code}`);
    await expect(guest.getByPlaceholder(NICK)).toBeVisible({ timeout: 30_000 });
    await guest.getByPlaceholder(NICK).fill("Conv J");
    await guest.getByRole("button", { name: /Entrar na sala/ }).click();
    await expect(host.getByText("Conv J").first()).toBeVisible({
      timeout: 30_000,
    });
    const seated = async () =>
      Number(
        ((await host.locator("body").innerText()).match(
          /Jogadores \((\d+)\/12\)/i,
        ) ?? [])[1] ?? 0,
      );
    for (let i = 0; i < 2; i++) {
      const before = await seated();
      await host.getByRole("button", { name: /\+1 Bot/ }).click();
      await expect.poll(seated, { timeout: 30_000 }).toBeGreaterThan(before);
    }
    await host.getByRole("button", { name: /Começar/ }).click();
    const [room] = sql<{ id: string }>(
      `select id from public.rooms where code = ${lit(code)} order by created_at desc limit 1;`,
    );
    const roomId = room!.id;

    // escolha: coordenador humano sorteia; bot escolhe sozinho
    await expect(async () => {
      let acted = false;
      for (const [, p] of humans()) {
        const sortear = p.getByRole("button", { name: /Sortear palavra/ });
        if (await sortear.isVisible().catch(() => false)) {
          await sortear.click({ force: true, timeout: 3_000 });
          await p
            .locator("button.sticker")
            .first()
            .click({ force: true, timeout: 15_000 });
          acted = true;
        }
      }
      const writing = await Promise.all(
        humans().map(([, p]) =>
          p
            .getByPlaceholder(WRITE)
            .isVisible()
            .catch(() => false),
        ),
      );
      expect(acted || writing.some(Boolean)).toBeTruthy();
    }).toPass({ timeout: 90_000, intervals: [1_000] });

    // o significado da palavra da rodada (só o teste lê) → paráfrase
    const [mean] = sql<{ meaning: string; word: string }>(
      `select coalesce(w.meaning, rw.meaning) as meaning, coalesce(w.word, rw.word) as word
         from public.rooms r
         left join public.words w on w.id = r.current_word_id
         left join public.room_words rw on rw.id = r.current_word_id
        where r.id = ${lit(roomId)};`,
    );
    const paraphrase = `isto e: ${mean!.meaning}`.toLowerCase().slice(0, 130);
    console.log(`PALAVRA ${mean!.word} — paráfrase: ${paraphrase}`);
    let writer: string | null = null;
    for (const [name, p] of humans()) {
      const field = p.getByPlaceholder(WRITE);
      const coord = p.getByText(/Você é o coordenador/i).first();
      await expect
        .poll(
          async () =>
            (await field.isVisible().catch(() => false)) ||
            (await coord.isVisible().catch(() => false)),
          { timeout: 90_000, intervals: [500] },
        )
        .toBe(true);
      if (!(await field.isVisible().catch(() => false))) continue;
      const text = writer
        ? "danca de roda tipica das festas do interior"
        : paraphrase;
      if (!writer) writer = name;
      await expect(async () => {
        await field.fill(text);
        await p
          .getByRole("button", { name: /Enviar definição/ })
          .click({ timeout: 3_000 });
        await expect(field).toBeHidden({ timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
    }
    expect(writer, "um humano escreveu a paráfrase").not.toBeNull();
    const writerNick = writer === "host" ? "Host J" : "Conv J";

    // votação: os dois humanos votam
    const ballots = (p: Page) =>
      p.locator("button:has(.token):not([disabled])");
    await expect(ballots(host).first()).toBeVisible({ timeout: 120_000 });
    await expect(ballots(guest).first()).toBeVisible({ timeout: 30_000 });
    await ballots(host).first().click({ force: true });
    await guest.waitForTimeout(600);
    await ballots(guest).first().click({ force: true });
    await expect(host.getByText(/A definição verdadeira/i).first()).toBeVisible(
      { timeout: 90_000 },
    );

    // 1) o juiz aprova a paráfrase: near_truth + 3 (assíncrono)
    const state = () =>
      sql<{
        near: boolean;
        score: number;
        attempts: number;
        judged: string | null;
        def_id: string;
        pid: string;
      }>(
        `select d.near_truth as near, p.score, ro.judge_attempts as attempts, ro.judged_at as judged,
                d.id as def_id, p.id as pid
           from public.definitions d
           join public.players p on p.id = d.player_id and p.room_id = d.room_id
           join public.rounds ro on ro.room_id = d.room_id and ro.round = d.round
          where d.room_id = ${lit(roomId)} and d.round = 1 and p.nickname = ${lit(writerNick)};`,
      )[0]!;
    let s1 = state();
    for (let i = 0; i < 30 && !s1.near; i++) {
      await host.waitForTimeout(3_000);
      s1 = state();
    }
    const ev1 = sql<{
      kind: string;
      attempt: string | null;
      scores: string | null;
      reason: string | null;
    }>(
      `select kind, payload->>'attempt' as attempt, payload->>'scores' as scores, payload->>'reason' as reason
         from public.ops_events where payload->>'room_id' = ${lit(roomId)} order by id;`,
    );
    console.log(
      `JUIZ 1ª: near=${s1.near} score=${s1.score} tentativas=${s1.attempts} eventos=${JSON.stringify(ev1)}`,
    );
    expect(s1.near, "paráfrase aprovada pelo juiz").toBe(true);

    // 2) bônus PERDIDO (simulado, como o 503 da sala 3361): desfaz o +3 e a
    //    marca, e a resposta da tentativa "sumiu" há 2 min
    const before = s1.score;
    sql(
      `update public.definitions set near_truth = false where id = ${lit(s1.def_id)};
       update public.players set score = score - 3 where id = ${lit(s1.pid)} and room_id = ${lit(roomId)};
       update public.rounds set judged_at = null, judge_request_id = -1,
              judge_fired_at = now() - interval '2 minutes', scored_at = now() - interval '30 seconds'
        where room_id = ${lit(roomId)} and round = 1;`,
    );
    const lost = state();
    console.log(
      `BÔNUS PERDIDO (simulado): near=${lost.near} score=${lost.score}`,
    );
    // o cron de produção (a cada minuto) reenvia e o juiz de verdade aprova
    let s2 = lost;
    for (let i = 0; i < 40 && !(s2.near && s2.judged); i++) {
      await host.waitForTimeout(5_000);
      s2 = state();
    }
    const ev2 = sql<{
      kind: string;
      attempt: string | null;
      reason: string | null;
    }>(
      `select kind, payload->>'attempt' as attempt, payload->>'reason' as reason
         from public.ops_events where payload->>'room_id' = ${lit(roomId)} order by id;`,
    );
    console.log(
      `REENVIO: near=${s2.near} score=${s2.score} tentativas=${s2.attempts} julgada=${!!s2.judged} eventos=${JSON.stringify(ev2)}`,
    );
    expect(s2.near, "o reenvio recuperou o near_truth").toBe(true);
    expect(s2.score, "+3 de volta, uma vez só").toBe(before);
    expect(s2.attempts, "2ª tentativa").toBe(2);
    // e não dobra: espera mais um ciclo do cron
    await host.waitForTimeout(65_000);
    const s3 = state();
    console.log(
      `DEPOIS DE MAIS UM CICLO: score=${s3.score} tentativas=${s3.attempts}`,
    );
    expect(s3.score, "sem +3 dobrado").toBe(before);
    expect(s3.attempts).toBe(2);
    console.log(
      `=== JSON ${JSON.stringify({ code, word: mean!.word, before, lost: lost.score, after: s2.score, attempts: s2.attempts, final: s3.score })}`,
    );
  } finally {
    if (code) {
      try {
        await host
          .getByRole("button", { name: "Resetar jogo" })
          .click({ timeout: 15_000 });
        await host
          .getByRole("button", { name: /Sim, resetar/ })
          .click({ timeout: 10_000 });
        await expect(
          host.getByRole("button", { name: /Começar|Mín\. 4/ }),
        ).toBeVisible({ timeout: 30_000 });
        console.log(`SALA ${code} RESETADA PARA O LOBBY`);
      } catch (e) {
        console.log(`RESET FALHOU: ${String(e).slice(0, 200)}`);
      }
    }
    await hostCtx.close();
    await guestCtx.close();
  }
});
