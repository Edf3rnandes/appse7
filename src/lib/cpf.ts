import { createHash } from "node:crypto";

// O Laravel grava o CPF em `customers.cpf` ja sem pontuacao (ver o
// str_replace(['-', '.'], '') espalhado pelos controllers dele) — mas grava
// tambem alguns com barra/espaco. Normalizamos para so digitos dos dois lados
// da comparacao para nao depender de como foi digitado na epoca.
export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

// Validacao real de CPF (digitos verificadores). Barrar "111.111.111-11" antes
// de consultar o banco evita gastar tentativa do limite com lixo obvio.
export function cpfValido(valor: string): boolean {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digito = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) {
      soma += Number(cpf[i]) * (ate + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(9) === Number(cpf[9]) && digito(10) === Number(cpf[10]);
}

// Usado so na trilha de auditoria (hub_tentativas_vinculo): guarda que houve
// tentativa com aquele documento sem guardar o documento.
export function hashCpf(valor: string): string {
  return createHash("sha256").update(somenteDigitos(valor)).digest("hex");
}

export function mascararCpf(valor: string): string {
  const cpf = somenteDigitos(valor);
  if (cpf.length !== 11) return "***";
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}
