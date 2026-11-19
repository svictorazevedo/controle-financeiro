import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { app } = createApp(cfg);

if (cfg.isProd && !cfg.cookieSecure) {
  console.warn('[aviso] Em produção, use HTTPS e COOKIE_SECURE=true.');
}

app.listen(cfg.port, cfg.host, () => {
  console.log(`Controle Financeiro rodando em http://${cfg.host}:${cfg.port}`);
  if (cfg.allowRegistration) console.log('Cadastro aberto (ALLOW_REGISTRATION=true). Feche após criar as contas da família.');
});
