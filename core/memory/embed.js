// Embedding provider for the memory store.
//
// Default: builtin — dependency-free feature hashing (384 dim). It provides
// useful lexical retrieval with no model download, native binary, network, or
// supply-chain expansion. The richer local provider remains opt-in.
//
// Opt-in providers (not yet implemented; placeholder for the future):
//   DEVTEAM_EMBEDDING_PROVIDER=openai  + OPENAI_API_KEY → text-embedding-3-small
//   DEVTEAM_EMBEDDING_PROVIDER=cohere  + COHERE_API_KEY  → embed-english-v3.0
//
// Tests: DEVTEAM_EMBEDDING_PROVIDER=stub gives a deterministic whole-text
// vector with a small dimension.
//
// API:
//   const { getEmbedder } = require("./embed");
//   const e = await getEmbedder();
//   const v = await e.embed("text");          // → Float32Array
//   const vs = await e.embedBatch(["a","b"]); // → Float32Array[]
//   e.modelId, e.dimensions

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";
const DEFAULT_DIM = 384;
const BUILTIN_MODEL = "builtin-feature-hash-v1";

// Seam for tests — replaced with a throwing stub to exercise the absent-module path.
let _requireHF = () => require("@huggingface/transformers");
function _setRequireHF(fn) { _requireHF = fn; }

let _cached = null;

async function getEmbedder(opts = {}) {
  if (_cached && !opts.fresh) return _cached;
  const provider = process.env.DEVTEAM_EMBEDDING_PROVIDER || "builtin";
  switch (provider) {
    case "builtin": _cached = makeBuiltin(opts);       return _cached;
    case "local":  _cached = await makeLocal(opts);  return _cached;
    case "stub":   _cached = makeStub(opts);          return _cached;
    case "openai": throw new Error("Unsupported embedding provider \"openai\"; supported providers: builtin, local, stub");
    case "cohere": throw new Error("Unsupported embedding provider \"cohere\"; supported providers: builtin, local, stub");
    default:       throw new Error(`Unknown DEVTEAM_EMBEDDING_PROVIDER: ${provider}; supported providers: builtin, local, stub`);
  }
}

// ---------------------------------------------------------------------------
// Builtin — dependency-free signed feature hashing
// ---------------------------------------------------------------------------

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector) {
  let magnitude = 0;
  for (let i = 0; i < vector.length; i++) magnitude += vector[i] * vector[i];
  magnitude = Math.sqrt(magnitude) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  return vector;
}

function makeBuiltin(opts = {}) {
  const dim = opts.dimensions || DEFAULT_DIM;

  function hashVec(text) {
    const vector = new Float32Array(dim);
    const tokens = String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
    const features = [...tokens];
    for (let i = 1; i < tokens.length; i++) features.push(`${tokens[i - 1]} ${tokens[i]}`);

    for (const feature of features) {
      const hash = fnv1a(feature);
      const bucket = hash % dim;
      vector[bucket] += (hash & 0x80000000) === 0 ? 1 : -1;
    }
    return normalize(vector);
  }

  async function embed(text) { return hashVec(text); }
  async function embedBatch(texts) { return texts.map(hashVec); }
  return { modelId: BUILTIN_MODEL, dimensions: dim, provider: "builtin", embed, embedBatch };
}

// ---------------------------------------------------------------------------
// Local — @huggingface/transformers
// ---------------------------------------------------------------------------

async function makeLocal(opts = {}) {
  const modelId = opts.modelId || process.env.DEVTEAM_EMBEDDING_MODEL || DEFAULT_MODEL;
  let pipeline;
  try {
    const transformers = _requireHF();
    pipeline = transformers.pipeline;
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `devteam memory's local embeddings need the optional dependency:\n` +
        `  npm install @huggingface/transformers\n` +
        `(or set DEVTEAM_EMBEDDING_PROVIDER=stub for tests)`,
      );
    }
    throw e;
  }
  // Quiet the library's progress chatter unless DEBUG asks for it.
  if (!process.env.DEBUG) {
    process.env.TRANSFORMERS_VERBOSITY = process.env.TRANSFORMERS_VERBOSITY || "error";
  }
  const extractor = await pipeline("feature-extraction", modelId, { quantized: true });

  async function embed(text) {
    const out = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(out.data);
  }
  async function embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    // out is a Tensor [batch, dim]. Split into per-row Float32Arrays.
    const dim = out.dims[out.dims.length - 1];
    const result = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(new Float32Array(out.data.slice(i * dim, (i + 1) * dim)));
    }
    return result;
  }
  return { modelId, dimensions: DEFAULT_DIM, provider: "local", embed, embedBatch };
}

// ---------------------------------------------------------------------------
// Stub — deterministic hash-based vectors for tests
// ---------------------------------------------------------------------------

function makeStub(opts = {}) {
  const dim = opts.dimensions || 16;
  function hashVec(text) {
    const v = new Float32Array(dim);
    // Lightweight DJB2-ish hash mixed across dims.
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h) ^ text.charCodeAt(i);
    }
    for (let i = 0; i < dim; i++) {
      const k = (h ^ (i * 2654435761)) >>> 0;
      v[i] = ((k & 0xffff) / 65535) * 2 - 1;
    }
    // L2-normalize so cosine = dot for the test.
    let n = 0;
    for (let i = 0; i < dim; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dim; i++) v[i] /= n;
    return v;
  }
  async function embed(text) { return hashVec(text); }
  async function embedBatch(texts) { return texts.map(hashVec); }
  return { modelId: "stub", dimensions: dim, provider: "stub", embed, embedBatch };
}

function resetCache() { _cached = null; }

module.exports = { getEmbedder, resetCache, DEFAULT_MODEL, DEFAULT_DIM, BUILTIN_MODEL, _setRequireHF };
