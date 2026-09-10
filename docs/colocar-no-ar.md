# Colocar no ar

Do zero até o sistema respondendo, sem tocar no Laravel e sem depender dele.

O sistema **não precisa** do se7volei para funcionar. A importação dos alunos
([`importar-a-escola.md`](importar-a-escola.md)) é um passo separado, e pode
esperar: dá para subir hoje, olhar as telas com as 46 turmas e os 43 planos de
verdade, e trazer os alunos quando quiser.

São quatro passos. O primeiro é o único que exige atenção.

---

## 1 · Criar as tabelas no Supabase

O arquivo é **`prisma/instalar-no-supabase.sql`**. No painel do Supabase, o
mesmo projeto do se7-cobrancas: **SQL Editor → New query →** cole o arquivo
inteiro → **Run**.

O que ele faz:

- cria o schema `hub` e as **22 tabelas** do sistema;
- acrescenta a coluna `observacoes` em `public.cronograma_semanas`.

O que ele **não** faz: encostar em qualquer outra coisa fora do `hub`. As
tabelas do se7-cobrancas (`central_cards`, `cobranca_registros`, `loja_*`,
`usuarios`…) ficam exatamente como estão. Não há `DROP`, `DELETE` nem
`TRUNCATE` em nenhuma linha do arquivo.

Para conferir depois:

```sql
select table_schema, count(*)
  from information_schema.tables
 where table_schema in ('hub','public')
 group by 1;
-- hub deve dar 22; public, o mesmo número de antes.
```

### Se ele parar dizendo que algo "already exists"

```
ERROR: 42710: type "Provedor" already exists
```

Quer dizer que o schema `hub` já tem uma instalação anterior. O script não
altera o que existe — ele para. É de propósito: continuar por cima de uma
versão antiga daria um banco meio de um jeito, meio de outro.

**Antes de apagar, veja o que tem lá.** Rode isto:

```sql
select 'turmas'      as tabela, count(*) from hub.turmas
union all select 'planos',      count(*) from hub.planos
union all select 'alunos',      count(*) from hub.alunos
union all select 'matriculas',  count(*) from hub.matriculas
union all select 'usuarios',    count(*) from hub.usuarios;
```

- **Alunos e matrículas em zero** — é a instalação de experimento. Pode apagar.
- **Alunos ou matrículas com número** — pare e me diga o que apareceu. Tem
  cadastro de verdade ali, e apagar é definitivo.

Sendo o primeiro caso, rode **este comando sozinho**, conferindo que está
escrito `hub` e não `public`, e depois cole o script inteiro de novo:

```sql
DROP SCHEMA "hub" CASCADE;
```

Ele apaga só o schema do Hub. As tabelas do se7-cobrancas vivem em `public` e
não são tocadas — conferido: depois do DROP e da reinstalação, `public`
continuou com exatamente as mesmas tabelas de antes.

## 2 · Criar o serviço no Render

O arquivo é **`render.yaml`**, na raiz do repositório. Render → **New → Blueprint**
→ aponte para o repositório e o ramo `claude/se7-volei-praia-code-review-ds0fmj`.

Ele já traz build, start, health check e a lista de variáveis. Só estas
precisam ser preenchidas à mão:

| Variável | O que pôr | Obrigatória |
|---|---|---|
| `DATABASE_URL` | **o mesmo valor do serviço se7-cobrancas** — é o que faz o cronograma ser a mesma tabela nos dois sistemas | sim |
| `ADMIN_EMAILS` | seu e-mail. Quem administra a escola. Aceita vários, separados por vírgula | sim |
| `SOCIO_EMAILS` | seu e-mail de novo. Quem vê o resultado da escola | sim, para a área dos sócios abrir |
| `SEED_ADMIN_SENHA` | uma senha forte | só se quiser entrar sem Google |
| `GOOGLE_CLIENT_ID` | o ID do projeto no Google Cloud | só para o login com Google |
| `ASAAS_API_KEY` | a chave da conta | só para ver cobranças; **ela sozinha não emite nada** |

`JWT_SECRET` o Render gera sozinho. `TZ` e `CEP_BASE_URL` já vêm preenchidas.
As quatro `LEGACY_MYSQL_*` podem ficar vazias — não são mais necessárias.

**Por que `SOCIO_EMAILS` é separada de `ADMIN_EMAILS`:** ADMIN administra a
escola; SÓCIO vê a distribuição do resultado. Somar os dois automaticamente
daria acesso ao painel financeiro a qualquer pessoa que a escola precise tornar
administradora um dia. E ela precisa existir porque **só sócio convida sócio** —
sem ela a área nasceria sem ninguém que pudesse entrar.

## 3 · Trazer as turmas e os planos

Uma vez, do seu computador, com o `.env` apontando para o mesmo banco:

```bash
npm install
npm run importar:turmas
npm run importar:planos
```

São as 46 turmas e os 43 planos de verdade, os que você mandou. A saída avisa
se alguma turma ficar sem plano — turma sem plano não aceita matrícula.

Os dois comandos podem ser repetidos: atualizam em vez de duplicar.

## 4 · Entrar

Com o serviço no ar, cinco endereços:

| Tela | Endereço | Quem entra |
|---|---|---|
| Matrícula pelo site | `/matricula.html` | qualquer pessoa, sem login |
| Portal do responsável | `/` | responsável, com Google ou senha |
| Área do professor | `/professor.html` | professor, por convite |
| Administrativo | `/administrativo.html` | ADMIN e ADMINISTRATIVO |
| Sócios | `/socios.html` | SÓCIO |

O administrativo e a área dos sócios se enxergam: quem tem os dois papéis
troca de área pelo canto superior direito, sem sair.

---

## Uma conta com vários papéis

A mesma pessoa pode ser dono, administrador, professor e pai de aluno — e no
seu caso vai ser. O sistema foi feito assim de propósito: `Usuario` é uma
**pessoa**, não um perfil, e por isso papel e vínculo são tabelas separadas.

Na prática, com os quatro papéis:

- as áreas aparecem como atalhos no canto superior direito, e trocar entre elas
  não pede login de novo;
- cada área continua mostrando só o que é dela — o professor vê as turmas dele,
  o portal mostra os filhos dele;
- no celular a barra do topo quebra em duas linhas para caber.

Verificado com uma conta carregando os cinco papéis ao mesmo tempo: as cinco
telas abrem, os atalhos aparecem em todas, e nenhuma estoura a largura no
celular.

## Como cada pessoa entra pela primeira vez

- **Você** — já entra, pelas variáveis do passo 2.
- **Administrativo** — Administrativo → Configurações → Usuários → convite.
- **Professor** — mesmo lugar, escolhendo qual professor do cadastro a conta
  representa. O convite sai pronto para mandar no WhatsApp.
- **Sócio** — mesma tela, mas **só outro sócio** pode emitir.
- **Responsável** — sozinho: entra pelo portal com o Google ou criando senha, e
  informa o CPF para ligar a conta ao cadastro.

## O que já funciona sem o Laravel

Tudo, menos os alunos que ainda estão lá:

- as 46 turmas e os 43 planos, com horários e condições contratuais;
- matrícula pelo site, nos quatro passos, com endereço e busca por CEP;
- cadastro de aluno, matrícula de família e renovação pelo administrativo;
- chamada do professor, frequência por turma e por aluno;
- portal do responsável: alunos, frequência, faturas, endereço e foto;
- painel dos sócios: receita prevista, adesão, turmas ociosas e com demanda;
- fechamento diário às 23:59, que começa a gravar no primeiro dia no ar;
- cronograma, eventos e avisos.

O que depende de outra coisa, e diz isso na tela em vez de quebrar:

| Recurso | Depende de |
|---|---|
| Faturas e cobranças vencidas | `ASAAS_API_KEY` |
| Emitir cobrança | a chave **mais** a configuração `asaas.emissaoAtiva`, ligada por um ADMIN pela tela |
| Login com Google | `GOOGLE_CLIENT_ID` |
| Alunos e matrículas históricas | a importação do dump |

## Verificado

Este roteiro foi executado inteiro num banco Postgres limpo, com o schema
`public` já ocupado por tabelas de outro sistema, para reproduzir o Supabase de
vocês:

- o script criou 22 tabelas em `hub` e não alterou nenhuma tabela do vizinho —
  só acrescentou a coluna `observacoes`;
- as 46 turmas e os 43 planos entraram;
- as cinco telas abriram, sem um único erro de JavaScript.
