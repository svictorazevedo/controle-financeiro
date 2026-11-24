# Análise de segurança

**Arquitetura:** site estático (GitHub Pages) + Supabase (Auth, Postgres e Edge Function).

Não existe servidor próprio, e o código do site é público. Isso exige três coisas:

- **Toda regra de acesso fica no banco** (Row Level Security). O site só exibe o que o banco deixa ler.
- **Segredos nunca ficam no site.** A chave publicável do Supabase é pública por natureza; a chave de IA fica na Edge Function.
- **Supor que o atacante chama a API diretamente**, sem passar pelas telas.

Os itens com 🧪 são verificados pelos testes:
- `npm run test:db`: 105 verificações das regras do banco, incluindo Compras (112 em `npm run test:migration`, que parte da v1);
- `npm test`: cálculos, relatórios e PDF.

## 1. Ameaças e defesas

| # | Ameaça | Defesa | Onde |
|---|---|---|---|
| 1 | **Senhas vazadas** | Gerenciadas pelo Supabase Auth (hash bcrypt). O banco do app nunca vê a senha. | Supabase Auth |
| 2 | **Senha fraca** | Mínimo 10 caracteres com letras e números, conferido no site **e** no Supabase (passo 1.4 do README). | `js/app.js`, painel |
| 3 | **Força bruta no login** | Limites de taxa do Supabase Auth por IP. Mensagem única para e-mail inexistente ou senha errada. Opcional: CAPTCHA (seção 2). | Supabase Auth |
| 4 | **Estranhos criando conta** | Confirmação de e-mail obrigatória. Depois de criar as contas da família, desligue "Allow new users to sign up". Uma conta nova **não vê nada** sem convite. 🧪 | painel, RLS |
| 5 | **Ver ou alterar dados de outra casa** 🧪 | RLS em todas as tabelas: só quem é morador da casa (`is_member`) lê. Chaves estrangeiras compostas `(id, house_id)` impedem ligar um gasto a uma categoria ou morador de outra casa. Um registro nunca muda de casa (gatilho). | `schema.sql` |
| 6 | **Morador mexer nos dados de outro** 🧪 | Papéis admin/morador no banco. O morador só altera os próprios ganhos, objetivos e descontos e os gastos que lançou; não promove a si mesmo; não cria descontos da casa. | `schema.sql` |
| 7 | **Forjar autoria de gasto** 🧪 | Um gatilho preenche `created_by` com o usuário logado, ignorando o que o site enviar. | `schema.sql` |
| 8 | **Entrar numa casa sem convite** 🧪 | Vincular uma conta a um morador só é possível por `join_house` (o gatilho bloqueia UPDATE direto). O código tem 48 bits aleatórios, vale 72h, é de **uso único** e fica salvo só como hash SHA-256 (moradores comuns nem veem os hashes). Limite de 10 tentativas por hora por usuário. | `schema.sql` |
| 9 | **Casa sem administrador** 🧪 | Gatilho impede rebaixar ou remover o último admin com login. | `schema.sql` |
| 10 | **Visitante não logado** 🧪 | O papel `anon` não tem permissão em nenhuma tabela nem função. | `schema.sql` |
| 11 | **Vazamento da chave de IA** 🧪 | A chave vai direto para a Edge Function e é criptografada com **AES-256-GCM**. O id da casa entra como dado autenticado, então a chave cifrada não funciona se copiada para outra casa. Fica em `ai_secrets`, tabela sem nenhuma política RLS: nem o admin lê pelo site. O navegador só vê os 4 últimos caracteres. A chave mestra fica nos *Secrets* da função. | `functions/ai`, `schema.sql` |
| 12 | **SSRF** (usar a "URL base" para atacar a rede do Supabase) | Exige HTTPS. Resolve o DNS e bloqueia IPs privados, loopback, link-local e metadados de nuvem. Não segue redirecionamentos. | `functions/ai` |
| 13 | **Abuso de custo da IA** | 30 perguntas por hora por usuário (configurável). Histórico de até 20 mensagens de 4.000 caracteres; contexto até 40 mil caracteres; corpo até 100 KB. | `functions/ai` |
| 14 | **Prompt injection** (uma descrição de gasto tentando comandar a IA) | Dados enviados dentro de `<dados_financeiros>` com instrução explícita de que são dados. A IA não tem ferramentas nem acesso ao banco; a resposta é exibida como texto puro. | `functions/ai` |
| 15 | **XSS** (script escondido numa descrição) | O site insere textos só com `textContent` (nunca `innerHTML`). A **Content-Security-Policy** só permite scripts do próprio site e do supabase-js, sem script inline. | `js/ui.js`, `index.html` |
| 16 | **SQL injection** | Não há SQL montado com texto: o PostgREST usa parâmetros, e as funções são PL/pgSQL com variáveis. Funções `SECURITY DEFINER` usam `search_path = ''`. | `schema.sql` |
| 17 | **Chave secreta do Supabase no site** | O app se recusa a funcionar se `js/config.js` tiver uma chave `service_role`/`sb_secret_`. | `js/api.js` |
| 18 | **Valores absurdos** | `CHECK` no banco: dinheiro > 0 e ≤ R$ 100 mi, percentuais de 0,01% a 100%, meses `AAAA-MM`, textos com tamanho máximo, parcelas de 1 a 600. 🧪 | `schema.sql` |
| 19 | **Colaborador ver ou mexer em telas que não deveria** 🧪 | Permissão por tela (0 sem acesso, 1 ver, 2 editar) guardada em `residents.permissions`, validada por `CHECK` e conferida pelas políticas RLS com `perm()`/`can_view()`. Só o admin altera permissões. Lançamentos são legíveis por quem vê Painel, Lançamentos, Contas, Calendário ou Relatórios (essas telas são calculadas a partir deles). A Edge Function confere "Assistente IA". | `schema.sql`, `functions/ai` |
| 20 | **Senha vazada de quem usa 2FA** 🧪 | Política RLS **restritiva** em todas as tabelas: quem tem fator TOTP verificado só lê/grava com sessão `aal2` (depois do código). Vale também para as funções RPC, os comprovantes e a função de IA. | `schema.sql`, `functions/ai` |
| 21 | **Comprovante de outra casa / arquivo malicioso** 🧪 | Bucket privado `receipts`, caminho sempre `<id da casa>/<uuid>.<ext>` (conferido por `CHECK` no lançamento e pela política do Storage). Só JPG, PNG, WEBP e PDF, até 5 MB (limite no bucket). Visualização por link assinado de 2 minutos. | `schema.sql`, `js/pages/tx.js` |
| 22 | **Logo/ícone com script** 🧪 | Só `data:image/png|jpeg|webp;base64` (SVG recusado por `CHECK`), com tamanho máximo. | `schema.sql` |
| 23 | **CSV com fórmula** (planilha executando `=HYPERLINK(...)`) | Células de texto que começam com `= + @` ganham um apóstrofo antes. | `js/pages/reports.js`, `transactions.js` |
| 24 | **Áudio do lançamento por voz** | Não é gravado nem enviado ao Supabase: o reconhecimento é do navegador (Web Speech API; no Chrome, processado pelo serviço de voz do Google) e o app só recebe o texto. O texto (até 1.000 caracteres) vai para a IA dentro de `<fala>`, tratado como dado. A IA só escolhe categorias/contas/pessoas da própria casa por códigos curtos e nada é gravado sem o usuário confirmar; a gravação passa pelo RLS normal. Exige "Lançamentos: editar" e conta no limite de pedidos por hora. | `js/pages/voice.js`, `functions/ai` |
| 25 | **Foto do cupom / dados de compras** 🧪 | Tabelas de Compras com RLS e 2FA como as demais; permissão própria "Compras" (0/1/2). Cupom só altera/exclui quem lançou ou o admin. A foto fica no bucket privado `receipts` (caminho começa pelo id da casa, conferido por `CHECK` e pela Edge Function, que só baixa arquivos da própria casa). O cupom inteiro é salvo por `save_shop_receipt` (`SECURITY INVOKER`: vale o RLS de quem chama) numa transação só. Chave de acesso única por casa (não lança o mesmo cupom duas vezes). | `003_compras.sql`, `functions/ai` |
| 26 | **Pesquisa de preços / prompt injection pela web** | Vão para a IA só nomes de produtos, a região e os nomes dos mercados. Resultados da web são tratados como dados; a resposta é validada (preço > 0, URL só `https://`, produto só dos códigos enviados). Endereços citados que não vieram da busca ficam marcados como "fonte não conferida". Links abrem com `noopener noreferrer nofollow`. Conta no limite de pedidos por hora. | `functions/ai`, `js/pages/shopping.js` |

## 2. Recomendações (dependem de você, no painel)

1. **Desligue o cadastro aberto** depois de criar as contas (README 1.6).
2. **CAPTCHA no login e no cadastro**: em Authentication › Attack Protection, ligue o Cloudflare Turnstile (grátis).
   Se quiser, eu adapto o site para enviar o token, como no `louvorganize`.
3. **Ative a verificação em duas etapas** em *Minha conta* (cada pessoa, principalmente os administradores).
   Confira que o TOTP está ligado em Authentication › Multi-Factor (vem ligado por padrão).
4. **Guarde a `APP_ENCRYPTION_KEY`** num gerenciador de senhas. Se ela vazar, gere outra e cadastre as chaves de IA de novo.
5. **Backup:** o plano grátis do Supabase **não** tem backup diário. Exporte periodicamente
   (Database › Backups, ou `pg_dump` com a connection string).
6. **Chave de IA com limite de gasto**: no console da Anthropic, defina um teto mensal de cobrança.

## 3. Limitações conhecidas

- **Sessão no `localStorage`** (padrão do supabase-js): um XSS conseguiria ler o token. A defesa é não ter XSS:
  `textContent` + CSP. A sessão expira e pode ser encerrada em "Sair de todos os dispositivos".
- **Biblioteca do Supabase vem do CDN jsDelivr** (versão fixa, 2.118.0). Para eliminar essa dependência,
  dá para copiar o arquivo para dentro do repositório.
- **GitHub Pages não permite cabeçalhos HTTP próprios.** A CSP vai em `<meta>`, e `frame-ancestors`
  (anti-clickjacking) não funciona por meta. O risco é baixo: as ações sensíveis pedem confirmação.
- **O repositório é público** (exigência do Pages grátis). Não há segredos nele; quem protege os dados é o RLS.
- **Dados financeiros ficam em texto** no Postgres do Supabase (criptografado em disco pelo provedor).
  Quem tem acesso ao painel do projeto vê tudo: proteja sua conta do Supabase com 2FA.
- **Dados enviados à IA** vão para o provedor escolhido e seguem a política de privacidade dele.
