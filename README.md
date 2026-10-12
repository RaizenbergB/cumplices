# Cúmplices

Jogo de dedução para **5 a 12 pessoas**, cada uma no seu celular. Dois jogadores são cúmplices e tentam responder igual às perguntas bobas, sem combinar nada. O resto da mesa tenta descobrir quem são.

**Jogar:** https://raizenbergb.github.io/cumplices/
**Regras completas:** https://raizenbergb.github.io/cumplices/regras.html

## Como jogar (versão curta)

1. Uma pessoa toca em **Criar sala**. Os outros entram com o código de 4 letras, o link ou o QR code.
2. O celular sorteia em segredo **dois cúmplices**. Eles sabem quem é a dupla. O resto é detetive.
3. A cada rodada aparece uma pergunta com três respostas. Todos respondem em silêncio.
4. O celular mostra as respostas e diz só uma coisa: os cúmplices responderam **IGUAL** (1 ponto para eles) ou **DIFERENTE**.
5. A partir da segunda pergunta, qualquer um pode acusar uma dupla. Se mais da metade da mesa disser sim, o celular revela: acertou, os detetives vencem; errou, os cúmplices ganham 1 ponto.
6. Os cúmplices vencem ao chegar à meta. Os detetives vencem acusando a dupla certa ou se as perguntas acabarem antes.

Também dá para jogar com **um celular só** (passando de mão em mão) ou **sem celular**, com um narrador.

## Publicar no GitHub Pages (uma vez só)

1. No GitHub, abra o repositório e vá em **Settings → Pages**.
2. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
3. Em **Branch**, escolha **main** e a pasta **/ (root)**. Clique em **Save**.
4. Espere um ou dois minutos. O jogo fica em https://raizenbergb.github.io/cumplices/

## Como o site funciona

- É um site estático (só arquivos), sem servidor próprio e sem custo.
- O celular de quem cria a sala guarda a partida. Ele deve ficar com a tela acesa até o fim.
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
npm test          # testes do motor, da sala online e da rede
npm run simular   # simulações de equilíbrio
npm run build     # gera index.html, regras.html e companhia na raiz do repositório
```

- O motor do jogo (regras, metas por número de jogadores) está em `codigo/src/engine.js`.
- As perguntas estão em `codigo/src/questions.js`.

## Créditos

Jogo e código: RaizenbergB, com o Claude. Fontes Rubik e Rubik Dirt (licença SIL Open Font License). PeerJS (licença MIT). Gerador de QR code qrcode-generator (licença MIT).
