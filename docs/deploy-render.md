# Subir o SE7 Hub no Render

Passo a passo do primeiro deploy. O banco já precisa estar preparado — se ainda
não estiver, rode `prisma/instalar-no-supabase.sql` no SQL Editor do Supabase
antes (ver README).

## 1. Criar o serviço

Render → **New** → **Web Service** → conecte o repositório `Edf3rnandes/appse7`
e escolha a branch `claude/se7-volei-praia-code-review-ds0fmj`.

O `render.yaml` na raiz já descreve build, start e health check. Se preferir
usar o Blueprint (**New → Blueprint**), ele lê esse arquivo e cria o serviço
`se7-hub` pronto — só faltam as variáveis marcadas como `sync: false`.

## 2. Variáveis de ambiente

### Copiadas do `se7-cobrancas`, sem alterar nada

Estas duas têm de ser **exatamente as mesmas** do outro serviço. É isso que faz
o cronograma ser a mesma tabela nos dois sistemas.

| Variável | Onde pegar |
|---|---|
| `DATABASE_URL` | Render → `se7-cobrancas` → Environment → mesma variável |
| `DIRECT_URL` | idem |

### Novas

| Variável | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | do projeto no Google Cloud (passo 3) |
| `ADMIN_EMAILS` | seu e-mail — é quem vira ADMIN no primeiro login |
| `TZ` | `America/Fortaleza` (já vem no `render.yaml`) |
| `JWT_SECRET` | o Render gera sozinho (`generateValue: true`) |

### Opcionais — o app sobe sem elas

Cada uma destrava um pedaço; sem elas as telas correspondentes dizem
"indisponível" em vez de quebrar.

| Variável | Destrava |
|---|---|
| `ASAAS_API_KEY` | faturas no portal do responsável |
| `LEGACY_MYSQL_HOST` `_USER` `_PASSWORD` `_DATABASE` | alunos, turmas, frequência, cadastro |
| `LEGACY_API_URL` | envio da chamada pelo professor |

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
{"ok":true,"google":true,"legado":false,"lancamentoFrequencia":false}
```

`google: true` confirma que o login está configurado. `legado` e
`lancamentoFrequencia` seguem `false` até as variáveis do MySQL existirem — é o
esperado no primeiro deploy.

Então entre em `/secretaria.html` com a conta de `ADMIN_EMAILS`. Você cai como
ADMIN e já consegue cadastrar cronograma e eventos — inclusive vendo as semanas
que a secretaria criou pelo painel antigo, porque é a mesma tabela.

## 5. Primeiros acessos das outras pessoas

- **Professor**: em `/secretaria.html`, emita um convite (`POST /auth/convites`)
  com o e-mail dele e o `legacyId` (o `teachers.id` do sistema atual). Aí ele
  entra em `/professor.html` com o Google e já cai vinculado.
- **Responsável**: entra em `/` com o Google e informa o CPF. Só funciona
  depois que o MySQL estiver liberado, porque o CPF é conferido lá.

## Observação sobre o plano gratuito

O serviço hiberna após um tempo sem acesso e a primeira requisição depois disso
demora alguns segundos. Para o uso da secretaria isso é aceitável; se incomodar
no dia a dia do professor, o plano pago do Render remove a hibernação.
