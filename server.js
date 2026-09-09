'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const DEMO_PREFIX = 'seminario:';
// O seminário será executado sem Docker; o modo simulado é o padrão.
const REDIS_MODE = String(process.env.REDIS_MODE || 'mock').toLowerCase();
const REDIS_URL = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const REDIS_HOST = REDIS_URL.hostname || '127.0.0.1';
const REDIS_PORT = Number(REDIS_URL.port || 6379);
const REDIS_PASSWORD = REDIS_URL.password ? decodeURIComponent(REDIS_URL.password) : null;
const REDIS_DB = REDIS_URL.pathname && /^\/\d+$/.test(REDIS_URL.pathname)
  ? Number(REDIS_URL.pathname.slice(1))
  : 0;
const RETRY_REDIS_AFTER_MS = 10_000;
const PUBLIC_DIR = path.join(__dirname, 'public');

let activeBackend = 'desconhecido';
let lastRedisError = null;
let lastRedisAttempt = 0;

class RedisCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedisCommandError';
    this.isRedisCommandError = true;
  }
}

class MemoryRedis {
  constructor() {
    this.data = new Map();
  }

  purge(key) {
    const entry = this.data.get(key);
    if (entry && entry.expireAt !== null && entry.expireAt <= Date.now()) {
      this.data.delete(key);
    }
    return this.data.get(key);
  }

  requireEntry(key, expectedType) {
    const entry = this.purge(key);
    if (!entry) return null;
    if (expectedType && entry.type !== expectedType) {
      throw new RedisCommandError(`WRONGTYPE Operation against a key holding the wrong kind of value`);
    }
    return entry;
  }

  create(key, type, value, expireAt = null) {
    const entry = { type, value, expireAt };
    this.data.set(key, entry);
    return entry;
  }

  ttl(key) {
    const entry = this.purge(key);
    if (!entry) return -2;
    if (entry.expireAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expireAt - Date.now()) / 1000));
  }

  keyMatches(key, pattern) {
    const escaped = String(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`).test(key);
  }

  numericValue(entry, key) {
    if (!entry) return 0;
    if (entry.type !== 'string') {
      throw new RedisCommandError('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    if (!/^-?\d+$/.test(entry.value)) {
      throw new RedisCommandError('ERR value is not an integer or out of range');
    }
    return Number(entry.value);
  }

  range(values, start, end) {
    const size = values.length;
    let from = Number(start);
    let to = Number(end);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new RedisCommandError('ERR value is not an integer or out of range');
    }
    if (from < 0) from = size + from;
    if (to < 0) to = size + to;
    from = Math.max(from, 0);
    to = Math.min(to, size - 1);
    if (from > to || from >= size) return [];
    return values.slice(from, to + 1);
  }

  sortedMembers(entry, reverse) {
    return [...entry.value.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => {
        const scoreDifference = reverse ? b.score - a.score : a.score - b.score;
        if (scoreDifference !== 0) return scoreDifference;
        return reverse
          ? b.member.localeCompare(a.member, 'pt-BR')
          : a.member.localeCompare(b.member, 'pt-BR');
      });
  }

  command(args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new RedisCommandError('ERR empty command');
    }

    const command = String(args[0]).toUpperCase();
    const values = args.slice(1).map(String);
    const key = values[0];

    switch (command) {
      case 'PING':
        return values[0] || 'PONG';

      case 'SET': {
        if (values.length < 2) throw new RedisCommandError('ERR wrong number of arguments for SET');
        let expireAt = null;
        for (let index = 2; index < values.length; index += 1) {
          const option = values[index].toUpperCase();
          if (option === 'EX' || option === 'PX') {
            const amount = Number(values[index + 1]);
            if (!Number.isFinite(amount) || amount <= 0) {
              throw new RedisCommandError('ERR invalid expire time in set');
            }
            expireAt = Date.now() + (option === 'EX' ? amount * 1000 : amount);
            index += 1;
          }
        }
        this.create(key, 'string', values[1], expireAt);
        return 'OK';
      }

      case 'GET': {
        const entry = this.requireEntry(key, 'string');
        return entry ? entry.value : null;
      }

      case 'MGET':
        return values.map((item) => {
          const entry = this.requireEntry(item, 'string');
          return entry ? entry.value : null;
        });

      case 'INCR':
      case 'INCRBY': {
        const amount = command === 'INCR' ? 1 : Number(values[1]);
        if (!Number.isInteger(amount)) throw new RedisCommandError('ERR value is not an integer or out of range');
        const entry = this.requireEntry(key, 'string');
        const next = this.numericValue(entry, key) + amount;
        this.create(key, 'string', String(next), entry ? entry.expireAt : null);
        return next;
      }

      case 'DEL': {
        let removed = 0;
        for (const item of values) {
          this.purge(item);
          if (this.data.delete(item)) removed += 1;
        }
        return removed;
      }

      case 'EXISTS':
        return values.filter((item) => Boolean(this.purge(item))).length;

      case 'TYPE': {
        const entry = this.purge(key);
        return entry ? entry.type : 'none';
      }

      case 'TTL':
        return this.ttl(key);

      case 'EXPIRE': {
        const entry = this.purge(key);
        if (!entry) return 0;
        const seconds = Number(values[1]);
        if (!Number.isInteger(seconds)) throw new RedisCommandError('ERR value is not an integer or out of range');
        if (seconds <= 0) {
          this.data.delete(key);
          return 1;
        }
        entry.expireAt = Date.now() + seconds * 1000;
        return 1;
      }

      case 'KEYS': {
        for (const item of this.data.keys()) this.purge(item);
        return [...this.data.keys()].filter((item) => this.keyMatches(item, key)).sort();
      }

      case 'HSET': {
        if (values.length < 3 || values.length % 2 === 0) {
          throw new RedisCommandError('ERR wrong number of arguments for HSET');
        }
        let entry = this.requireEntry(key, 'hash');
        if (!entry) entry = this.create(key, 'hash', new Map());
        let created = 0;
        for (let index = 1; index < values.length; index += 2) {
          if (!entry.value.has(values[index])) created += 1;
          entry.value.set(values[index], values[index + 1]);
        }
        return created;
      }

      case 'HGET': {
        const entry = this.requireEntry(key, 'hash');
        return entry ? (entry.value.get(values[1]) ?? null) : null;
      }

      case 'HGETALL': {
        const entry = this.requireEntry(key, 'hash');
        if (!entry) return [];
        return [...entry.value.entries()].flat();
      }

      case 'LPUSH':
      case 'RPUSH': {
        if (values.length < 2) throw new RedisCommandError(`ERR wrong number of arguments for ${command}`);
        let entry = this.requireEntry(key, 'list');
        if (!entry) entry = this.create(key, 'list', []);
        if (command === 'LPUSH') {
          for (let index = 1; index < values.length; index += 1) entry.value.unshift(values[index]);
        } else {
          entry.value.push(...values.slice(1));
        }
        return entry.value.length;
      }

      case 'LPOP':
      case 'RPOP': {
        const entry = this.requireEntry(key, 'list');
        if (!entry || entry.value.length === 0) return null;
        const count = values[1] === undefined ? null : Number(values[1]);
        if (count === null) return command === 'LPOP' ? entry.value.shift() : entry.value.pop();
        if (!Number.isInteger(count) || count < 0) throw new RedisCommandError('ERR value is not an integer or out of range');
        const result = [];
        for (let index = 0; index < count && entry.value.length > 0; index += 1) {
          result.push(command === 'LPOP' ? entry.value.shift() : entry.value.pop());
        }
        return result;
      }

      case 'LRANGE': {
        const entry = this.requireEntry(key, 'list');
        return entry ? this.range(entry.value, values[1], values[2]) : [];
      }

      case 'SADD': {
        if (values.length < 2) throw new RedisCommandError('ERR wrong number of arguments for SADD');
        let entry = this.requireEntry(key, 'set');
        if (!entry) entry = this.create(key, 'set', new Set());
        let added = 0;
        for (const member of values.slice(1)) {
          if (!entry.value.has(member)) {
            entry.value.add(member);
            added += 1;
          }
        }
        return added;
      }

      case 'SMEMBERS': {
        const entry = this.requireEntry(key, 'set');
        return entry ? [...entry.value].sort((a, b) => a.localeCompare(b, 'pt-BR')) : [];
      }

      case 'ZADD': {
        if (values.length < 3 || values.length % 2 === 0) {
          throw new RedisCommandError('ERR wrong number of arguments for ZADD');
        }
        let entry = this.requireEntry(key, 'zset');
        if (!entry) entry = this.create(key, 'zset', new Map());
        let created = 0;
        for (let index = 1; index < values.length; index += 2) {
          const score = Number(values[index]);
          if (!Number.isFinite(score)) throw new RedisCommandError('ERR value is not a valid float');
          const member = values[index + 1];
          if (!entry.value.has(member)) created += 1;
          entry.value.set(member, score);
        }
        return created;
      }

      case 'ZRANGE':
      case 'ZREVRANGE': {
        const entry = this.requireEntry(key, 'zset');
        if (!entry) return [];
        const withScores = values.slice(3).some((item) => item.toUpperCase() === 'WITHSCORES');
        const selected = this.range(this.sortedMembers(entry, command === 'ZREVRANGE'), values[1], values[2]);
        if (!withScores) return selected.map((item) => item.member);
        return selected.flatMap((item) => [item.member, String(item.score)]);
      }

      case 'INFO':
        return '# Server\nredis_version:simulado\nused_memory_human:modo demonstração\n';

      default:
        throw new RedisCommandError(`ERR unknown command '${command.toLowerCase()}'`);
    }
  }
}

const memoryRedis = new MemoryRedis();

function encodeResp(args) {
  const output = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = String(arg);
    output.push(`$${Buffer.byteLength(value, 'utf8')}\r\n`, value, '\r\n');
  }
  return output.join('');
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const marker = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset + 1);
  if (lineEnd === -1) return null;

  if (marker === '+' || marker === '-' || marker === ':') {
    const value = buffer.toString('utf8', offset + 1, lineEnd);
    if (marker === '-') return { kind: 'error', value, next: lineEnd + 2 };
    if (marker === ':') return { kind: 'value', value: Number(value), next: lineEnd + 2 };
    return { kind: 'value', value, next: lineEnd + 2 };
  }

  if (marker === '$') {
    const length = Number(buffer.toString('ascii', offset + 1, lineEnd));
    if (length === -1) return { kind: 'value', value: null, next: lineEnd + 2 };
    const valueStart = lineEnd + 2;
    const valueEnd = valueStart + length;
    if (buffer.length < valueEnd + 2) return null;
    return {
      kind: 'value',
      value: buffer.toString('utf8', valueStart, valueEnd),
      next: valueEnd + 2,
    };
  }

  if (marker === '*') {
    const count = Number(buffer.toString('ascii', offset + 1, lineEnd));
    if (count === -1) return { kind: 'value', value: null, next: lineEnd + 2 };
    const items = [];
    let cursor = lineEnd + 2;
    for (let index = 0; index < count; index += 1) {
      const item = parseResp(buffer, cursor);
      if (!item) return null;
      if (item.kind === 'error') return item;
      items.push(item.value);
      cursor = item.next;
    }
    return { kind: 'value', value: items, next: cursor };
  }

  throw new Error(`Unsupported Redis response type: ${marker}`);
}

function connectionError(error) {
  const wrapped = new Error(error?.message || 'Não foi possível conectar ao Redis.');
  wrapped.name = 'RedisConnectionError';
  wrapped.code = error?.code;
  wrapped.isRedisConnectionError = true;
  return wrapped;
}

function openRedisSocket() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: REDIS_HOST, port: REDIS_PORT });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(connectionError(new Error('Tempo esgotado ao conectar ao Redis.')));
    }, 4_000);

    const onConnect = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener('error', onError);
      resolve(socket);
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(connectionError(error));
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function redisRequest(socket, args) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Tempo esgotado aguardando resposta do Redis.')), 4_000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const parsed = parseResp(buffer);
        if (!parsed) return;
        if (parsed.kind === 'error') {
          finish(new RedisCommandError(parsed.value));
        } else {
          finish(null, parsed.value);
        }
      } catch (error) {
        finish(error);
      }
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('A conexão com o Redis foi encerrada antes da resposta.'));

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(encodeResp(args));
  });
}

async function redisCommand(args) {
  let socket = null;
  try {
    socket = await openRedisSocket();
    if (REDIS_PASSWORD) await redisRequest(socket, ['AUTH', REDIS_PASSWORD]);
    if (REDIS_DB) await redisRequest(socket, ['SELECT', REDIS_DB]);
    return await redisRequest(socket, args);
  } finally {
    if (socket) socket.end();
  }
}

async function executeCommand(args) {
  if (REDIS_MODE === 'mock') {
    activeBackend = 'simulado';
    return memoryRedis.command(args);
  }

  const shouldRetry = activeBackend !== 'simulado'
    || Date.now() - lastRedisAttempt >= RETRY_REDIS_AFTER_MS;
  if (!shouldRetry) return memoryRedis.command(args);

  lastRedisAttempt = Date.now();
  try {
    const result = await redisCommand(args);
    activeBackend = 'redis';
    lastRedisError = null;
    return result;
  } catch (error) {
    if (REDIS_MODE === 'real' || !error.isRedisConnectionError) throw error;
    activeBackend = 'simulado';
    lastRedisError = error.message;
    return memoryRedis.command(args);
  }
}

function quoteCommandPart(value) {
  const stringValue = String(value);
  return /[^\w:./=@+-]/u.test(stringValue) ? JSON.stringify(stringValue) : stringValue;
}

function commandToText(args) {
  return args.map(quoteCommandPart).join(' ');
}

const DEMO_META = [
  {
    id: 'strings',
    number: '01',
    label: 'Strings',
    icon: 'S',
    color: 'coral',
    tagline: 'Valor direto',
    description: 'A estrutura mais simples: uma chave aponta para um texto ou número.',
    concept: 'Ideal para mensagens, contadores e valores simples.',
    preview: ['SET', 'GET', 'INCR'],
  },
  {
    id: 'hashes',
    number: '02',
    label: 'Hashes',
    icon: 'H',
    color: 'mint',
    tagline: 'Objeto em campos',
    description: 'Uma única chave agrupa vários pares campo–valor, como um pequeno objeto.',
    concept: 'Bom para perfis, sessões e registros leves.',
    preview: ['HSET', 'HGETALL'],
  },
  {
    id: 'lists',
    number: '03',
    label: 'Lists',
    icon: 'L',
    color: 'gold',
    tagline: 'Fila ordenada',
    description: 'Coleção ordenada pela inserção, com operações nas pontas da lista.',
    concept: 'A mesma ideia de uma fila de tarefas assíncronas.',
    preview: ['RPUSH', 'LPOP', 'LRANGE'],
  },
  {
    id: 'sets',
    number: '04',
    label: 'Sets',
    icon: '∪',
    color: 'lavender',
    tagline: 'Itens únicos',
    description: 'Coleção sem ordem e sem duplicatas: adicionar o mesmo membro não repete o dado.',
    concept: 'Útil para tags, permissões e interesses de usuários.',
    preview: ['SADD', 'SMEMBERS'],
  },
  {
    id: 'sorted-sets',
    number: '05',
    label: 'Sorted Sets',
    icon: '↕',
    color: 'blue',
    tagline: 'Ranking por score',
    description: 'Cada membro é único e recebe um score que mantém a coleção ordenada.',
    concept: 'Perfeito para placares e rankings em tempo real.',
    preview: ['ZADD', 'ZREVRANGE'],
  },
  {
    id: 'ttl',
    number: '06',
    label: 'TTL / expiração',
    icon: '◷',
    color: 'peach',
    tagline: 'Dado temporário',
    description: 'Uma chave pode receber tempo de vida e desaparecer automaticamente.',
    concept: 'Base para cache, tokens e códigos temporários.',
    preview: ['SET ... EX', 'TTL'],
  },
  {
    id: 'rate-limit',
    number: '07',
    label: 'Rate limiting',
    icon: '#',
    color: 'rose',
    tagline: 'Contador atômico',
    description: 'INCR + EXPIRE conta requisições por janela de tempo sem precisar de tabela relacional.',
    concept: 'Ajuda a limitar abuso e excesso de chamadas em APIs.',
    preview: ['INCR', 'EXPIRE', 'TTL'],
  },
];

const DEMO_SEQUENCES = {
  strings: [
    ['DEL', 'seminario:string:mensagem', 'seminario:string:visitas'],
    ['SET', 'seminario:string:mensagem', 'Olá, Redis!'],
    ['SET', 'seminario:string:visitas', '0'],
    ['INCR', 'seminario:string:visitas'],
    ['GET', 'seminario:string:mensagem'],
  ],
  hashes: [
    ['DEL', 'seminario:hash:aluno'],
    ['HSET', 'seminario:hash:aluno', 'nome', 'Ana', 'curso', 'Banco de Dados', 'status', 'ativo'],
    ['HGETALL', 'seminario:hash:aluno'],
  ],
  lists: [
    ['DEL', 'seminario:list:fila'],
    ['RPUSH', 'seminario:list:fila', 'pedido-101', 'pedido-102', 'pedido-103'],
    ['LPOP', 'seminario:list:fila'],
    ['LRANGE', 'seminario:list:fila', '0', '-1'],
  ],
  sets: [
    ['DEL', 'seminario:set:tags'],
    ['SADD', 'seminario:set:tags', 'cache', 'sessao', 'fila', 'cache'],
    ['SMEMBERS', 'seminario:set:tags'],
  ],
  'sorted-sets': [
    ['DEL', 'seminario:zset:ranking'],
    ['ZADD', 'seminario:zset:ranking', '120', 'Lia', '90', 'João', '150', 'Ravi'],
    ['ZREVRANGE', 'seminario:zset:ranking', '0', '-1', 'WITHSCORES'],
  ],
  ttl: [
    ['DEL', 'seminario:ttl:codigo'],
    ['SET', 'seminario:ttl:codigo', 'ABC-123', 'EX', '30'],
    ['TTL', 'seminario:ttl:codigo'],
  ],
  'rate-limit': [
    ['DEL', 'seminario:rate:aluno-01'],
    ['INCR', 'seminario:rate:aluno-01'],
    ['EXPIRE', 'seminario:rate:aluno-01', '60'],
    ['TTL', 'seminario:rate:aluno-01'],
  ],
};

function allDemoCommands() {
  return DEMO_META.flatMap((item) => DEMO_SEQUENCES[item.id]);
}

async function runSequence(commands) {
  const steps = [];
  for (const args of commands) {
    const result = await executeCommand(args);
    steps.push({ command: commandToText(args), result });
  }
  return steps;
}

async function inspectKey(key) {
  const type = await executeCommand(['TYPE', key]);
  if (type === 'none') return null;
  const ttl = await executeCommand(['TTL', key]);
  let value;

  if (type === 'string') {
    value = { kind: 'string', value: await executeCommand(['GET', key]) };
  } else if (type === 'hash') {
    const raw = await executeCommand(['HGETALL', key]);
    const fields = {};
    for (let index = 0; index < raw.length; index += 2) fields[raw[index]] = raw[index + 1];
    value = { kind: 'hash', fields };
  } else if (type === 'list') {
    value = { kind: 'list', items: await executeCommand(['LRANGE', key, '0', '-1']) };
  } else if (type === 'set') {
    value = { kind: 'set', items: await executeCommand(['SMEMBERS', key]) };
  } else if (type === 'zset') {
    const raw = await executeCommand(['ZRANGE', key, '0', '-1', 'WITHSCORES']);
    const items = [];
    for (let index = 0; index < raw.length; index += 2) {
      items.push({ member: raw[index], score: raw[index + 1] });
    }
    value = { kind: 'zset', items };
  } else {
    value = { kind: 'unknown', value: String(await executeCommand(['GET', key])) };
  }

  return { key, type, ttl, value };
}

async function getState() {
  await executeCommand(['PING']);
  const keys = await executeCommand(['KEYS', `${DEMO_PREFIX}*`]);
  const records = [];
  for (const key of keys) {
    const record = await inspectKey(key);
    if (record) records.push(record);
  }
  return {
    ok: true,
    status: {
      backend: activeBackend,
      isRealRedis: activeBackend === 'redis',
      endpoint: activeBackend === 'redis' ? `${REDIS_HOST}:${REDIS_PORT}` : 'modo simulado local',
      note: activeBackend === 'redis'
        ? 'Comandos executados em uma instância Redis real.'
        : 'Redis indisponível: os comandos estão sendo reproduzidos em memória para a demonstração.',
      error: lastRedisError,
    },
    keys: records.sort((a, b) => a.key.localeCompare(b.key, 'pt-BR')),
    updatedAt: new Date().toISOString(),
  };
}

async function resetDemo() {
  const keys = await executeCommand(['KEYS', `${DEMO_PREFIX}*`]);
  const removed = keys.length ? await executeCommand(['DEL', ...keys]) : 0;
  return { removed };
}

function splitCommandLine(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const character of String(line)) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }

  if (escaped) current += '\\';
  if (quote) throw new Error('Comando inválido: aspas não foram fechadas.');
  if (current) tokens.push(current);
  return tokens;
}

const CONSOLE_COMMANDS = new Set([
  'PING', 'SET', 'GET', 'MGET', 'INCR', 'INCRBY', 'DEL', 'EXISTS', 'TYPE', 'TTL', 'EXPIRE',
  'HSET', 'HGET', 'HGETALL', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'SADD', 'SMEMBERS',
  'ZADD', 'ZRANGE', 'ZREVRANGE',
]);

const COMMANDS_WITH_KEY = new Set([
  'SET', 'GET', 'MGET', 'INCR', 'INCRBY', 'DEL', 'EXISTS', 'TYPE', 'TTL', 'EXPIRE',
  'HSET', 'HGET', 'HGETALL', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'SADD', 'SMEMBERS',
  'ZADD', 'ZRANGE', 'ZREVRANGE',
]);

function validateConsoleCommand(args) {
  if (!args.length) throw new Error('Digite um comando Redis.');
  const command = args[0].toUpperCase();
  if (!CONSOLE_COMMANDS.has(command)) {
    throw new Error(`Comando não disponível neste protótipo: ${command}.`);
  }
  if (COMMANDS_WITH_KEY.has(command)) {
    const keys = command === 'MGET' || command === 'DEL' || command === 'EXISTS'
      ? args.slice(1)
      : [args[1]];
    if (!keys.length || keys.some((key) => !String(key).startsWith(DEMO_PREFIX))) {
      throw new Error(`Por segurança, use apenas chaves que começam com ${DEMO_PREFIX}`);
    }
  }
  return [command, ...args.slice(1)];
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) reject(new Error('Corpo da requisição muito grande.'));
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    request.on('error', reject);
  });
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extension] || 'application/octet-stream';
}

function serveStatic(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const relativeToPublic = path.relative(PUBLIC_DIR, filePath);
  if (relativeToPublic.startsWith('..') || path.isAbsolute(relativeToPublic)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  });
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const { pathname } = requestUrl;

  try {
    if (request.method === 'GET' && pathname === '/api/demos') {
      sendJson(response, 200, { demos: DEMO_META });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/state') {
      sendJson(response, 200, await getState());
      return;
    }

    if (request.method === 'POST' && pathname === '/api/demo') {
      const body = await readJson(request);
      if (body.id !== 'all' && !DEMO_SEQUENCES[body.id]) {
        sendJson(response, 404, { ok: false, error: 'Demonstração não encontrada.' });
        return;
      }
      const steps = await runSequence(body.id === 'all' ? allDemoCommands() : DEMO_SEQUENCES[body.id]);
      sendJson(response, 200, { ok: true, id: body.id, steps, state: await getState() });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/command') {
      const body = await readJson(request);
      const args = validateConsoleCommand(splitCommandLine(body.command));
      const result = await executeCommand(args);
      sendJson(response, 200, {
        ok: true,
        command: commandToText(args),
        result,
        state: await getState(),
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/reset') {
      const result = await resetDemo();
      sendJson(response, 200, { ok: true, ...result, state: await getState() });
      return;
    }

    if (request.method === 'GET') {
      serveStatic(request, response, pathname);
      return;
    }

    sendJson(response, 405, { ok: false, error: 'Método não permitido.' });
  } catch (error) {
    const statusCode = error.isRedisConnectionError ? 503 : error.isRedisCommandError ? 400 : 500;
    sendJson(response, statusCode, { ok: false, error: error.message || 'Erro inesperado.' });
  }
}

module.exports = { handleRequest };

if (require.main === module) {
  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`Redis Lab disponível em http://localhost:${PORT}`);
    console.log(`Backend Redis configurado: ${REDIS_HOST}:${REDIS_PORT} (modo ${REDIS_MODE})`);
  });
}
