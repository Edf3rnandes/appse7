import { PapelNome, Provedor, TipoVinculo } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { adminEmails, env } from "../../config/env.js";
import { cpfValido, hashCpf, somenteDigitos } from "../../lib/cpf.js";
import { buscarResponsavelPorCpf } from "../../db/legacy/escola.repository.js";
import type { PerfilGoogle } from "./google.js";
import type { PapelNomeToken, TokenHub } from "../../plugins/auth.js";

export class ContaInativaError extends Error {}
export class CpfInvalidoError extends Error {}
export class CpfNaoEncontradoError extends Error {}
export class CpfJaVinculadoError extends Error {}
export class LimiteTentativasError extends Error {}

// Entrada unica de todo login social. Cria a conta na primeira vez e, dai em
// diante, so atualiza nome/foto e o carimbo de ultimo acesso.
//
// Regras de papel no primeiro acesso:
//   - email em ADMIN_EMAILS  -> ADMIN (bootstrap; sem isso ninguem emite o
//     primeiro convite)
//   - convite valido pendente -> o papel do convite, ja com o vinculo de
//     professor quando o convite trouxer legacyId
//   - qualquer outra conta   -> RESPONSAVEL, ainda SEM vinculo. Autenticado,
//     mas sem enxergar dado de aluno nenhum ate informar o CPF.
/**
 * Aplica um convite pendente à conta que acabou de entrar.
 *
 * Precisa rodar em TODO login, não só no primeiro: um convite emitido para
 * quem já tem conta — o caso mais comum, a secretaria que também quer a área
 * do professor — não fazia nada, porque a checagem só existia no caminho de
 * criação. A pessoa via o convite "aguardando" para sempre.
 *
 * Idempotente: sem convite pendente, não faz nada.
 */
async function aplicarConvitePendente(usuarioId: string, email: string) {
  const convite = await prisma.convite.findFirst({
    where: { email, usadoEm: null, expiraEm: { gt: new Date() } },
  });
  if (!convite) return;

  if (convite.papel === PapelNome.PROFESSOR) {
    if (convite.legacyId == null) return;

    const jaVinculado = await prisma.vinculo.findUnique({
      where: { tipo_legacyId: { tipo: TipoVinculo.PROFESSOR, legacyId: convite.legacyId } },
    });

    // Aquele professor já pertence a outra conta: não roubamos o vínculo e
    // deixamos o convite pendente, para a secretaria ver que algo não fechou.
    if (jaVinculado && jaVinculado.usuarioId !== usuarioId) return;

    if (!jaVinculado) {
      await prisma.vinculo.create({
        data: { usuarioId, tipo: TipoVinculo.PROFESSOR, legacyId: convite.legacyId },
      });
    }
  }

  await prisma.papel.upsert({
    where: { usuarioId_nome: { usuarioId, nome: convite.papel } },
    create: { usuarioId, nome: convite.papel },
    update: {},
  });

  await prisma.convite.update({ where: { id: convite.id }, data: { usadoEm: new Date() } });
}

export async function entrarComGoogle(perfil: PerfilGoogle) {
  const existente = await prisma.identidade.findUnique({
    where: { provedor_provedorSub: { provedor: Provedor.GOOGLE, provedorSub: perfil.sub } },
    include: { usuario: { include: { papeis: true, vinculos: true } } },
  });

  if (existente) {
    if (!existente.usuario.ativo) throw new ContaInativaError("Conta desativada.");

    await prisma.usuario.update({
      where: { id: existente.usuarioId },
      data: { nome: perfil.nome, avatarUrl: perfil.avatarUrl, ultimoLoginEm: new Date() },
    });
    await aplicarConvitePendente(existente.usuarioId, perfil.email);

    // Relido depois do convite: o papel e o vínculo recém-criados precisam
    // entrar no token desta mesma sessão.
    return prisma.usuario.findUniqueOrThrow({
      where: { id: existente.usuarioId },
      include: { papeis: true, vinculos: true },
    });
  }

  // Conta Google nova. Pode, ainda assim, ser um email que ja existe no Hub
  // (por exemplo, um admin criado com senha antes do Google entrar no ar) —
  // nesse caso a identidade Google e anexada a conta que ja existe, em vez de
  // criar uma segunda pessoa com o mesmo email.
  const porEmail = await prisma.usuario.findUnique({
    where: { email: perfil.email },
    include: { papeis: true, vinculos: true },
  });

  if (porEmail) {
    if (!porEmail.ativo) throw new ContaInativaError("Conta desativada.");

    await prisma.identidade.create({
      data: { usuarioId: porEmail.id, provedor: Provedor.GOOGLE, provedorSub: perfil.sub },
    });
    await prisma.usuario.update({
      where: { id: porEmail.id },
      data: { avatarUrl: perfil.avatarUrl, ultimoLoginEm: new Date() },
    });
    await aplicarConvitePendente(porEmail.id, perfil.email);

    return prisma.usuario.findUniqueOrThrow({
      where: { id: porEmail.id },
      include: { papeis: true, vinculos: true },
    });
  }

  const convite = await prisma.convite.findFirst({
    where: { email: perfil.email, usadoEm: null, expiraEm: { gt: new Date() } },
  });

  const papel: PapelNome = adminEmails.includes(perfil.email)
    ? PapelNome.ADMIN
    : (convite?.papel ?? PapelNome.RESPONSAVEL);

  return prisma.$transaction(async (tx) => {
    const usuario = await tx.usuario.create({
      data: {
        nome: perfil.nome,
        email: perfil.email,
        avatarUrl: perfil.avatarUrl,
        ultimoLoginEm: new Date(),
        identidades: {
          create: { provedor: Provedor.GOOGLE, provedorSub: perfil.sub },
        },
        papeis: { create: { nome: papel } },
      },
      include: { papeis: true, vinculos: true },
    });

    // Convite de professor ja chega com o id da linha em `teachers`, entao o
    // vinculo sai pronto — professor nao passa pelo caminho do CPF (a tabela
    // do Laravel nao tem CPF nem email).
    if (convite) {
      if (convite.papel === PapelNome.PROFESSOR && convite.legacyId != null) {
        await tx.vinculo.create({
          data: {
            usuarioId: usuario.id,
            tipo: TipoVinculo.PROFESSOR,
            legacyId: convite.legacyId,
          },
        });
      }
      await tx.convite.update({ where: { id: convite.id }, data: { usadoEm: new Date() } });
    }

    return tx.usuario.findUniqueOrThrow({
      where: { id: usuario.id },
      include: { papeis: true, vinculos: true },
    });
  });
}

// Vincula a conta logada a um responsavel do sistema Laravel, pelo CPF.
//
// Este e o unico ponto do Hub em que alguem consulta a base pelo documento de
// outra pessoa, entao ele carrega tres protecoes que a API publica de hoje nao
// tem: exige estar autenticado, valida os digitos antes de ir ao banco e conta
// as tentativas por hora (o CPF vai para a trilha em hash, nunca em claro).
export async function vincularPorCpf(usuarioId: string, cpfBruto: string, ip: string) {
  const cpf = somenteDigitos(cpfBruto);

  if (!cpfValido(cpf)) {
    throw new CpfInvalidoError("CPF invalido.");
  }

  const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);
  const tentativas = await prisma.tentativaVinculo.count({
    where: { usuarioId, sucesso: false, criadoEm: { gte: umaHoraAtras } },
  });
  if (tentativas >= env.VINCULO_MAX_TENTATIVAS_HORA) {
    throw new LimiteTentativasError(
      "Muitas tentativas com CPF diferente. Tente novamente em uma hora ou fale com a secretaria.",
    );
  }

  const registrar = (sucesso: boolean) =>
    prisma.tentativaVinculo.create({
      data: { usuarioId, cpfHash: hashCpf(cpf), sucesso, ip },
    });

  const responsavel = await buscarResponsavelPorCpf(cpf);
  if (!responsavel) {
    await registrar(false);
    throw new CpfNaoEncontradoError(
      "Nao encontramos esse CPF no cadastro. Confira o numero ou fale com a secretaria.",
    );
  }

  const jaVinculado = await prisma.vinculo.findUnique({
    where: { tipo_legacyId: { tipo: TipoVinculo.RESPONSAVEL, legacyId: responsavel.id } },
  });

  if (jaVinculado && jaVinculado.usuarioId !== usuarioId) {
    // Nao dizemos a quem pertence: so que ja esta em uso. Confirmar "existe e e
    // de outra pessoa" ja seria vazamento.
    await registrar(false);
    throw new CpfJaVinculadoError(
      "Esse CPF ja esta vinculado a outra conta. Fale com a secretaria para transferir o acesso.",
    );
  }

  await registrar(true);

  if (jaVinculado) return { vinculo: jaVinculado, responsavel };

  const vinculo = await prisma.vinculo.create({
    data: {
      usuarioId,
      tipo: TipoVinculo.RESPONSAVEL,
      legacyId: responsavel.id,
      cpf,
    },
  });

  return { vinculo, responsavel };
}

type UsuarioComRelacoes = {
  id: string;
  nome: string;
  email: string;
  papeis: { nome: PapelNome }[];
  vinculos: { tipo: TipoVinculo; legacyId: number }[];
};

export function montarToken(usuario: UsuarioComRelacoes): TokenHub {
  const responsavel = usuario.vinculos.find((v) => v.tipo === TipoVinculo.RESPONSAVEL);
  const professor = usuario.vinculos.find((v) => v.tipo === TipoVinculo.PROFESSOR);

  return {
    sub: usuario.id,
    email: usuario.email,
    nome: usuario.nome,
    papeis: usuario.papeis.map((p) => p.nome as PapelNomeToken),
    ...(responsavel ? { responsavelId: responsavel.legacyId } : {}),
    ...(professor ? { professorId: professor.legacyId } : {}),
  };
}
