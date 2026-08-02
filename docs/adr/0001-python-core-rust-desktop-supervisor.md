# ADR 0001: Keep the Python Core and add a thin Rust desktop supervisor

- Status: Accepted
- Date: 2026-08-02
- Scope: Step 11 macOS desktop distribution

## Context

Restork depends on the Python research, model, parsing, and evaluation ecosystem. Rewriting that
Core would slow feature work and create behavioral drift. At the same time, a source-distributed
Python application can expose users to interpreter discovery, package incompatibility, slow
environment setup, and fragile process startup—the failure pattern seen in projects such as Hermes
Agent.

The desktop problem is narrower than the agent problem: select a port, start one known binary, prove
and monitor ownership, show a window, update safely, and clean up on failure.

## Decision

Keep Python 3.12 as the only Core implementation. Freeze it with `uv.lock` and distribute it as a
PyInstaller `onedir` resource. Add a Tauri 2 Rust shell whose authority ends at lifecycle and OS
integration. Do not add Go.

Rust must not own prompts, workflows, provider logic, policy, memory, retrieval, or user data. The
shell communicates with Core only through the reviewed bootstrap/readiness/pairing contracts and
the existing loopback API.

Rust owns the compiled-resource selection and process lifecycle: release builds spawn only the Core
bundled at the fixed signed application-resource path, retain its child handle and process group,
probe readiness, and perform bounded cleanup. Python still owns agent orchestration. A one-way
kernel pipe lets Core observe loss of the Rust owner even when the shell is killed before cleanup can
run.

## Why not all Python

A Python GUI/supervisor would still depend on Python packaging and process behavior at the exact
layer intended to recover from Python startup failures. It would also provide a heavier or less
native desktop shell. PyInstaller still packages the Core, but the installed application launches a
small native supervisor first and performs no dependency resolution.

## Why not rewrite the Core in Rust

A rewrite would remove access to mature Python-first ML/research libraries, duplicate tested
contracts, and make future model experimentation slower. Restork's current bottlenecks are network
and model work, not local language throughput. Rust adds value at the process boundary, not in the
agent domain.

## Why not Go

Go could also supervise a process, but Tauri already requires Rust for the selected shell. Adding Go
would create another compiler, release artifact, IPC boundary, and security surface without
removing either TypeScript or Python.

## Consequences

Positive:

- end users install no Python packages and wait for no package resolver;
- startup and shutdown have a native owner independent of Core health;
- transient readiness loss, a frozen Core, and loss of the native parent have explicit recovery;
- the existing model/research ecosystem and test suite remain available;
- the browser, CLI, and desktop app share one Core and one UI.

Costs:

- release builds contain both Rust and a frozen Python runtime;
- nested binaries increase signing/notarization complexity;
- PyInstaller hooks and cold-start performance require explicit release tests;
- Windows/Linux later require platform secret-store and child-lifecycle adapters.

## Guardrails

- `onedir` remains the default until measured release builds justify `onefile`.
- no package manager runs at application startup;
- no model/provider request occurs during readiness;
- optional update checks wait until the initial Core/session path has completed;
- release builds never select Core from `PATH` or a runtime override;
- one readiness miss is tolerated and three consecutive misses trigger bounded process-group cleanup;
- no Core feature is accepted only in Rust;
- a future language change requires measured evidence and a new ADR.
