# web-form-bug — segundo teste da POC (navegador)

Aplicação web mínima, sem dependências: `node server.mjs` sobe em `http://localhost:3000`.

Comportamento esperado: preencher Quantidade = 2 e Preço = 19.90 e clicar em **Calcular** deve exibir
`Total: R$ 39,80`.

Bug proposital: o front-end (`public/app.js`) escreve o resultado em `#total-value`, mas o elemento se
chama `#total`. Ao clicar, nada aparece e o console do navegador mostra
`TypeError: Cannot set properties of null`. A API (`/api/quote`) está correta (os testes de API passam),
então o bug só é observável no navegador.

> Este README não é copiado para o workspace do agente.
