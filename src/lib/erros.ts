import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/**
 * Tratador de erro compartilhado.
 *
 * Cada módulo que registra o seu próprio `setErrorHandler` substitui o do
 * servidor naquele escopo — inclusive o tratamento de ZodError. Foi assim que
 * um link do Canva inválido virou "Erro interno" em vez de dizer o que estava
 * errado. Em vez de repetir a checagem em cada módulo (e esquecer de novo),
 * eles montam o tratador a partir daqui e só acrescentam os erros próprios.
 *
 * `especificos` devolve uma resposta quando reconhece o erro, ou undefined
 * para deixar seguir o caminho padrão.
 */
export function tratadorDeErro(
  especificos?: (erro: unknown) => { status: number; mensagem: string } | undefined,
) {
  return function tratar(
    err: Error & { statusCode?: number },
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (err instanceof ZodError) {
      // "Required" e "Invalid input" são as mensagens padrão do Zod e não
      // dizem nada a quem está na tela. Quando sobra alguma, ao menos dizemos
      // qual campo faltou.
      const mensagem = err.issues
        .map((i) => {
          const generica = i.message === "Required" || i.message === "Invalid input";
          const campo = i.path.join(".");
          return generica && campo ? `Campo obrigatório: ${campo}` : i.message;
        })
        .join("; ");
      return reply.code(400).send({ message: mensagem || "Dados invalidos." });
    }

    const conhecido = especificos?.(err);
    if (conhecido) {
      return reply.code(conhecido.status).send({ message: conhecido.mensagem });
    }

    request.log.error(err);
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.code(statusCode).send({
      message: statusCode < 500 ? err.message : "Erro interno.",
    });
  };
}
