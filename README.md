# 💰 Controle Financeiro

Sistema web de controle financeiro doméstico: cadastre a casa e os moradores, informe quanto cada um ganha e
seus objetivos em percentual, lance os gastos por categoria e deixe os descontos automáticos (dízimo, aluguel,
parcelas, assinaturas) entrarem sozinhos todo mês. Tem um painel com **ganhos do mês** e **gastos do mês**
e um assistente de IA (Claude, ou outro provedor) que analisa as finanças da casa.

## Funcionalidades

| Área | O que faz |
|---|---|
| **Login e senha** | Cadastro, login, troca de senha, "sair de todos os dispositivos". Senhas com hash scrypt. |
| **Casa e moradores** | Cada usuário cria uma ou mais casas. O administrador adiciona moradores (com ou sem login, ex.: crianças) e gera **códigos de convite** de uso único para darem acesso. |
| **Ganhos** | Cada morador informa quanto ganha: mensal (salário) ou único (freela, 13º), com período opcional. |
| **Objetivos em %** | Ex.: Reserva 10%, Investimentos 15%, Viagem 5%. O sistema calcula o valor em R$ sobre a renda do mês e impede passar de 100%. |
| **Gastos** | Lançamento com descrição, valor, data, categoria e de quem é (ou "Casa", compartilhado). |
| **Categorias** | 15 categorias padrão já criadas em cada casa; renomeie, exclua ou crie as suas. |
| **Descontos automáticos** | **Percentual da renda** (dízimo 10%), **valor fixo** (aluguel, internet), **parcelado** (10x — some do painel depois da última parcela), com início/fim, pausa e atalhos prontos. |
| **Painel** | **Ganhos do mês**, **Gastos do mês** (lançados + automáticos) e **Saldo**, gastos por categoria, ganhos × gastos dos últimos 6 meses e resumo por morador com objetivos. |
| **Assistente de IA** | Chat que recebe o resumo do mês. Provedores: **Claude (Anthropic)**, qualquer API **compatível com OpenAI** (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Ollama/LM Studio locais) e **Google Gemini**. |

### Quem pode fazer o quê

| Ação | Administrador | Morador com login |
|---|---|---|
| Ver painel e dados da casa | ✅ | ✅ |
| Ganhos, objetivos e descontos **próprios** | ✅ | ✅ |
| Ganhos/objetivos/descontos de **outros** moradores e da casa | ✅ | ❌ |
| Lançar gasto próprio ou da casa | ✅ | ✅ (edita só os que lançou) |
| Criar/renomear categorias | ✅ | ✅ |
| Excluir categorias, gerenciar moradores, convites, IA, excluir casa | ✅ | ❌ |

## Como rodar

Pré-requisito: **Node.js 22.13 ou mais novo** (o banco usa o SQLite embutido no Node, sem compilar nada).

```bash
cd controle-financeiro
npm install
cp .env.example .env      # no Windows: copy .env.example .env
npm start
```

Abra <http://127.0.0.1:3000>, clique em **Cadastre-se**, crie a casa e adicione os moradores.

Outros comandos:

```bash
npm run dev     # reinicia sozinho ao salvar arquivos
npm test        # testes automáticos (cálculos + segurança)
npm run audit   # verifica vulnerabilidades nas dependências
```

### Conectar o Claude

1. Crie uma chave de API em <https://console.anthropic.com>.
2. No sistema, como administrador: **Assistente IA → Provedor: Claude (Anthropic)**, cole a chave e salve.
   O modelo padrão é `claude-opus-5-5`; você pode trocar (ex.: `claude-sonnet-5-5`, `claude-haiku-5-5` para gastar menos).
3. Pergunte, por exemplo: *"Onde estou gastando mais este mês?"* ou *"Consigo bater meus objetivos?"*

Outros provedores: escolha **Compatível com OpenAI** e informe a URL base (ex.: `https://openrouter.ai/api/v1`,
`https://api.groq.com/openai/v1`) ou **Google Gemini**. Para Ollama local, defina `ALLOW_LOCAL_AI=true` e use
`http://localhost:11434/v1` (chave pode ficar vazia).

> O que vai para a IA: nomes dos moradores, ganhos, gastos, categorias, objetivos e descontos do mês escolhido.
> **E-mails e senhas nunca são enviados.**

## Colocar em produção (acesso pela internet)

1. Gere a chave de criptografia e coloque no `.env`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. No `.env`: `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `ALLOW_REGISTRATION=false`
   (depois de criar as contas).
3. Rode atrás de um proxy reverso com **HTTPS** — o jeito mais simples é o [Caddy](https://caddyserver.com):
   ```
   financas.seudominio.com.br {
       reverse_proxy 127.0.0.1:3000
   }
   ```
4. Faça **backup** do arquivo `data/financas.db` (e guarde a `APP_ENCRYPTION_KEY` em local seguro).

## Estrutura

```
src/
  server.js            inicialização
  app.js               Express, cabeçalhos de segurança (CSP/HSTS), rotas
  config.js            variáveis de ambiente
  db.js                esquema SQLite
  middleware.js        autenticação, autorização por casa, CSRF, erros
  validate.js          validação de todas as entradas
  routes/auth.js       cadastro, login, senha, criar/entrar em casa
  routes/house.js      moradores, ganhos, objetivos, gastos, categorias, descontos, painel, IA
  services/finance.js  cálculos do mês (ganhos, gastos, dízimo, parcelas, objetivos)
  services/ai.js       Claude (SDK oficial), compatível com OpenAI, Gemini
  security/            senha (scrypt), sessão, criptografia, rate limit, anti-SSRF
public/                front-end (HTML/CSS/JS puro, sem CDN)
tests/                 testes automáticos
```

Valores em dinheiro são guardados em **centavos (inteiros)** e percentuais em **pontos-base** (1000 = 10%),
para não haver erro de arredondamento.

Veja a análise de segurança completa em [SECURITY.md](SECURITY.md).
