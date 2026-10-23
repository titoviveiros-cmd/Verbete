// Reservas dos bots escolhidas NO SERVIDOR (cópia de src/lib/bot-names.ts,
// BOT_FAKE_DEFINITIONS_TEMPLATES — um teste garante que as duas listas são
// iguais). Segurança: a v2 não aceita textos do client para passar pelo juiz,
// senão a edge viraria um oráculo ("este palpite está perto da verdade?")
// durante a escrita.
export const RESERVE_DEFINITIONS: readonly string[] = [
  "Tipo de dança popular do interior do Brasil",
  "Instrumento usado para medir a temperatura da sopa",
  "Pequeno animal noturno de hábitos solitários",
  "Sentimento que dá depois de comer demais",
  "Móvel de madeira usado em mosteiros antigos",
  "Profissional que conserta sapatos de couro",
  "Ato de espirrar sem cobrir a boca",
  "Espécie rara de cogumelo encontrado em florestas",
  "Movimento brusco da cabeça em sinal de surpresa",
  "Receita de doce típico de festas juninas",
  "Forma antiga de cumprimento entre nobres",
  "Pequena ferramenta usada na carpintaria",
  "Ruído característico de portas mal fechadas",
  "Tipo de penteado popular nos anos 70",
  "Tecido grosso usado em barracas de feira",
  "Peixe de água doce encontrado em rios rasos",
  "Erva aromática usada em chás calmantes",
  "Golpe antigo de luta praticado em vilarejos",
  "Enfeite de metal pendurado em arreios de cavalo",
  "Mancha esbranquiçada que aparece em frutas maduras",
  "Cerimônia de colheita celebrada no outono",
  "Moeda de pouco valor usada em trocas rurais",
  "Espécie de ave que canta apenas ao amanhecer",
  "Nó marinheiro usado para prender redes",
  "Vasilha de barro para armazenar azeite",
  "Doença leve que atinge plantas ornamentais",
  "Passo de dança executado em rodas de festa",
  "Instrumento de sopro feito de bambu",
  "Chapéu de abas largas usado por pescadores",
  "Grito agudo dado em comemorações antigas",
  "Caminho estreito entre plantações",
  "Bebida fermentada servida em festivais de inverno",
  "Pedra lisa usada para amolar facas",
  "Costume de visitar parentes no primeiro domingo do mês",
  "Marca deixada pela chuva em paredes de barro",
  "Pequeno roedor que vive em celeiros",
  "Bolo denso preparado com farinha de milho",
  "Ferramenta curva usada na poda de videiras",
  "Assobio usado por pastores para reunir o rebanho",
  "Faixa de pano amarrada na cintura em danças típicas",
  "Inseto que aparece apenas em noites quentes",
  "Técnica de pesca praticada em águas paradas",
  "Lamparina a óleo usada em porões",
  "Sabor amargo que fica após remédios caseiros",
  "Reunião informal para resolver disputas de vizinhos",
  "Tipo de renda feita à mão no litoral",
  "Barulho ritmado de moinhos de vento",
  "Fruto silvestre de casca espinhosa",
  "Cadeira de balanço feita de vime trançado",
  "Hábito de conversar na porta de casa ao entardecer",
  "Ponto de costura usado em remendos invisíveis",
  "Vento frio que sopra antes da chuva",
  "Brincadeira infantil jogada com tampinhas",
  "Sino pequeno pendurado no pescoço de cabras",
  "Massa frita vendida em portas de igreja",
  "Gesto de respeito feito ao entrar em casa alheia",
  "Cor desbotada típica de roupas lavadas no rio",
  "Ferramenta de ferro usada para marcar gado",
  "Canto repetitivo entoado durante mutirões",
  "Cheiro forte que sobe do chão depois da queimada",
  "Tipo de trança feita em crina de cavalo",
  "Jarro de boca larga usado em quermesses",
];

/** Até `n` reservas sorteadas (Fisher–Yates com o rng dado). */
export function pickReserves(n: number, rng: () => number = Math.random): string[] {
  const a = [...RESERVE_DEFINITIONS];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, Math.max(0, n));
}
