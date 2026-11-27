# Etapa 23 — Testabilidade e CI

Foram adicionados testes unitários para memória escopada, rejeição de padrões de credenciais, catálogo de preços, avaliação de orçamento, idempotência, integridade do journal, compilação de blueprint e fingerprint de workspace. O checkpoint store também é testado em substituições repetidas.

O workflow GitHub Actions (`.github/workflows/ci.yml`) executa formatação, testes Rust, Clippy, typecheck e build do Desktop. O job Windows produz bundles Tauri em `workflow_dispatch` ou tags.

**Limite:** o CI ainda precisa ser executado em um repositório remoto e receber aprovação. Nenhum resultado de CI é alegado nesta entrega.
