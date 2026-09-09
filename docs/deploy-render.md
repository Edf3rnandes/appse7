# Subir o SE7 Hub no Render

Passo a passo do primeiro deploy.

**Antes de tudo, o banco.** Rode `prisma/instalar-no-supabase.sql` no SQL Editor
do Supabase — ele cria o schema `hub` com as 20 tabelas e não toca em nada do
se7-inadimplencia. O cabeçalho do arquivo explica o que fazer se você já rodou
a versão anterior, que criava 9.

## 1. Criar o serviço

Render → **New** → **Web Service** → conecte o repositório `Edf3rnandes/appse7`
e escolha a branch `claude/se7-volei-praia-code-review-ds0fmj`.

O `render.yaml` na raiz já descreve build, start e health check. Se preferir
usar o Blueprint (**New → Blueprint**), ele lê esse arquivo e cria o serviço
`se7-hub` pronto — só faltam as variáveis marcadas como `sync: false`.

## 2. Variáveis de ambiente

### Copiada do `se7-cobrancas`, sem alterar nada

Uma só, e ela tem de ser **exatamente a mesma** do outro serviço. É isso que faz
o cronograma ser a mesma tabela nos dois sistemas.

| Variável | Onde pegar |
|---|---|
| `DATABASE_URL` | Render → `se7-cobrancas` → Environment → mesma variável |

**`DIRECT_URL` não é necessária.** Ela só serve ao CLI do Prisma, em `db push` e
migrações; em tempo de execução o app usa apenas `DATABASE_URL`. Como as tabelas
do Hub são criadas pelo `instalar-no-supabase.sql`, não há migração para rodar —
e é por isso que o próprio `se7-cobrancas` também roda sem ela. Se um dia
precisar mudar schema pela CLI, pegue a conexão direta em Supabase → Project
Settings → Database → Connection string, porta **5432** (nunca a 6543).

### Novas

| Variável | Valor |
|---|---|
| `ADMIN_EMAILS` | seu e-mail — é quem vira ADMIN no primeiro login |
| `SEED_ADMIN_SENHA` | uma senha forte. Sem Google configurado, é a única porta de entrada |
| `TZ` | `America/Fortaleza` (já vem no `render.yaml`) |
| `JWT_SECRET` | o Render gera sozinho (`generateValue: true`) |
| `GOOGLE_CLIENT_ID` | do projeto no Google Cloud (passo 3) — opcional |

`GOOGLE_CLIENT_ID` deixou de ser obrigatória: com `SEED_ADMIN_SENHA` definida,
a tela de entrada mostra o formulário de e-mail e senha e o sistema sobe sem o
Google. Dá para deixar o Google para depois, quando o domínio estiver decidido.

### Opcionais — o app sobe sem elas

Cada uma destrava um pedaço; sem elas as telas correspondentes dizem
"indisponível" em vez de quebrar.

| Variável | Destrava |
|---|---|
| `ASAAS_API_KEY` | faturas no portal do responsável e a tela de cobranças vencidas |
| `LEGACY_MYSQL_HOST` `_USER` `_PASSWORD` `_DATABASE` | só a importação única dos alunos do Laravel |

**A chave do Asaas sozinha não faz o sistema cobrar.** Com ela, o Hub apenas
_consulta_ — faturas do responsável e cobranças vencidas —, o que é inofensivo
com os dois sistemas no ar, já que a conta é a mesma. Emitir cobrança depende
de uma segunda chave, `asaas.emissaoAtiva`, que fica no banco, nasce desligada
e só um ADMIN liga, pela tela de Cobranças vencidas. É o que impede os dois
sistemas de cobrarem o mesmo pai durante a transição.

As variáveis `LEGACY_MYSQL_*` **não** são mais necessárias para o sistema
funcionar: alunos, turmas e matrículas moram no Postgres do Hub. Elas servem
apenas ao dia da importação, e podem ficar vazias até lá.

## 3. Os dados da escola, uma vez só

Com o serviço no ar, as unidades, turmas e planos entram por dois comandos.
Eles não rodam a cada deploy — são uma vez, e repetir não duplica (cada linha
guarda o id que tem no sistema atual):

```bash
npm run importar:turmas   # 6 unidades e 46 turmas, com horários
npm run importar:planos   # 43 planos, cada um ligado às suas turmas
```

Rodando localmente, com `DATABASE_URL` apontando para o Supabase, ou pelo Shell
do Render. A saída lista o que foi ligado e avisa se alguma turma ficou sem
plano — turma sem plano não aceita matrícula.

Alunos, responsáveis e matrículas ainda não têm importador: dependem dos dados
do MySQL do Laravel (ver `docs/acesso-mysql.md`).

## 3. Google Cloud, para o login

Console → **APIs e serviços** → **Credenciais** → **Criar credenciais** →
**ID do cliente OAuth** → tipo **Aplicativo da Web**.

Em **Origens JavaScript autorizadas**, acrescente a URL do serviço:

```
https://se7-hub.onrender.com
```

Este passo é obrigatório e é o esquecimento mais comum: sem a origem
autorizada, o botão do Google simplesmente não funciona, sem mensagem de erro
clara. Se depois o serviço ganhar domínio próprio, acrescente o domínio aqui
também — a lista aceita mais de uma origem.

Copie o **ID do cliente** para `GOOGLE_CLIENT_ID`. Não existe client secret
neste fluxo: o servidor só valida o `id_token`.

## 4. Conferir

Depois do deploy, abra `https://se7-hub.onrender.com/health`:

```json
{"ok":true,"banco":true,"cronogramaCompartilhado":true,
 "google":false,"importacaoLegadoPronta":false}
```

Como ler cada campo:

| Campo | O que significa quando é `false` |
|---|---|
| `banco` | A `DATABASE_URL` está errada ou o Postgres não respondeu |
| `cronogramaCompartilhado` | Conectou, mas **num banco sem `cronograma_semanas`** — provavelmente projeto errado, ou o `instalar-no-supabase.sql` não rodou |
| `google` | Falta `GOOGLE_CLIENT_ID`. Com `SEED_ADMIN_SENHA` definida, dá para entrar por e-mail e senha assim mesmo |
| `importacaoLegadoPronta` | Sem as variáveis `LEGACY_MYSQL_*`. Não impede nada: só a importação dos alunos precisa delas |

Os dois últimos em `false` são o esperado, e o sistema funciona assim. Os dois
primeiros precisam estar `true`.

Então entre em `/administrativo.html` com a conta de `ADMIN_EMAILS` e a senha de
`SEED_ADMIN_SENHA`. Você cai como ADMIN, com o cadastro da escola já no lugar
se os dois comandos de importação tiverem rodado — e vendo as semanas de
cronograma que o administrativo criou pelo painel antigo, porque é a mesma tabela.

## 5. Primeiros acessos das outras pessoas

- **Professor**: em `/administrativo.html`, emita um convite (`POST /auth/convites`)
  com o e-mail dele e o `legacyId` (o `teachers.id` do sistema atual). Aí ele
  entra em `/professor.html` com o Google e já cai vinculado.
- **Responsável**: entra em `/` com o Google e informa o CPF. Só funciona
  depois que o MySQL estiver liberado, porque o CPF é conferido lá.

## Observação sobre o plano gratuito

O serviço hiberna após um tempo sem acesso e a primeira requisição depois disso
demora alguns segundos. Para o uso do administrativo isso é aceitável; se incomodar
no dia a dia do professor, o plano pago do Render remove a hibernação.
