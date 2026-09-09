# Redis Lab — protótipo didático

Protótipo visual para o seminário de Banco de Dados. A aplicação apresenta, de forma interativa, a relação entre **chave**, **valor** e as principais estruturas de dados do Redis.

## O que dá para demonstrar

- `Strings`: `SET`, `GET` e `INCR`;
- `Hashes`: vários campos dentro de uma única chave;
- `Lists`: uma fila com `RPUSH`, `LPOP` e `LRANGE`;
- `Sets`: itens únicos com `SADD` e `SMEMBERS`;
- `Sorted Sets`: ranking com score usando `ZADD` e `ZREVRANGE`;
- `TTL`: expiração automática com `SET ... EX` e `TTL`;
- rate limiting: contador atômico com `INCR` + `EXPIRE`;
- console livre com comandos Redis seguros dentro do namespace `seminario:*`.

## Como executar

Requisitos: Node.js 18 ou superior. O projeto não precisa instalar pacotes NPM e já está configurado para o **modo simulado**, ideal para apresentar sem Docker ou internet.

```bash
npm start
```

Depois, abra <http://localhost:3000>.

O modo simulado reproduz, em memória do próprio aplicativo, os comandos e comportamentos usados no roteiro. A interface mostra `modo simulado` no canto superior direito.

Se algum dia quiser testar com Redis real, basta iniciar o Docker e executar:

```bash
docker compose up -d
$env:REDIS_MODE = "real"
npm start
```

## Roteiro sugerido para apresentar

1. Clique em **Rodar roteiro completo** para criar exemplos de todas as estruturas.
2. Selecione **Strings** e mostre que `seminario:string:mensagem` aponta para um valor simples.
3. Selecione **Hashes** e compare uma chave com seus campos `nome`, `curso` e `status`.
4. Em **Lists**, explique a fila: o primeiro pedido é retirado com `LPOP`.
5. Em **Sets**, execute o exemplo e destaque que `cache` foi enviado duas vezes, mas aparece uma só vez.
6. Em **Sorted Sets**, mostre que o ranking é ordenado automaticamente pelo score.
7. Em **TTL**, observe a contagem regressiva; a chave desaparece depois de 30 segundos.
8. No console, execute:

```text
SET seminario:teste "olá"
GET seminario:teste
INCR seminario:contador
TTL seminario:contador
```

O botão **Limpar laboratório** remove apenas chaves que começam com `seminario:`. O protótipo não executa `FLUSHALL` nem comandos administrativos.

## Referências úteis para os slides

- [Redis Documentation](https://redis.io/docs/latest/)
- [Redis data types](https://redis.io/docs/latest/develop/data-types/)
- [Redis command reference](https://redis.io/docs/latest/commands/)
- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis licensing](https://redis.io/legal/licenses/)
- [Valkey — Linux Foundation](https://www.linuxfoundation.org/press/valkey-community)

O PDF da apresentação foi usado apenas como referência de conteúdo do seminário; ele não contém instruções de implementação do projeto.
