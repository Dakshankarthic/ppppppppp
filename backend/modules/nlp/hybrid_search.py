"""
Hybrid search engine: vector (ChromaDB/SentenceTransformers) + lexical (BM25).

Indexes three corpora:
  1. rules.json      — Motor Vehicles Act rules (schema v1 or v2)
  2. violations_db   — DriveLegalKB violation chunks  (schema v2 / dataset)
  3. faq_chatbot     — DriveLegalKB FAQ chunks

NoneType safeguards are applied at every point where document fields may be absent.
"""

import os
import sys
import json
import csv
import logging
from typing import Any, Dict, List, Optional

import chromadb
from rank_bm25 import BM25Okapi
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger(__name__)

# ── Optional DriveLegalKB import (path-safe) ──────────────────────────────────
_DATASET_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "drivelegal_dataset")
)
if _DATASET_DIR not in sys.path:
    sys.path.insert(0, _DATASET_DIR)

try:
    from data_loader import DriveLegalKB  # type: ignore
    _HAS_KB = True
except Exception as _kb_err:
    logger.warning("DriveLegalKB unavailable (%s). RAG will use rules.json only.", _kb_err)
    _HAS_KB = False


def _safe_text(value: Any) -> str:
    """Return a non-None string — central guard against AttributeError on None."""
    if value is None:
        return ""
    return str(value)


def _tokenize(text: Any) -> List[str]:
    """Tokenize text for BM25; always returns a list (never raises)."""
    return _safe_text(text).lower().split() or ["<empty>"]


class HybridSearch:
    """
    Hybrid (vector + BM25) search over DriveLegal knowledge corpus.

    The ChromaDB collection is lazily populated on first use; subsequent restarts
    skip re-indexing unless the collection is empty.  Deleting the vector_db
    directory forces a full re-index (done automatically by merge_dataset.py).
    """

    def __init__(self, rules_path: str, persist_directory: str):
        self.rules_path        = rules_path
        self.persist_directory = persist_directory

        # ── Embedding function (Ollama local) ─────────────────────────────────
        self.embedding_function: Optional[Any] = None
        ollama_embed_model = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
        ollama_base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
        # ChromaDB's OllamaEmbeddingFunction expects the base URL without /v1
        ollama_url = ollama_base.replace("/v1", "").rstrip("/")
        
        try:
            import requests
            from chromadb.api.types import Documents, EmbeddingFunction, Embeddings
            
            class TimeoutOllamaEmbeddingFunction(EmbeddingFunction):
                def __init__(self, url: str, model_name: str):
                    self.url = url
                    self.model_name = model_name
                
                def __call__(self, input: Documents) -> Embeddings:
                    embeddings = []
                    for text in input:
                        # 5-second timeout to prevent Uvicorn/Nginx hangs (HTTP 504)
                        response = requests.post(
                            self.url,
                            json={"model": self.model_name, "prompt": text},
                            timeout=5.0
                        )
                        response.raise_for_status()
                        embeddings.append(response.json()["embedding"])
                    return embeddings

            self.embedding_function = TimeoutOllamaEmbeddingFunction(
                url=f"{ollama_url}/api/embeddings",
                model_name=ollama_embed_model,
            )
            # Quick smoke-test: embed a single word to verify Ollama + model are reachable
            self.embedding_function(["test"])
            logger.info("Ollama embeddings ready — model: %s at %s", ollama_embed_model, ollama_url)
        except Exception as e:
            self.embedding_function = None
            logger.warning("Ollama embeddings unavailable (%s). Using BM25-only fallback.", e)

        # ── ChromaDB ──────────────────────────────────────────────────────────
        self.client = chromadb.PersistentClient(path=self.persist_directory)
        embedding_tag    = "ollama" if self.embedding_function else "none"
        collection_name  = f"drivelegal_{embedding_tag}_v3"

        try:
            self.collection = self.client.get_or_create_collection(
                name=collection_name,
                embedding_function=self.embedding_function,
            )
        except Exception as e:
            # Embedding function conflict — stale collection was created with a
            # different embedding function class. Delete it and start fresh.
            logger.warning("ChromaDB collection conflict (%s). Deleting stale collection and rebuilding.", e)
            try:
                self.client.delete_collection(collection_name)
            except Exception:
                pass
            self.collection = self.client.get_or_create_collection(
                name=collection_name,
                embedding_function=self.embedding_function,
            )

        # ── BM25 ──────────────────────────────────────────────────────────────
        self.bm25: Optional[BM25Okapi] = None
        self.documents: List[Dict]     = []   # flat list of indexable chunks

        self._build_corpus()

    # ── Corpus construction ───────────────────────────────────────────────────

    def _build_corpus(self):
        """Load all documents, build BM25 index, and populate ChromaDB if empty."""
        chunks: List[Dict] = []

        # 1. rules.json
        chunks.extend(self._chunks_from_rules())

        # 2. DriveLegalKB (violations + FAQs + state rules) — schema v2 dataset
        if _HAS_KB:
            chunks.extend(self._chunks_from_kb())
            
        # 3. QA Dataset
        chunks.extend(self._chunks_from_qa_csv())

        if not chunks:
            logger.warning("No documents available for indexing.")
            return

        self.documents = chunks

        # BM25 — always rebuilt in-memory
        tokenized = [_tokenize(c["text"]) for c in chunks]
        self.bm25  = BM25Okapi(tokenized)

        # ChromaDB — skip if already populated (avoids duplicate-ID errors)
        if self.collection.count() == 0:
            self._chroma_add(chunks)

    def _chunks_from_rules(self) -> List[Dict]:
        """Convert rules.json entries to indexable chunks."""
        if not os.path.exists(self.rules_path):
            return []

        try:
            with open(self.rules_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            logger.error("Failed to read rules.json: %s", e)
            return []

        chunks = []
        for rule in data.get("rules", []):
            rid   = _safe_text(rule.get("rule_id"))
            if not rid:
                continue

            tags_str = ", ".join(rule.get("tags", []))
            text = " ".join([
                _safe_text(rule.get("title")),
                _safe_text(rule.get("description")),
                tags_str,
                _safe_text(rule.get("section")),
            ]).strip()

            chunks.append({
                "id":       rid,
                "text":     text or rid,
                "metadata": {
                    "section":  _safe_text(rule.get("section")),
                    "title":    _safe_text(rule.get("title")),
                    "source":   "rules_json",
                },
            })
        return chunks

    def _chunks_from_qa_csv(self) -> List[Dict]:
        """Convert Indian_Traffic_Rules_final.csv to indexable chunks."""
        csv_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "Indian_traffic_law_QA", "Indian_Traffic_Rules_final.csv")
        if not os.path.exists(csv_path):
            return []
            
        chunks = []
        try:
            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for i, row in enumerate(reader):
                    text = row.get("text", "")
                    parts = text.split("###Assistant:")
                    if len(parts) == 2:
                        human_part = parts[0].replace("###Human:", "").strip()
                        assistant_part = parts[1].strip()
                        
                        rid = f"QA_{i}"
                        content = f"Q: {human_part}\nA: {assistant_part}"
                        
                        chunks.append({
                            "id": rid,
                            "text": content,
                            "metadata": {
                                "rule_id": rid,
                                "title": human_part,
                                "source": "qa_csv",
                            },
                            "content": content
                        })
        except Exception as e:
            logger.error("Failed to read QA CSV: %s", e)
        return chunks

    def _chunks_from_kb(self) -> List[Dict]:
        """Build chunks from DriveLegalKB (violations + FAQs + state rules)."""
        try:
            kb     = DriveLegalKB()
            raw    = kb.get_all_chunks()
        except Exception as e:
            logger.error("DriveLegalKB failed: %s", e)
            return []

        chunks = []
        seen_ids: set = set()
        for item in raw:
            cid = _safe_text(item.get("id"))
            if not cid or cid in seen_ids:
                continue
            seen_ids.add(cid)

            text = _safe_text(item.get("text"))
            meta = item.get("metadata", {}) or {}
            # Flatten list values so ChromaDB accepts them (str/int/float/bool only)
            clean_meta: Dict[str, Any] = {}
            for k, v in meta.items():
                if isinstance(v, list):
                    clean_meta[k] = ", ".join(str(i) for i in v)
                elif isinstance(v, bool):
                    clean_meta[k] = str(v)
                else:
                    clean_meta[k] = v
            clean_meta.setdefault("source", "drivelegal_kb")

            chunks.append({"id": cid, "text": text or cid, "metadata": clean_meta})
        return chunks

    def _chroma_add(self, chunks: List[Dict]):
        """Batch-add chunks to ChromaDB, skipping any with duplicate IDs."""
        batch_size = 100
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i : i + batch_size]
            try:
                self.collection.add(
                    ids=       [c["id"]       for c in batch],
                    documents= [c["text"]     for c in batch],
                    metadatas= [c["metadata"] for c in batch],
                )
            except Exception as e:
                logger.warning("ChromaDB batch add failed (batch %d): %s", i // batch_size, e)

    # ── Search ────────────────────────────────────────────────────────────────

    def search(self, query: str, top_k: int = 3) -> List[Dict]:
        """
        Hybrid search: vector results (ranked by position) merged with BM25 results.
        Returns at most top_k unique results sorted by combined score (descending).
        Falls back gracefully if any sub-system is unavailable.
        """
        results: Dict[str, Dict] = {}   # chunk_id → result entry

        # 1. Vector search
        if self.embedding_function and self.collection.count() > 0:
            try:
                vr = self.collection.query(query_texts=[query], n_results=min(top_k, self.collection.count()))
                ids   = (vr.get("ids")       or [[]])[0]
                metas = (vr.get("metadatas") or [[]])[0]
                docs  = (vr.get("documents") or [[]])[0]
                for rank, (cid, meta, doc) in enumerate(zip(ids, metas, docs)):
                    results[cid] = {
                        "rule_id":  cid,
                        "score":    1.0 / (rank + 1),
                        "metadata": meta or {},
                        "content":  _safe_text(doc),
                        "source":   "vector",
                    }
            except Exception as e:
                logger.warning("Vector search failed: %s", e)

        # 2. BM25 search
        if self.bm25 and self.documents:
            try:
                tokenized_query = _tokenize(query)
                scores          = self.bm25.get_scores(tokenized_query)
                top_indices     = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
                for idx in top_indices:
                    doc   = self.documents[idx]
                    cid   = doc["id"]
                    bscore = float(scores[idx]) / max(10.0, float(scores[idx]) + 1e-9)
                    if cid in results:
                        # Boost combined score
                        results[cid]["score"] += bscore * 0.3
                    else:
                        results[cid] = {
                            "rule_id":  cid,
                            "score":    bscore,
                            "metadata": doc.get("metadata", {}),
                            "content":  doc.get("text", ""),
                            "source":   "lexical",
                        }
            except Exception as e:
                logger.warning("BM25 search failed: %s", e)

        return sorted(results.values(), key=lambda x: x["score"], reverse=True)[:top_k]
