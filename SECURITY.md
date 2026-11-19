# Análise de segurança

Este documento lista as ameaças consideradas, como o sistema se defende de cada uma e o que ainda depende
de quem hospeda. Os itens marcados com 🧪 têm teste automático em `tests/api.test.js` (`npm test`).

## 1. Ameaças e defesas

| # | Ameaça | Defesa implementada | Onde |
|---|---|---|---|
| 1 | **Senhas vazadas do banco** | Hash **scrypt** (memory-hard, ~32 MB por tentativa) com sal aleatório; comparação em tempo constante. Senha nunca é guardada nem registrada em log. | `security/password.js` |
| 2 | **Força bruta / adivinhar senha** 🧪 | Limite por IP (20 tentativas / 15 min) + **bloqueio da conta por 15 min após 5 erros**. Política de senha: mínimo 10 caracteres, bloqueia senhas comuns e senhas com o e-mail. | `routes/auth.js` |
| 3 | **Descobrir quais e-mails têm conta** 🧪 | Login responde a mesma mensagem e no mesmo tempo (hash "falso") para e-mail inexistente ou senha errada. | `routes/auth.js` |
| 4 | **Roubo de sessão** 🧪 | Token aleatório de 256 bits em cookie **HttpOnly** (JavaScript não lê), **SameSite=Strict**, **Secure** + prefixo `__Host-` em produção. No banco só fica o SHA-256 do token. Sessão expira por inatividade (12h) e por idade máxima (7 dias). Token novo a cada login (evita fixação). Troca de senha derruba as outras sessões. | `security/session.js` |
| 5 | **CSRF** (site malicioso agindo em seu nome) 🧪 | Três camadas: cookie SameSite=Strict; exigência de `Content-Type: application/json` (formulário HTML não consegue enviar); verificação do cabeçalho `Origin`; token **X-CSRF-Token** por sessão em toda alteração. | `middleware.js` |
| 6 | **Ver/alterar dados de outra casa** (IDOR) 🧪 | Toda rota `/api/houses/:id` confirma que o usuário é morador da casa; todas as consultas filtram por `house_id`; IDs de morador/categoria enviados no corpo também são validados contra a casa. Responde 404 para não revelar se a casa existe. | `middleware.js`, `routes/house.js` |
| 7 | **Morador alterar dados de outro** 🧪 | Papéis admin/morador; morador comum só mexe nos próprios ganhos, objetivos e descontos e nos gastos que lançou. Não é possível remover o último administrador. | `routes/house.js` |
| 8 | **SQL injection** | 100% das consultas usam *prepared statements* com parâmetros; nenhuma SQL é montada com texto do usuário. | todo `src/` |
| 9 | **XSS** (injetar script em uma descrição) | Front-end insere textos só com `textContent` (nunca `innerHTML`); **Content-Security-Policy** só permite scripts do próprio site, sem inline, sem CDN; `frame-ancestors 'none'`. | `public/js/ui.js`, `app.js` |
| 10 | **Clickjacking, sniffing, vazamento de URL** 🧪 | Helmet: `X-Frame-Options`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS em produção, `Permissions-Policy`, sem `X-Powered-By`. API com `Cache-Control: no-store`. | `app.js` |
| 11 | **Vazamento das chaves de API de IA** 🧪 | Chaves criptografadas com **AES-256-GCM** (chave mestra no `.env`, fora do banco e do git). Nunca são devolvidas ao navegador (só os 4 últimos caracteres). Chamadas à IA partem do servidor. | `security/crypto.js`, `routes/house.js` |
| 12 | **SSRF** (usar o servidor para acessar a rede interna via "URL base" da IA) 🧪 | Exige HTTPS; resolve o DNS e bloqueia IPs privados, loopback, link-local e o endereço de metadados de nuvem (169.254.169.254); não segue redirecionamentos; localhost só com `ALLOW_LOCAL_AI=true`. | `security/urlGuard.js` |
| 13 | **Prompt injection** (descrição de gasto tentando comandar a IA) | Dados enviados dentro de `<dados_financeiros>` com instrução explícita de que são dados. A IA não tem ferramentas nem acesso ao banco: no pior caso, só responde algo estranho. Resposta exibida como texto puro. | `services/ai.js` |
| 14 | **Abuso de custo da IA** | Limite de perguntas por usuário por hora (`AI_REQUESTS_PER_HOUR`), histórico limitado a 20 mensagens de até 4.000 caracteres. | `routes/house.js` |
| 15 | **Entrada maliciosa / gigante** | Corpo JSON limitado a 100 KB; validação de tipo, formato e tamanho de cada campo; valores em centavos inteiros com limites; caracteres de controle removidos. | `validate.js` |
| 16 | **Vazamento de detalhes internos** | Erros 500 retornam mensagem genérica; stack trace só no log do servidor. | `middleware.js` |
| 17 | **Cadastro de estranhos** | `ALLOW_REGISTRATION=false` fecha o cadastro; novas contas só com código de convite (uso único, 72h, guardado como hash). | `routes/auth.js` |
| 18 | **Segredos no git** | `.gitignore` exclui `.env`, `data/`, `*.db` e `*.key`. | `.gitignore` |
| 19 | **Dependências vulneráveis** | Apenas 3 dependências diretas (express, helmet, SDK oficial da Anthropic); `npm audit` sem vulnerabilidades na criação. | `package.json` |
| 20 | **Rastro de ações** | Log de auditoria: login, falhas, bloqueios, troca de senha, convites, exclusões, mudança da IA. | tabela `audit_log` |

## 2. Responsabilidades de quem hospeda (obrigatório em produção)

O código não resolve sozinho estes pontos:

1. **HTTPS sempre.** Rode atrás de Caddy/nginx com certificado e defina `COOKIE_SECURE=true` e `TRUST_PROXY=true`.
   Sem HTTPS, senha e cookie trafegam abertos na rede.
2. **`APP_ENCRYPTION_KEY` forte e guardada fora do servidor** (gerenciador de senhas). Se o servidor e o `.env`
   vazarem juntos, as chaves de IA podem ser lidas — revogue-as no painel do provedor nesse caso.
3. **Feche o cadastro** (`ALLOW_REGISTRATION=false`) depois de criar as contas da família.
4. **Backup criptografado** do `data/financas.db` em outro lugar; teste a restauração.
5. **Atualize** o Node.js e rode `npm audit` / `npm update` periodicamente.
6. **Firewall**: deixe aberta só a porta 443 (e 80 para o certificado). O app escuta em `127.0.0.1` por padrão.
7. **Repositório privado** no GitHub se ele contiver qualquer configuração sua (o código em si não tem segredos).

## 3. Limitações conhecidas

- **Sem 2FA** (autenticação em dois fatores). É a melhoria mais valiosa a fazer a seguir (TOTP com app autenticador).
- **Sem recuperação de senha por e-mail** (precisa de um serviço de envio de e-mail). Hoje, se alguém esquecer a senha,
  o administrador do servidor precisa redefini-la direto no banco.
- **Cadastro revela se o e-mail já existe** (mensagem de conflito). Com o cadastro fechado (`ALLOW_REGISTRATION=false`), o risco é mínimo.
- **Rate limit em memória**: vale para uma instância só; reiniciar o servidor zera os contadores. Com várias instâncias, use Redis.
- **Bloqueio de conta** pode ser usado para incomodar um usuário (errar a senha dele 5 vezes); o bloqueio dura só 15 minutos.
- **Dados ficam em texto no SQLite** (exceto senhas e chaves de IA). Proteja o arquivo do banco e o disco (BitLocker/LUKS).
- **Dados enviados à IA** saem do servidor e vão para o provedor escolhido, sujeitos à política de privacidade dele.

## 4. Como verificar

```bash
npm test         # 10 testes: login, bloqueio, CSRF, IDOR, permissões, criptografia da chave, SSRF, cabeçalhos, cálculos
npm run audit    # vulnerabilidades em dependências
```
