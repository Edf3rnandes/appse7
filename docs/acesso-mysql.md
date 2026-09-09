# Pedido de acesso somente leitura ao MySQL

Documento para encaminhar a quem administra o servidor do sistema atual (o
Laravel). Ele responde de antemão as três perguntas que qualquer pessoa
responsável faz: **o que vai ser lido, com que permissão, e como sei que não
vai escrever nada.**

## O que criar

Um usuário MySQL com `SELECT` e nada mais:

```sql
CREATE USER 'se7hub_ro'@'%' IDENTIFIED BY 'TROQUE-POR-UMA-SENHA-FORTE';
GRANT SELECT ON nome_do_banco.* TO 'se7hub_ro'@'%';
FLUSH PRIVILEGES;
```

Trocar `nome_do_banco` pelo banco do Laravel. Se o servidor aceitar conexão só
de IPs conhecidos, o `'%'` pode virar o IP de saída do serviço no Render — é
mais seguro e não muda nada do lado do sistema novo.

Para conferir que ficou só leitura:

```sql
SHOW GRANTS FOR 'se7hub_ro'@'%';
-- deve mostrar apenas: GRANT SELECT ON `nome_do_banco`.* TO ...
```

## O que precisa chegar de volta

| Dado | Exemplo |
|---|---|
| Host | `mysql.servidor.com.br` |
| Porta | `3306` |
| Usuário | `se7hub_ro` |
| Senha | a que foi definida acima |
| Banco | o nome do banco do Laravel |

## Quais tabelas são lidas

Somente estas, e somente com `SELECT`:

| Tabela | Para quê |
|---|---|
| `customers` | achar o responsável pelo CPF e mostrar o cadastro dele |
| `students` | alunos de cada responsável e de cada turma |
| `enrollments` | matrícula ativa, turma, plano e vencimento |
| `courses`, `units`, `plans` | nome da turma, unidade e plano |
| `attendances` | frequência dos últimos 6 meses |
| `teachers` | nome e token do professor, para o app dele |
| `course_teacher` | quais turmas são de cada professor |

Nada é lido de `password_reset_tokens`, `personal_access_tokens`, `jobs`,
`failed_jobs` ou `users`.

## Por que não há risco de escrita

Três camadas independentes, e basta uma para impedir:

1. **A permissão do banco.** Com apenas `GRANT SELECT`, qualquer `INSERT`,
   `UPDATE`, `DELETE` ou `ALTER` é recusado pelo próprio MySQL.
2. **O código.** Toda consulta passa por uma função única
   (`readOnlyQuery`, em `src/db/legacy/pool.ts`) que **recusa qualquer
   statement que não comece com `SELECT`** antes de enviá-lo. Nenhum outro
   trecho do sistema abre conexão com esse banco.
3. **A arquitetura.** O sistema novo tem banco próprio (PostgreSQL) para tudo
   que ele mesmo cria. O MySQL do Laravel é só fonte de consulta.

O único caso em que o sistema novo grava algo do lado do Laravel é o
lançamento de frequência — e mesmo esse **não usa esta conexão**: ele chama o
`POST /api/attendances` que o próprio Laravel já expõe, autenticado com o
token do professor. Ou seja, a regra "esta conexão só lê" não tem exceção.

## O que acontece enquanto não chega

O sistema novo já está no ar e funcionando para cronograma, eventos, avisos e
acessos. As telas que dependem desta conexão — chamada, turmas e o portal do
responsável — mostram "indisponível no momento" com clareza, em vez de quebrar.
Nada trava enquanto o acesso não existir.

---

## Mensagem pronta para encaminhar

> Oi! Estamos colocando no ar um sistema novo do SE7 que **lê** dados do
> sistema atual para mostrar turmas, frequência e cadastro — sem alterar nada
> lá dentro.
>
> Preciso de um usuário MySQL só de leitura:
>
> ```sql
> CREATE USER 'se7hub_ro'@'%' IDENTIFIED BY 'uma-senha-forte';
> GRANT SELECT ON nome_do_banco.* TO 'se7hub_ro'@'%';
> FLUSH PRIVILEGES;
> ```
>
> Com `GRANT SELECT` ele não consegue escrever nada, nem alterar estrutura. Do
> nosso lado, o código também recusa qualquer comando que não seja `SELECT`
> antes de enviar.
>
> Me manda host, porta, usuário, senha e nome do banco quando puder. Obrigado!
