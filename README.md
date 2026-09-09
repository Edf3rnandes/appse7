# SE7 Hub

Sistema unificado do SE7 Vôlei de Praia. Junta, num acesso só, o que hoje está
partido em dois sistemas:

| Sistema | Stack | Papel hoje | Papel no Hub |
|---|---|---|---|
| **se7volei** (Laravel 10 / MySQL) | PHP 8.1, Blade, Asaas | Alunos, turmas, matrículas, frequência, cobrança | **Fonte de dados durante a transição** — lido em modo somente leitura, nunca escrito |
| **se7-inadimplencia** (Fastify / Postgres) | Node, Prisma, Supabase | Secretaria: central de demandas, inadimplência, loja, ponto | Módulos migram para cá em seguida |
| **se7-hub** (este repositório) | Node, Fastify, Prisma, Postgres | — | Acesso único, portal do responsável, app do professor |

O Hub é um **caminho novo**: sobe ao lado dos outros dois, sem alterar uma linha
do Laravel nem do se7-inadimplencia. Enquanto ele cresce, os sistemas atuais
continuam funcionando exatamente como estão.

## Como o acesso funciona

Um `Usuario` é uma **pessoa**, não um perfil. A mesma pessoa pode ser professora
e mãe de um aluno ao mesmo tempo — por isso papel e vínculo são tabelas
separadas.

```
Google Sign-In  ──▶  POST /auth/google  ──▶  token do Hub (12h)
                          │
                          ├─ e-mail em ADMIN_EMAILS ......... ADMIN (bootstrap)
                          ├─ convite pendente ............... papel do convite
                          └─ qualquer outra conta ........... RESPONSAVEL sem vínculo
                                                                     │
                                              POST /auth/vincular-cpf │
                                                                     ▼
                                            confere o CPF em customers (MySQL)
                                                     e emite token novo
```

**Responsável entra sozinho, pelo CPF.** É o único caminho self-service, porque
`customers.cpf` existe, é único e é o dado que a família conhece.

**Professor, secretaria e admin entram por convite.** Isso não é escolha de
produto: a tabela `teachers` do Laravel **não tem CPF nem e-mail**, então não há
como o professor provar quem é sozinho no primeiro acesso. A secretaria emite o
convite em `POST /auth/convites` informando o `legacyId` (o `teachers.id`), e o
vínculo já sai pronto quando a pessoa entra com o Google.

### O que impede a enumeração de CPF

A API atual do Laravel aceita `GET /api/customer/bills?cpf=...` sem login — quem
tiver um CPF vê faturas de qualquer família. No Hub, o mesmo dado exige:

1. estar autenticado (não existe rota de dado pessoal aberta);
2. CPF com dígitos verificadores válidos, conferidos antes de tocar o banco;
3. no máximo `VINCULO_MAX_TENTATIVAS_HORA` erros por conta por hora;
4. registro de toda tentativa em `hub_tentativas_vinculo`, com o CPF **em hash** —
   o número em claro nunca é gravado nessa trilha;
5. um CPF já vinculado a outra conta é recusado sem dizer a quem pertence.

Depois do vínculo, `responsavelId` e `professorId` viajam **dentro do token**.
Nenhuma rota do portal aceita CPF, `customer_id` ou `student_id` como critério de
busca vindo do cliente: `student_id` só é aceito depois de passar pela checagem
de posse (`alunoPertenceAoResponsavel`), e responde 404 — não 403 — quando não
pertence, para não confirmar que o aluno existe.

## Rotas

| Método | Rota | Quem acessa |
|---|---|---|
| `GET` | `/health` | público (diz quais integrações subiram) |
| `GET` | `/auth/config` | público |
| `POST` | `/auth/google` | público (troca o id_token do Google pelo token do Hub) |
| `POST` | `/auth/vincular-cpf` | autenticado |
| `GET` | `/auth/eu` | autenticado |
| `POST` `GET` | `/auth/convites` | ADMIN, SECRETARIA |
| `GET` | `/portal/alunos` | responsável vinculado |
| `GET` | `/portal/alunos/:id/frequencia` | responsável vinculado (dono do aluno) |
| `GET` | `/portal/faturas` | responsável vinculado |
| `GET` | `/portal/perfil` | responsável vinculado |
| `GET` | `/professor/turmas` | professor vinculado |
| `GET` | `/escola/ocupacao` | ADMIN, SECRETARIA |

## Telas

Servidas como arquivos estáticos pelo próprio Hub, em `public/` — sem build e sem framework.

| Página | Para quem |
|---|---|
| `/` | **Portal do responsável** — alunos, frequência dos últimos 6 meses, faturas com 2ª via e cadastro |
| `/professor.html` | **Área do professor** — turmas agrupadas por unidade, com ocupação |

O login é o botão do Google (GIS); no primeiro acesso o responsável informa o CPF e a partir daí
o token guardado no navegador carrega o vínculo. Mobile primeiro: quase todo acesso do responsável
vem do celular, então listas longas viram cartões em vez de tabelas — uma tabela de faturas com
cinco colunas empurra o botão de 2ª via para fora da tela.

`/auth/*` tem limite próprio de 20 req/min; o resto do app, 240 req/min.

## A ponte com o Laravel

`src/db/legacy/` é a única parte do código que fala com o MySQL do sistema
antigo, e só com `SELECT` — `readOnlyQuery` recusa qualquer outro statement,
como segunda camada além da permissão do usuário no banco:

```sql
CREATE USER 'se7hub_ro'@'%' IDENTIFIED BY '...';
GRANT SELECT ON nome_do_banco.* TO 'se7hub_ro'@'%';
```

Os nomes de tabela e coluna em `escola.repository.ts` saíram das migrations
reais do se7volei: `units`, `courses`, `students`, `customers`, `enrollments`,
`plans`, `attendances`, `teachers` e os pivôs `course_teacher` e `course_plan`.

> O esboço equivalente no se7-inadimplencia (`src/db/legacy/alunos.repository.ts`)
> consulta `alunos` e `unidades` com `status = 'ativo'`. Essas tabelas não
> existem — a ponte nunca teria funcionado como estava. As consultas daqui
> substituem aquelas.

Duas particularidades do legado valem para todas as consultas:

- matrícula ativa é `enrollments.status = 'CONFIRMED'` (os outros valores são
  `CREATED`, `PAYMENT_PENDDING` — com dois D mesmo — e `CANCELED`);
- `students`, `customers` e `enrollments` têm `deleted_at`, mas o Laravel nunca
  aplica o `SoftDeletes` de fato. Filtramos por `deleted_at IS NULL` assim mesmo:
  não custa nada e já fica correto no dia em que aquele bug for corrigido lá.

Sem `LEGACY_MYSQL_*` preenchido, o Hub **sobe do mesmo jeito** e as rotas que
dependem do legado respondem 503 com mensagem clara.

## Rodando

```bash
cp .env.example .env     # preencha DATABASE_URL, DIRECT_URL, JWT_SECRET
npm install
npm run prisma:push      # cria as tabelas hub_* no Postgres
npm run seed             # garante o ADMIN de ADMIN_EMAILS
npm run dev
```

`npm run typecheck` roda o TypeScript em modo estrito sem emitir nada.

## O que ainda não está aqui

Esta é a fundação: acesso, vínculo e leitura. Ainda não foram feitos:

- **escrita** de matrícula e renovação (hoje só leitura — a escrita ainda é do Laravel);
- atualização de cadastro/endereço pelo responsável (fecha o módulo "cadastros
  sem endereço" do se7-inadimplencia, que hoje é importação manual);
- lançamento de frequência pelo professor (substitui o app atual, que autentica
  com `secret` previsível em query string);
- migração dos módulos da secretaria vindos do se7-inadimplencia;
- as telas de administração (hoje só portal e área do professor).
