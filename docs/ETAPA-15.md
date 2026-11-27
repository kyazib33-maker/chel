# Etapa 15 — Orquestração autônoma controlada

## Entrega

A execução de workflows ganhou uma política explícita (`WorkflowRunPolicy`) com limites de segurança:

- até 12 nós por execução por padrão;
- até 60 minutos por agente;
- até 180 minutos para o workflow inteiro;
- captura limitada a 64 KiB por agente (o teto interno continua valendo mesmo se o cliente pedir mais);
- exigência de um agente dedicado de revisão.

Antes de iniciar, o Desktop exibe uma confirmação com quantidade de agentes, limites de tempo, captura de saída e aviso de consumo de cota. A execução é recusada se não houver revisor conectado, direta ou indiretamente, a todos os demais nós. O workflow continua respeitando o DAG: nós do mesmo nível podem executar em paralelo e dependências só iniciam após sucesso dos predecessores.

## Cancelamento e limites

O executor acompanha IDs de tarefas ativas. Ao atingir o limite total, solicita cancelamento dos processos registrados e encerra a execução. Cada nó também cancela seu processo ao exceder o limite individual. A política rejeita limites nulos, workflows acima do máximo de nós e captura inferior a 1 KiB.

## Limitações explícitas

- O limite de tokens/orçamento monetário ainda não é aplicado: os formatos de telemetria e preços diferem entre provedores e modelos. Não se estima custo sem tabela configurada e dados confiáveis.
- O clique de confirmação autoriza iniciar o workflow inteiro; checkpoints humanos entre nós e aprovação por etapa ainda não estão implementados.
- Fallback automático entre provedores não é executado: trocar de CLI pode mudar permissões, contexto e comportamento, portanto segue exigindo política e aprovação próprias.
- O workflow retorna resultado ao final; acompanhamento granular e cancelamento de uma execução inteira pela interface ainda são próximos passos.
- Build e testes Rust precisam ser executados em ambiente com Rust toolchain instalado.

## Arquivos principais

- `crates/workflow-runner/src/lib.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src/lib/tauri.ts`
- `apps/desktop/src/features/workflows/WorkflowBuilder.tsx`
