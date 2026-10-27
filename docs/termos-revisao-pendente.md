# Termos de Uso — revisão pendente (aprovação do Tito)

> Registrado em 26/10/2026, na rodada do aceite explícito (branch
> `compliance/play-ugc-consent`). O texto de `/terms` **não** foi alterado:
> esta é só a lista do que a política de conteúdo gerado por usuários (UGC) do
> Google Play e a auditoria de prontidão apontaram. Nada aqui inventa o
> responsável pelos dados, o prazo de retenção ou o e-mail de contato.

## O que o aceite desta rodada já resolve

- Aceite **explícito** (caixa desmarcada + links) antes de criar apelido,
  definição ou nome da conta — não vale mais "ao usar você concorda".
- A versão aceita é a data da "Última atualização" de `/terms`
  (`TERMS_VERSION` em `src/lib/terms-consent.ts`; um teste exige que as duas
  andem juntas). **Mudar a data = todos aceitam de novo.**

## O que os Termos de 18/05/2026 ainda precisam (proposta)

| # | Tema | Hoje | Proposta (texto a aprovar) |
|---|---|---|---|
| 1 | Conteúdo proibido | discriminação, sexual envolvendo menores, ameaças/assédio, spam/automação/bugs, acesso indevido | incluir: conteúdo sexual explícito (qualquer), discurso de ódio, violência gráfica ou incitação, incentivo a automutilação, atividades ilegais, dados pessoais de terceiros, personificação, golpes e links |
| 2 | Denúncia e moderação | "filtros automáticos" e "podemos remover/banir" | descrever a 🚩 (denúncia de definição, inclusive as dos bots), a análise humana, as sanções (remoção, banimento temporário ou definitivo por conta e/ou aparelho) e como contestar |
| 3 | Inteligência artificial | não citada | definições e palpites processados pelo Google Gemini (bots e julgamento de semelhança); conteúdo gerado por IA também pode ser denunciado |
| 4 | Licença do conteúdo (§4) | só "enquanto a partida ocorre" | alinhar com o que acontece: fica guardado com o registro da sala e passa pela IA — o **prazo** depende da decisão de retenção (pendente do dono) |
| 5 | Aceitação (§1) | "ao usar você concorda" | citar o aceite pela caixa e o novo aceite a cada revisão relevante |
| 6 | Idade (§2) | "recomendado para 13+" | decidir se 13+ é exigência (afeta o questionário de público-alvo do Play) |
| 7 | Contato (§8) | `hello@verbete.app` (domínio sem MX: não recebe) | trocar quando o dono indicar um e-mail real |
| 8 | Funções que saíram | — | conferir menções a chat (removido em 20/10) também na Política de Privacidade |

## Como aplicar quando aprovado

1. O dono aprova o texto (e define idade, retenção e contato).
2. Um PR troca `src/routes/terms.tsx`, a data "Última atualização" e
   `TERMS_VERSION` (o teste de versão falha se só um dos dois mudar).
3. Depois do deploy, todos os aparelhos aceitam a nova versão uma vez, no
   próximo conteúdo que criarem.
