let MIN = 10; // atualizado a partir de /api/config

// estado
let valorSelecionado = null;
let pollTimer = null;

// elementos
const blocos = document.querySelectorAll('.bloco');
const valorCustom = document.getElementById('valorCustom');

const passoValor = document.getElementById('passo-valor');
const passoPix = document.getElementById('passo-pix');
const passoObrigada = document.getElementById('passo-obrigada');
const carregando = document.getElementById('carregando');

const dicaMinimo = document.getElementById('dicaMinimo');
const erroEl = document.getElementById('erro');
const botaoContinuar = document.getElementById('continuar');

const qrImg = document.getElementById('qrImg');
const valorPix = document.getElementById('valorPix');
const pixCodigo = document.getElementById('pixCodigo');
const botaoCopiar = document.getElementById('copiar');
const statusPgto = document.getElementById('statusPgto');
const valorObrigada = document.getElementById('valorObrigada');

const brl = (v) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---- busca o valor mínimo do servidor ----
fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg?.minAmount) {
      MIN = Number(cfg.minAmount);
      valorCustom.min = MIN;
      dicaMinimo.textContent = `Valor mínimo: ${brl(MIN)} 🌷`;
    }
  })
  .catch(() => {});

// ---- seleção dos blocos ----
blocos.forEach((b) => {
  b.addEventListener('click', () => {
    valorCustom.value = '';
    blocos.forEach((x) => x.classList.remove('ativo'));
    b.classList.add('ativo');
    valorSelecionado = Number(b.dataset.valor);
    esconderErro();
  });
});

// ---- input customizado ----
valorCustom.addEventListener('input', () => {
  blocos.forEach((x) => x.classList.remove('ativo'));
  const v = Number(valorCustom.value);
  valorSelecionado = Number.isFinite(v) && v >= MIN ? v : null;
  esconderErro();
});

valorCustom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') continuar();
});

// ---- botão continuar: valida seleção OU input ----
botaoContinuar.addEventListener('click', continuar);

function continuar() {
  const digitado = valorCustom.value.trim();
  let valor = null;

  if (valorSelecionado) {
    valor = valorSelecionado;
  } else if (digitado !== '') {
    valor = Number(digitado);
  }

  if (valor === null) {
    return mostrarErro('Escolha um valor ou digite quanto quer mimar 🌸');
  }
  if (!Number.isFinite(valor) || valor < MIN) {
    return mostrarErro(`O valor precisa ser maior ou igual a ${brl(MIN)} 🌷`);
  }

  valorSelecionado = valor;
  gerarPix(valor);
}

// ---- navegação entre passos ----
function mostrar(passo) {
  [passoValor, passoPix, passoObrigada, carregando].forEach((p) =>
    p.classList.add('escondido')
  );
  passo.classList.remove('escondido');
}

function recomecar() {
  pararPolling();
  blocos.forEach((x) => x.classList.remove('ativo'));
  valorCustom.value = '';
  valorSelecionado = null;
  esconderErro();
  mostrar(passoValor);
}

document.getElementById('voltarPix').addEventListener('click', recomecar);
document.getElementById('maisMimo').addEventListener('click', recomecar);

// ---- gerar PIX ----
async function gerarPix(valor) {
  esconderErro();
  botaoContinuar.disabled = true;
  mostrar(carregando);

  try {
    const res = await fetch('/api/pix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: valor }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Não deu pra gerar o PIX agora.');

    qrImg.src = data.qrCode;
    valorPix.textContent = brl(data.amount);
    pixCodigo.value = data.pixCode;
    botaoCopiar.textContent = 'Copiar';
    botaoCopiar.classList.remove('copiado');
    statusPgto.innerHTML = '<span class="bolinha"></span> aguardando pagamento…';
    mostrar(passoPix);

    // começa a checar se o PIX foi pago
    if (data.transactionId) iniciarPolling(data.transactionId, data.amount);
  } catch (err) {
    mostrar(passoValor);
    mostrarErro(err.message);
  } finally {
    botaoContinuar.disabled = false;
  }
}

// ---- polling de status ----
function iniciarPolling(id, valor) {
  pararPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      if (data.situacao === 'pago') {
        pararPolling();
        valorObrigada.textContent = brl(valor);
        mostrar(passoObrigada);
      } else if (data.situacao === 'falhou') {
        pararPolling();
        statusPgto.innerHTML = '⚠️ pagamento não concluído';
      }
    } catch {
      /* ignora falhas pontuais de rede e tenta de novo */
    }
  }, 4000);
}

function pararPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function mostrarErro(msg) {
  erroEl.textContent = msg;
  erroEl.classList.remove('escondido');
}
function esconderErro() {
  erroEl.classList.add('escondido');
}

// ---- copiar código ----
botaoCopiar.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pixCodigo.value);
  } catch {
    pixCodigo.select();
    document.execCommand('copy');
  }
  botaoCopiar.textContent = 'Copiado ♡';
  botaoCopiar.classList.add('copiado');
  setTimeout(() => {
    botaoCopiar.textContent = 'Copiar';
    botaoCopiar.classList.remove('copiado');
  }, 2000);
});
