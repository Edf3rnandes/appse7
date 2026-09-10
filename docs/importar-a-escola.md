# Trazer a escola do sistema atual

Este é o caminho da importação: **um arquivo**, gerado uma vez no servidor do
se7volei, e um comando aqui. Não precisa de senha de banco, nem de liberar
firewall, nem de alguém de plantão nos dois lados.

O outro caminho — ler o MySQL pela rede — continua existindo e está descrito em
[`acesso-mysql.md`](acesso-mysql.md). Ele serve para quem já tem a conexão
pronta. Se você não tem, ignore aquele documento: este aqui é mais simples e
chega no mesmo lugar.

---

## 1. Gerar o arquivo

No servidor onde o Laravel roda, um comando só:

```bash
mysqldump --no-create-info --complete-insert nome_do_banco \
  units courses course_schedules plans course_plan teachers course_teacher \
  customers students enrollments attendances \
  > se7volei-dados.sql
```

Troque `nome_do_banco` pelo nome do banco do Laravel.

As três opções importam:

| Opção | Por quê |
|---|---|
| `--no-create-info` | traz só os dados. A estrutura do banco novo já existe e é diferente. |
| `--complete-insert` | põe o nome de cada coluna no arquivo. **Sem isso a importação recusa o arquivo** — a ordem das colunas viria implícita, e bastaria uma coluna a mais no meio para o telefone de todo mundo virar CPF. |
| a lista de tabelas | deixa de fora `jobs`, `sessions`, `migrations` e o resto, que não interessam e só engordam o arquivo. |

O arquivo não tem senha nem token de ninguém: `teachers.password` até vem no
banco, mas a importação não usa e não grava — professor entra pelo Google ou por
convite, e não existe senha nessa tabela no sistema novo.

## 2. Importar

Com o arquivo na máquina:

```bash
npm run importar:dump -- caminho/para/se7volei-dados.sql
```

Precisa do `.env` configurado (`DATABASE_URL` e `JWT_SECRET`), o mesmo que roda
o sistema.

## 3. Ler o relatório

No fim ele imprime três blocos:

```
LIDO DO DUMP        quantas linhas vieram de cada tabela
GRAVADO             quantas eram novas e quantas já existiam
NÃO ENTRARAM        cada linha que ficou de fora, e por quê
```

**O terceiro bloco é o que interessa.** Ele lista uma a uma — não uma amostra —
as linhas que o sistema novo recusou. Os casos que aparecem de verdade:

| O que aparece | O que significa | O que fazer |
|---|---|---|
| `CPF ausente ou incompleto` | o cadastro está sem CPF no sistema atual | o CPF é o que liga a família à conta do portal; sem ele o responsável não entra. Preencher no sistema atual e reimportar. |
| `CPF já pertence a outro cadastro` | a mesma pessoa foi cadastrada duas vezes | as matrículas foram todas para o primeiro cadastro. Conferir se é a mesma pessoa mesmo. |
| `responsável X não existe` | aluno apontando para um responsável que não existe | no sistema atual essa coluna não tinha chave estrangeira, então isso é possível lá. O aluno não entra. |
| `plano X não encontrado` | a matrícula usa um plano que não veio no dump | conferir se a lista de tabelas do `mysqldump` estava completa. |
| `status "X" desconhecido` | um status fora dos quatro conhecidos | avisar, porque é sinal de que o sistema atual mudou. |

## Pode rodar quantas vezes quiser

A importação é casada pelo id que cada linha tem no MySQL. Rodar de novo
**atualiza** o que já veio, em vez de duplicar.

Isso é de propósito, e muda o combinado da virada: dá para importar hoje só
para conferir os números, deixar a escola rodando mais duas semanas no sistema
antigo, e importar de novo no dia da virada. Sem essa garantia, a importação
teria que ser feita de primeira e no escuro.

**Ela nunca apaga nada.** Um aluno que existe aqui e não está no dump fica como
está — pode ter entrado pelo site depois de o arquivo ser gerado.

## O que a importação corrige no caminho

Não é uma cópia. O que estava errado no banco antigo é corrigido ao entrar:

- `PAYMENT_PENDDING`, com dois D desde 2023, vira `PAGAMENTO_PENDENTE`;
- `amount_students` era texto; vira número, e o que não for número vira
  *ausência de capacidade*, não zero — zero diria "turma sem vaga", que é o
  oposto de "não sabemos";
- `address_number` era obrigatório sem valor padrão; aqui é opcional, como o
  resto do endereço;
- `enrollments.category` guardava `parent`/`child` na mesma coluna que em
  `courses` guarda Kids/Teens/Adulto; vira um campo próprio;
- a falta passa a ser uma linha de chamada, e não a ausência de uma — é o que
  permite dizer percentual de presença;
- `0000-00-00` vira data ausente.

## Depois de importar

Confira os números contra o painel do sistema atual: alunos, matrículas ativas
e matriculados por turma. Foi assim que apareceram, na importação das turmas,
quatro turmas com mais alunos do que a capacidade cadastrada — o sistema atual
nunca conferiu isso porque a capacidade estava gravada como texto.
