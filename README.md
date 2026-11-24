# 💰 Controle Financeiro

Sistema de controle financeiro para casa ou pequena empresa: contas bancárias e carteiras com saldo automático,
lançamentos de entradas e saídas com comprovante, orçamento por categoria, metas de economia, calendário,
8 relatórios (PDF, CSV e impressão), assistente de IA, usuários com permissão por tela e verificação em duas etapas.

**Custo: R$ 0.** Site estático no **GitHub Pages** + login, banco e arquivos no **Supabase** (plano gratuito).

```
Navegador ──► GitHub Pages (HTML + JS, estático)
    │
    ├──► Supabase Auth ........ login, senha, recuperação por e-mail, 2FA (app autenticador)
    ├──► Supabase Postgres .... dados, protegidos por RLS (supabase/schema.sql)
    ├──► Supabase Storage ..... comprovantes (bucket privado "receipts")
    └──► Edge Function "ai" ... guarda a chave de IA criptografada e chama Claude / OpenAI / Gemini
```

## Funcionalidades

| Área | O que faz |
|---|---|
| **Painel** | Saldo consolidado das contas; entradas, saídas e resultado do mês (com variação sobre o mês anterior); indicadores do dia (entradas, saídas, a pagar em 7 dias); gráfico de entradas x saídas dos últimos 6 meses; mini calendário; resumo do orçamento; metas em andamento; saídas por categoria; últimos lançamentos. |
| **Lançamentos** | Entradas e saídas com data, conta, categoria, de quem é e **comprovante** (foto ou PDF, até 5 MB). Filtros por tipo, período, conta, categoria e busca. Editar, duplicar, excluir, exportar CSV. Atalho: tecla **N**. |
| **Lançar por voz** | Botão de microfone ao lado de "Novo lançamento" (ou tecla **V**): você fala ("gastei 52 e 90 no mercado hoje no Nubank e 30 na farmácia"), a IA monta os lançamentos com valor, data, categoria, conta e pessoa, e você confere antes de salvar. O áudio não é gravado: o navegador converte a fala em texto e só o texto vai para a IA. Funciona no Chrome, Edge e Safari; nos outros, dá para digitar a frase. Sem IA configurada, o sistema preenche o que conseguir (valor, tipo, data) no formulário manual. |
| **Compras** (v3.2) | **Cupom fiscal → preço de cada produto.** Três jeitos de lançar: **foto** do cupom (a IA lê mercado, CNPJ, data, chave de acesso e todos os itens; cupom comprido é fatiado para as letras pequenas ficarem legíveis), **XML da NFC-e** (lido no navegador, exato, sem IA) ou **digitado**. Você confere antes de salvar e pode lançar junto a saída em Lançamentos (com a foto como comprovante). O sistema aprende como cada mercado escreve cada produto ("ARROZ T.JOAO 5KG" → "Arroz Tio João 5kg") e da próxima vez já acerta. Abas: **Resumo** (gasto, ticket médio, mais comprados, ranking de mercados mais baratos, **melhor época do ano** já descontando o efeito do mercado), **Cupons**, **Produtos** (preço médio, menor, maior, último, por mercado, por mês do ano, histórico, mesclar duplicados, CSV), **Lista do mês** (o que se repete em ≥ metade dos meses, quantidade sugerida, onde comprar cada item, quanto custa a cesta em cada mercado e a melhor combinação) e **Pesquisa de preços** (a IA busca na web o preço de hoje nos mercados da sua cidade; Claude ou Gemini). |
| **Esconder valores** (v3.3) | Ícone de **olho** na barra superior (também no celular) ou tecla **O**: com o olho fechado, todo valor em todas as telas vira **R$ •••••** — painel, lançamentos, contas, gráficos, relatórios, compras. Dá para lançar e navegar sem expor os números (ex.: compartilhando a tela). A escolha fica guardada no navegador: se você fechou o olho, o sistema já abre escondido. O PDF e o CSV baixados saem com os valores reais. |
| **Importar extrato** (v3.3) | Botão **Importar extrato** em Lançamentos (ou no menu de cada conta/cartão): envie o **OFX** do banco ou da fatura (ou CSV, se o banco só oferecer isso). O arquivo é lido no navegador, sem IA e sem custo. O sistema **sugere a categoria** pelo seu histórico ("IFOOD *RESTAURANTE" → Restaurante) ou por palavras-chave, **separa o que já está lançado** (mesmo valor na mesma conta em até 4 dias, inclusive rendas e descontos automáticos), desmarca **pagamento de fatura e transferências** (que apareceriam em dobro) e, no OFX de conta, **confere o saldo** com o do banco. Você revisa, ajusta descrição/categoria e importa. Trocar a categoria de um item aplica a mesma aos outros com o mesmo texto do banco. Reimportar o mesmo arquivo não duplica. |
| **Ícone no celular** (v3.3.1) | "Adicionar à tela de início" agora usa ícones PNG próprios: no iPhone (antes aparecia um print da página) e no Android (ícone adaptável, preenche o formato do aparelho). Se já tinha o atalho, apague e adicione de novo. |
| **Contas** | Conta corrente, poupança, carteira, cartão de crédito, investimento. Saldo calculado sozinho (saldo inicial + movimentos), previsto para o fim do mês, extrato. |
| **Fixos e recorrentes** | Rendas fixas (salário) e descontos automáticos: **% da renda** (dízimo), **valor fixo** (aluguel, internet), **parcelado** (some depois da última parcela). Entram sozinhos no dia do mês informado. Também a distribuição da renda em %. |
| **Categorias** | De entrada e de saída, com **subcategorias** e **cor**. 15 de saída e 5 de entrada já vêm criadas. |
| **Orçamento** | Limite de gasto por categoria (todo mês ou só num mês), planejado x realizado com alerta de estouro, comparação com o mês anterior. |
| **Metas** | Valor e data-alvo, aportes e retiradas, progresso, quanto guardar por mês para cumprir o prazo. |
| **Relatórios** | 8 prontos: entradas, saídas, entradas x saídas mensal, próximas entradas, próximas saídas, totais mensais (12 meses), extrato por conta, saídas por categoria. **PDF, CSV e impressão.** |
| **Calendário** | Mês inteiro com total de entradas e saídas por dia, resumo do mês e detalhe do dia. |
| **Usuários** | Administradores e colaboradores (com ou sem login). **Permissão por tela**: sem acesso, ver ou editar. |
| **Segurança** | Verificação em duas etapas (app autenticador). Quem ativa só acessa os dados com o código. |
| **Configuração** | Nome, **moeda**, **logo** e **ícone** próprios; tema claro/escuro. |
| **Celular** | Barra de navegação embaixo (Painel, Lançamentos, **+**, Calendário, Mais) e microfone no topo. Os formulários sobem de baixo, como folhas (arraste para baixo para fechar). Lançamentos aparecem agrupados por dia, e tocar num item abre editar, duplicar e excluir. Filtros ficam recolhidos e as tabelas viram cartões. A descrição sugere lançamentos anteriores e já preenche categoria e conta. Dá para instalar o site na tela inicial. |
| **Assistente de IA** | Chat sobre o mês: **Claude (Anthropic)**, APIs compatíveis com OpenAI e **Google Gemini**. |

### Quem pode fazer o quê

**Administrador**: tudo, inclusive usuários, permissões, configurações e exclusão da casa.

**Colaborador**: o administrador escolhe, tela por tela, *sem acesso*, *ver* ou *editar*. Padrão:

| Tela | Padrão | Observação |
|---|---|---|
| Painel, Calendário, Relatórios, Assistente IA | ver | |
| Lançamentos | editar | lança para si ou para a casa; altera os que lançou ou os seus |
| Fixos e recorrentes | editar | só os próprios; os da casa são do admin |
| Categorias | editar | criar e renomear; excluir é só do admin |
| Metas | editar | |
| Contas, Orçamento | ver | |
| Compras | editar | lança cupons e pesquisa preços; altera/exclui só os cupons que lançou |

Essas regras ficam **no banco** (RLS), não só nas telas: valem mesmo que alguém chame a API do Supabase direto.
Como Painel, Contas, Calendário e Relatórios são calculados a partir dos lançamentos, quem tem "ver" em qualquer
uma dessas telas consegue ler os lançamentos. Para esconder os valores de alguém, tire o acesso de todas elas.

---

## Instalação (uma vez, ~20 minutos)

### 1. Supabase (banco + login)

1. Crie uma conta e um projeto em <https://supabase.com> (plano Free). Anote a senha do banco.
2. **SQL Editor › New query**: cole todo o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
   Ele cria as tabelas, as regras de acesso e o bucket privado de comprovantes.
   Em seguida, numa nova query, rode também [`supabase/migrations/003_compras.sql`](supabase/migrations/003_compras.sql) (tela Compras).
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
- **Google Gemini** (plano gratuito, sem cartão): crie a chave em <https://aistudio.google.com/apikey> e use o modelo `gemini-3.8-flash`.

> O que vai para a IA: nomes dos moradores, ganhos, gastos, categorias, objetivos e descontos do mês escolhido.
> **E-mails e senhas nunca são enviados.**

---

## Atualizar da versão 1 (quem já usa o sistema)

A versão 2 muda o banco. **Siga esta ordem**: se o site novo for publicado antes do passo 1, ele não abre.

1. **Supabase › SQL Editor › New query**: cole [`supabase/migrations/002_v2.sql`](supabase/migrations/002_v2.sql) e clique em **Run**.
   Roda numa transação (se der erro, nada muda). Os gastos antigos viram lançamentos de saída na nova
   "Conta principal"; as rendas e descontos também ficam nela; cada casa ganha as categorias de entrada.
   Depois, ajuste o **saldo inicial** das contas em *Contas* para o saldo bater com o do banco.
2. **Edge Functions › ai**: cole de novo o conteúdo de [`supabase/functions/ai/index.ts`](supabase/functions/ai/index.ts) e publique
   (agora ela respeita a permissão "Assistente IA" e o 2FA). Pelo terminal: `supabase functions deploy ai --no-verify-jwt`.
3. Envie o código novo para o GitHub (`git push`). Em 1 a 2 minutos o Pages publica.

**2FA**: o TOTP (app autenticador) vem ligado por padrão no Supabase. Confira em *Authentication › Multi-Factor*.
Cada pessoa ativa em **Minha conta › Verificação em duas etapas**.

## Atualizar para a 3.3 (esconder valores e importar extrato)

Só o site mudou: nada para rodar no Supabase. Basta o `git push` (se ainda não fez a atualização 3.2 abaixo, faça-a também).

## Atualizar para a 3.2 (tela Compras)

**Nesta ordem:**

1. **Supabase › SQL Editor › New query**: cole [`supabase/migrations/003_compras.sql`](supabase/migrations/003_compras.sql) e **Run**
   (uma vez só; roda numa transação). Cria mercados, produtos, cupons, itens, cotações, a permissão "Compras"
   e libera a foto do cupom no bucket `receipts`.
2. **Edge Functions › ai**: publique de novo [`supabase/functions/ai/index.ts`](supabase/functions/ai/index.ts)
   (`supabase functions deploy ai --no-verify-jwt`). Ela ganhou a leitura do cupom (`receipt`) e a pesquisa de preços (`prices`).
3. `git push`. Se o site subir antes do passo 1, só a tela Compras mostra um aviso; o resto funciona.

**IA para Compras:** a foto do cupom funciona com os 3 provedores (precisa de modelo com visão: Claude, Gemini, `gpt-4o`...).
A **pesquisa de preços na web** só com **Claude** (ferramenta `web_search`, cobrada à parte pela Anthropic, cerca de US$ 10 por
1.000 buscas) ou **Gemini** (Google Search; tem cota grátis). Cada rodada pesquisa até 10 produtos.

### Compras: o que ficou de fora (e ideias)

| Pendência | Por quê | Como resolver |
|---|---|---|
| Buscar a nota direto na SEFAZ pelo QR Code | A consulta pública da NFC-e é diferente em cada estado, costuma ter CAPTCHA e não libera acesso pelo navegador (CORS). | Hoje: o QR é lido (chave de acesso, contra duplicidade) e a IA lê a foto; o XML pode ser importado. Dá para testar um "leitor" da página de consulta da SEFAZ-MT numa Edge Function, se ela não tiver CAPTCHA. |
| Preços oficiais por região | MT tem o **Menor Preço** dentro do app/portal **Nota MT** (preços tirados das notas fiscais, busca por nome ou código de barras), mas só com login e sem API pública. | Usar o app para conferir e lançar como "Preço de encarte"; se a SEFAZ-MT abrir uma API, vira mais uma fonte de cotação. |
| Pesquisa na web é "melhor esforço" | Muitos mercados não publicam preço online; encartes mudam toda semana. | Por isso o sistema prioriza o que **você pagou** (cupons) e marca "fonte não conferida" quando o link não veio da busca. Encartes podem ser digitados em Produtos › "Preço de encarte". |
| Pesquisa automática agendada | O site é estático e a função só roda quando chamada. | Agendar a função com `pg_cron` do Supabase (ex.: toda segunda) para a lista do mês. |
| Leitura de encarte por foto | Não feito. | Reaproveitar a ação `receipt` com outro prompt: foto do encarte → cotações. |
| Foto do cupom no celular sem QR | O leitor de QR do navegador (`BarcodeDetector`) só existe no Chrome do Android e no Safari recente; no Windows, não. | A chave impressa também é lida pela IA. |

## Desenvolvimento

Não tem build: são arquivos estáticos. Para testar localmente, sirva a pasta com qualquer servidor estático
(ex.: `npx serve .`) e adicione `http://localhost:3000` nas **Redirect URLs** do Supabase.

```bash
npm test                                   # cálculos, relatórios e PDF
npm i --no-save @electric-sql/pglite@0.3.14
npm run test:db                            # regras do banco (RLS, permissões, 2FA, comprovantes), sem Docker
npm run test:migration                     # migração v1 -> v2 com dados antigos
```

```
index.html, css/, icon.svg   página e estilos (tema claro/escuro, responsivo, impressão)
manifest.webmanifest         instalação na tela inicial do celular
js/config.js                 URL e chave publicável do Supabase
js/api.js                    cliente Supabase e mensagens de erro
js/app.js                    menu, rotas, login, 2FA
js/ctx.js                    estado, permissões e componentes de formulário
js/pages/                    uma tela por arquivo (painel, lançamentos, contas, orçamento...)
js/finance.js                cálculos (puro, testado): saldos, automáticos, orçamento, metas, calendário
js/reports.js                os 8 relatórios (puro, testado)
js/pdf.js                    gerador de PDF próprio, sem biblioteca externa
js/charts.js, js/icons.js    gráficos e ícones em SVG
js/ui.js                     utilitários (sem innerHTML), diálogos, moeda
supabase/schema.sql          instalação nova: tabelas, RLS, funções, bucket
supabase/migrations/         atualização de bancos existentes
supabase/functions/ai/       Edge Function da IA (chave criptografada, anti-SSRF, limite de uso)
tests/                       testes dos cálculos e das regras do banco
```

Valores em dinheiro ficam em **centavos (inteiros)** e percentuais em **pontos-base** (1000 = 10%), para não haver erro de arredondamento.

Análise de segurança: [SECURITY.md](SECURITY.md).
