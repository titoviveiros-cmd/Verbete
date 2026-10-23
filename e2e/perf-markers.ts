// Marcos de tela do cronômetro de partida (e2e/perf-round.spec.ts).
// innerText respeita text-transform (as sobrancelhas são CAIXA ALTA): todo
// marco de texto compara sem diferenciar maiúsculas.
export const MARKERS = () => {
  const w = window as unknown as {
    __perf: {
      log: Array<[number, string, 0 | 1]>;
      on: Record<string, boolean>;
    };
  };
  w.__perf = { log: [], on: {} };
  const PHASE_TITLES = [
    "Escolha da Palavra",
    "Hora de Inventar",
    "Placar da Rodada",
    "Fim de Jogo",
  ];
  const checks: Record<string, () => boolean> = {
    cortina: () =>
      Array.from(document.querySelectorAll('[role="status"]')).some((s) =>
        PHASE_TITLES.includes((s.textContent ?? "").trim()),
      ),
    lobby: () => /Sala de espera/i.test(document.body.innerText),
    escolhendo: () => /Coordenador da rodada/i.test(document.body.innerText),
    sortear: () =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        /Sortear palavra/.test(b.textContent ?? ""),
      ),
    palavras: () =>
      /Escolha uma palavra rara/i.test(document.body.innerText) &&
      document.querySelectorAll("button.sticker").length >= 3,
    escrita: () =>
      !!document.querySelector(
        '[placeholder="escreva sua definicao mirabolante..."]',
      ),
    embaralhando: () =>
      /Embaralhando as cédulas/i.test(document.body.innerText),
    votacao: () =>
      !!document.querySelector("button .token") &&
      /Qual é o significado de/i.test(document.body.innerText),
    revelacao: () => /A definição verdadeira/i.test(document.body.innerText),
    placar: () =>
      /Como cada um pontuou|Pontuação por equipe/i.test(
        document.body.innerText,
      ),
  };
  const tick = () => {
    if (!document.body) return;
    for (const [k, f] of Object.entries(checks)) {
      let v = false;
      try {
        v = f();
      } catch {
        v = false;
      }
      if (v !== !!w.__perf.on[k]) {
        w.__perf.on[k] = v;
        w.__perf.log.push([Date.now(), k, v ? 1 : 0]);
      }
    }
  };
  setInterval(tick, 40);
};
