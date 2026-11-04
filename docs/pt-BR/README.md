<!-- Tradução produzida com IA a partir de README.md. -->

# taste-library

Uma biblioteca de gosto em design, local, para quem desenvolve com agentes de IA.

[English](../../README.md)

> **Situação:** início do desenvolvimento. Ainda não há nada para instalar.

## Para que serve

Interfaces geradas por IA costumam ficar parecidas entre si. A taste-library ajuda você a levar o seu próprio gosto para o design feito com IA:

1. **Colete** referências: cole prints, URLs de páginas (capturadas por inteiro) ou vídeos curtos.
2. **Anote** com as suas palavras e marque as partes de que você gosta e as de que não gosta.
3. **Organize**: famílias estéticas surgem da sua coleção, com o vocabulário de cada uma, e dá para navegar por tipo de tela, componente e aspecto de design.
4. **Exporte** pacotes de prompts para um projeto: estética, referências numeradas, intenção e limites, prontos para entregar ao seu agente de programação ou à sua ferramenta de imagem.
5. **Traga os resultados de volta** e deixe que eles afinem a próxima rodada.

Ela roda no seu computador, abre no navegador, funciona offline e guarda tudo como arquivos simples em pastas que você escolhe. Um plugin para o Claude Code e um conector MCP deixam o seu agente fazer o trabalho de interpretação nos mesmos arquivos.

## Como este projeto é feito

Este projeto é dirigido pelo seu mantenedor e executado com agentes de IA para programação (Claude Code), desde o primeiro commit. O fluxo de trabalho é versionado junto com o código: o `CLAUDE.md` guarda as regras e o ciclo por issue, e `.claude/agents/` define os agentes especializados. Toda mudança passa por uma issue, uma branch, uma revisão automatizada e um pull request, e só entra depois que o mantenedor revisa e aprova.

## Como contribuir

Veja o [CONTRIBUTING.md](../../CONTRIBUTING.md). Para relatar uma vulnerabilidade, veja o [SECURITY.md](../../SECURITY.md).

## Licença

Ainda não foi escolhida; será definida antes da primeira versão pública.
