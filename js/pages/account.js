// Minha conta: senha, verificação em duas etapas (2FA/TOTP), sessões, outras casas.
import { sb, q } from '../api.js';
import { state, page, card, field, input, run, loadMe } from '../ctx.js';
import { h, openDialog, confirmDialog, toast, initials } from '../ui.js';
import { icon } from '../icons.js';

export function passwordProblem(pw, email = '') {
  if (pw.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
  if (pw.length > 72) return 'A senha deve ter no máximo 72 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letras e números na senha.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'A senha não deve conter o seu e-mail.';
  return null;
}

async function enrollTotp(after) {
  // Limpa tentativas antigas não concluídas
  const { data: list } = await sb.auth.mfa.listFactors();
  for (const f of list?.all ?? []) if (f.status !== 'verified') await sb.auth.mfa.unenroll({ factorId: f.id });
  const data = await run(null, () => q(sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Autenticador ${new Date().toLocaleDateString('pt-BR')}` })));
  if (!data) return;
  const code = input('code', { required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '\\d{6}', placeholder: '000000', class: 'otp' });
  const ok = h('button', { type: 'submit', class: 'btn' }, icon('shield', 18), h('span', {}, 'Ativar'));
  const form = h('form', { class: 'stack mfa-enroll' },
    h('ol', { class: 'steps' },
      h('li', {}, 'Instale um app autenticador (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).'),
      h('li', {}, 'Leia o QR code abaixo com o app — ou digite a chave manualmente.'),
      h('li', {}, 'Digite o código de 6 dígitos que aparece no app.')),
    h('div', { class: 'qr' }, h('img', { src: data.totp.qr_code, alt: 'QR code para o app autenticador', width: 180, height: 180 })),
    h('p', { class: 'center' }, h('small', { class: 'muted' }, 'Chave: '), h('code', { class: 'secret' }, data.totp.secret)),
    field('Código do app', code), h('div', { class: 'dialog-actions' }, ok));
  const d = openDialog({ title: 'Ativar verificação em duas etapas', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const done = await run(ok, () => q(sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: code.value.trim() })), 'Verificação em duas etapas ativada.');
    if (done) {
      d.close();
      after();
    }
  });
}

export async function renderAccount() {
  const user = state.user;
  const name = user.user_metadata?.name || user.email.split('@')[0];
  const { data: factors } = await sb.auth.mfa.listFactors();
  const totp = (factors?.totp ?? []).filter((f) => f.status === 'verified');
  const rerender = () => renderAccount();

  const nw = input('newPassword', { type: 'password', required: true, minlength: 10, maxlength: 72, autocomplete: 'new-password' });
  const nw2 = input('newPassword2', { type: 'password', required: true, minlength: 10, maxlength: 72, autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, 'Trocar senha');
  const pwForm = h('form', { class: 'form-grid' }, field('Nova senha', nw), field('Repita a nova senha', nw2),
    h('p', { class: 'hint span-2' }, 'Mínimo de 10 caracteres, com letras e números.'), h('div', { class: 'dialog-actions span-2' }, pwBtn));
  pwForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const problem = passwordProblem(nw.value, user.email);
    if (problem) return toast(problem, true);
    if (nw.value !== nw2.value) return toast('As senhas não conferem.', true);
    if (await run(pwBtn, () => q(sb.auth.updateUser({ password: nw.value })), 'Senha alterada.')) pwForm.reset();
  });

  const mfaCard = card('Verificação em duas etapas (2FA)', { sub: 'Pede um código do celular além da senha' },
    totp.length
      ? h('div', { class: 'stack' },
        h('div', { class: 'alert good' }, icon('shield', 18), h('span', {}, 'Ativada. Ao entrar, será pedido o código do app autenticador. Sem o código, o banco não libera nenhum dado.')),
        ...totp.map((f) => h('div', { class: 'row-between' }, h('span', {}, icon('key', 16), ' ', f.friendly_name || 'App autenticador'),
          h('button', {
            type: 'button', class: 'btn small ghost danger-text',
            onclick: async (ev) => {
              if (!await confirmDialog('Desativar a verificação em duas etapas? Sua conta ficará protegida só pela senha.', { danger: true, confirmText: 'Desativar' })) return;
              if (await run(ev.currentTarget, () => q(sb.auth.mfa.unenroll({ factorId: f.id })), '2FA desativada.')) {
                await sb.auth.refreshSession();
                rerender();
              }
            },
          }, 'Desativar'))))
      : h('div', { class: 'stack' },
        h('div', { class: 'alert warn' }, icon('alert', 18), h('span', {}, 'Desativada. Recomendamos ativar: protege seus dados mesmo se a senha vazar.')),
        h('button', { type: 'button', class: 'btn', onclick: () => enrollTotp(rerender) }, icon('shield', 18), h('span', {}, 'Ativar com app autenticador'))));

  const joinCode = input('code', { required: true, maxlength: 20, placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off' });
  const joinBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Entrar');
  const joinForm = h('form', { class: 'inline' }, field('Código de convite', joinCode), joinBtn);
  joinForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = await run(joinBtn, () => q(sb.rpc('join_house', { p_code: joinCode.value })), 'Você entrou!');
    if (id) {
      state.houseId = id;
      state.d = null;
      await loadMe();
      location.hash = '#/painel';
    }
  });
  const newHouse = input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Casa da praia, Minha empresa' });
  const nhBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Criar');
  const nhForm = h('form', { class: 'inline' }, field('Nova casa/empresa', newHouse), nhBtn);
  nhForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = await run(nhBtn, () => q(sb.rpc('create_house', { p_name: newHouse.value, p_my_name: name })), 'Criada!');
    if (id) {
      state.houseId = id;
      state.d = null;
      await loadMe();
      location.hash = '#/painel';
    }
  });

  page('Minha conta', { subtitle: user.email },
    h('div', { class: 'grid cols-2' },
      card(null, { cls: 'profile-card' }, h('div', { class: 'profile' }, h('span', { class: 'avatar lg' }, initials(name)),
        h('div', {}, h('strong', {}, name), h('p', { class: 'muted' }, user.email),
          h('p', { class: 'small muted' }, `${state.houses.length} casa(s)/empresa(s): ${state.houses.map((x) => `${x.name} (${x.role === 'admin' ? 'admin' : 'colaborador'})`).join(', ')}`))),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: async () => { await sb.auth.signOut({ scope: 'global' }); } }, icon('logout', 16), h('span', {}, 'Sair de todos os dispositivos')))),
      mfaCard,
      card('Senha', {}, pwForm),
      card('Outras casas/empresas', {}, nhForm, h('div', { class: 'sep' }), joinForm)));
}

/** Tela de código 2FA depois do login com senha. */
export function renderMfaChallenge(onDone) {
  const app = document.getElementById('app');
  const code = input('code', { required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '\\d{6}', placeholder: '000000', class: 'otp' });
  const err = h('div', { class: 'error', hidden: true });
  const ok = h('button', { type: 'submit', class: 'btn block' }, 'Verificar');
  const form = h('form', { class: 'stack' }, field('Código do app autenticador', code), err, ok,
    h('button', { type: 'button', class: 'link center', onclick: () => sb.auth.signOut() }, 'Entrar com outra conta'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    ok.disabled = true;
    try {
      const { data } = await sb.auth.mfa.listFactors();
      const f = data?.totp?.find((x) => x.status === 'verified');
      if (!f) throw new Error('Nenhum app autenticador cadastrado.');
      await q(sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: code.value.trim() }));
      await onDone();
    } catch (e) {
      err.textContent = /invalid|expired/i.test(String(e.message)) ? 'Código inválido ou expirado. Confira o relógio do celular e tente de novo.' : e.message;
      err.hidden = false;
    } finally {
      ok.disabled = false;
    }
  });
  app.replaceChildren(h('div', { class: 'auth-wrap single' }, h('div', { class: 'auth-card' },
    h('div', { class: 'auth-ico' }, icon('shield', 28)), h('h1', {}, 'Verificação em duas etapas'),
    h('p', { class: 'muted center' }, 'Abra o app autenticador no celular e digite o código de 6 dígitos.'), form)));
  code.focus();
}
