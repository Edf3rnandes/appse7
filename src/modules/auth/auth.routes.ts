import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PapelNome } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env, googleConfigurado } from "../../config/env.js";
import { GoogleNaoConfiguradoError, TokenGoogleInvalidoError, verificarIdToken } from "./google.js";
import {
  ContaInativaError,
  CpfInvalidoError,
  CpfJaVinculadoError,
  CpfNaoEncontradoError,
  CredencialInvalidaError,
  LimiteTentativasError,
  entrarComGoogle,
  entrarComSenha,
  montarToken,
  vincularPorCpf,
} from "./auth.service.js";

// required_error alem do min(): sem ele, campo ausente devolve o "Required"
// cru do Zod em vez da mensagem em portugues que o front mostra ao usuario.
const googleSchema = z.object({
  idToken: z
    .string({ required_error: "idToken e obrigatorio." })
    .min(1, "idToken e obrigatorio."),
});

const senhaSchema = z.object({
  email: z.string({ required_error: "Informe o e-mail." }).email("E-mail invalido."),
  senha: z.string({ required_error: "Informe a senha." }).min(1, "Informe a senha."),
});

const cpfSchema = z.object({
  cpf: z
    .string({ required_error: "Informe o CPF." })
    .min(11, "Informe o CPF completo."),
});

const conviteSchema = z.object({
  email: z.string().email("Email invalido."),
  papel: z.enum(["SOCIO", "ADMIN", "ADMINISTRATIVO", "PROFESSOR"]),
  // Qual professor do cadastro essa conta vai representar.
  professorId: z.string().uuid().optional(),
  validadeDias: z.number().int().min(1).max(90).default(14),
});

export async function authRoutes(app: FastifyInstance) {
  // Diz ao front o que esta ligado, para ele nao mostrar um botao do Google que
  // vai falhar. Unica rota de auth sem autenticacao alguma.
  //
  // O clientId sai daqui de proposito: ele e publico por definicao (aparece na
  // URL do consentimento do Google), e assim o front nao precisa ser
  // reconstruido quando o projeto do Google Cloud mudar.
  app.get("/auth/config", async () => ({
    google: googleConfigurado,
    clientId: env.GOOGLE_CLIENT_ID,
    // O front so desenha o formulario de senha quando ele e util: sem Google
    // configurado ele e a unica porta, e com Google ele fica atras de um link
    // discreto para nao competir com o caminho normal.
    senha: true,
  }));

  // Ver entrarComSenha(): porta de servico da administracao, nao o caminho
  // normal de ninguem.
  app.post("/auth/senha", async (request, reply) => {
    const body = senhaSchema.parse(request.body);

    try {
      const usuario = await entrarComSenha(body.email, body.senha);
      const payload = montarToken(usuario);

      return reply.send({
        token: app.jwt.sign(payload),
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          avatarUrl: usuario.avatarUrl,
          papeis: payload.papeis,
          vinculoPendente:
            payload.papeis.includes("RESPONSAVEL") && payload.responsavelId === undefined,
        },
      });
    } catch (err) {
      if (err instanceof CredencialInvalidaError) {
        return reply.code(401).send({ message: err.message });
      }
      if (err instanceof ContaInativaError) {
        return reply.code(403).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/google", async (request, reply) => {
    const body = googleSchema.parse(request.body);

    try {
      const perfil = await verificarIdToken(body.idToken);
      const usuario = await entrarComGoogle(perfil);
      const payload = montarToken(usuario);

      return reply.send({
        token: app.jwt.sign(payload),
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          avatarUrl: usuario.avatarUrl,
          papeis: payload.papeis,
          // O front usa isto para decidir se manda a pessoa para a tela de CPF
          // antes de qualquer outra coisa.
          vinculoPendente:
            payload.papeis.includes("RESPONSAVEL") && payload.responsavelId === undefined,
        },
      });
    } catch (err) {
      if (err instanceof GoogleNaoConfiguradoError) {
        return reply.code(503).send({ message: err.message });
      }
      if (err instanceof TokenGoogleInvalidoError) {
        return reply.code(401).send({ message: err.message });
      }
      if (err instanceof ContaInativaError) {
        return reply.code(403).send({ message: err.message });
      }
      throw err;
    }
  });

  app.post("/auth/vincular-cpf", { preHandler: [app.autenticar] }, async (request, reply) => {
    const body = cpfSchema.parse(request.body);

    try {
      const { responsavel } = await vincularPorCpf(
        request.user.sub,
        body.cpf,
        request.ip,
      );

      const usuario = await prisma.usuario.findUniqueOrThrow({
        where: { id: request.user.sub },
        include: { papeis: true, vinculos: true },
      });

      // Token novo: o anterior nao carrega o responsavelId, e e o token que
      // autoriza a leitura do legado.
      return reply.send({
        token: app.jwt.sign(montarToken(usuario)),
        responsavel: { id: responsavel.id, nome: responsavel.nome },
      });
    } catch (err) {
      if (err instanceof CpfInvalidoError) return reply.code(400).send({ message: err.message });
      if (err instanceof LimiteTentativasError) return reply.code(429).send({ message: err.message });
      if (err instanceof CpfNaoEncontradoError) return reply.code(404).send({ message: err.message });
      if (err instanceof CpfJaVinculadoError) return reply.code(409).send({ message: err.message });
      throw err;
    }
  });

  app.get("/auth/eu", { preHandler: [app.autenticar] }, async (request) => ({
    id: request.user.sub,
    nome: request.user.nome,
    email: request.user.email,
    papeis: request.user.papeis,
    responsavelId: request.user.responsavelId ?? null,
    professorId: request.user.professorId ?? null,
  }));

  // Professor e administrativo entram por convite — ver o comentario em
  // prisma/schema.prisma (model Convite) para o porque.
  app.post(
    "/auth/convites",
    { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] },
    async (request, reply) => {
      const body = conviteSchema.parse(request.body);
      const email = body.email.toLowerCase();

      // Só sócio convida sócio. Sem esta linha um administrativo emitiria um
      // convite de SOCIO e, no login seguinte, teria acesso a tudo — incluindo
      // a distribuição de lucro. Convite é o caminho por onde permissão entra
      // no sistema, e nenhum caminho pode dar mais do que quem o abriu tem.
      if (body.papel === "SOCIO" && !request.user.papeis.includes("SOCIO")) {
        return reply.code(403).send({
          message: "Só um sócio pode convidar outro sócio.",
        });
      }

      if (body.papel === "PROFESSOR" && body.professorId === undefined) {
        return reply.code(400).send({
          message: "Escolha qual professor do cadastro essa conta vai representar.",
        });
      }

      // Um professor por conta: sem esta checagem o convite seria aceito e
      // falharia calado no login, deixando a pessoa em "aguardando" para
      // sempre — foi exatamente assim que o primeiro convite não funcionou.
      if (body.professorId) {
        const professor = await prisma.professor.findUnique({
          where: { id: body.professorId },
          include: { vinculo: true },
        });
        if (!professor) {
          return reply.code(404).send({ message: "Professor não encontrado no cadastro." });
        }
        if (professor.vinculo) {
          return reply.code(409).send({
            message: `${professor.nome} já está ligado a outra conta.`,
          });
        }

        // Nem dois convites em aberto para o mesmo professor. Só o primeiro a
        // entrar receberia o vínculo; o segundo ficaria "aguardando" para
        // sempre, sem nada na tela explicando por quê.
        const jaConvidado = await prisma.convite.findFirst({
          where: {
            professorId: body.professorId,
            email: { not: email },
            usadoEm: null,
            expiraEm: { gt: new Date() },
          },
        });
        if (jaConvidado) {
          return reply.code(409).send({
            message: `Já existe um convite em aberto para ${professor.nome}, enviado para ${jaConvidado.email}. Cancele aquele antes.`,
          });
        }
      }

      const expiraEm = new Date(Date.now() + body.validadeDias * 24 * 60 * 60 * 1000);

      const convite = await prisma.convite.upsert({
        where: { email },
        create: {
          email,
          papel: body.papel as PapelNome,
          professorId: body.professorId ?? null,
          criadoPorId: request.user.sub,
          expiraEm,
        },
        update: {
          papel: body.papel as PapelNome,
          professorId: body.professorId ?? null,
          criadoPorId: request.user.sub,
          expiraEm,
          usadoEm: null,
        },
      });

      return reply.code(201).send({
        id: convite.id,
        email: convite.email,
        papel: convite.papel,
        expiraEm: convite.expiraEm,
      });
    },
  );

  app.get(
    "/auth/convites",
    { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] },
    async () =>
      prisma.convite.findMany({
        orderBy: { criadoEm: "desc" },
        take: 100,
        select: {
          id: true,
          email: true,
          papel: true,
          professorId: true,
          expiraEm: true,
          usadoEm: true,
          criadoEm: true,
        },
      }),
  );

  // Cancelar um convite ainda não usado — e-mail errado, pessoa que desistiu.
  app.delete(
    "/auth/convites/:id",
    { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await prisma.convite.delete({ where: { id } }).catch(() => null);
      return reply.code(204).send();
    },
  );

  // Quem tem acesso hoje, com papel e vínculo. É a resposta para "quem entra
  // no sistema?", que antes só existia consultando o banco na mão.
  app.get(
    "/auth/usuarios",
    { preHandler: [app.exigirPapel("ADMIN", "ADMINISTRATIVO")] },
    async () => {
      const usuarios = await prisma.usuario.findMany({
        orderBy: [{ ativo: "desc" }, { nome: "asc" }],
        take: 200,
        select: {
          id: true,
          nome: true,
          email: true,
          ativo: true,
          ultimoLoginEm: true,
          papeis: { select: { nome: true } },
          vinculos: {
            select: {
              tipo: true,
              professor: { select: { id: true, nome: true } },
              responsavel: { select: { id: true, nome: true } },
            },
          },
        },
      });

      return usuarios.map((u) => ({
        id: u.id,
        nome: u.nome,
        email: u.email,
        ativo: u.ativo,
        ultimoLoginEm: u.ultimoLoginEm,
        papeis: u.papeis.map((p) => p.nome),
        // A tela mostra o nome da pessoa ligada à conta, não um id: "Rafael
        // Lima" diz o que "7" nunca disse.
        vinculos: u.vinculos.map((v) => ({
          tipo: v.tipo,
          nome: v.professor?.nome ?? v.responsavel?.nome ?? null,
        })),
      }));
    },
  );

  // Desativar quem saiu da escola. Não apagamos a conta: o histórico de
  // frequência e de vínculo continua fazendo sentido, e reativar é um clique.
  app.patch(
    "/auth/usuarios/:id",
    { preHandler: [app.exigirPapel("ADMIN")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { ativo } = z.object({ ativo: z.boolean() }).parse(request.body);

      if (id === request.user.sub && !ativo) {
        return reply.code(409).send({
          message: "Você não pode desativar a própria conta.",
        });
      }

      const existe = await prisma.usuario.findUnique({ where: { id } });
      if (!existe) return reply.code(404).send({ message: "Usuário não encontrado." });

      const usuario = await prisma.usuario.update({
        where: { id },
        data: { ativo },
        select: { id: true, nome: true, email: true, ativo: true },
      });

      return usuario;
    },
  );
}
