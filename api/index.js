// Serverless function da Vercel: reaproveita o mesmo app Express do server.js.
// O vercel.json manda /api/* e /webhook para cá; o restante (html/css/js)
// a Vercel serve como arquivos estáticos.
import app from '../server.js';

export default app;
