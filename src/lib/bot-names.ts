export const BOT_NAMES = [
  "TioBlefe", "MestreLero", "Dona Lupa", "Zé Tagarela",
  "Profa. Trapaça", "Dr. Engano", "Vó Vera", "Caco Esperto",
];

export const BOT_FAKE_DEFINITIONS_TEMPLATES = [
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
];

export function randomBotDef(seed: number) {
  return BOT_FAKE_DEFINITIONS_TEMPLATES[seed % BOT_FAKE_DEFINITIONS_TEMPLATES.length];
}


