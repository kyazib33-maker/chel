# Etapa 2 — Task Board, Git Worktrees e Workflow Builder

## Git Worktrees

`workspace-manager` usa a CLI oficial do Git com argumentos separados (sem shell), valida branch com `git check-ref-format`, valida a referência base como commit e mantém um registro de propriedade no diretório de dados do aplicativo. O registro fica fora do worktree para não aparecer como arquivo de projeto nem entrar acidentalmente em commits do agente.

O gerenciador lista apenas worktrees que ele próprio registrou. A remoção passa por `git worktree remove`; sem `force`, o Git preserva a proteção de alterações locais. A remoção forçada só é feita após confirmação na interface. O Host também bloqueia a remoção enquanto uma tarefa ativa tiver `cwd` dentro daquele worktree. Caso a pasta seja apagada manualmente, o registro órfão pode ser limpo e o Git recebe uma solicitação de `worktree prune`.

## Workflow Engine

Cada workflow é um DAG composto por nós de agente e arestas. Os nós carregam papel/system prompt, provedor, modelo, esforço, política de contexto, modo de worktree e posição visual. As arestas carregam a regra `pass_context`.

A validação checa nomes vazios, ids duplicados, extremidades inválidas, conexões duplicadas, auto-conexões, tamanho máximo e ciclos. O resultado inclui `execution_levels`, que agrupa os nós que podem iniciar no mesmo nível, respeitando dependências anteriores.

Os templates são salvos em JSON no diretório de dados local, um arquivo por UUID.

## Task Board

O Board agrupa tarefas em fila, execução, aprovação, conclusão e erro/cota. A Split View mantém até quatro streams selecionados simultaneamente. O tempo decorrido usa `started_at` e, para tarefas encerradas, `finished_at`.

`process-manager` usa `notify` para acompanhar modificações recursivas dentro do diretório de trabalho. Ele ignora `.git`, `node_modules`, `target`, `dist`, `build`, `.next`, `coverage`, ambientes virtuais e arquivos temporários. `current_file` significa o último arquivo alterado observado; não é uma afirmação sobre o arquivo que o modelo está lendo naquele instante.

## Limites desta etapa

- A validação e persistência do workflow estão implementadas; o Workflow Runner que dispara nós, espera fan-in e compõe o contexto ainda não está ligado à interface.
- `awaiting_approval` e `quota_exceeded` já fazem parte do protocolo e das colunas do Board, mas os adaptadores ainda não emitem esses estados.
- A persistência de tarefas e a continuidade de processos após fechar o Desktop ainda dependem do daemon separado planejado.
- A comunicação remota, WebSocket e pareamento QR Code pertencem à Etapa 3.
