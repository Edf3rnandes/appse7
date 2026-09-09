# Patches para o sistema atual (Laravel `se7volei`)

Este diretório guarda correções para o **outro** repositório — o Laravel que
está em produção hoje. Elas não fazem parte do SE7 Hub e não são aplicadas
por nada aqui; ficam versionadas só para não se perderem.

## `se7volei-correcoes-criticas.patch`

Cinco falhas de segurança, corrigidas cirurgicamente: nenhuma tela muda,
nenhuma funcionalidade some. 28 arquivos.

| # | Falha | Efeito enquanto não for aplicado |
|---|---|---|
| 1 | Webhook do Asaas sem autenticação | Um `POST` de qualquer lugar da internet confirma matrícula sem pagamento |
| 2 | Senha de professor zerada a cada edição | Conta editada passa a aceitar login com o campo em branco |
| 3 | Rotas de API e ajax abertas | `/api/courses/{id}/students` devolve nome e foto de aluno para qualquer um |
| 4 | Verificação TLS desligada (17 chamadas) | A chave de produção do Asaas trafega sem validação de certificado |
| 5 | Senhas em MD5 sem sal | Vazamento do banco entrega as senhas |

Junto vêm três consequências diretas: `SoftDeletes` finalmente aplicado em
`Customer` e `Student` (a trait era importada e nunca usada — cancelar
matrícula apagava o cadastro em definitivo), `config('assas.pix_key')`
corrigido para `asaas` (um caractere que criava o PIX da pré-matrícula sem
chave), e a classe `Admin/Controller.php` duplicada removida.

### Como aplicar

No clone do `se7volei`, a partir de um working tree limpo:

```bash
git checkout -b correcoes-criticas
git am /caminho/para/se7volei-correcoes-criticas.patch
```

Se o `git am` recusar por divergência, `git apply --3way` resolve a maioria
dos casos. Para só conferir antes: `git apply --check`.

### Antes de subir para produção

O item 1 **falha fechado**: sem token configurado, `/webhook/asaas` recusa
tudo com 503. Isso é de propósito — é o que impede a rota de voltar a aceitar
qualquer coisa. Mas significa que a ordem importa:

1. Gerar o token: `php -r "echo bin2hex(random_bytes(32));"`
2. Pôr o valor em `ASAAS_WEBHOOK_TOKEN` no `.env` do servidor.
3. Cadastrar **o mesmo valor** no painel do Asaas, em
   *Integrações > Webhooks*, no campo de token de autenticação.
4. Só então subir o código, e `php artisan config:clear`.

Fazer o passo 4 antes do 3 derruba a confirmação automática de pagamento até
que o token seja cadastrado. Nenhum pagamento se perde — o Asaas repete a
entrega —, mas as matrículas ficam pendentes no intervalo.

As demais variáveis novas estão no `.env.example` do próprio patch, com
comentário explicando cada uma.

### O que foi verificado

`php -l` limpo em todo `app/`, `config/`, `routes/` e `database/`;
`composer dump-autoload` sem avisos de PSR-4; e `php artisan route:list`
confirmando o middleware aplicado em cada rota.
