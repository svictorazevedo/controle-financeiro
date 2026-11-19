import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Proteção contra SSRF: a URL base de um provedor de IA "compatível com OpenAI" é
 * informada pelo usuário, então o servidor não pode ser usado para acessar a rede interna.
 * - exige HTTPS (HTTP só para localhost quando ALLOW_LOCAL_AI=true, ex.: Ollama/LM Studio);
 * - bloqueia IPs privados, loopback, link-local (inclui 169.254.169.254 de metadados de nuvem).
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export async function assertSafeBaseUrl(raw, { allowLocal = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL base inválida.');
  }
  if (url.username || url.password) throw new Error('A URL base não pode conter usuário/senha.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLocal = LOCAL_HOSTS.has(url.hostname) || LOCAL_HOSTS.has(host);

  if (isLocal) {
    if (!allowLocal) throw new Error('Endereços locais estão desativados (defina ALLOW_LOCAL_AI=true para usar Ollama/LM Studio).');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocolo não permitido.');
    return url;
  }
  if (url.protocol !== 'https:') throw new Error('A URL base precisa usar HTTPS.');

  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Não foi possível resolver o endereço da URL base.');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('A URL base aponta para uma rede interna, o que não é permitido.');
  return url;
}

export { isPrivateIp };
