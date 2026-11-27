# Etapa 21 — Primitivas de idempotência

O crate `orchestrator-intelligence` inclui um `IdempotencyLedger` persistente com estados `running`, `completed` e `failed`. Ele reserva uma chave de ação, bloqueia segunda reserva enquanto está em execução, reconhece ações concluídas e permite nova tentativa somente após marcação explícita de falha.

As gravações usam temporário + backup para compatibilidade com Windows. O ledger é uma primitiva disponível para integrações futuras; ainda não intercepta automaticamente todos os comandos shell, chamadas de rede ou efeitos externos executados pelos CLIs. Portanto não se declara execução exactly-once.
