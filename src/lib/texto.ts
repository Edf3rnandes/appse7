/**
 * Normaliza para comparação: sem acento, tudo minúsculo.
 *
 * Serve para casar texto que a mesma pessoa escreve de formas diferentes —
 * "Família" e "familia", "Terça" e "terca". Usado nos importadores, onde os
 * nomes vêm de exportações e de redação à mão, e uma diferença de acento não
 * pode significar "não achei".
 */
export function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
