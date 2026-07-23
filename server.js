import express from 'express';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const {
  SYNCPAY_CLIENT_ID,
  SYNCPAY_CLIENT_SECRET,
  SYNCPAY_BASE_URL = 'https://api.syncpayments.com.br',
  SYNCPAY_POSTBACK_URL = '',
  MOCK_NAME = 'Cliente Mimos',
  MOCK_CPF = '11144477735',
  MOCK_EMAIL = 'mimo@mimos.app',
  MOCK_PHONE = '11999999999',
  PORT = 3000,
} = process.env;

const MIN_AMOUNT = Number(process.env.MIN_AMOUNT) || 10;

// ----------------------------------------------------------
// Cache simples do token (válido por ~1h). Renova só quando expira.
// ----------------------------------------------------------
let tokenCache = { access_token: null, expires_at: 0 };

// Pagamentos confirmados via webhook (id da transação -> situação).
// Em produção troque por um banco/redis; em memória some ao reiniciar.
const pagamentos = new Map();

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expires_at - 60_000) {
    return tokenCache.access_token;
  }

  if (!SYNCPAY_CLIENT_ID || !SYNCPAY_CLIENT_SECRET) {
    throw new Error(
      'Credenciais da SyncPay não configuradas. Preencha SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET no arquivo .env'
    );
  }

  const res = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Falha ao autenticar na SyncPay (HTTP ${res.status}): ${data.message || JSON.stringify(data)}`
    );
  }

  const ttlMs = (data.expires_in ? Number(data.expires_in) : 3600) * 1000;
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + ttlMs,
  };
  return tokenCache.access_token;
}

// ----------------------------------------------------------
// Procura o código PIX (copia-e-cola) e o id da transação na
// resposta da SyncPay, cobrindo os vários nomes de campo possíveis.
// ----------------------------------------------------------
function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = deepFind(val, keys);
      if (found) return found;
    }
  }
  return null;
}

function findPixCode(data) {
  return deepFind(data, [
    'pix_code',
    'paymentCode',
    'pixCode',
    'qrcode',
    'qrCode',
    'qr_code',
    'copiaecola',
    'copia_e_cola',
    'emv',
    'brcode',
    'pix_copia_cola',
    'payload',
  ]);
}

function findTransactionId(data) {
  return deepFind(data, [
    'identifier',
    'idTransaction',
    'transactionId',
    'transaction_id',
    'id',
    'reference',
    'external_id',
  ]);
}

// ----------------------------------------------------------
// Config pública para o frontend (só o que é seguro expor)
// ----------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({ minAmount: MIN_AMOUNT });
});

// ----------------------------------------------------------
// Cria a cobrança PIX (cash-in) e devolve o copia-e-cola + QR code
// ----------------------------------------------------------
app.post('/api/pix', async (req, res) => {
  try {
    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount < MIN_AMOUNT) {
      return res
        .status(400)
        .json({ error: `O valor precisa ser maior ou igual a R$ ${MIN_AMOUNT}.` });
    }

    const token = await getAccessToken();

    // Dados do cliente são mockados (o usuário final só escolhe o valor).
    const body = {
      ip: req.ip,
      amount,
      items: [
        {
          title: 'Mimo 🌸',
          quantity: 1,
          tangible: false,
          unitPrice: amount,
        },
      ],
      customer: {
        name: MOCK_NAME,
        cpf: MOCK_CPF.replace(/\D/g, ''),
        email: MOCK_EMAIL,
        phone: MOCK_PHONE.replace(/\D/g, ''),
      },
      traceable: true,
    };
    if (SYNCPAY_POSTBACK_URL) body.postbackUrl = SYNCPAY_POSTBACK_URL;

    const apiRes = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/cash-in`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await apiRes.json().catch(() => ({}));
    console.log('SyncPay cash-in response:', JSON.stringify(data, null, 2));

    // A SyncPay pode devolver o código PIX em campos com nomes diferentes.
    const pixCode = findPixCode(data);
    const transactionId = findTransactionId(data);

    if (!apiRes.ok || !pixCode) {
      return res.status(502).json({
        error: `A SyncPay não retornou o código PIX (HTTP ${apiRes.status}). ${data.message || ''}`.trim(),
      });
    }

    // Gera a imagem do QR code a partir do PIX copia-e-cola.
    const qrDataUrl = await QRCode.toDataURL(pixCode, {
      width: 320,
      margin: 1,
      color: { dark: '#d6336c', light: '#ffffff' },
    });

    res.json({
      amount,
      pixCode,
      qrCode: qrDataUrl,
      transactionId,
    });
  } catch (err) {
    console.error('Erro ao gerar PIX:', err);
    res.status(500).json({ error: err.message || 'Erro inesperado ao gerar o PIX.' });
  }
});

// ----------------------------------------------------------
// Consulta o status de uma transação (para saber se o PIX foi pago)
// GET /api/partner/v1/transaction/{identifier}
// ----------------------------------------------------------
const STATUS_PAGO = [
  'paid', 'approved', 'completed', 'success', 'confirmed', 'received',
  'pago', 'aprovado', 'concluido', 'concluído', 'confirmado', 'recebido',
];
const STATUS_FALHOU = [
  'refused', 'cancelled', 'canceled', 'failed', 'expired', 'refunded', 'chargeback', 'med',
  'recusado', 'cancelado', 'expirado', 'estornado', 'falhou',
];

// Converte o status cru da SyncPay em 'pago' | 'falhou' | 'pendente'.
function normalizarStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase();
  if (STATUS_PAGO.includes(s)) return 'pago';
  if (STATUS_FALHOU.includes(s)) return 'falhou';
  return 'pendente';
}

app.get('/api/status/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // 1) Se o webhook já confirmou este pagamento, responde na hora.
    if (pagamentos.has(id)) {
      return res.json({ situacao: pagamentos.get(id), statusOriginal: 'webhook' });
    }

    // 2) Senão, consulta a SyncPay.
    const token = await getAccessToken();
    const apiRes = await fetch(`${SYNCPAY_BASE_URL}/api/partner/v1/transaction/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      return res.status(502).json({ error: `Falha ao consultar status (HTTP ${apiRes.status}).` });
    }

    const rawStatus = deepFind(data, ['status', 'situacao', 'situation']);
    const situacao = normalizarStatus(rawStatus);
    if (situacao !== 'pendente') pagamentos.set(id, situacao); // memoriza estados finais

    res.json({ situacao, statusOriginal: String(rawStatus || '').toLowerCase() });
  } catch (err) {
    console.error('Erro ao consultar status:', err);
    res.status(500).json({ error: err.message || 'Erro ao consultar status.' });
  }
});

// ----------------------------------------------------------
// Webhook (postback) da SyncPay — chamado quando o PIX muda de estado.
// Configure a URL pública desta rota em SYNCPAY_POSTBACK_URL, ex:
//   https://seudominio.com/webhook
// A SyncPay faz POST com { "data": { "id": "...", "status": "completed", ... } }
// e espera HTTP 200 em até 5 segundos.
// ----------------------------------------------------------
app.post('/webhook', (req, res) => {
  try {
    const payload = req.body || {};
    console.log('Webhook SyncPay recebido:', JSON.stringify(payload));

    const id = findTransactionId(payload); // procura data.id / identifier / etc.
    const rawStatus = deepFind(payload, ['status', 'situacao', 'situation']);
    const situacao = normalizarStatus(rawStatus);

    if (id && situacao !== 'pendente') {
      pagamentos.set(id, situacao);
      console.log(`Pagamento ${id} atualizado para: ${situacao} (${rawStatus})`);
    }

    // Responde 200 rápido pra não estourar o timeout de 5s da SyncPay.
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    // Ainda responde 200 pra evitar reenvios em loop por erro nosso.
    res.status(200).json({ received: true });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    minAmount: MIN_AMOUNT,
    credenciais: Boolean(SYNCPAY_CLIENT_ID && SYNCPAY_CLIENT_SECRET),
  });
});

app.listen(PORT, () => {
  console.log(`\n🌸 Site de mimos rodando em http://localhost:${PORT}`);
  console.log(`   Valor mínimo: R$ ${MIN_AMOUNT}`);
  if (!SYNCPAY_CLIENT_ID || !SYNCPAY_CLIENT_SECRET) {
    console.log('⚠️  Configure suas credenciais no arquivo .env antes de gerar PIX.\n');
  }
});
