# Cúmplices

Jogo de dedução para **5 a 12 pessoas**, cada uma no seu celular. Dois jogadores são cúmplices e tentam responder igual às perguntas bobas, sem combinar nada. O resto da mesa tenta descobrir quem são.

- **Jogar:** https://raizenbergb.github.io/cumplices/
- **Livro de regras** (com exemplos, dúvidas, variantes e resumo de uma página): https://raizenbergb.github.io/cumplices/regras.html
- **Kit para imprimir** (versão sem celular, PDF com 10 folhas A4): https://raizenbergb.github.io/cumplices/kit/cumplices-kit-para-imprimir.pdf

## Como jogar (versão curta)

1. Uma pessoa toca em **Criar sala**. Os outros entram com o código de 4 letras, o link ou o QR code.
2. O celular sorteia em segredo **dois cúmplices**. Eles sabem quem é a dupla. O resto é detetive.
3. A cada rodada aparece uma pergunta com três respostas. Todos respondem em silêncio.
4. O celular mostra as respostas e diz só uma coisa: os cúmplices responderam **IGUAL** (1 ponto para eles) ou **DIFERENTE**.
5. A partir da segunda pergunta, qualquer um pode acusar uma dupla. Se mais da metade da mesa disser sim, o celular revela. Acertou: os detetives vencem. Errou: os cúmplices ganham 1 ponto.
6. Os cúmplices vencem ao chegar à meta. Os detetives vencem acusando a dupla certa ou se as perguntas acabarem antes.

| Pessoas | Meta dos cúmplices |
|---|---|
| 5 ou 6 | 3 IGUAIS em até 5 perguntas |
| 7 ou 8 | 3 IGUAIS em até 4 perguntas |
| 9 ou 10 | 4 IGUAIS em até 7 perguntas |
| 11 ou 12 | 4 IGUAIS em até 6 perguntas |

Também dá para jogar com **um celular só** (passando de mão em mão) ou **sem celular**, com um narrador. Está tudo no livro de regras.

## Publicar no GitHub Pages (uma vez só)

1. No GitHub, abra o repositório e vá em **Settings → Pages**.
2. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
3. Em **Branch**, escolha **main** e a pasta **/ (root)**. Clique em **Save**.
4. Espere um ou dois minutos. O jogo fica em https://raizenbergb.github.io/cumplices/

## Como o site funciona

- É um site estático (só arquivos), sem servidor próprio e sem custo.
- O celular de quem cria a sala guarda a partida. Ele deve ficar com a tela acesa até o fim. Se a página recarregar, é só tocar em **Voltar para a sala**.
- Os celulares se conectam por dois caminhos ao mesmo tempo:
  - direto, pelo PeerJS (WebRTC);
  - e, como plano B, por servidores públicos de mensagens (MQTT da EMQX e da HiveMQ).

  Cada celular fica com o caminho que abrir primeiro. Se um cair, o outro segura.
- Se a internet oscilar, cada celular volta sozinho para o mesmo lugar. Quem trocou de celular volta pelo mesmo nome.

## Para mexer no código

O código fica na pasta `codigo`. Com o Node.js instalado:

```bash
cd codigo
npm install
npm test          # motor do jogo, sala online, rede e plano B
npm run simular   # simulações de equilíbrio (grava a tabela usada no livro de regras)
npm run build     # gera index.html, regras.html e companhia na raiz do repositório
```

- Regras e metas por número de jogadores: `codigo/src/engine.js`
- Perguntas: `codigo/src/questions.js`
- Telas do jogo: `codigo/src/app.js` e `codigo/src/style.css`
- Livro de regras: `codigo/src/regras.html`
- Kit para imprimir: `python3 codigo/ferramentas/kit.py` (precisa de Python com Playwright)
- Testes no navegador: `codigo/test/e2e_online.py` e `codigo/test/e2e_local.py`

## Créditos

Jogo e código: RaizenbergB, com o Claude. Fontes Rubik e Rubik Dirt (SIL Open Font License). PeerJS (licença MIT). Gerador de QR code qrcode-generator (licença MIT).
