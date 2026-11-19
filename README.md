# 💰 Controle Financeiro

Controle financeiro doméstico: cadastre a casa e os moradores, informe quanto cada um ganha e seus objetivos em
percentual, lance os gastos por categoria e deixe os descontos automáticos (dízimo, aluguel, parcelas, assinaturas)
entrarem sozinhos todo mês. O painel mostra **ganhos do mês** e **gastos do mês**, e um assistente de IA (Claude ou
outro provedor) analisa as finanças da casa.

**Custo: R$ 0.** Site estático no **GitHub Pages** + login e banco no **Supabase** (plano gratuito).

```
Navegador ──► GitHub Pages (HTML + JS, estático)
    │
    ├──► Supabase Auth ........ login, senha, recuperação por e-mail
    ├──► Supabase Postgres .... dados, protegidos por RLS (supabase/schema.sql)
    └──► Edge Function "ai" ... guarda a chave de IA criptografada e chama Claude / OpenAI / Gemini
```

## Funcionalidades

| Área | O que faz |
|---|---|
| **Login e senha** | Cadastro, login, "esqueci minha senha" por e-mail, troca de senha, sair de todos os dispositivos. |
| **Casa e moradores** | O administrador cria a casa e cadastra os moradores (com ou sem login, ex.: crianças). Para dar acesso, gera um **código de convite** (uso único, 72h). |
| **Ganhos** | Mensal (salário, com fim opcional) ou único (freela, 13º). |
| **Objetivos em %** | Ex.: Reserva 10%, Investimentos 15%. Mostra o valor em R$ sobre a renda do mês. A soma não pode passar de 100%. |
| **Gastos** | Descrição, valor, data, categoria e de quem é (ou "Casa", compartilhado). |
| **Categorias** | 15 padrão já criadas em cada casa. Renomeie, exclua ou crie as suas. |
| **Descontos automáticos** | **% da renda** (dízimo), **valor fixo** (aluguel, internet), **parcelado** (some do painel depois da última parcela), com início, fim e pausa. |
| **Painel** | **Ganhos do mês**, **Gastos do mês** (lançados + automáticos) e **Saldo**. Também mostra gastos por categoria, ganhos × gastos dos últimos 6 meses e o resumo por morador. |
| **Assistente de IA** | Chat sobre o mês. Provedores: **Claude (Anthropic)**, APIs **compatíveis com OpenAI** (OpenAI, OpenRouter, Groq, DeepSeek, Mistral…) e **Google Gemini**. |

### Quem pode fazer o quê

| Ação | Administrador | Morador com login |
|---|---|---|
| Ver painel e dados da casa | ✅ | ✅ |
| Ganhos, objetivos e descontos **próprios** | ✅ | ✅ |
| Ganhos, objetivos e descontos de **outros** moradores e da casa | ✅ | ❌ |
| Lançar gasto próprio ou da casa | ✅ | ✅ (edita os que lançou) |
| Criar e renomear categorias | ✅ | ✅ |
| Excluir categorias, gerenciar moradores e convites, configurar a IA, excluir a casa | ✅ | ❌ |

Essas regras ficam **no banco** (RLS). Elas valem mesmo que alguém tente acessar a API sem passar pelo site.

---

## Instalação (uma vez, ~20 minutos)

### 1. Supabase (banco + login)

1. Crie uma conta e um projeto em <https://supabase.com> (plano Free). Anote a senha do banco.
2. **SQL Editor › New query**: cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. **Project Settings › API Keys**: copie a **Project URL** e a chave **publishable** (ou "anon").
   Cole as duas em [`js/config.js`](js/config.js).
   ⚠️ Nunca use a chave `service_role` / `sb_secret_...` no site. O app se recusa a funcionar com ela.
4. **Authentication › Sign In / Providers › Email**:
   - deixe **Confirm email** ligado;
   - **Minimum password length**: `10`; **Password requirements**: *letters and digits*.
5. **Authentication › URL Configuration**:
   - **Site URL**: o endereço do Pages (passo 2), ex.: `https://SEU-USUARIO.github.io/controle-financeiro/`;
   - em **Redirect URLs**, adicione o mesmo endereço.
6. Depois que a família tiver criado as contas, desligue **Allow new users to sign up**
   (Authentication › Sign In / Providers). Quem já tem conta continua entrando normalmente.

### 2. GitHub Pages (site)

1. Envie esta pasta para um repositório no GitHub chamado `controle-financeiro`. Ele precisa ser
   **público** para o Pages ser grátis; o código não tem nenhum segredo.
2. **Settings › Pages › Build and deployment**: *Deploy from a branch* → `main` → `/ (root)` → **Save**.
3. Em 1 a 2 minutos o site abre em `https://SEU-USUARIO.github.io/controle-financeiro/`.

### 3. Assistente de IA (opcional)

A chave de API não pode ficar no site, então ela vai para uma **Edge Function** do Supabase.

1. Gere a chave de criptografia (guarde uma cópia no seu gerenciador de senhas):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. No Supabase, **Edge Functions › Secrets**: crie `APP_ENCRYPTION_KEY` com esse valor.
   Opcional: `AI_REQUESTS_PER_HOUR` (padrão 30 perguntas por pessoa por hora).
3. **Edge Functions › Deploy a new function › Via Editor**: nome `ai`. Cole o conteúdo de
   [`supabase/functions/ai/index.ts`](supabase/functions/ai/index.ts) e publique. Em **Settings** da função,
   deixe **Verify JWT with legacy secret** desligado (recomendação do Supabase): a própria função confere o login
   com `auth.getUser()` e recusa quem não está logado. Pelo terminal: `supabase functions deploy ai --no-verify-jwt`.
4. Crie uma chave do Claude em <https://console.anthropic.com>.
5. No site, como administrador: **Assistente IA › Claude (Anthropic)**, cole a chave e salve.
   O modelo padrão é `claude-opus-5-5`. Para gastar menos, use `claude-sonnet-5-5` ou `claude-haiku-5-5`.

Outros provedores:
- **Compatível com OpenAI**: informe a URL base, ex.: `https://openrouter.ai/api/v1` ou `https://api.groq.com/openai/v1`.
- **Google Gemini**: só a chave.

> O que vai para a IA: nomes dos moradores, ganhos, gastos, categorias, objetivos e descontos do mês escolhido.
> **E-mails e senhas nunca são enviados.**

---

## Desenvolvimento

Não tem build: são arquivos estáticos. Para testar localmente, sirva a pasta com qualquer servidor estático
(ex.: `npx serve .`) e adicione `http://localhost:3000` nas **Redirect URLs** do Supabase.

```bash
npm test                                   # cálculos (ganhos, gastos, dízimo, parcelas, objetivos)
npm i --no-save @electric-sql/pglite@0.3.14
npm run test:db                            # regras de segurança do banco (RLS), sem Docker
```

```
index.html, css/, icon.svg   página e estilos
js/config.js                 URL e chave publicável do Supabase
js/api.js                    cliente Supabase e mensagens de erro
js/app.js                    telas
js/finance.js                cálculos do mês (puro, testado)
js/charts.js, js/ui.js       gráficos SVG e utilitários (sem innerHTML)
supabase/schema.sql          tabelas, RLS, funções (create_house, create_invite, join_house)
supabase/functions/ai/       Edge Function da IA (chave criptografada, anti-SSRF, limite de uso)
tests/                       testes dos cálculos e das regras do banco
```

Valores em dinheiro ficam em **centavos (inteiros)** e percentuais em **pontos-base** (1000 = 10%), para não haver erro de arredondamento.

Análise de segurança: [SECURITY.md](SECURITY.md).
