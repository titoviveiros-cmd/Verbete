# Checklist de Teste Interno Android — Verbete

> **Candidato:** AAB assinado do commit `bb08c58` (artifact `verbete-release-aab`,
> run https://github.com/titoviveiros-cmd/Verbete/actions/runs/30823653635)
> **Versão do app:** 2.0.0 (versionCode 2)
> **Como usar:** siga os testes em ordem. Marque `[ ]` → `[P]` (passou) ou `[F]` (falhou).
> **Em QUALQUER falha:** tire print da tela inteira, anote o nº do teste, o **código da
> sala** (canto superior esquerdo) e o horário — e me mande. Não precisa investigar.

---

## SEÇÃO A — OBRIGATÓRIOS (1 aparelho; bots substituem outros jogadores)

**A-1. Upload do AAB no Teste interno**
- Ação: Play Console → Testar e lançar → Teste interno → Criar nova versão → arrastar o `app-release.aab` (baixado do run acima, descompactado do zip).
- Esperado: upload conclui; a versão aparece como "2.0.0 (2)".
- [ ] PASSOU / FALHOU — Se falhar: print da mensagem de erro da Play Console.

**A-2. Play Console aceita o bundle**
- Ação: após o upload, revisar a página da versão antes de salvar.
- Esperado: nenhum ERRO em vermelho (avisos amarelos sobre "símbolos de depuração/deobfuscação" são normais e não bloqueiam).
- [ ] PASSOU / FALHOU — Se falhar: print da lista de erros.

**A-3. Instalação pela Play Store**
- Ação: salvar a versão → aba Testadores → criar lista com seu e-mail → copiar o "link de participação" → abrir NO CELULAR → aceitar o convite → instalar pela Play Store.
- Esperado: app "Verbete" instala com o ícone da marca (tile roxo com V).
- [ ] PASSOU / FALHOU — Se falhar: print da tela da Play Store.

**A-4. Primeiro launch**
- Ação: tocar no ícone do Verbete.
- Esperado: app abre em menos de ~5s, sem tela branca nem erro.
- [ ] PASSOU / FALHOU — Se falhar: print/filmagem da abertura.

**A-5. Splash screen**
- Ação: observar a abertura do app.
- Esperado: splash roxa escura com o logo Verbete centralizado (não a splash genérica do Capacitor).
- [ ] PASSOU / FALHOU — Se falhar: print da splash exibida.

**A-6. Login e criação de conta**
- Ação: Home → Perfil → Entrar → tocar "Entrar com Google" → escolher sua conta.
- Esperado: volta ao app logado; o Perfil mostra seus dados.
- [ ] PASSOU / FALHOU — Se falhar: print da tela onde parou + mensagem de erro.

**A-7. Login persiste após fechar o app**
- Ação: fechar o app COMPLETAMENTE (recentes → deslizar para fora) → reabrir → ir ao Perfil.
- Esperado: continua logado, sem pedir login de novo.
- [ ] PASSOU / FALHOU — Se falhar: print do Perfil.

**A-8. Home**
- Ação: observar a tela inicial.
- Esperado: logo + "Verbete", botões CRIAR SALA / ENTRAR COM CÓDIGO, atalhos Como jogar / Ranking / Desafio / Perfil, card de estatísticas. Tudo em português, nada cortado.
- [ ] PASSOU / FALHOU — Se falhar: print da Home.

**A-9. Criação de sala**
- Ação: CRIAR SALA → preencher apelido → Criar!
- Esperado: entra no lobby com código de 4 dígitos no topo.
- [ ] PASSOU / FALHOU — Se falhar: print + anotar o apelido usado.

**A-11. Lobby**
- Ação: no lobby, observar sua ficha de jogador e as opções do anfitrião (modo, rodadas, categorias, nível).
- Esperado: você aparece na lista com avatar/cor; opções respondem ao toque.
- [ ] PASSOU / FALHOU — Se falhar: print do lobby.

**A-34. Bots**
- Ação: no lobby, adicionar 2 bots (botão de adicionar bot).
- Esperado: os bots aparecem na lista imediatamente, com nomes tipo "Zé Tagarela".
- [ ] PASSOU / FALHOU — Se falhar: print do lobby.

**A-12. Início de partida**
- Ação: tocar "Começar".
- Esperado: cortina de transição e a fase "Escolha da Palavra" começa (você ou um bot é sorteado coordenador).
- [ ] PASSOU / FALHOU — Se falhar: print + código da sala.

**A-13. Escolha da palavra**
- Ação: se você for o coordenador: "Sortear palavra" → escolher 1 das 3 cartas. Se for um bot, apenas aguardar (~5s).
- Esperado: a palavra é escolhida e o jogo segue para a escrita.
- [ ] PASSOU / FALHOU — Se falhar: print da tela de escolha.

**A-14. Envio de definição**
- Ação: na fase de escrita, digitar uma definição falsa (ou usar uma sugestão pronta) → "Enviar definição".
- Esperado: confirmação de envio; quando todos enviam, vai para o embaralhamento.
- [ ] PASSOU / FALHOU — Se falhar: print + o texto que tentou enviar.

**A-15. Votação**
- Ação: ler as cédulas e tocar na que acha verdadeira (a sua própria fica bloqueada).
- Esperado: voto registrado com vibração curta; timer visível; ao final, vai para a revelação.
- [ ] PASSOU / FALHOU — Se falhar: print da votação + código da sala.

**A-16. Revelação**
- Ação: assistir à revelação completa.
- Esperado: blefes eliminados de baixo para cima, verdade no topo em destaque, pontos aparecendo nos cards (incluindo 🧠 +3 se alguém chegou perto da verdade).
- [ ] PASSOU / FALHOU — Se falhar: print da revelação inteira.

**A-17. Placar**
- Ação: observar o placar da rodada.
- Esperado: título "Placar" com o troféu dourado; sua pontuação bate com a revelação (ex.: acertou a verdade = +3); breakdown explica cada ponto.
- [ ] PASSOU / FALHOU — Se falhar: print do placar + print da revelação anterior.

**A-18. Avanço de rodada**
- Ação: "Próxima rodada".
- Esperado: nova rodada começa com outro coordenador; placar acumula.
- [ ] PASSOU / FALHOU — Se falhar: print.

**A-19. Fim da partida**
- Ação: jogar até o número de rodadas configurado (dica: configure 2 rodadas no lobby para o teste ser rápido).
- Esperado: tela final com pódio (1º maior, com coroa), confete e estatísticas divertidas.
- [ ] PASSOU / FALHOU — Se falhar: print da tela final.

**A-20. XP e conquistas**
- Ação: na tela final (logado), observar o ganho de XP; depois abrir o Perfil.
- Esperado: XP ganho aparece; Perfil mostra nível/barra de XP e conquistas desbloqueadas.
- [ ] PASSOU / FALHOU — Se falhar: prints da tela final e do Perfil.

**A-23. Som**
- Ação: jogar uma rodada com volume alto; testar o botão de som (🔊) no topo da sala.
- Esperado: música por fase + efeitos (contagem, voto, revelação); mudo silencia tudo.
- [ ] PASSOU / FALHOU — Se falhar: anotar em qual momento o som falhou.

**A-24. Haptics (vibração)**
- Ação: com o som LIGADO (o mudo desliga a vibração junto), sentir: confirmar voto, últimos 3s do timer, revelação, pódio.
- Esperado: vibrações curtas e distintas em cada um desses momentos.
- [ ] PASSOU / FALHOU — Se falhar: anotar quais momentos vibraram e quais não.

**A-25. Minimizar e retornar durante rodada**
- Ação: no MEIO da votação, ir para a Home do Android (~10s) → voltar ao app.
- Esperado: tela sincronizada com a fase atual em ~1s; timer correto; sem "tempo acabou" indevido.
- [ ] PASSOU / FALHOU — Se falhar: print + código da sala + horário.

**A-26. Bloquear/desbloquear o telefone**
- Ação: durante a escrita, bloquear a tela (~15s) → desbloquear.
- Esperado: igual ao A-25 — ressincroniza sozinho.
- [ ] PASSOU / FALHOU — Se falhar: print + código da sala.

**A-27. Alternar Wi-Fi/dados móveis**
- Ação: no lobby ou entre rodadas, desligar o Wi-Fi (ficando no 4G/5G) e continuar jogando.
- Esperado: no máximo alguns segundos de "reconectar" e o jogo segue normal.
- [ ] PASSOU / FALHOU — Se falhar: print + qual rede estava usando.

**A-28. Perder conexão e reconectar**
- Ação: modo avião por ~10s durante uma rodada → desligar modo avião.
- Esperado: indicador de reconexão aparece; ao voltar a rede, o jogo ressincroniza sem travar (pode haver penalidade de tempo se o prazo estourou — isso é regra, não bug).
- [ ] PASSOU / FALHOU — Se falhar: print + código da sala.

**A-29. Fechar o app e voltar à mesma sala**
- Ação: durante uma partida, fechar o app COMPLETAMENTE → reabrir → CRIAR/ENTRAR? Não: a Home deve oferecer voltar, ou entre com o mesmo código da sala.
- Esperado: você volta à MESMA sala, com sua pontuação preservada.
- [ ] PASSOU / FALHOU — Se falhar: print + código da sala.

**A-31. Botão Voltar do Android**
- Ação: (a) numa tela interna (ex.: Ranking), tocar Voltar; (b) na Home, tocar Voltar.
- Esperado: (a) volta à tela anterior; (b) o app MINIMIZA (não fecha nem crasha).
- [ ] PASSOU / FALHOU — Se falhar: descrever em qual tela e o que aconteceu.

**A-39. Idioma das mensagens**
- Ação: ao longo de todos os testes, observar mensagens, avisos e erros.
- Esperado: tudo em português (nenhum texto em inglês visível).
- [ ] PASSOU / FALHOU — Se falhar: print de cada texto em inglês encontrado.

**A-40. Estabilidade geral**
- Ação: ao final da bateria, responder: houve algum crash, tela branca ou travamento?
- Esperado: nenhum.
- [ ] PASSOU / FALHOU — Se falhar: descrever o momento exato + prints.

---

## SEÇÃO C — DOIS APARELHOS (obrigatórios para liberar o multiplayer real)

> Use o 2º aparelho com o link de testador também instalado — ou, na falta,
> o navegador do 2º aparelho em jogo.verbete.workers.dev (vale como teste).

**C-10. Entrada de segundo jogador**
- Ação: aparelho 1 cria sala; aparelho 2: ENTRAR COM CÓDIGO → digitar o código.
- Esperado: o jogador 2 aparece no lobby do aparelho 1 em ~2s (e vice-versa).
- [ ] PASSOU / FALHOU — Se falhar: prints DOS DOIS aparelhos + código.

**C-21. Chat**
- Ação: no lobby, abrir o chat (balão rosa) no aparelho 1 e enviar mensagem; responder do aparelho 2.
- Esperado: mensagens chegam nos dois lados em ~1s; lista de conectados visível; durante a rodada o chat fica restrito (por design).
- [ ] PASSOU / FALHOU — Se falhar: prints dos dois chats.

**C-22. Reações**
- Ação: durante a votação, tocar um emoji da barra inferior no aparelho 1.
- Esperado: a reação voa na tela DOS DOIS aparelhos.
- [ ] PASSOU / FALHOU — Se falhar: print do aparelho que não mostrou.

**C-32. Compartilhamento**
- Ação: (a) no lobby, usar o botão de convite/compartilhar link e abrir o link no aparelho 2; (b) após uma revelação, tocar "Compartilhar replay".
- Esperado: (a) o link abre direto na sala (com o app instalado, abre NO APP); (b) gera o card/replay para compartilhar.
- [ ] PASSOU / FALHOU — Se falhar: print + para onde o link levou.

**C-EXTRA (recomendado): partida completa 2 aparelhos + 2 bots**
- Ação: jogar 2 rodadas completas com essa formação.
- Esperado: fases sincronizadas nos dois aparelhos do início ao fim.
- [ ] PASSOU / FALHOU — Se falhar: prints dos dois + código.

---

## SEÇÃO B — RECOMENDÁVEIS (não bloqueiam a liberação)

**B-30. Safe areas, notch e teclado**
- Ação: em telas com recorte/notch, verificar topo e rodapé de todas as fases; abrir o teclado na escrita e no chat.
- Esperado: nada escondido sob o notch/barra; o teclado não cobre o campo de digitação.
- [ ] PASSOU / FALHOU — Se falhar: print da tela com o problema.

**B-33. Sala pública/partida rápida**
- Nota: recurso REMOVIDO da interface por decisão de design (2026-07-19) — redundante com Criar sala. Não há o que testar. **N/A por design.**

**B-35. Tela de perfil**
- Ação: abrir o Perfil e percorrer: dados, nível/XP, conquistas, histórico.
- Esperado: informações corretas e coerentes com as partidas jogadas.
- [ ] PASSOU / FALHOU — Se falhar: print.

**B-36. Configurações disponíveis**
- Ação: testar os controles existentes: som/mudo (topo da sala), tema claro/escuro (onde exibido), sair da conta no Perfil.
- Esperado: cada controle surte efeito imediato. (Não existe tela "Configurações" dedicada — é por design.)
- [ ] PASSOU / FALHOU — Se falhar: qual controle e o que fez.

**B-37. Ranking**
- Ação: Home → Ranking.
- Esperado: tabela carrega com jogadores e pontuações.
- [ ] PASSOU / FALHOU — Se falhar: print.

**B-38. Modo diário**
- Ação: Home → Desafio → ler a palavra do dia → escrever seu palpite de significado → enviar.
- Esperado: recebe % de proximidade e pontos; contagem para o próximo desafio aparece.
- [ ] PASSOU / FALHOU — Se falhar: print + o palpite enviado.

---

## Critério de liberação
- **Libera a próxima etapa** (promover para produção): todos os itens de A e C com PASSOU (B não bloqueia; B-33 é N/A).
- **Qualquer FALHOU**: me envie os prints/anotações — eu investigo pelo próprio banco/telemetria (os erros do app já são registrados automaticamente no painel /admin/ops).
