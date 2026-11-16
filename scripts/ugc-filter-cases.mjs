// Casos do filtro de conteúdo de jogador (ECA Digital, 11/11/2026). Usados
// pelo teste do cliente (src/lib/__tests__/ugc-filter-parity.test.ts) e pelo
// do banco (scripts/test-ugc-filtro.mjs): as duas regras têm de responder
// IGUAL a cada caso. [texto, motivo esperado ou null]
export const UGC_CASES = [
  // palavrão (começo de palavra, sem acento, maiúscula)
  ["que porra é essa", "blocked_word"],
  ["PORRADA geral", "blocked_word"],
  ["seu otário", "blocked_word"],
  ["sapatão", "blocked_word"],
  ["vtnc mano", "blocked_word"],
  // link
  ["veja https://x.com", "link"],
  ["entra em www.site.com.br", "link"],
  ["HTTP://EXEMPLO.ORG/a", "link"],
  // contato: telefone, @, e-mail, rede social
  ["me chama 11987654321", "contact"],
  ["liga (11) 98765-4321", "contact"],
  ["11 9 8765 4321", "contact"],
  ["me segue @fulano_23", "contact"],
  ["manda no fulano@gmail.com", "contact"],
  ["chama no zapzap", "contact"],
  ["me add no Instagram", "contact"],
  ["discord: fulano", "contact"],
  ["WhatsApp", "contact"],
  // legítimo: trecho dentro de outra palavra, números curtos, @ sozinho
  ["computador antigo de 1985", null],
  ["disputa entre vizinhos", null],
  ["tecido usado em velas no seculo 19", null],
  ["peixe amarelo e grande", null],
  ["2 + 2 = 4 e 10 x 10 = 100", null],
  ["preço: 1.500 reais", null],
  ["sinal @ sozinho", null],
  ["face de um dado", null],
  ["Zé_Tagarela-2", null],
  ["Jogador", null],
  ["", null],
];
