const form = document.querySelector('#quote-form');
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    quantity: form.quantity.value,
    unitPrice: form.unitPrice.value,
  };
  const res = await fetch('/api/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  document.querySelector('#total-value').textContent = brl.format(data.total);
});
