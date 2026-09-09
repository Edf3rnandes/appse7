# Rodar o Hub na sua máquina

O Hub não precisa do Supabase de produção nem do MySQL do Laravel para subir.
Um Postgres local basta, e é assim que se deve mexer no sistema sem risco de
encostar em dado real.

## 1. Postgres

Qualquer Postgres 14+ serve. Com o pacote do sistema:

```bash
initdb -U postgres -A trust -D ~/se7data
pg_ctl -D ~/se7data -o "-p 5433" start
createdb -h 127.0.0.1 -p 5433 -U postgres se7hub
```

## 2. `.env`

```env
DATABASE_URL=postgresql://postgres@127.0.0.1:5433/se7hub
DIRECT_URL=postgresql://postgres@127.0.0.1:5433/se7hub
JWT_SECRET=desenvolvimento-local-somente-nao-usar-em-producao-32
PORT=3000
ADMIN_EMAILS=seu-email@exemplo.com
SEED_ADMIN_SENHA=umasenhaqualquer
```

`GOOGLE_CLIENT_ID` e as variáveis `LEGACY_MYSQL_*` ficam vazias de propósito:
o Hub sobe sem elas. Sem Google, a tela de entrada mostra o formulário de
e-mail e senha; sem MySQL, as telas que dependem do sistema antigo respondem
503 com mensagem clara, e o resto funciona.

## 3. Tabelas

```bash
npx prisma db push        # cria o schema hub
npm run seed              # admin de ADMIN_EMAILS, com senha
npm run importar:turmas   # as 6 unidades e as 46 turmas de verdade
npm run importar:planos   # os 43 planos, já ligados às turmas de cada um
npm run seed:escola       # professores e famílias de demonstração
```

A ordem importa: `importar:planos` precisa das turmas para ligar cada plano
às suas, e `seed:escola` precisa das duas — os dois param com um recado se
faltar o passo anterior. `importar:turmas` lê `prisma/dados/turmas.tsv`, que é a
exportação do painel do sistema atual, e é repetível — a primeira coluna é o
id de lá, guardado em `legacyId`, então rodar de novo atualiza em vez de
duplicar.

O cronograma mora numa tabela do **outro** sistema (`se7-inadimplencia`), que
não é modelo do Prisma daqui — ver o comentário em
`src/db/compartilhado/cronograma.repository.ts`. Para tê-la localmente:

```sql
CREATE TABLE IF NOT EXISTS public.cronograma_semanas (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  semana date NOT NULL UNIQUE,
  tema text,
  fundamentos text,
  "exerciciosSugeridos" text,
  observacoes text,
  "postagensPlanejadas" text,
  "textoDivulgacao" text,
  "linkCanva" text,
  "imagemBase64" text,
  "imagemNome" text,
  status text NOT NULL DEFAULT 'rascunho',
  "criadoEm" timestamptz NOT NULL DEFAULT now(),
  "atualizadoEm" timestamptz NOT NULL DEFAULT now()
);
```

Este `CREATE TABLE` é **só para desenvolvimento**. Em produção a tabela já
existe e pertence ao outro sistema: lá se roda apenas
`prisma/instalar-no-supabase.sql`, que é aditivo.

## 4. Subir

```bash
npm run dev          # ou: npx tsx src/server.ts
curl localhost:3000/health
```

O `/health` diz o que está ligado:

```json
{"ok":true,"banco":true,"cronogramaCompartilhado":true,
 "google":false,"importacaoLegadoPronta":false}
```

`google:false` e `importacaoLegadoPronta:false` são o esperado numa máquina de
desenvolvimento — e em produção também, enquanto o Google não estiver
configurado e a importação dos alunos não acontecer. `banco:false` ou `cronogramaCompartilhado:false` indicam que
o passo 3 não foi feito.

Entre em <http://localhost:3000/secretaria.html> com o e-mail de
`ADMIN_EMAILS` e a senha de `SEED_ADMIN_SENHA`.

## 5. Testes

```bash
npm test
```

Eles usam o mesmo `DATABASE_URL` do `.env` e limpam o que criam. Não aponte
para o banco de produção.
