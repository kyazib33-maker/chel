# Etapa 19 — Checkpoints e recuperação segura

## Implementado

1. Checkpoint JSON por `run_id`, com gravação temporária seguida de rename.
2. Snapshot da definição, workspace, prompt, política, resultados concluídos e estado.
3. Persistência após cada nó concluído e nos cancelamentos explícitos.
4. Classificação de execuções `running`/`queued` como `interrupted` ao consultar o repositório de checkpoints.
5. Consulta no Desktop via `list_workflow_checkpoints`.
6. Consulta remota autenticada via `GET /api/v1/workflow-checkpoints`.
7. Teste unitário para a classificação de checkpoint interrompido.

## Segurança de recuperação

Não há reexecução automática de agentes. Uma execução pode alterar arquivos, chamar serviços externos ou realizar ações não idempotentes. O checkpoint preserva os resultados concluídos e identifica o estado interrompido, mas a retomada exige inspeção dos worktrees e confirmação explícita. Isso evita duplicar ações sem uma política de idempotência por agente.

## Limitações

- Worktrees são preservados, mas ainda não há inventário completo/validação de integridade dos diretórios Git durante recuperação.
- Falhas ocorridas antes do primeiro checkpoint ou durante uma gravação podem deixar apenas o último snapshot válido.
- Checkpoints não são removidos automaticamente e precisam de política de retenção futura.
- Build/testes Rust não executados neste ambiente se `cargo`/`rustc` não estiverem instalados.
