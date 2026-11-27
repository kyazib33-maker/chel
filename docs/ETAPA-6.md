# Etapa 6 — Permission Engine

## Entregue

- Novo crate `permission-engine`, independente dos adapters e reutilizável pelo Host.
- Políticas `read_only`, `ask_for_sensitive` e `allow_all`.
- Classes de ação: `read`, `write`, `execute`, `network` e `destructive`.
- Avaliação determinística: leitura é permitida por `ask_for_sensitive`; ações sensíveis exigem aprovação; `read_only` bloqueia tudo que não seja leitura.
- Solicitações com ID, tarefa, provedor, ferramenta, classe, resumo, prévia de argumentos, criação e expiração.
- Expiração automática no momento da leitura/decisão da fila.
- Decisão única, com identidade do decisor e timestamp; decisões repetidas são rejeitadas.
- Comandos Tauri para listar e decidir solicitações no Desktop.
- API remota autenticada para listar e decidir solicitações no Mobile:
  - `GET /api/v1/approvals`
  - `POST /api/v1/approvals/{id}/decision` com `{ "approve": true|false }`
- Interfaces de fila e histórico no Desktop e Mobile.

## Política padrão

O Host inicializa com `ask_for_sensitive` e TTL de cinco minutos. Não há modo `allow_all` habilitado por padrão. Uma solicitação expirada muda para `expired` e não pode ser aprovada posteriormente.

## Limite de integração — importante

O motor e os canais de decisão estão implementados, mas os adapters atuais ainda iniciam os CLIs em modo headless e não publicam pedidos nativos de permissão. O método `PermissionEngine::submit` é a entrada destinada ao adapter quando ele receber um evento real de ferramenta. A decisão registrada ainda não retoma nem interrompe um comando dentro do CLI. Não declarar suporte a aprovação em tempo real até existir, por provedor, um protocolo de entrada/saída interativo que conecte a decisão ao processo real.

A etapa seguinte deve implementar adapters interativos individualmente, começando pelo provedor cujo protocolo de permissões possa ser controlado e testado de ponta a ponta. Para cada um: captura do pedido nativo, pausa segura, envio ao Permission Engine, resposta allow/deny ao processo, timeout fail-closed e testes de integração.

## Testes e validação

Testes unitários incluídos para política somente leitura e decisão única de uma solicitação sensível. A compilação Rust e os testes Cargo ainda precisam ser executados em ambiente com a toolchain Rust instalada. A interface TypeScript foi validada sintaticamente; a verificação completa de tipos depende da instalação das dependências do workspace.
