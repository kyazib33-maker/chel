# Psylium

Monorepo para orquestrar localmente Claude Code, Codex CLI e Antigravity, com Host Rust, Desktop Tauri e Remote Control Expo. O projeto usa as autenticações já existentes dos CLIs; não solicita chaves de API.

## Estado do projeto

### Etapa 1 — Fundação e pool paralelo

- [x] Workspace Rust e monorepo pnpm.
- [x] Processo concorrente com limite de paralelismo.
- [x] Streaming independente de stdout/stderr.
- [x] Estados de tarefa e eventos tipados.
- [x] Cancelamento com interrupção graciosa e fallback.
- [x] Limite configurável de concorrência e retenção limitada de tarefas concluídas.
- [x] Adaptadores iniciais para Claude, Codex e Antigravity.
- [x] Janela Desktop Tauri + React/TypeScript.
- [x] Esqueleto Expo Router + NativeWind.
- [ ] Compilação e teste local no Windows (este ambiente de geração não contém Rust/Cargo).
- [x] Servidor REST/WebSocket remoto opcional, pareamento por código de uso único e token de dispositivo.
- [x] SQLite local para dispositivos pareados, armazenamento somente do hash do token e revogação.
- [x] Leitura de Usage histórico para Claude Code/Codex e observação live de streams para os três adapters.
- [ ] Persistência durável de todas as saídas/timelines de tarefas e execução independente da interface.
- [x] Mobile Expo: pareamento por câmera/QR, SecureStore, Dashboard, logs, disparador rápido, workflows salvos e Usage.
- [ ] Workflow Runner remoto (execução DAG/contexto).
- [x] Aprovações nativas do Codex integradas à fila unificada e ao Mobile.
- [ ] Aprovações interativas nativas de Claude Code e Antigravity.

## Requisitos para Windows 11

1. Node.js 22.13 ou superior.
2. pnpm 10.
3. Rust estável via rustup, com toolchain MSVC.
4. Visual Studio Build Tools com C++ Build Tools e Windows SDK.
5. WebView2 Runtime.
6. Git para Windows.
7. CLIs já instalados e autenticados: `claude`, `codex` e/ou `agy`.

Execute primeiro o diagnóstico:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\doctor.ps1
```

Ele consulta somente versões e caminhos de executáveis. Não lê nem exporta tokens, credenciais ou arquivos de autenticação.

## Instalação

Na raiz do projeto:

```powershell
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install
```

Instalar dependências Rust:

```powershell
rustup update stable
rustup target add x86_64-pc-windows-msvc
```

## Verificar o código Rust

```powershell
cargo fmt --all
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

## Executar Desktop

```powershell
pnpm dev:desktop
```

O frontend pode ser executado no navegador com `pnpm --filter @orchestrator/desktop dev`, mas a execução dos CLIs locais só fica disponível dentro do shell Tauri.

## Executar Mobile

```powershell
pnpm dev:mobile
```

Para Android nativo, configure Android Studio, Android SDK e JDK compatível com o Expo SDK usado pelo projeto.

## Arquitetura atual

```text
apps/
  desktop/                 Tauri v2 + React + TypeScript + Tailwind
  mobile/                  Expo Router + React Native + NativeWind
crates/
  shared-protocol/         IDs, estados e eventos serializáveis
  process-manager/         Tokio process pool e streaming
  provider-adapters/       conversão de requests em argv por CLI
  orchestrator-core/       fachada de orquestração
  workspace-manager/       criação e ciclo de vida seguro de Git Worktrees
  workflow-engine/         modelo, validação DAG e armazenamento de workflows
  remote-server/            Axum REST/WebSocket, pareamento, auth e replay
  usage-monitor/            leitura de Usage JSONL e observação dos streams
  workflow-runner/          execução DAG com paralelismo e worktrees isolados
  permission-engine/        políticas, fila e auditoria de aprovações
  codex-app-server/         protocolo JSON-RPC nativo e bridge de aprovações
```

## Segurança e limites desta etapa

- O backend inicia executáveis sem `sh -c`/`cmd /c` com texto concatenado. No Windows, shims `.cmd` são resolvidos por PowerShell com argumentos em JSON codificado, não interpolados como script.
- O prompt e os argumentos de execução não são copiados para o Task Board.
- Nesta primeira etapa, o pool Rust é hospedado pelo processo Tauri. A separação em um daemon supervisionado independente fica como uma decisão explícita antes de habilitar execução persistente em background e o controle remoto.
- O pool usa um buffer de eventos em memória e mantém até 500 snapshots de tarefas por padrão (tarefas ativas nunca são removidas). O servidor remoto oferece replay de eventos enquanto o Host está ativo; ainda faltam persistência durável das saídas e recuperação da timeline completa após reinicialização.
- SIGINT/CTRL_BREAK é solicitado primeiro; se o processo não sair, há encerramento forçado após o período de tolerância. No Windows, o Host cria um console oculto herdado pelos CLIs e envia CTRL_BREAK ao grupo de processos específico; taskkill `/T /F` é o fallback para a árvore de processos.
- Os argumentos dos CLIs são encapsulados em adapters e precisam ser validados nas versões instaladas. Antigravity é marcado como experimental até verificarmos `agy --help` na máquina alvo.
- Não há bypass de permissões. O Codex App Server possui aprovações nativas encaminhadas à fila unificada e respondidas pelo Desktop ou Mobile; os demais CLIs ainda não possuem retomada interativa integrada.

## Observação sobre Expo

Este scaffold usa Expo SDK 57 (React Native 0.86.3) porque o NativeWind v4.2.7 documenta suporte a essa versão. O Expo Router inclui suas dependências de navegação (`expo-linking`, `expo-constants`, `react-native-screens`, `react-native-safe-area-context` e `expo-status-bar`), e o Gesture Handler segue a linha 2.32 do SDK 57. O SDK 58 já foi publicado, mas a compatibilidade do NativeWind v4 com ele ainda não está documentada. Reanimated 4.5.1 está pareado com Worklets 0.10.2, ambos na linha compatível com React Native 0.86. Antes de atualizar o Expo, valide a matriz de compatibilidade e execute Expo Doctor.


## Etapa 2 — Task Board, Worktrees e Workflow Builder

A Etapa 2 adiciona três módulos principais:

- `workspace-manager`: cria, lista e remove apenas worktrees registrados pelo aplicativo. A remoção normal respeita a proteção do Git contra diretórios sujos; a remoção forçada é uma ação explícita.
- `workflow-engine`: define o modelo persistido de workflow, valida identificadores e conexões, detecta ciclos e calcula níveis topológicos que representam grupos paralelos (fan-out/fan-in).
- Desktop UI: Task Board em cinco colunas, logs por tarefa, Split View de até quatro processos, indicador de arquivo ativo por monitoramento nativo e telas de Worktree Manager e Workflow Builder.

Os templates são armazenados no diretório `app_data/workflows`; os worktrees gerenciados ficam em `app_data/worktrees`, com registros de propriedade separados dos diretórios de código. A execução coordenada de workflows foi adicionada na Etapa 5. A execução remota pelo Mobile e a detecção confiável de cotas permanecem pendentes.

### Testes adicionados

- `workspace-manager`: criação/listagem/remoção, proteção contra remoção forçada e validação de branches.
- `workflow-engine`: topologia paralela, detecção de ciclos e persistência de templates.
- `process-manager`: detecção do arquivo alterado durante uma execução.

Para validar no ambiente local: `cargo fmt --all -- --check`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `pnpm install` e `pnpm --filter @orchestrator/desktop build`.


## Etapa 3 — Remote Control e Usage

- `remote-server`: Axum REST + WebSocket, porta padrão `17891`, iniciado somente após ação explícita do usuário.
- O bind padrão é `127.0.0.1`; LAN requer habilitação explícita. Endereços Tailscale são anunciados quando o CLI está disponível.
- Pareamento por QR de uso único com expiração de 180 segundos. O QR não contém o token permanente.
- Tokens de dispositivo têm alta entropia, são armazenados como SHA-256 no SQLite e podem ser revogados pelo Desktop.
- REST exige Bearer token; WebSocket autentica pelo primeiro frame (não pela URL) e oferece snapshot/replay com sequência global.
- Usage histórico do Claude Code é reconstruído de `~/.claude/projects`; Codex de `~/.codex/sessions`. Antigravity usa leitura live somente até que o formato local seja confirmado.
- Métricas históricas e live ficam separadas para evitar contagem duplicada. Cotas oficiais não são inferidas quando não há endpoint confiável.
- O Mobile Expo possui scanner QR, SecureStore, REST/WebSocket, Dashboard, quick dispatch, logs por tarefa, biblioteca de workflows e Usage.
- A central de aprovações permite decidir solicitações nativas do Codex remotamente. Os workflows ainda não podem ser iniciados pelo celular.

**Aviso de rede:** o modo LAN nesta versão usa HTTP simples e deve ficar restrito a redes confiáveis. O Mobile permite apenas IPs privados/Tailscale enviados no QR; no Android, a declaração de HTTP simples é uma política ampla do app, enquanto no iOS é usada a exceção `NSAllowsLocalNetworking`. Isso não cifra o tráfego. Para redes não confiáveis, use Tailscale e não exponha a porta diretamente à Internet. No Windows, autorize a porta TCP `17891` somente em redes privadas caso o Firewall solicite. O Host ainda roda dentro do processo Tauri; fechar o Desktop encerra o servidor remoto.

Consulte [`docs/ETAPA-3.md`](docs/ETAPA-3.md) para contratos do Host remoto e [`docs/ETAPA-4.md`](docs/ETAPA-4.md) para o aplicativo Mobile.

## Etapa 5 — Workflow Runner (execução real no Desktop)

- `workflow-runner`: executa grafos validados por níveis topológicos; nós do mesmo nível rodam em paralelo e fan-in aguarda todos os predecessores.
- Cada nó recebe o objetivo inicial e somente as saídas dos predecessores conectados com `pass_context=true`, respeitando o modo de contexto e limite de 48 KiB.
- Saídas por nó são limitadas a 64 KiB para evitar crescimento ilimitado em memória.
- Nós com `worktree_mode=isolated` recebem worktrees gerenciados e branches exclusivos por execução; worktrees são preservados para inspeção e merge manual.
- Falhas bloqueiam nós dependentes, enquanto ramos independentes podem terminar. O resultado inclui estado e task id de cada nó.
- Desktop Workflow Builder ganhou campos de repositório/objetivo e botão Executar workflow.

**Limitações ainda abertas:** a execução de workflow está conectada ao Desktop, mas não ao endpoint remoto Mobile; o comando Tauri aguarda o resultado integral e ainda não oferece cancelamento por `run_id`/progresso de workflow dedicado. O Workflow Runner usa o pool de processos já existente e, por isso, respeita o limite global de concorrência.


## Etapa 6 — Permission Engine

A camada de permissões agora centraliza políticas `read_only`, `ask_for_sensitive` e `allow_all`, solicitações com expiração e decisões únicas. A fila pode ser consultada e decidida no Desktop e no Mobile por endpoints remotos autenticados. O padrão do Host é `ask_for_sensitive` com expiração em cinco minutos.

**Status histórico:** na Etapa 6 a fila ainda não retomava processos CLI. A Etapa 8 conectou o Codex App Server à fila e enviou decisões de volta ao JSON-RPC nativo. Claude Code e Antigravity continuam pendentes.

Detalhes: [`docs/ETAPA-6.md`](docs/ETAPA-6.md).

## Etapa 7 — Codex App Server nativo

Integração inicial com o protocolo bidirecional JSON-RPC do `codex app-server`, com sessões persistentes, sandbox explícito, streaming de eventos e decisões nativas para aprovações de execução de comandos e alterações de arquivos. O Desktop possui uma página dedicada **Codex nativo**. O fluxo `codex exec` permanece como caminho legado/alternativo.

**Limites na entrega original:** a integração Mobile e a unificação de aprovações foram concluídas na Etapa 8. Elicitation MCP e entrada do usuário ainda não estão integradas. Claude Code e Antigravity continuam pendentes. Build Rust e teste real do CLI seguem pendentes por ausência do toolchain e do executável neste ambiente.

Detalhes: [`docs/ETAPA-7.md`](docs/ETAPA-7.md).


## Etapa 8 — Aprovações unificadas Desktop + Mobile

- `CodexApprovalBridge` consome solicitações JSON-RPC nativas de execução de comandos, alterações de arquivos e permissões adicionais.
- Cada solicitação é registrada no `PermissionEngine`, preservando provedor, classe de ação, resumo, payload de inspeção, prazo e auditoria.
- A decisão no Desktop ou no Mobile é enviada de volta ao `request_id` JSON-RPC exato que pausou o turno do Codex.
- Políticas `read_only` e `allow_all` são aplicadas automaticamente às solicitações nativas; `ask_for_sensitive` encaminha para aprovação humana.
- Fila cheia, sessão desconectada, solicitação resolvida externamente e expiração não devem resultar em autorização implícita; pedidos pendentes são negados/expirados de forma conservadora.
- O Mobile atualiza a fila enquanto a tela de aprovações está aberta. O Desktop e o Mobile usam a mesma fila e a mesma decisão.

**Limites:** o fluxo foi integrado ao Codex App Server; Claude Code e Antigravity ainda não enviam callbacks nativos para esta ponte. O Mobile usa atualização periódica da fila, não push dedicado de aprovações. Build Rust e teste de ponta a ponta com Codex instalado continuam pendentes porque este ambiente não possui Rust/Cargo nem os CLIs locais.

Detalhes: [`docs/ETAPA-8.md`](docs/ETAPA-8.md).

## Etapa 9 — Claude Code Interactive Adapter

O crate `claude-code-adapter` controla sessões Claude Code por `stream-json` bidirecional, reutilizando a autenticação local do CLI. Solicitações `can_use_tool` são encaminhadas ao Permission Engine e respondidas no processo original por `control_response`. O Desktop ganhou um painel de sessões Claude nativas; a central remota autenticada também agrega solicitações Claude e Codex para aprovação pelo Mobile.

Para aprovações humanas centralizadas, mantenha o modo Claude em `default`. Modos nativos como `acceptEdits`, `auto` e `dontAsk` podem resolver permissões sem consultar o Host. `bypassPermissions` não é aceito pelo adapter.

Consulte [`docs/ETAPA-9.md`](docs/ETAPA-9.md) para protocolo, segurança, limitações e validação pendente.


## Etapa 10 — Session Manager central

A Etapa 10 adiciona o crate `session-manager`, persistência de metadados de sessões em `sessions.json`, reconciliação de sessões ativas para `interrupted` após reinicialização, integração de ciclo de vida para Claude Code e Codex App Server, endpoint remoto autenticado `GET /api/v1/sessions`, Central de Sessões no Desktop e visualização no Mobile. A recuperação de metadados não restaura processos automaticamente. Claude guarda seu ID nativo para retomada explícita; Codex ainda está em modo metadata-only até a integração de `thread/resume`. Antigravity permanece sem adapter nativo.

Consulte `docs/ETAPA-10.md` para detalhes e limitações.


## Etapa 11 — Antigravity e retomada nativa

A Etapa 11 adiciona o crate `antigravity-adapter`, importação de conversas pelo cache oficial do AGY e retomada por `--conversation`. O Desktop pode retomar Claude Code, Codex (`thread/resume`) e Antigravity; o Mobile possui retomada remota Antigravity com validação de workspace. O AGY é executado headless por turno, sem fingir oferecer aprovação JSON-RPC em tempo real. Consulte `docs/ETAPA-11.md`.


## Etapa 12 — Catálogo de capacidades dos provedores

A Etapa 12 adiciona o crate `provider-runtime`, com catálogo comum de capacidades e um vocabulário normalizado de eventos. O Desktop apresenta a página **Capacidades dos provedores** e o Mobile possui a aba **CLIs**. O endpoint remoto autenticado `GET /api/v1/providers` informa o que está efetivamente integrado, incluindo a distinção de que Antigravity ainda não oferece aprovação interativa centralizada. Consulte [`docs/ETAPA-12.md`](docs/ETAPA-12.md).

## Etapa 13 — Controle remoto de sessões

O Mobile agora pode retomar sessões Claude Code, Codex e Antigravity pelo protocolo nativo; enviar mensagens adicionais para sessões Claude/Codex ativas; e interromper processos Claude/Codex. O Host aplica autenticação do dispositivo pareado, validação de workspace e modos de permissão conservadores. Consulte `docs/ETAPA-13.md` para rotas e limitações.

## Etapa 14 — Roteamento inteligente e delegação

O novo crate `agent-router` classifica tarefas, estima complexidade, pontua os provedores de forma explicável, recomenda effort e sugere uma ordem de fallback. O Desktop ganhou a página **Roteador IA**, que também monta um blueprint consultivo de planejamento, implementação isolada e revisão cruzada. Nenhuma execução ou troca de provedor ocorre sem confirmação. O roteador usa o modelo padrão do CLI local, evitando aliases não suportados; custo monetário real e delegação automática ficam para uma etapa posterior. Consulte [`docs/ETAPA-14.md`](docs/ETAPA-14.md).

## Etapa 15 — Orquestração controlada

Workflows agora aplicam limites configuráveis por política (número de agentes, tempo por agente, tempo total e captura de saída), confirmação explícita antes da execução e revisão obrigatória conectada a todos os agentes predecessores. Processos ativos são cancelados quando o limite total é atingido. Consulte `docs/ETAPA-15.md` para limites e restrições conhecidas.

## Etapa 16 — Histórico de execuções

A Etapa 16 adiciona persistência local de resultados de workflows concluídos, retenção de até 100 execuções e a página Desktop **Execuções** para consultar status, timestamps, saídas e falhas por agente. O comando Tauri `list_workflow_runs` permite consultar o histórico. A execução ainda é síncrona; monitoramento em tempo real, cancelamento de workflow, checkpoints e sincronização remota ficam para etapas posteriores. Consulte `docs/ETAPA-16.md`.

## Etapa 17 — Execução assíncrona e controle de workflows

A Etapa 17 adiciona execução assíncrona no Desktop, identificador imediato de execução, eventos de progresso por nó, consulta de execuções ativas e cancelamento cooperativo. O painel Execuções acompanha eventos ao vivo e atualiza o histórico. Consulte `docs/ETAPA-17.md` para limites e detalhes.

## Etapa 18 — Execução remota de workflows

O Mobile pode iniciar workflows armazenados no Host, acompanhar eventos por WebSocket, reconciliar snapshots pela API e solicitar cancelamento. Consulte `docs/ETAPA-18.md` para endpoints, segurança e limitações.

## Etapa 19 — Checkpoints e recuperação

- Workflows iniciados pelo Desktop ou pela API remota gravam checkpoints atômicos em `workflow-checkpoints/`.
- O checkpoint contém definição do workflow, workspace, prompt, política e resultados dos nós já concluídos.
- Cada nó concluído atualiza o checkpoint; cancelamentos preservam os resultados já obtidos.
- Ao consultar checkpoints após reinício, estados `running`/`queued` são apresentados como `interrupted`, com instrução para inspecionar worktrees antes de qualquer retomada.
- Desktop: comando `list_workflow_checkpoints`.
- API remota autenticada: `GET /api/v1/workflow-checkpoints`.
- Retomada automática ainda não é habilitada: agentes podem produzir efeitos externos, portanto a reexecução precisa de uma etapa explícita de revisão de idempotência e aprovação.


## Etapas 20–30 — Consolidação e candidato a 1.0

As etapas 20–30 adicionam retomada preflight de workflows, memória persistente por projeto, catálogo de preços informado pelo operador, estimativas de custo, primitives de idempotência, journal de auditoria encadeado, blueprint de delegação convertido em DAG, console de inteligência, scripts de diagnóstico/build Windows 11, CI e checklist de release. O detalhe de cada entrega está em `docs/ETAPA-20.md` até `docs/ETAPA-30.md`.

**Estado real da versão:** este pacote é um candidato técnico/RC, não uma versão 1.0 certificada. Neste ambiente não foi possível executar Cargo/Rust, typecheck completo via dependências do workspace, testes ponta a ponta com os CLIs instalados, nem gerar/testar MSI/NSIS em Windows 11. Veja [`docs/RELEASE-1.0.md`](docs/RELEASE-1.0.md) e [`SECURITY.md`](SECURITY.md) antes de utilizar em produção.

### Comandos de release no Windows

- Diagnóstico: `pnpm doctor:windows`
- Scanner heurístico: `pnpm security:audit`
- Gates de release: `pnpm release:check`
- Build MSI + NSIS: `pnpm build:windows`

Os CLIs preservam a autenticação nativa local. Não coloque tokens, chaves ou senhas na memória compartilhada; a filtragem de segredos é heurística e não substitui um gerenciador de segredos.

Relatório da validação estática desta consolidação: [`docs/VALIDACAO-RC-2026-11-26.md`](docs/VALIDACAO-RC-2026-11-26.md). Ele distingue as verificações executadas dos builds e testes que precisam ser rodados no Windows 11.
