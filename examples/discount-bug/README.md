# discount-bug — projeto de teste da POC

Projeto Node.js/TypeScript mínimo, **sem dependências**, com um bug proposital e reproduzível.

- Código: `src/discount.ts`
- Testes: `test/discount.test.ts` (runner nativo `node:test`; o Node ≥ 22.18 executa TypeScript diretamente)

```bash
npm test
```

Estado inicial esperado: **5 testes passam e 1 falha** (`10% de desconto a partir de R$ 100 (inclusive)`).

Regra de negócio: pedidos **a partir de** R$ 100,00 ganham 10% de desconto. O código usa `>` em vez de `>=`.
A correção mínima é trocar `subtotal > VOLUME_THRESHOLD` por `subtotal >= VOLUME_THRESHOLD`.

> Este README descreve a resposta para quem estiver avaliando. Ele **não** é copiado para o workspace do agente
> nos testes automatizados (ver `scripts/prepare-workspace.sh`), para não entregar a solução ao modelo.
