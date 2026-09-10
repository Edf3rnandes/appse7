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

Uma coisa só. **Não há passo anterior**, e ele serve tanto para a primeira vez
quanto para reinstalar por cima de uma tentativa que deu errado.

O que ele faz:

1. confere se há cadastro de verdade no schema `hub` — e **para** se houver;
2. cria o schema `hub` e as **22 tabelas** do sistema;
3. acrescenta a coluna `observacoes` em `public.cronograma_semanas`.

O que ele **não** faz: encostar em qualquer coisa fora do `hub`. As tabelas do
se7-cobrancas (`central_cards`, `cobranca_registros`, `loja_*`, `usuarios`…)
ficam exatamente como estão.

Para conferir depois:

```sql
select table_schema, count(*)
  from information_schema.tables
 where table_schema in ('hub','public')
 group by 1;
-- hub deve dar 22; public, o mesmo número de antes.
```

### Sobre a conferência do passo 1

O arquivo contém um `DROP SCHEMA hub CASCADE` — é o que permite colá-lo por
cima de uma instalação anterior sem parar com `already exists`.

Um DROP num arquivo pronto para colar é uma armadilha, **a não ser que ele se
recuse a rodar quando houver o que perder**. É o que a conferência faz: se
houver qualquer aluno ou matrícula no `hub`, o script para com esta mensagem e
não apaga nada:

```
ERROR: NAO APAGUEI NADA. O schema hub tem 1 aluno(s) e 0 matricula(s)
cadastrados. Isso e cadastro de verdade, e apagar nao tem volta.
```

Se isso aparecer, **pare e me diga** — tem cadastro real ali, e o caminho passa
a ser outro.

Testado nos três estados possíveis: banco sem `hub` nenhum (instala), `hub` já
instalado e vazio (reinstala), e `hub` com um aluno cadastrado (recusa, e o
aluno continua lá).

## 2 · Criar o serviço no Render

O arquivo é **`render.yaml`**, na raiz do repositório. Render → **New → Blueprint**
→ aponte para o repositório → **Apply**.

O ramo **está escrito dentro do arquivo** (`claude/se7-volei-praia-code-review-ds0fmj`),
então não há o que escolher e não há como errar. Isso importa: o ramo padrão do
repositório não tem nada deste sistema, e sem essa linha o serviço subiria
verde, servindo o código errado.

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

`DIRECT_URL` não precisa existir aqui: ela só serve ao CLI do Prisma, e o
código a iguala à `DATABASE_URL` quando está vazia.

**Sobre o plano gratuito.** Ele hiberna depois de alguns minutos parado, e a
primeira visita depois disso demora uns 30 segundos. O fechamento das 23:59 não
se perde por causa disso: ao voltar, o sistema reconstrói os dias que faltaram e
marca cada um como `RECONSTRUIDO`, para a tela dos sócios não mostrar
reconstrução com cara de número exato. Para o número do dia ser sempre exato, o
plano pago.

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
- cronograma, eventos e avisos;
- cópia diária da ocupação real das turmas para o se7-cobrancas (o painel da
  secretaria, hoje publicado como serviço `se7-cobrancas`), no mesmo horário
  do fechamento. Ele mostrava esse número digitado à mão numa planilha; agora
  recebe o de verdade. Sem efeito se esse serviço não existir ao lado — ver
  `src/modules/socios/ocupacao-cobrancas.ts`.

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

E o passo 2 foi ensaiado do jeito que o Render executa: `npm run build`, depois
`node dist/db/seed.js && node dist/server.js` — exatamente os comandos do
`render.yaml`, a partir do código compilado, e não do `tsx` do dia a dia.
O `/health` respondeu, as cinco páginas e os arquivos estáticos vieram com 200,
o login por senha funcionou e as seis rotas da área dos sócios responderam.
