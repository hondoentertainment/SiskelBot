# BPE Tokenizer

SiskelBot ships a pure-JavaScript implementation of Byte-Pair Encoding, ported
from [Andrej Karpathy's `minbpe`][minbpe] and faithful to the algorithm walked
through in the ["Let's build the GPT Tokenizer"][video] lecture. The goal is an
easy-to-read reference implementation that can be used for local tokenization,
token counting, and teaching — not a replacement for `tiktoken`.

- Source: [`lib/bpe-tokenizer.js`](../lib/bpe-tokenizer.js)
- Routes: [`routes/bpe-tokenizer.js`](../routes/bpe-tokenizer.js)
- Tests: [`tests/bpe-tokenizer.test.js`](../tests/bpe-tokenizer.test.js)
- CLI: `siskelbot tokenize`

## Why BPE?

Modern LLMs (GPT-2, GPT-3, GPT-4, Claude, Llama, Mistral, Gemma, ...) all
tokenize text into subword units using some variant of Byte-Pair Encoding.
BPE sits between character-level and word-level tokenization: common words
get a single token, rare words get split into a handful of pieces, and the
vocabulary is fixed-size regardless of the input language or emoji usage.

BPE was first described as a data-compression scheme in 1994 and was
popularized for NLP by [Sennrich et al. 2015][sennrich].

## The algorithm in one page

Start from the raw UTF-8 bytes of a corpus (256 base tokens — one per possible
byte value). Then repeatedly:

1. Count every adjacent pair of tokens: `(t_i, t_{i+1})`.
2. Find the pair that occurs most often.
3. Mint a new token id and replace every occurrence of the pair with it.
4. Record the merge: `(t_i, t_{i+1}) -> new_id`.

Stop when the vocab reaches the target size (e.g. 50,257 for GPT-2).

**Encoding** a new string re-runs the merges in the order they were learned
(lowest id first, because a merge can only be applied once its constituents
already exist). **Decoding** looks up the UTF-8 bytes each id stands for and
concatenates them.

### Worked example

Corpus: `aaabdaaabac` (repeated three times).

```
bytes        : 97 97 97 98 100 97 97 97 98 97 99
most frequent: (97,97) with count 6
merge         : (97,97) -> 256
after merge  : 256 97 98 100 256 97 98 97 99
most frequent: (256,97) with count 2
merge         : (256,97) -> 257
...
```

After a few iterations the tokenizer has learned that `"aaab"` is one token,
`"a"` is one token, and the string encodes to just 4 ids instead of 11 bytes.

## JavaScript API

```js
import {
  BasicBPETokenizer,
  RegexBPETokenizer,
  GPT4_SPLIT_PATTERN,
  GPT2_SPLIT_PATTERN,
  getStats,
  merge,
  bytesToUnicode,
  countTokens,
} from "./lib/bpe-tokenizer.js";
```

### `BasicBPETokenizer`

The bare-bones version: trains directly on the byte stream.

```js
const t = new BasicBPETokenizer();
t.train(corpus, /* vocabSize */ 512, /* verbose */ false);
const ids = t.encode("hello world");     // => number[]
const text = t.decode(ids);                // => string
t.save("./model.bpe");
t.load("./model.bpe");
t.getVocabSize();                          // => 512
```

### `RegexBPETokenizer`

GPT-2/GPT-4 style: first splits the text by a regex (so merges never cross
word, number, or punctuation boundaries), then trains one chunk at a time.

```js
import { RegexBPETokenizer, GPT4_SPLIT_PATTERN } from "./lib/bpe-tokenizer.js";

const t = new RegexBPETokenizer(GPT4_SPLIT_PATTERN); // default
t.train(corpus, 1024);

// Special tokens are assigned by hand, never by training.
t.registerSpecialToken("<|endoftext|>", 1000);

// Encoding with specials enabled.
const ids = t.encode("hi <|endoftext|> bye", { allowSpecial: "all" });
```

The split patterns are exactly those used in Karpathy's `minbpe`:

```js
// GPT-4 style
/'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+$|\s+(?!\S)|\s/gu

// GPT-2 style
/'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu
```

(Python's `regex` module supports possessive quantifiers like `++`, which
JavaScript does not — the patterns above are the JS-compatible equivalents.)

### Utilities

```js
getStats([1, 2, 3, 1, 2]);
// => Map { "1,2" => 2, "2,3" => 1, "3,1" => 1 }

merge([1, 2, 3, 1, 2], [1, 2], 9);
// => [9, 3, 9]

bytesToUnicode();
// => Map<number, string>  (GPT-2's reversible byte<->unicode map)

countTokens("hello world", tokenizer);
// If a tokenizer is given, returns tokenizer.encode(text).length.
// If not, falls back to a ceil(byteLen/4) heuristic for rough estimates.
```

## HTTP endpoints

One tokenizer is kept in memory per `(user, workspace)` pair. These routes are
mounted at both `/api/v1/tokenizer/*` and `/api/tokenizer/*` (legacy).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/tokenizer/train` | Train on a text corpus |
| `POST` | `/api/v1/tokenizer/encode` | Encode text to ids |
| `POST` | `/api/v1/tokenizer/decode` | Decode ids back to text |
| `GET`  | `/api/v1/tokenizer/vocab` | Inspect the vocab (admin for >2048) |
| `POST` | `/api/v1/tokenizer/count` | Count tokens in text |

### Train

```bash
curl -X POST $URL/api/v1/tokenizer/train \
  -H "Content-Type: application/json" \
  -d '{
    "text": "the quick brown fox jumps over the lazy dog. the cat sat.",
    "vocabSize": 512,
    "kind": "regex",
    "workspace": "default"
  }'
```

Response:

```json
{
  "_version": 1,
  "kind": "regex",
  "vocabSize": 512,
  "merges": 256,
  "specialTokens": []
}
```

### Encode / decode

```bash
curl -X POST $URL/api/v1/tokenizer/encode \
  -H "Content-Type: application/json" \
  -d '{"text": "the cat", "workspace": "default"}'
# { "_version": 1, "ids": [257, 261], "count": 2 }

curl -X POST $URL/api/v1/tokenizer/decode \
  -H "Content-Type: application/json" \
  -d '{"ids": [257, 261], "workspace": "default"}'
# { "_version": 1, "text": "the cat" }
```

### Count

```bash
curl -X POST $URL/api/v1/tokenizer/count \
  -H "Content-Type: application/json" \
  -d '{"text": "hello world"}'
# { "_version": 1, "count": 3, "tokenizer": "heuristic", "bytes": 11 }
```

`count` uses a trained tokenizer if one exists for the workspace; otherwise it
falls back to a `ceil(utf8_bytes / 4)` heuristic that is ~20% accurate for
English and good enough for rough quota estimation.

### Limits

- Train corpus: 2 MiB
- Vocab size: 256 – 8192
- Encode input: 512 KiB
- Decode ids: 200 000
- Vocab inspection: non-admin callers can only list vocabs with ≤ 2048 entries

## CLI

```bash
# Train and save a model
siskelbot tokenize --train ./corpus.txt --vocab-size 1024 --model ./my.model

# Tokenize a string using a saved model
siskelbot tokenize --text "hello world" --model ./my.model
# tokens (2): 257 261
# decoded: hello world

# Count tokens only
siskelbot tokenize --text "hello world" --model ./my.model --count
# 2

# Decode a list of ids back to text
siskelbot tokenize --decode "257,261" --model ./my.model

# Machine-readable output
siskelbot tokenize --text "hi" --model ./my.model --json
```

Flags:

| Flag | Meaning |
|------|---------|
| `--text "..."` | Text to encode |
| `--train <file>` | Train on the contents of `<file>` |
| `--vocab-size <n>` | Target vocab size (>= 256, default 512) |
| `--model <path>` | `.model` file to load (or save to with `--train`) |
| `--kind basic\|regex` | Tokenizer kind (default: `regex`) |
| `--decode "1,2,3"` | Decode a comma-separated list of ids |
| `--count` | Print only the token count |
| `--json` | Machine-readable output |

## Model file format

The `.model` files produced by `save()` and consumed by `load()` use Karpathy's
exact format:

```
minbpe v1
<regex pattern or empty>
<numSpecialTokens>
<special_token_1> <id_1>
...
<a_1> <b_1>
<a_2> <b_2>
...
```

Merges are listed in the order they were learned, so their ids are implicit
(the first merge gets `256`, the second `257`, ...). This format is
intentionally interoperable with Karpathy's Python implementation.

## Caveats

- **This is a reference implementation.** It is `O(n)` per merge step and
  will get slow on corpora larger than a few megabytes. For production
  tokenization use `tiktoken` or a compiled BPE library.
- **Vocab does not persist across process restarts.** The HTTP routes keep
  trained tokenizers in an in-memory map per `(user, workspace)`. Save to disk
  via `save()` / `load()` if you need persistence.
- **JavaScript regex differs from Python `regex`.** Python's possessive
  quantifiers (`++`) are not supported; the patterns here are the
  JS-compatible equivalents, which match the same tokens on well-formed input
  but can have different catastrophic-backtracking profiles.

## References

- Andrej Karpathy's [`minbpe` repo][minbpe] — the Python original
- ["Let's build the GPT Tokenizer"][video] YouTube lecture
- [Sennrich et al. 2015][sennrich] — BPE for NMT
- [`tiktoken`](https://github.com/openai/tiktoken) — OpenAI's fast Rust tokenizer
- [GPT-2 vocab via byte-level BPE](https://github.com/openai/gpt-2)

[minbpe]: https://github.com/karpathy/minbpe
[video]: https://www.youtube.com/watch?v=zduSFxRajkE
[sennrich]: https://arxiv.org/abs/1508.07909
