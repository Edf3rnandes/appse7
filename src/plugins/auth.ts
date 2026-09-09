import fjwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";

export type PapelNomeToken = "SOCIO" | "ADMIN" | "ADMINISTRATIVO" | "PROFESSOR" | "RESPONSAVEL";

export interface TokenHub {
  sub: string;
  email: string;
  nome: string;
  papeis: PapelNomeToken[];
  // Ids no sistema Laravel, quando o usuario tem o vinculo correspondente.
  // Vao no token de proposito: e o que permite autorizar uma leitura do legado
  // sem consultar o Postgres a cada requisicao — e o que impede o cliente de
  // escolher de qual responsavel quer ver os dados.
  responsavelId?: string;
  professorId?: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: TokenHub;
    user: TokenHub;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    autenticar: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    exigirPapel: (
      ...papeis: PapelNomeToken[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    exigirResponsavel: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    exigirProfessor: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Os papeis que o token realmente vale, depois de aplicar quem contem quem.
 *
 * SOCIO e o dono: faz tudo o que ADMIN faz, e mais. Isso esta AQUI, num lugar
 * so, e nao espalhado como `exigirPapel("ADMIN", "SOCIO")` em cada rota — a
 * segunda forma da certo ate o dia em que alguem escreve uma rota nova e
 * esquece de somar o SOCIO. A regra de quem contem quem e do sistema de
 * acesso, nao de cada rota.
 *
 * ADMIN NAO contem ADMINISTRATIVO de proposito: as rotas que os dois usam ja
 * listam os dois explicitamente, e existem coisas que so o ADMIN faz (ligar a
 * emissao de cobranca, por exemplo). Encadear tudo aqui daria permissao nova a
 * quem nao pediu.
 */
export function papeisEfetivos(papeis: PapelNomeToken[]): PapelNomeToken[] {
  const efetivos = new Set<PapelNomeToken>(papeis);
  if (efetivos.has("SOCIO")) efetivos.add("ADMIN");
  return [...efetivos];
}

// Diferenca deliberada em relacao aos dois sistemas atuais: aqui existe papel.
// No Laravel qualquer usuario logado faz tudo (inclusive apagar cobranca no
// Asaas) e no se7-inadimplencia o login e unico e compartilhado. Um portal que
// vai receber aluno e responsavel nao pode continuar assim.
export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(fjwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "12h" },
  });

  app.decorate("autenticar", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: "Nao autenticado." });
    }
  });

  app.decorate(
    "exigirPapel",
    (...papeis: PapelNomeToken[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          await request.jwtVerify();
        } catch {
          return reply.code(401).send({ message: "Nao autenticado." });
        }
        const temPapel = papeisEfetivos(request.user.papeis).some((p) => papeis.includes(p));
        if (!temPapel) {
          return reply.code(403).send({ message: "Sem permissao para esta operacao." });
        }
      },
  );

  // Atalhos para os dois casos mais comuns: a rota nao so exige o papel como
  // depende do vinculo com o legado estar feito.
  app.decorate("exigirResponsavel", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: "Nao autenticado." });
    }
    if (typeof request.user.responsavelId !== "string") {
      return reply.code(409).send({
        message: "Conta ainda nao vinculada a um responsavel. Informe o CPF em /auth/vincular-cpf.",
        codigo: "VINCULO_PENDENTE",
      });
    }
  });

  app.decorate("exigirProfessor", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: "Nao autenticado." });
    }
    if (typeof request.user.professorId !== "string") {
      return reply.code(409).send({
        message: "Conta sem vinculo de professor. Peca um convite o administrativo.",
        codigo: "VINCULO_PENDENTE",
      });
    }
  });
});
