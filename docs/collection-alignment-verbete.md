# Verbete — Collection Alignment + Social Share Preview

> Rodada de 18/10/2026 · branch `collection-alignment` (a partir do master
> `8b05157`, que é o build em produção). **Sem deploy.** Aguarda aprovação
> visual do Tito.
>
> **Intocáveis (não mudaram):** calibração semântica, corte 80, prompt
> semântico, score-similarity, pontuação do Diário, bônus +3, pontuação, XP,
> streak, migrations, RLS, backend, banco, palavras e regras do
> multiplayer. A rodada mexe só em apresentação (CSS/JSX), na imagem de
> prévia de link e nas metatags.

## 1. Referências inspecionadas (fonte → o que foi lido)

| Fonte | Arquivo | Situação |
|---|---|---|
| DNA da família (ratificado pelo dono) | `Documents/king/docs/VERBETE-GAME-DNA.md` | ✅ lido |
| Design System do KING (tokens congelados da Home) | `Documents/king/docs/KING-DESIGN-SYSTEM.md` | ✅ lido |
| Placar Final do KING renderizado | `king/apps/web/playwright-report/data/*.png` (2 capturas) | ✅ visto |
| Tokens e botões do TITOKO | `collection-puzzle/src/app/theme.css` | ✅ lido |
| Prévia de link do TITOKO | `collection-puzzle/public/titoko-social-day-v2-1200x630.png` + DEC-222 | ✅ visto/lido |
| Identidade v1.0 do TITOKO (folhas, diálogos) | `collection-puzzle/docs/DECISIONS.md` DEC-212/DEC-214 | ✅ lido (texto) |
| Home do KING (artifact 69477d05) | claude.ai | ⚠️ **NÃO VERIFICADO** visualmente (só a descrição no DS) |
| Telas do TITOKO renderizadas | — | ⚠️ **NÃO VERIFICADO** visualmente (só tokens, decisões e a arte social) |

## 2. DNA compartilhado — o que a coleção tem em comum

Os valores abaixo **existem nos dois irmãos** (KING `KING-DESIGN-SYSTEM.md`,
TITOKO `theme.css`) e agora também no Verbete (`src/styles.css`, tokens `--c-*`):

| Papel | KING | TITOKO | Verbete (antes) | Verbete (agora) |
|---|---|---|---|---|
| Noite (fundo) | `#140a24` | `#140b26` | `oklch(.22 .09 290)` ≈ `#1e0f3d` liso | `#150a2c` + brilho roxo no alto e neon nas bordas |
| Superfície / peça | `#241546` / `#2d1a56` | `#241746` / `#2e1e58` | `oklch(.28 .10 285)` | `#261650` / `#311d66` com relevo |
| Ouro (CTA, vitória, 1º) | `#f4c542` | `#f4c542` (+ top/low/edge) | amarelo-limão `#ffde00` só na Home | `#f4c542` + topo `#ffe27a` + aresta `#7a5510` |
| Turquesa (positivo/verdade) | `#2dd4bf` | `#2dd4bf` | menta `oklch(.82 .16 175)` | `#2dd4bf` |
| Magenta (tensão/destaque) | `#e0338a` | `#ff4f9e` | rosa `oklch(.72 .22 0)` | `#ff4f9e` |
| Violeta / roxo | `#9b6cff` / `#6d28d9` | `#9b6cff` / `#6d28d9` | grape `oklch(.55 .2 305)` | `#9b6cff` / `#6d28d9` |
| Corpo de texto | Nunito 400/700 | Nunito 400/700/800 | **declarada mas nunca carregada** (caía na fonte do sistema) | Nunito 400–800 carregada |
| Botão assinatura | candy, aresta dura `0 7px 0`, afunda no toque | candy, aresta `0 5px 0`, afunda 70 ms, volta com quique | `.btn-pop` com sombra suave; CTAs em degradê rosa | candy da coleção (aresta `0 5px 0`, afunda 3 px em 70 ms, quique `cubic-bezier(.3,1.4,.6,1)`) |
| Variantes | ouro (primário) · violeta (secundário) · ghost turquesa (bots) | ouro · violeta · ghost turquesa · plain | — | **as mesmas**: `btn-gold`, `btn-violet`, `btn-turq`, `btn-plain` (+ `btn-neon`, só do Verbete) |
| Sobrancelha de seção | caixa alta, espaçada | `.eyebrow` .78rem 800 .14em | texto 10–11 px avulso | `.eyebrow` (Nunito 800, .14em) |
| Foco de teclado | dourado | turquesa 3 px | **invisível** (`hsl()` sobre token oklch = declaração inválida) | turquesa 3 px |
| Mascote com estados + flutuação | O Rei (arquitetura de humores) | turma do Titoko | Livro (fora da Home) | Livro de volta à Home, no Lobby, na escolha, na escrita, na revelação, no Diário e no pódio |

### Personalidade própria do Verbete (preservada)
- **Neon magenta** da noite de jogo (`--v-neon #ff3fae`): brilho atrás da marca,
  a palavra da rodada, seleção de cédula, opções escolhidas, chat.
- **A palavra como "verbete de dicionário"** (`.word-hero`): cartão neon com as
  linhas da página por cima — o nome do jogo virou linguagem visual.
- Display **Fredoka** (KING usa Gabarito; TITOKO, Nunito 800 — cada irmão com o seu).
- **Livro Mascote**, tile "V + livro" e wordmark branco com contorno roxo — intactos.
- Letras de dicionário flutuando na Home (A, ?, Ç, é, !) no lugar dos confetes.

## 3. Sistema visual (consolidado em `src/styles.css`)

| Peça | Classe | Uso |
|---|---|---|
| Botão candy | `.btn-pop` + `.btn-gold` / `.btn-violet` / `.btn-neon` / `.btn-turq` / `.btn-plain` | ouro = ação principal da tela (comedido); violeta = secundária; turquesa = bots; plain = voltar/sair |
| Desabilitado | `.btn-pop:disabled` | vira vidro neutro com texto apagado (ouro a meia opacidade parecia barro) |
| Peça de jogo | `.sticker` | cédulas, linhas de placar, cartões de resultado: luz no topo + aresta + sombra |
| Painel | `panel` (`@utility`, aceita `lg:panel`) | contêiner de seção (vidro escuro) |
| Vidro | `.glass-tile` | ações terciárias e botões redondos do topo |
| Campo | `.field` | textarea/inputs: poço escuro, anel neon no foco (o anel é o foco) |
| Ficha | `.token` | letra da cédula (moeda ouro com aresta) |
| Segmentado | `.seg` / `.seg-on` | opções da sala; a escolhida acende em neon |
| Barras | `.meter` + `.meter-fill-gold` / `-turq` / `-urgent` | tempo, progresso, semelhança |
| Palavra | `.word-hero` | palavra da rodada e do Diário |
| Revelação | `.truth-card`, `.truth-seal`, `.bluff-stamp` | verdade turquesa com selo ouro; blefes carimbados |
| Embaralhar | `.card-back` | verso da cédula (roxo, filete ouro, marca) |
| Pódio | `.podium-block` + `.podium-gold/-silver/-bronze` | degraus metálicos "candy" |
| Destaques | `.ring-gold` (1º/vencedor) · `.ring-neon` (seleção) · `.text-gold-grad` · `.text-neon` | |
| Palco desktop | `.mobile-shell.stage-wide` | ≥1024 px: moldura larga (até 1240 px) em vez da coluna de celular |

Os tokens antigos (`--sun`, `--mint`, `--pink`, `--card`, `--background`…)
agora apontam para os da coleção — as ~400 classes `text-sun`, `bg-card`,
`text-mint` do app mudaram juntas, sem caça a cores avulsas. Tema claro
(creme) redefinido com os mesmos papéis (ouro escuro `#9a6200` para texto,
turquesa `#0b7166`).

## 4. Telas — o que mudou

| Tela | Antes | Agora |
|---|---|---|
| **Home** (âncora) | degradê magenta→azul de "festa", confetes, estrela/coração; desktop = coluna de 448 px | noite roxa com brilho neon atrás da marca, Livro ao lado do tile, letras flutuando; CTA ouro "Criar sala", violeta "Entrar com código", vidro para Como jogar/Ranking/Desafio; **desktop em 2 colunas** (herói + "Invente/Engane/Descubra" | painel de ações) |
| **Diário** | coluna única, cartões lavados, "Como calculamos" sempre aberto | palavra do desafio como verbete neon; o Livro pensa durante o palpite e, no resultado, comemora ou lamenta no lugar do emoji; impacto "+78 pts" em ouro; **barra de semelhança com a marca dos 80%**; palpite × verdade lado a lado; "Como calculamos" recolhível; ranking com medalhas e "você"; desktop em 2 colunas |
| **Lobby** | painéis cinza, botões rosa/menta | cabeçalho "Sala de espera" com Livro + "Convidar" ouro; assentos; bots em ghost turquesa; opções em segmentados neon; "Começar!" ouro; **desktop: jogadores + ação à esquerda, opções à direita** |
| **Escolha da palavra** | mascote + nome amarelo | coordenador com avatar em anel ouro e nome em degradê; "Sortear palavra" ouro; 3 palavras como cartões de dicionário (3 colunas no desktop); quem espera vê "Fulano está escolhendo…" |
| **Escrever** | palavra rosa, botões rosa | palavra neon de dicionário, tempo em ouro, campo com anel neon, sugestões em vidro, "Enviar" ouro; desktop: palavra/tempo + **dica de blefe com o Livro** \| área de escrita |
| **Embaralhar** | 5 cartas abrem e fecham uma vez | **micro-evento em laço**: uma carta por cédula (4–7) com verso roxo/filete ouro, abre em leque e embaralha enquanto a votação prepara; "Qual delas é a verdade?" |
| **Votação** | cartões cinza, letra amarela | cédulas como peças com **ficha ouro** (A–F), seleção com anel neon, "SUA" em turquesa; cabeçalho "Qual é o significado de…" + tempo; **2 colunas no desktop** |
| **Revelação** | verdade em cartão menta, blefes riscados | suspense com Livro "uau" e pulso neon; blefes eliminados com **carimbo BLEFE**; verdade em peça turquesa com **selo ouro ✓ VERDADE**; "Placar em Ns" em pílula; 2 colunas de blefes no desktop |
| **Placar** | "Placar" amarelo, bordas medalha | título em ouro de troféu, 1º com anel ouro, **saldo da rodada ("+5 na rodada")** — a mesma conta que o placar já fazia para a ultrapassagem; "Próxima rodada" ouro |
| **Pódio** | faixa rosa "Fim de jogo!", degraus translúcidos | "**Bia venceu!**" em ouro com o Livro comemorando; **degraus metálicos ouro/prata/bronze** com avatares em anel; títulos (Campeão em anel ouro); XP em pílula ouro; desktop: pódio à esquerda, placar/títulos/destaques à direita |
| **Sala no desktop** | coluna de celular dentro de moldura | **palco largo** + coluna **"Placar ao vivo"** (posição, pontos, quem já enviou/votou, coordenador) nas fases de jogo |

Outros: barra do topo (sobrancelhas "Código"/"Rodada", **"3/10"** quando a
partida é por rodadas, ícones em vidro), barra de reações e chat no padrão
da coleção, botões de login/perfil/ranking/convite/denúncia nas mesmas
variantes, `theme-color` e manifest na noite `#150a2c`, Livro sem o aviso
`<circle> cx undefined` (pupilas andam por transform).

### Capturas antes × depois (celular 390×844 e desktop 1366×768)

Partida simulada idêntica nos dois lados (mesmos jogadores, palavra, votos
e placares); "antes" = master `8b05157`, "depois" = esta branch. Conjunto
completo (7 tamanhos + tema claro) fora do repositório, em
`verbete-capturas/antes` e `verbete-capturas/depois` — regenerável com o
comando da seção 6.

| | |
|---|---|
| ![Home](collection-alignment/home.jpg) | ![Home logada](collection-alignment/home-logada.jpg) |
| ![Diário](collection-alignment/diario.jpg) | ![Diário — resultado](collection-alignment/diario-resultado.jpg) |
| ![Lobby](collection-alignment/lobby.jpg) | ![Escolha](collection-alignment/choosing.jpg) |
| ![Palavras sorteadas](collection-alignment/choosing-palavras.jpg) | ![Escrita](collection-alignment/writing.jpg) |
| ![Embaralhamento](collection-alignment/shuffling.jpg) | ![Votação](collection-alignment/voting.jpg) |
| ![Revelação](collection-alignment/reveal.jpg) | ![Placar](collection-alignment/scoreboard.jpg) |
| ![Pódio](collection-alignment/finished.jpg) | |

## 5. Prévia de link (WhatsApp / Open Graph)

| Antes — `og-verbete.jpg` | Depois — `verbete-social-v2-1200x630.jpg` |
|---|---|
| ![antes](../public/og-verbete.jpg) | ![depois](../public/verbete-social-v2-1200x630.jpg) |

Simulação do balão do WhatsApp (cartão grande e miniatura quadrada; antes
à esquerda, com a copy antiga; depois à direita) —
`node scripts/social-preview-sim.mjs …`:

![Simulação WhatsApp antes × depois](collection-alignment/whatsapp-preview-antes-depois.jpg)

### Diagnóstico (antes)
- `og-verbete.jpg` (1200×630, 53 KB): fundo `#0f0a1f` (quase preto), tile à
  esquerda e wordmark à direita. **O quadrado central** (285–915 px, o que o
  WhatsApp mostra quando recorta a prévia) caía no **vão escuro** entre os
  dois: daí o "bloco preto".
- Mesmo nome de arquivo desde julho: celulares que já guardaram a prévia
  não têm motivo para buscar de novo.
- Título/descrição: "Ganhar conhecimento nunca foi tão divertido!" e
  "4 a 12 amigos" (o lobby começa com **2**).

### Depois
- `public/verbete-social-v2-1200x630.jpg` — **JPEG 1200×630, ~89 KB**
  (folga larga sob os ~300 KB em que o WhatsApp descarta sem aviso), gerado
  por `node scripts/gen-store-assets.mjs verbete-social-v2-1200x630.jpg`.
- Composição: noite roxa com brilho neon; **no quadrado central (o recorte
  da miniatura) o tile V com o Livro Mascote espiando, o nome grande e a
  tagline em três cores**; nas laterais, só na prévia larga, o gancho do
  jogo: "Qual é o significado de **Rapapé?**", duas cédulas com definições
  de verdade (B, C em fichas violeta) e a verdade em turquesa ✓. (O Red
  Team derrubou a 1ª versão: barras cinzas pareciam "carregando" e a
  miniatura virava só ícone + nome.)
- Nome com versão (`-v2-`): arte nova = arquivo novo. `og-verbete.jpg`
  continua em `public/` para links/caches antigos.
- Metas (todas no `__root.tsx`, URL absoluta https de `APP_URL`):
  `og:image`, `og:image:secure_url`, `og:image:type` (image/jpeg),
  `og:image:width` 1200, `og:image:height` 630, `og:image:alt`,
  `twitter:card` summary_large_image, `twitter:image`, `twitter:image:alt`,
  `og:title`, `og:description`, `og:url`, `og:site_name`, `og:locale` pt_BR,
  `<link rel="canonical">`. A constante do arquivo vive em
  `src/lib/social-image.ts` (o teste importa a mesma).

### Copy — antes × depois
| Campo | Antes | Depois |
|---|---|---|
| `<title>` / `og:title` | Verbete — Ganhar conhecimento nunca foi tão divertido! | **Verbete — blefe com palavras raras** (cabe numa linha no cartão do WhatsApp) |
| `og:description` (Home) | Multiplayer em tempo real para até 12 amigos. Blefa, vota e ri muito. | **Invente significados, engane os amigos e descubra a verdade. De 2 a 12 jogadores.** (2 linhas, sem corte) |
| `description` | …Multiplayer em tempo real para 4 a 12 amigos… | **Invente significados para palavras raras, engane seus amigos e descubra a verdade. Multiplayer em tempo real, de 2 a 12 jogadores, direto no navegador.** |
| `og:image:alt` | Verbete — jogo multiplayer de blefe com palavras raras do português | **Verbete: a marca V, o Livro Mascote e cédulas de votação na noite roxa — Invente. Engane. Descubra a verdade.** |

### Cache do WhatsApp — como validar (depois do deploy aprovado)
1. Conferir que a imagem responde: `https://jogo.verbete.workers.dev/verbete-social-v2-1200x630.jpg` → 200, `image/jpeg`.
2. O WhatsApp guarda a prévia **por endereço compartilhado**. Para forçar
   leitura nova, compartilhar **`https://jogo.verbete.workers.dev/?v=2`**
   (o app ignora o parâmetro; abre a mesma Home).
3. Numa conversa consigo mesmo: colar o link, esperar a prévia montar
   (2–5 s) **antes** de enviar. Conferir: imagem larga com a marca no centro,
   título "Verbete — blefe com palavras raras" e a descrição nova.
4. Conferir também a prévia **pequena** (link com texto antes): o quadrado
   recortado deve mostrar o tile V + "Verbete", nunca um vão escuro.
5. Se aparecer a arte antiga em `jogo.verbete.workers.dev/` sem parâmetro:
   é cache do aparelho; some sozinho — o `?v=2` prova que o servidor já
   entrega a nova.

## 6. Como testar e capturar (sem backend)

`e2e/visual/` monta a partida inteira **sem Supabase**: `supabase-mock.ts`
intercepta no navegador REST, RPC, auth, edge functions e o WebSocket do
realtime (protocolo 2.0.0, incluindo o ping binário de latência) e
**aborta qualquer rota desconhecida** — o teste visual não consegue tocar
um banco. `fixtures.ts` tem uma partida coerente de 3 rodadas (os placares
batem com os votos: +3 verdade, +1 por voto, +3 🧠).

```bash
npx playwright test e2e/visual                    # 390×844 (o que roda no CI)
VISUAL_VIEWPORTS=all SHOTS_DIR=../verbete-capturas/depois npx playwright test e2e/visual
VISUAL_SCREENS=reveal,finished npx playwright test e2e/visual
```

Checagens em toda tela × tamanho: nenhum erro de página, nenhuma rolagem
horizontal, nenhuma chamada ao Supabase fora do simulador, conteúdo-chave
visível. Telas: Home (visitante e logada), Diário (jogar e resultado),
Lobby, Escolha (antes e depois de sortear), Escrever, Embaralhar,
Votação, Revelação, Placar, Pódio + 4 em tema claro. Tamanhos: 375×812,
390×844, 430×932, 667×375, 768×1024, 1366×768, 1920×1080.

## 7. Áudio e haptics — mapa (sem mudança)

O motor do Verbete (`src/lib/sound.ts`, síntese Web Audio sem arquivos +
vibração semântica) é a origem do que o KING reaproveitou (DNA §4) — a
coerência da coleção já existe. A rodada **não mexeu** em som; só conferiu
que as peças novas disparam os mesmos eventos:

| Momento | Som | Tato |
|---|---|---|
| Qualquer botão (inclui os candy novos) | `playUITap` (ouvinte global em `__root.tsx`) | `vibrate(8)` |
| Escolher palavra / opção | `playUITap` | — |
| Enviar definição | `playSubmit` | — |
| Votar | `playVoteCast` | `vibrate(12)` |
| Alguém cai no seu blefe | `playVoteReceived` | — |
| Embaralhar | `playCardShuffle` | — |
| Revelação | `playRevealBuildUp` → `playRevealStinger` → reação da plateia | `hapticSuccess` / `hapticFail` / `hapticBigWin` |
| Pontos | `playPointMagnitude`, `playStreak` | — |
| Contagem final | `playCountdownTick` / `playCountdownFinal` | `hapticTick` nos 3 s finais |
| Vitória | `playGameWin` + música "victory" | `hapticBigWin` (campeão) / `hapticSuccess` |

## 8. Acessibilidade
- Foco de teclado volta a aparecer (antes: contorno inválido = invisível).
- Campos ganharam `<label htmlFor>` (apelido, código, definição, palpite).
- Botões redondos do topo: 32 px no celular / 36 px a partir de 640 px
  (antes 28 px).
- `prefers-reduced-motion` segue valendo (CSS global + `MotionConfig`); o
  laço do embaralhamento e as letras flutuantes param junto.
- Contraste: texto sobre ouro em `#2a1606`; ouro de texto no tema claro
  `#9a6200`; verdade em `#06221e` sobre turquesa.

## 9. Fora desta rodada (registrado)
- Splash/status bar do app Android (`capacitor.config.ts`, `#0f0a1f`):
  exige novo AAB — fica para a próxima release nativa.
- Telas administrativas e Perfil/Ranking só herdaram tokens e botões
  (sem redesenho).
- Ícones da PWA (`icon-192/512`) não mudaram.

## 10. Resultado dos testes (18/10)

| Verificação | Resultado |
|---|---|
| Lint | 0 erros · 60 avisos (o master tem os mesmos 60) |
| Typecheck | ✅ |
| Unitários (Vitest) | ✅ 123/123 (inclui o teste novo da prévia: arquivo, 1200×630, < 200 KB, metas apontando para ele) |
| Fumaça visual — dev, 17 telas × 7 tamanhos | ✅ 119/119 (1 falha real achada e corrigida: "Sortear palavra" atrás da barra de reações em 667×375) |
| Fumaça visual — **build de produção** (`vite preview`), 17 telas × 2 tamanhos | ✅ 34/34 |
| `e2e/og-image.spec.ts` (dev e build) | ✅ 3/3 — HTTP 200, `image/jpeg`, 1200×630, metas absolutas, canonical |
| Variante `short` (telas baixas) | escolha/pódio sem mascote e embaralhamento compacto abaixo de 520 px de altura |
| CI do PR (integração SQL + Playwright multiplayer contra Supabase local) | ver PR #3 |

## 11. Red Team visual (um só, 15 perguntas)

Notas do Red Team **antes** das correções abaixo: coleção 7 · identidade
própria 8 · desktop 6 · mobile 6 · game feel 7 · prévia 7.

| # | Pergunta | Veredito | O que foi feito |
|---|---|---|---|
| 1 | Alguma tela ainda parece web app? | PARCIAL | Placar: motivos viraram fichas; nota da escrita deixou de parecer botão; cartão de stats some para quem não jogou (painel de zeros) |
| 2 | Destoa de KING/TITOKO? | PARCIAL | **Ouro comedido**: XP em turquesa, ouro só no 1º (pontuação final e ranking do Diário), fichas das cédulas em violeta (ouro só na escolhida); robô "gerar definição" em ghost turquesa (DNA: turquesa = bots) |
| 3 | Perdeu identidade própria? | NÃO | — |
| 4 | Excesso de animação? | PARCIAL | Livro calmo ("idle") na Home e no Lobby; no pódio a festa dura ~4,5 s, a coroa e a medalha param (regra da coleção: nada permanente) |
| 5 | Infantil demais? | PARCIAL (menor) | Emojis dos botões mantidos (personalidade do Verbete, já aprovada) |
| 6 | Desktop com espaço morto? | SIM | Palco com teto de 880 px; Votação, Escrita, Lobby e Diário centrados na altura; Placar em 2 colunas; pódio com piso |
| 7 | Mobile piorou? | PARCIAL | "Nova partida"/"Próxima rodada" com faixa livre para os botões flutuantes; "Entrar com código" numa linha em 375 px; Home rola em vez de transbordar; Lobby sem truncar em ≤389 px |
| 8 | Card administrativo? | SIM | ver 1 e 2 |
| 9 | Pódio/revelação com força? | PARCIAL | Coroa e avatar do campeão maiores, degrau do 1º mais alto, "Compartilhar resultado" depois do pódio; na revelação os botões ficam sempre à vista (fora da rolagem) |
| 10 | Prévia premium e clicável? | PARCIAL | Cédulas com texto de verdade + a pergunta "Rapapé?"; título curto que cabe numa linha; descrição em 2 linhas |
| 11 | Funciona em miniatura? | PARCIAL | Marca maior (tile 220, nome 140) e o Livro dentro do quadrado central; sem pílula |
| 12 | Algo cortado? | SIM | itens de 7, 9 e 10 |
| 13 | Fundo preto/genérico? | PARCIAL | Palco do desktop ganhou o brilho da noite; tema salvo passa a valer em qualquer página (o Diário aberto direto ignorava o tema claro) |
| 14 | Prévia claramente do Verbete? | SIM | — |
| 15 | Prévia parece da coleção? | PARCIAL | Personagem dentro do quadrado (o TITOKO é arte de personagem) — estilo ilustrado fica para arte dedicada |

**Não corrigido de propósito:** a versão (`v <sha>`) no rodapé da Home —
o KING proíbe infra no rodapé público, mas no Verbete ela é o ritual de
playtest aprovado (conferir o build no aparelho); fica a critério do Tito.
