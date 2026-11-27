# Etapa 22 — Auditoria e gates de aprovação

- `AuditJournal` mantém eventos JSONL encadeados, com sequência, hash anterior e hash do evento.
- O Desktop registra início, retomada e solicitação de cancelamento de workflow antes/depois das ações correspondentes.
- O journal verifica a cadeia antes de aceitar nova gravação e falha de forma conservadora se detectar inconsistência.
- Conteúdos que parecem credenciais são omitidos do detalhe de auditoria.
- A retomada exige confirmação de que nós sem resultado podem ser executados novamente; repetir nós já falhos é uma opção separada.

**Limites:** FNV-1a é detecção simples de corrupção, não proteção criptográfica contra adulteração. A trilha atual cobre essas ações do Desktop, não todas as decisões do Mobile nem todos os eventos de execução.
