# Status consolidado — Etapas 20–30

| Etapa | Implementação principal | Estado nesta entrega |
|---|---|---|
| 20 | Retomada com fingerprint e worktree de equipe sequencial | Implementado no código; testes Rust pendentes de execução |
| 21 | Ledger persistente de idempotência | Primitiva criada; integração global com efeitos externos ainda pendente |
| 22 | Journal de auditoria encadeado | Implementado para início, retomada e cancelamento de workflows Desktop; hash FNV não criptográfico |
| 23 | Testes e CI | Testes unitários criados e pipeline configurado; CI não executada nesta sessão |
| 24 | Memória compartilhada por projeto | Implementada com busca lexical e filtro heurístico de segredos; sem embeddings |
| 25 | Roteamento e delegação adaptativa | Recomendação heurística explicável; não troca provedor autonomamente |
| 26 | Compilação do plano em DAG | Implementada; cadeia sequencial compartilha worktree isolado de equipe |
| 27 | Preços, custos e orçamento | Preços manuais por modelo e estimativas; não representa faturamento real nem interrompe CLI ao atingir teto |
| 28 | Console Desktop | Memória, catálogo de preços e estimador de custo |
| 29 | Build Windows 11 e CI | Scripts e workflow de CI criados; MSI/NSIS não gerado neste ambiente |
| 30 | Segurança e release | Scanner heurístico, documentação e release gates; candidato RC, não release estável |

## Bloqueios para 1.0 estável

1. Executar `cargo fmt`, `cargo test` e `cargo clippy` com Rust estável no Windows 11.
2. Instalar dependências JS e executar typecheck/build reais (transpile isolado não substitui typecheck).
3. Testar Claude Code, Codex App Server e Antigravity com as versões locais instaladas e suas autenticações existentes.
4. Validar retomada, worktree, aprovação, cancelamento, Mobile e rede privada ponta a ponta.
5. Produzir e testar instaladores MSI/NSIS; decidir assinatura e atualização automática.

O pacote é um candidato a release para validação local. Não declare 1.0 estável enquanto qualquer gate acima estiver pendente.
