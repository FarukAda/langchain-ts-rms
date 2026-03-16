# ADR 0001: RAG-Centric Research Memory System

## Status

Accepted

## Context

Autonomous agents need access to up-to-date factual information. Raw web search results are noisy, verbose, and often contain irrelevant content. Agents benefit from a managed research cache that:

1. Deduplicates repeated queries on the same topic.
2. Uses LLM summarization to condense raw results into actionable research.
3. Automatically manages data freshness, re-searching when entries expire.
4. Supports semantic retrieval for related research topics.

## Decision

We choose a **RAG-centric** architecture where:

- **Qdrant** serves as the vector backbone, storing embedded research summaries.
- **SearXNG** provides privacy-respecting, self-hosted web search.
- **Ollama** provides local LLM inference for summarization.
- **Freshness management** is automatic: entries have an `expiresAt` timestamp computed from `updatedAt + freshnessDays`.

The research flow is:
1. Check cache → 2. If stale/missing, search web → 3. Summarize via LLM → 4. Store in Qdrant → 5. Return result.

## Consequences

### Positive

- Agents get concise, cached research without redundant web searches.
- Semantic search enables finding related research across topics.
- Self-hosted stack (Qdrant + SearXNG + Ollama) keeps all data local.
- Freshness model prevents serving outdated information.

### Negative

- Requires three backing services (Qdrant, SearXNG, Ollama) in the local dev environment.
- Summarization quality depends on the chosen LLM model.
- SearXNG availability depends on upstream search engines not blocking the instance.

### Mitigations

- Docker Compose provides one-command infrastructure setup.
- `RMS_OLLAMA_CHAT_MODEL` allows overriding the summarization model per deployment.
- `RMS_FRESHNESS_DAYS` is configurable per environment.
