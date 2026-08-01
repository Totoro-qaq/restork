# Research source boundary

Restork Research V1 fetches public evidence only through short-lived, exact-origin capabilities
issued to `OutboundGateway`. Source adapters never call an HTTP client directly and never place a
credential in a URL, query, body, or header.

## Supported sources

| Input | Canonical adapter | Persisted source metadata |
|---|---|---|
| Public HTTPS page | Visible HTML, plain text, Markdown, or bounded JSON | URL, publisher, title, retrieval time, media type, byte count, content hash |
| Public GitHub repository root | Unauthenticated `api.github.com` repository metadata and README | Repository identity, description, creation time, source hash |
| arXiv abstract or PDF URL | `export.arxiv.org` Atom metadata and abstract | Paper ID, title, authors, publication time, abstract hash |

The GitHub adapter follows the official [repository](https://docs.github.com/en/rest/repos/repos)
and [README](https://docs.github.com/en/rest/repos/contents#get-a-repository-readme) endpoints,
including the recommended media type and API-version header. The paper adapter follows the
official [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html), using a single
`id_list` query and parsing its Atom response with entity-safe XML handling.

Generic URLs with query parameters are not supported in V1. GitHub inputs must identify one
repository root, and the paper adapter currently accepts canonical arXiv IDs. Redirects fail closed:
the caller must submit the final canonical URL.

## Trust and retention

Before dispatch, Restork rejects credentials, fragments, non-HTTPS URLs, non-default ports, local or
internal hostnames, IP literals, and DNS results outside the public Internet. Responses have a byte
budget, a text-character budget, an explicit content-type allowlist, and no automatic redirect.

Every fetched body is marked untrusted and stays in the active workflow only. A source body can
provide evidence, but instructions inside it cannot alter mode, tool, network, approval, retention,
or completion policy. Persistable Source Cards contain provenance, a short description, and hashes;
they do not silently turn the fetched body into long-term knowledge.
