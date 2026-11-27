# Etapa 4 — Aplicativo Mobile Expo

## Entregas implementadas

O aplicativo `apps/mobile` agora oferece uma interface React Native com Expo Router e NativeWind, conectada ao protocolo remoto existente.

### Pareamento

- Scanner QR nativo com `expo-camera` e `CameraView`.
- Campo alternativo para colar o payload JSON do QR.
- Identificação do dispositivo por nome.
- Validação de protocolo, expiração e endpoint privado/Tailscale antes de enviar o desafio.
- Pareamento de uso único via `POST /api/v1/pair`.
- Token persistido com `expo-secure-store`.
- Desconexão que remove o token salvo no dispositivo.

### Dashboard e controle de tarefas

- Dashboard com status do Host, contagem de tarefas ativas, tarefas recentes e volume live informado pelo Usage.
- Atualização por REST e WebSocket.
- Tratamento de snapshot, replay, eventos de tarefa e atualizações periódicas de Usage.
- Reconexão com backoff exponencial limitado.
- Detalhe da tarefa com estado, provedor, modelo, esforço, diretório de trabalho, arquivo recentemente alterado e logs recebidos nesta sessão do aplicativo.
- Cancelamento remoto com confirmação do usuário.

### Disparador rápido

- Seleção de Claude Code, Codex CLI ou Antigravity.
- Modelo opcional em campo livre para não fixar nomes de modelos possivelmente indisponíveis na instalação local.
- Seleção de esforço por provedor, respeitando as opções definidas pelos adapters atuais.
- Nome, pasta absoluta de trabalho e prompt.
- O Host continua validando que o `cwd` existe e está dentro da raiz autorizada.

### Workflows

- Endpoint autenticado `GET /api/v1/workflows` compartilha a biblioteca de templates do Desktop.
- O Mobile lista workflows, contagem de agentes, data de atualização e detalhes dos nós.
- A ação de execução está deliberadamente indisponível: o projeto ainda não tem Workflow Runner que coordene DAG, fan-out/fan-in, dependências, resultados e passagem de contexto. A UI explica essa limitação e não simula a execução.

### Aprovações

- Tela dedicada à central de aprovações.
- Estado atual explica que o contrato de pedidos/decisões e os adaptadores interativos ainda não foram conectados.
- Não são exibidos botões falsos de aprovar/negar, pois o Host ainda não recebe solicitações de permissão interativa dos CLIs em seu protocolo.

### Usage

- Painel com Claude Code, Codex CLI e Antigravity.
- Tokens históricos separados de tokens ao vivo.
- Tempo de execução, sessões analisadas, estado de cota detectado e disponibilidade de cada fonte.
- Aviso de que os dados não representam uma leitura oficial de cotas de assinatura.

## API remota ampliada

Foi adicionado:

- `GET /api/v1/workflows` — requer `Authorization: Bearer <device_token>` e retorna os templates válidos persistidos pelo `WorkflowStore` do Desktop.

O controlador remoto compartilha a mesma instância do `WorkflowStore` utilizada pela interface Desktop, portanto não mantém uma segunda cópia dos templates.

## Navegação Mobile

```text
apps/mobile/app/
├── _layout.tsx
├── connect.tsx
├── task/
│   └── [id].tsx
└── (tabs)/
    ├── _layout.tsx
    ├── index.tsx       # Dashboard
    ├── prompt.tsx      # Quick dispatch
    ├── workflows.tsx  # Templates salvos
    ├── approvals.tsx  # Central de aprovações (integração pendente)
    └── usage.tsx       # Métricas
```

## Protocolo WebSocket consumido

O Mobile autentica usando o primeiro frame `authenticate`, com token do dispositivo e última sequência conhecida. Depois interpreta:

- `authenticated`
- `snapshot`
- `replay`
- `event`
- `usage`
- `error`

A sequência global é mantida em memória enquanto o app está aberto. Após encerramento completo do app, o próximo início recebe um novo snapshot; a timeline anterior não é persistida localmente pelo Mobile.

## Limitações conhecidas

1. Workflow templates são somente leitura no Mobile até existir Workflow Runner remoto.
2. Aprovações interativas ainda não são emitidas pelos adapters nem representadas por endpoints/eventos de decisão.
3. O histórico de logs exibido no detalhe inclui eventos recebidos enquanto o Mobile está conectado; o Host ainda não persiste duravelmente toda a saída dos processos.
4. O quick dispatch pede o caminho absoluto da pasta no Host; não existe ainda endpoint remoto para navegar pelo sistema de arquivos ou escolher worktrees registrados.
5. O servidor LAN da etapa anterior utiliza HTTP simples. Em redes não confiáveis, deve ser utilizado Tailscale; o tráfego HTTP local não é criptografado pelo app.

## Checklist de validação no Windows 11

```powershell
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install
pnpm --filter @orchestrator/shared-types typecheck
pnpm --filter @orchestrator/mobile typecheck
pnpm --filter @orchestrator/mobile start
```

Para teste no dispositivo Android, utilize um build Expo Development Client ou Expo Go compatível com o SDK fixado no monorepo, e confirme que celular e Desktop conseguem se alcançar na rede escolhida. Em seguida, habilite LAN no Desktop, gere o QR e pareie o dispositivo.

A geração desta etapa não possui `pnpm` instalado nem acesso ao ambiente Android/iOS do usuário. Portanto, os testes de build nativo e pareamento físico permanecem pendentes.
