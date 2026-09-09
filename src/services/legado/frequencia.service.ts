import { env, legadoApiConfigurada } from "../../config/env.js";
import { obterSecretDoProfessor } from "../../db/legacy/escola.repository.js";

export class LegadoApiIndisponivelError extends Error {}
export class FrequenciaRecusadaError extends Error {}

export interface PresencaEnviada {
  alunoId: number;
  presente: boolean;
}

/**
 * Grava a frequência chamando o POST /api/attendances do próprio Laravel.
 *
 * O formato do corpo é ditado pelo controller de lá, e tem uma sutileza que
 * precisa ser respeitada ao pé da letra: a presença é decidida por
 * `isset($student['selecionado'])`. Como `isset` é verdadeiro para `false`,
 * mandar `selecionado: false` marcaria o aluno como PRESENTE. Para registrar
 * falta, a chave tem de estar ausente do objeto.
 */
export async function lancarFrequencia(
  professorId: number,
  turmaId: number,
  presencas: PresencaEnviada[],
): Promise<void> {
  if (!legadoApiConfigurada) {
    throw new LegadoApiIndisponivelError(
      "Lançamento de frequência não configurado (LEGACY_API_URL).",
    );
  }

  const secret = await obterSecretDoProfessor(professorId);
  if (!secret) {
    throw new LegadoApiIndisponivelError(
      "Professor sem token no sistema atual. Fale com a secretaria.",
    );
  }

  const students = presencas.map((p) =>
    p.presente ? { id: p.alunoId, selecionado: true } : { id: p.alunoId },
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let resposta: Response;
  try {
    resposta = await fetch(`${env.LEGACY_API_URL.replace(/\/$/, "")}/api/attendances`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // O middleware do Laravel aceita o token por Bearer; mandamos por
        // header, e não em query string, para não deixar rastro em log de
        // servidor e histórico de proxy.
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ course_id: turmaId, students }),
      signal: controller.signal,
    });
  } catch {
    throw new LegadoApiIndisponivelError("Não foi possível falar com o sistema da escola.");
  } finally {
    clearTimeout(timer);
  }

  const corpo = (await resposta.json().catch(() => ({}))) as {
    success?: boolean;
    message?: string;
  };

  // O Laravel responde 200 com success:false quando já existe frequência
  // lançada hoje para a turma — não é erro de rede, é regra de negócio, e a
  // mensagem dele é a que o professor precisa ler.
  if (corpo.success === false) {
    throw new FrequenciaRecusadaError(corpo.message || "Frequência recusada pelo sistema.");
  }

  if (!resposta.ok) {
    throw new LegadoApiIndisponivelError(
      corpo.message || `O sistema da escola respondeu ${resposta.status}.`,
    );
  }
}
