# Etapa 8 — Aprovações unificadas Desktop + Mobile

## Objetivo

Conectar as solicitações de aprovação reais do Codex App Server à fila compartilhada do `PermissionEngine`, permitindo que o usuário responda pelo Desktop ou por um dispositivo Mobile pareado.

## Implementação

### Bridge Rust

O crate `codex-app-server` agora contém `CodexApprovalBridge`, que consome os eventos nativos do App Server e reconhece:

- `item/commandExecution/requestApproval` → ação `execute`;
- `item/fileChange/requestApproval` → ação `write`;
- `item/permissions/requestApproval` → ação `network` ou `write`, conforme o payload; a resposta usa `permissions` com o subconjunto solicitado aprovado e escopo limitado ao turno. Negar retorna um objeto de permissões vazio.

Cada item pendente guarda uma referência interna ao `session_id`, ao `request_id` JSON-RPC original e ao tipo de resposta esperado. O identificador interno da fila não é confundido com o ID do protocolo. Respostas de aprovação de comando/arquivo usam `{ decision }`; pedidos de permissões usam o payload próprio `{ permissions, scope }`, sem misturar os dois contratos.

### Política

- `ask_for_sensitive`: registra a solicitação e aguarda decisão humana.
- `read_only`: nega ações que não sejam leitura.
- `allow_all`: responde aceitar para as classes avaliadas pela política.
- Se a fila estiver cheia, a solicitação nativa é negada para não deixar o turno preso.
- Se o App Server resolver a solicitação externamente (`serverRequest/resolved`) ou a sessão cair, a entrada local é encerrada como expirada.
- Ao listar a fila, entradas expiradas são reconciliadas e os pedidos nativos correspondentes são negados. Uma aprovação depois do prazo nunca é enviada.

### Desktop e Mobile

- `RemoteServerController` recebe a mesma instância do bridge usada pelo Desktop.
- `GET /api/v1/approvals` lista solicitações do Permission Engine.
- `POST /api/v1/approvals/{id}/decision` autentica o dispositivo e envia a decisão ao bridge.
- Os comandos Tauri usam o mesmo bridge; não existe fila paralela no Desktop.
- A tela Mobile atualiza a lista a cada três segundos enquanto está aberta.
- O painel Codex nativo direciona o usuário à Central unificada em vez de manter botões de aprovação duplicados.

## Limitações

- Esta integração é específica do Codex App Server. Claude Code e Antigravity ainda não estão conectados ao bridge.
- A sincronização da fila no Mobile usa polling REST a cada três segundos; ainda não há evento WebSocket dedicado para aprovações.
- O App Server pode alterar payloads entre versões. Os campos usados são os documentados, mas a compatibilidade precisa ser verificada com a versão local instalada.
- Não foi possível executar `cargo test`, `cargo clippy` ou build Tauri: Rust/Cargo não estão disponíveis neste ambiente. Também não há CLI Codex local para teste real.

## Validações possíveis neste ambiente

- TOML e JSON: validação sintática local.
- TypeScript/TSX: transpilation/parsing local sem dependências.
- Rust: revisão estática do código e das dependências; compilação pendente.
